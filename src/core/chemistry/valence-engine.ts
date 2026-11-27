import type { AtomObject, SceneObject, VDrawDocument } from '../../types/document';
import { maxValenceFor, valenceStatesFor } from './electronic';
import { buildChemGraph, type ChemGraph } from './graph';

/**
 * 价态引擎：把"隐式氢"从用户输入改成派生量。
 *
 * 规则与 KingDraw 的实测实现一致（见 docs/kingdraw-rea-analysis.md §12.3）：
 * 在 allowed valences 列表上做"首次适配"——第一个 >= bondSum 的价态胜出，
 * H = 该价态 - bondSum；全部不足则 H = 0 并标记超价。
 * 注意不是取最大价态，也不是取最接近值。
 */

export interface HydrogenDerivation {
  hydrogens: number;
  /** 实际采用的价态（null 表示元素无价态数据） */
  valence: number | null;
  /** 键级总和超过所有允许价态 */
  superValent: boolean;
}

export function deriveHydrogens(
  element: string,
  charge: number,
  bondSum: number
): HydrogenDerivation | null {
  const states = valenceStatesFor(element, charge);
  if (states.length === 0) {
    const capacity = maxValenceFor(element, charge);
    if (capacity === null) return null;
    return {
      hydrogens: Math.max(0, capacity - bondSum),
      valence: capacity,
      superValent: bondSum > capacity + 0.01
    };
  }
  // valenceStatesFor 已按升序返回，等价于 KingDraw 的 valences 字符串顺序。
  for (const state of states) {
    if (state - bondSum >= -0.01) {
      return {
        hydrogens: Math.max(0, Number((state - bondSum).toFixed(2))),
        valence: state,
        superValent: false
      };
    }
  }
  return { hydrogens: 0, valence: states[states.length - 1], superValent: true };
}

/**
 * 单个原子的氢数（不含显式氢标记原子）。
 * SUP 官能团、显式氢原子、显式固定氢的原子一律跳过。
 */
export function hydrogensForAtom(atom: AtomObject, graph: ChemGraph): number | null {
  if (atom.label.group || atom.label.supId) return null;
  if (atom.explicitH !== null && atom.explicitH !== undefined) return atom.explicitH;
  if (atom.label.element === 'H') return 0;
  const derived = deriveHydrogens(
    atom.label.element,
    atom.label.charge,
    graph.bondSumOf(atom.id)
  );
  return derived ? derived.hydrogens : null;
}

export interface NormalizeResult {
  doc: VDrawDocument;
  changed: number;
}

/**
 * 保持"已标注氢"的原子自洽。
 *
 * 保守策略：只重算已经有数值氢的原子（hydrogens 为 number），
 * 不把 null 的骨架原子补成 CH₄/OH——否则打开旧文件会满屏多出氢标签，
 * 属于视觉回归而非优化。显式固定的氢（explicitH）不参与重算。
 */
export function normalizeHydrogens(doc: VDrawDocument): NormalizeResult {
  const graph = buildChemGraph(doc);
  let changed = 0;

  const layers = doc.layers.map((layer) => {
    let layerChanged = false;
    const objects = layer.objects.map((obj): SceneObject => {
      if (obj.type !== 'atom') return obj;
      if (typeof obj.label.hydrogens !== 'number') return obj;
      const next = hydrogensForAtom(obj, graph);
      if (next === null || Math.abs(next - obj.label.hydrogens) < 0.001) return obj;
      layerChanged = true;
      return { ...obj, label: { ...obj.label, hydrogens: next } };
    });
    if (!layerChanged) return layer;
    changed += 1;
    return { ...layer, objects };
  });

  if (changed === 0) return { doc, changed: 0 };
  return { doc: { ...doc, layers }, changed };
}

/** 供 UI/校验用：返回超价原子 id 列表。 */
export function superValentAtoms(doc: VDrawDocument): string[] {
  const graph = buildChemGraph(doc);
  const result: string[] = [];
  for (const atom of graph.atoms) {
    if (atom.label.group || atom.label.supId) continue;
    const derived = deriveHydrogens(
      atom.label.element,
      atom.label.charge,
      graph.bondSumOf(atom.id)
    );
    if (derived?.superValent) result.push(atom.id);
  }
  return result;
}
