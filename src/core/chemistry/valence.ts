import type { AtomObject, BondObject, SceneObject, VDrawDocument, Vec } from '../../types/document';
import { allObjects, getLayerOfObject } from '../scene';
import { groupRingBonds } from './ring-geometry';
import {
  bondingState,
  hybridizationFor,
  hybridizationLabel,
  maxValenceFor,
  valenceStatesFor
} from './electronic';

export type IssueSeverity = 'error' | 'warning';

export interface ChemIssue {
  id: string;
  objectId: string | null;
  position: Vec;
  message: string;
  severity: IssueSeverity;
}

export { maxValenceFor };

export function chemScopeIds(
  doc: VDrawDocument,
  selection: string[]
): string[] | undefined {
  if (selection.length === 0) return undefined;
  const objects = allObjects(doc);
  const scoped = selection.filter((id) => {
    const object = objects.find((item) => item.id === id);
    return object?.type === 'atom' || object?.type === 'bond' || object?.type === 'group';
  });
  return scoped.length > 0 ? scoped : undefined;
}

export function bondOrder(bond: BondObject): number {
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

/**
 * 结构报告：不再套用场景化的硬编码规则，
 * 而是由每个原子的 σ/π 价层占用与八隅体/扩展价态容量推导。
 */
export function validateStructure(doc: VDrawDocument, ids?: string[]): ChemIssue[] {
  const objects = allObjects(doc).filter((obj) => {
    const layer = getLayerOfObject(doc, obj.id);
    return Boolean(layer?.visible && !layer.locked && obj.visible);
  });
  const atoms = objects.filter((obj): obj is AtomObject => obj.type === 'atom');
  const bonds = objects.filter((obj): obj is BondObject => obj.type === 'bond');
  const groups = new Map(
    objects.filter((obj) => obj.type === 'group').map((obj) => [obj.id, obj])
  );
  const scope = ids && ids.length > 0 ? new Set(ids) : null;
  const issues: ChemIssue[] = [];

  for (const atom of atoms) {
    if (scope && !scope.has(atom.id) && !(atom.parentId && scope.has(atom.parentId))) continue;
    if (atom.label.group) continue;

    const element = atom.label.element;
    const touching = bonds.filter(
      (bond) =>
        Math.hypot(bond.start.x - atom.position.x, bond.start.y - atom.position.y) < 2.5 ||
        Math.hypot(bond.end.x - atom.position.x, bond.end.y - atom.position.y) < 2.5
    );
    const parentGroup = atom.parentId ? groups.get(atom.parentId) : null;
    const aromatic = Boolean(parentGroup && parentGroup.type === 'group' && parentGroup.ringStyle);
    const ringIds = aromatic
      ? new Set(
          groupRingBonds(bonds.filter((bond) => bond.parentId === atom.parentId)).map(
            (bond) => bond.id
          )
        )
      : new Set<string>();
    const state = bondingState(
      touching,
      atom.label.hydrogens ?? 0,
      atom.label.lonePairs ?? 0,
      aromatic,
      ringIds
    );
    const capacity = maxValenceFor(element, atom.label.charge);
    if (capacity === null) continue;

    const hybridization = hybridizationFor(state.orbitals, state.pi);
    if (state.used > capacity + 0.01) {
      issues.push({
        id: `valence_${atom.id}`,
        objectId: atom.id,
        position: atom.position,
        severity: 'error',
        message:
          `${element} 价层占用 ${Number(state.used.toFixed(1))} 超出容量 ${capacity}` +
          `（σ=${state.sigma}，π=${Number(state.pi.toFixed(1))}，${hybridizationLabel(hybridization)}）` +
          `；允许价态 ${valenceStatesFor(element, atom.label.charge).join(' / ') || capacity}`
      });
    } else if (element === 'C' && state.used < 4 && (atom.label.hydrogens ?? 0) === 0) {
      issues.push({
        id: `hint_${atom.id}`,
        objectId: atom.id,
        position: atom.position,
        severity: 'warning',
        message:
          `碳原子当前 σ/π 占用 ${Number(state.used.toFixed(1))}/4，` +
          '未标注氢或显式键不足'
      });
    }
  }

  if (bonds.length > 0 && atoms.length === 0) {
    const first = bonds[0];
    issues.push({
      id: 'implicit_only',
      objectId: first.id,
      position: {
        x: (first.start.x + first.end.x) / 2,
        y: (first.start.y + first.end.y) / 2
      },
      severity: 'warning',
      message: '当前结构仅包含隐含碳骨架；添加原子标签后可进行更完整的价态检查'
    });
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

export function collectChemistryObjects(doc: VDrawDocument): SceneObject[] {
  return allObjects(doc).filter(
    (obj) => obj.type === 'bond' || obj.type === 'atom' || obj.type === 'arrow'
  );
}
