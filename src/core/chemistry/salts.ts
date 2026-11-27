import type { AtomObject, BondObject, Vec } from '../../types/document';
import { normalize, sub } from '../geometry';
import { atomLabelLayout, atomParts, terminalLabelShift } from './labels';

/**
 * 能与酸性氢交换的金属及其常见阳离子电荷。
 * 只收录碱金属/碱土金属：它们与酸根形成离子对，而不是共价 O–M 键。
 */
export const SALT_METALS: Record<string, number> = {
  Li: 1,
  Na: 1,
  K: 1,
  Mg: 2,
  Ca: 2
};

export function saltMetalCharge(element: string): number | null {
  return SALT_METALS[element] ?? null;
}

/** 成盐时金属阳离子的摆放方式：键轴延长线，或垂直于键轴的侧向避让。 */
export type CationPlacement = 'axial' | 'right';

export interface AcidicGroupSpec {
  /** 脱氢后的标签；null 表示直接显示元素符号（如酚氧 O⁻）。 */
  group: string | null;
  element: string;
}

/**
 * 可被金属置换酸性氢的官能团。
 * OH/HO 为酚/醇羟基；COOH 为羧酸；SO₃H 为磺酸。
 */
const ACIDIC_GROUPS: Record<string, AcidicGroupSpec> = {
  OH: { group: null, element: 'O' },
  HO: { group: null, element: 'O' },
  COOH: { group: 'COO', element: 'C' },
  'CO₂H': { group: 'CO₂', element: 'C' },
  CO2H: { group: 'CO2', element: 'C' },
  'SO₃H': { group: 'SO₃', element: 'S' },
  SO3H: { group: 'SO3', element: 'S' },
  // 已脱氢的酸根再次点金属时，只补阳离子，不破坏原有酸根标签。
  'COO⁻': { group: 'COO', element: 'C' },
  'COO-': { group: 'COO', element: 'C' },
  'SO₃⁻': { group: 'SO₃', element: 'S' },
  'SO3-': { group: 'SO3', element: 'S' }
};

export function acidicGroupSpec(atom: AtomObject): AcidicGroupSpec | null {
  const group = atom.label.group;
  return group ? ACIDIC_GROUPS[group] ?? null : null;
}

export function isAcidicGroupLabel(atom: AtomObject): boolean {
  return acidicGroupSpec(atom) !== null;
}

export interface AcidicSaltPlan {
  /** 脱氢后的酸根标签，保留位置与字号。 */
  acidLabel: AtomObject['label'];
  /** 金属阳离子的目标位置。 */
  cation: {
    element: string;
    position: Vec;
    charge: number;
    fontSize: number;
  };
}

/**
 * 把酸性官能团上的 H 替换为金属阳离子：
 * - OH/HO → O⁻；COOH → COO⁻；SO₃H → SO₃⁻；
 * - 金属沿键轴延长线，或垂直于键轴的侧向摆放；
 * - 左侧官能团自动把侧向金属放到左边，避免伸进苯环；
 * - distance > 0 时作为最小金属–酸根距离，但仍会自动避让标签，避免重叠。
 */
export function planAcidicSalt(
  atom: AtomObject,
  metal: string,
  neighbor: Vec | null,
  fallbackDistance: number,
  placement: CationPlacement = 'axial',
  distance = 0
): AcidicSaltPlan | null {
  const spec = acidicGroupSpec(atom);
  if (!spec) return null;
  const charge = saltMetalCharge(metal);
  if (charge === null) return null;

  const fontSize = atom.label.fontSize ?? 16;
  const acidLabel: AtomObject['label'] = {
    ...atom.label,
    element: spec.element,
    group: spec.group,
    charge: -1,
    hydrogens: null
  };
  const acidAtom: AtomObject = { ...atom, label: acidLabel };
  const acidParts = atomParts(acidAtom);
  const acidWidth = Math.max(28, acidParts.width + acidParts.fontSize * 0.34);
  const acidHeight = Math.max(30, acidParts.fontSize * 1.5);
  const labelShift = neighbor
    ? terminalLabelShift(atom.position, neighbor, acidParts.width, acidHeight)
    : { x: 0, y: 0 };
  const labelCenter = {
    x: atom.position.x + labelShift.x,
    y: atom.position.y + labelShift.y
  };

  const cationLabel: AtomObject['label'] = {
    element: metal,
    charge,
    isotope: null,
    radical: 'none',
    lonePairs: 0,
    hydrogens: null,
    group: null,
    fontSize
  };
  const cationWidth =
    atomParts({ ...atom, label: cationLabel }).width + (charge > 0 ? fontSize * 0.3 : 0);
  const cationHalfWidth = cationWidth / 2;
  const cationHalfHeight = fontSize * 0.6;
  const gap = Math.max(6, fontSize * 0.3);

  const side =
    neighbor && atom.position.x < neighbor.x - 1 ? -1 : 1;
  const direction =
    placement === 'right'
      ? { x: side, y: 0 }
      : neighbor
        ? normalize(sub(atom.position, neighbor))
        : { x: 0, y: -1 };

  const boxLeft = labelCenter.x - acidWidth / 2;
  const boxRight = labelCenter.x + acidWidth / 2;
  const boxTop = labelCenter.y - acidHeight / 2;
  const boxBottom = labelCenter.y + acidHeight / 2;
  let required = 0;
  if (direction.x > 0.001) {
    required = Math.max(
      required,
      (boxRight + cationHalfWidth + gap - atom.position.x) / direction.x
    );
  } else if (direction.x < -0.001) {
    required = Math.max(
      required,
      (atom.position.x - boxLeft + cationHalfWidth + gap) / -direction.x
    );
  }
  if (direction.y > 0.001) {
    required = Math.max(
      required,
      (boxBottom + cationHalfHeight + gap - atom.position.y) / direction.y
    );
  } else if (direction.y < -0.001) {
    required = Math.max(
      required,
      (atom.position.y - boxTop + cationHalfHeight + gap) / -direction.y
    );
  }

  const bondLength = neighbor
    ? Math.hypot(atom.position.x - neighbor.x, atom.position.y - neighbor.y)
    : fallbackDistance;
  const minDistance = distance > 0 ? distance : bondLength;
  const resolved = Math.max(minDistance, required);

  return {
    acidLabel,
    cation: {
      element: metal,
      position: {
        x: atom.position.x + direction.x * resolved,
        y: atom.position.y + direction.y * resolved
      },
      charge,
      fontSize
    }
  };
}

/** 命中酸性官能团标签的完整文字框（包括 OH 里的 H、COOH/SO₃H 的整段文字）。 */
export function acidicGroupAtomAt(
  atoms: AtomObject[],
  bonds: BondObject[],
  point: Vec
): AtomObject | null {
  for (const atom of atoms) {
    if (!isAcidicGroupLabel(atom)) continue;
    const parts = atomParts(atom);
    const layout = atomLabelLayout(atom, bonds);
    const chargePad = atom.label.charge ? parts.fontSize * 0.34 : 0;
    const halfWidth = Math.max(28, parts.width + parts.fontSize * 0.34 + chargePad) / 2 + 4;
    const halfHeight = Math.max(30, parts.fontSize * 1.5) / 2 + 4;
    const centerX = atom.position.x + layout.dx;
    const centerY = atom.position.y + layout.dy;
    if (
      Math.abs(point.x - centerX) <= halfWidth &&
      Math.abs(point.y - centerY) <= halfHeight
    ) {
      return atom;
    }
  }
  return null;
}
