import type { AtomObject, BondObject, GroupObject, VDrawDocument, Vec } from '../../types/document';
import { allObjects, getLayerOfObject } from '../scene';
import { groupRingBonds, ringGeometry } from './ring-geometry';

/**
 * 化学图（ChemGraph）：坐标仍是唯一真值，本模块只负责把"谁连着谁"显式算出来。
 *
 * 之所以要这一层：画布上键只有 start/end 两个点，原子只有 position，
 * 过去每个调用点各自用 distance <= eps 猜邻居（1.4 / 0.9 / 2.5 三套 eps），
 * 于是吸附手感、价态校验、氢数重算的结果互相矛盾。
 * 这里集中一次推导，供吸附解算器与价态引擎共用。
 */

/** 键级：单 1 / 双 2 / 三 3 / 芳香 1.5；立体键、配位键按单键计。 */
export function bondOrderOfBond(bond: BondObject): number {
  switch (bond.bondType) {
    case 'double':
      return 2;
    case 'triple':
      return 3;
    case 'aromatic':
      return 1.5;
    default:
      return 1;
  }
}

/** 绑定容差：略大于旧的 TOUCH_EPS，容忍手绘时的亚像素误差。 */
export const BIND_EPS = 2.2;

export interface ChemGraph {
  doc: VDrawDocument;
  atoms: AtomObject[];
  bonds: BondObject[];
  byId: Map<string, AtomObject | BondObject>;
  getAtom: (id: string) => AtomObject | null;
  getBond: (id: string) => BondObject | null;
  /** 与某原子相连的键（依据显式绑定或就近绑定推导）。 */
  bondsOf: (atomId: string) => BondObject[];
  /** 与某原子直接成键的原子 id 列表（去重）。 */
  neighborsOf: (atomId: string) => string[];
  /** 该原子所有键的键级之和，等价 KingDraw 的 bondSum。 */
  bondSumOf: (atomId: string) => number;
  /** 该键两端绑定的原子（可能为 null，表示隐含碳或未绑定）。 */
  endsOf: (bond: BondObject) => { a: AtomObject | null; b: AtomObject | null };
  /** 该键是否属于某个环（显式 ringBondId 优先，其次按环几何推导）。 */
  isRingBond: (bond: BondObject) => boolean;
}

function interactive(doc: VDrawDocument, obj: { id: string; visible: boolean }): boolean {
  if (!obj.visible) return false;
  const layer = getLayerOfObject(doc, obj.id);
  return Boolean(layer?.visible && !layer.locked);
}

/** 组的环内键集合缓存：同一组只算一次几何。 */
function ringBondIdsOfGroup(group: GroupObject, bonds: BondObject[]): Set<string> {
  const groupBonds = bonds.filter((bond) => bond.parentId === group.id);
  if (groupBonds.length < 3) return new Set();
  const geometry = ringGeometry(groupBonds);
  if (!geometry?.closed) return new Set();
  return new Set(groupRingBonds(groupBonds).map((bond) => bond.id));
}

export function buildChemGraph(doc: VDrawDocument): ChemGraph {
  const objects = allObjects(doc).filter((obj) => interactive(doc, obj));
  const atoms = objects.filter((obj): obj is AtomObject => obj.type === 'atom');
  const bonds = objects.filter((obj): obj is BondObject => obj.type === 'bond');
  const byId = new Map<string, AtomObject | BondObject>();
  for (const atom of atoms) byId.set(atom.id, atom);
  for (const bond of bonds) byId.set(bond.id, bond);

  const groups = new Map<string, GroupObject>();
  for (const obj of objects) {
    if (obj.type === 'group') groups.set(obj.id, obj);
  }
  const ringCache = new Map<string, Set<string>>();
  const ringBonds = new Set<string>();
  for (const [id, group] of groups) {
    const ids = ringBondIdsOfGroup(group, bonds);
    ringCache.set(id, ids);
    for (const bondId of ids) ringBonds.add(bondId);
  }
  for (const bond of bonds) {
    if (bond.ringBondId) ringBonds.add(bond.id);
  }

  /** 就近绑定：只在键端与原子足够近时成立，避免跨结构误连。 */
  const nearestAtom = (point: Vec): AtomObject | null => {
    let best: AtomObject | null = null;
    let bestDistance = BIND_EPS;
    for (const atom of atoms) {
      const d = Math.hypot(atom.position.x - point.x, atom.position.y - point.y);
      if (d <= bestDistance) {
        bestDistance = d;
        best = atom;
      }
    }
    return best;
  };

  const endsCache = new Map<string, { a: AtomObject | null; b: AtomObject | null }>();
  const endsOf = (bond: BondObject) => {
    const cached = endsCache.get(bond.id);
    if (cached) return cached;
    const a = (bond.atomA ? byId.get(bond.atomA) : null) ?? nearestAtom(bond.start);
    const b = (bond.atomB ? byId.get(bond.atomB) : null) ?? nearestAtom(bond.end);
    const resolved = {
      a: a && a.type === 'atom' ? a : null,
      b: b && b.type === 'atom' ? b : null
    };
    endsCache.set(bond.id, resolved);
    return resolved;
  };

  const bondIndex = new Map<string, BondObject[]>();
  for (const bond of bonds) {
    const { a, b } = endsOf(bond);
    if (a) {
      const list = bondIndex.get(a.id) ?? [];
      list.push(bond);
      bondIndex.set(a.id, list);
    }
    if (b && b.id !== a?.id) {
      const list = bondIndex.get(b.id) ?? [];
      list.push(bond);
      bondIndex.set(b.id, list);
    }
  }

  const graph: ChemGraph = {
    doc,
    atoms,
    bonds,
    byId,
    getAtom: (id) => {
      const found = byId.get(id);
      return found && found.type === 'atom' ? found : null;
    },
    getBond: (id) => {
      const found = byId.get(id);
      return found && found.type === 'bond' ? found : null;
    },
    bondsOf: (atomId) => bondIndex.get(atomId) ?? [],
    neighborsOf: (atomId) => {
      const result = new Set<string>();
      for (const bond of bondIndex.get(atomId) ?? []) {
        const { a, b } = endsOf(bond);
        if (a && a.id !== atomId) result.add(a.id);
        if (b && b.id !== atomId) result.add(b.id);
      }
      return [...result];
    },
    bondSumOf: (atomId) => {
      let sum = 0;
      for (const bond of bondIndex.get(atomId) ?? []) sum += bondOrderOfBond(bond);
      return sum;
    },
    endsOf,
    isRingBond: (bond) => ringBonds.has(bond.id)
  };

  return graph;
}

/** 把一条新键的两端绑定到已存在的原子（无匹配则留 null，保持旧"裸键"语义）。 */
export function bindBondEnds(
  bond: BondObject,
  startAtom: AtomObject | null,
  endAtom: AtomObject | null
): BondObject {
  if (bond.atomA === (startAtom?.id ?? null) && bond.atomB === (endAtom?.id ?? null)) return bond;
  return {
    ...bond,
    atomA: startAtom?.id ?? null,
    atomB: endAtom?.id ?? null
  };
}
