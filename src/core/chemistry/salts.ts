import type { AtomObject, Vec } from '../../types/document';
import { normalize, sub } from '../geometry';
import { atomParts } from './labels';

/**
 * 能与羟基氢交换的金属及其常见阳离子电荷。
 * 只收录碱金属/碱土金属：它们与 O⁻ 形成离子对，而不是共价 O–M 键。
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

export function isHydroxylLabel(atom: AtomObject): boolean {
  return atom.label.group === 'OH' || atom.label.group === 'HO';
}

export interface HydroxylSaltPlan {
  /** 原羟基氧改成 O⁻，保留位置与字号。 */
  oxygenLabel: AtomObject['label'];
  /** 阳离子放在原来 H 的方向上，与 O 严格共线。 */
  cation: {
    element: string;
    position: Vec;
    charge: number;
    fontSize: number;
  };
}

/**
 * 把“羟基上的 H”替换为金属阳离子：
 * - O 标签由 OH/HO 变为带 −1 电荷的 O；
 * - 金属放在 O–取代基键的延长线上（原来 H 所在方向），距离不小于一个键长，
 *   因此不会压住 O 标签，也不会出现横向错位；
 * - 不创建共价键，保持离子对的化学语义。
 */
export function planHydroxylSalt(
  atom: AtomObject,
  metal: string,
  neighbor: Vec | null,
  fallbackDistance: number
): HydroxylSaltPlan | null {
  if (!isHydroxylLabel(atom)) return null;
  const charge = saltMetalCharge(metal);
  if (charge === null) return null;

  const fontSize = atom.label.fontSize ?? 16;
  const oxygenWidth = atomParts(atom).width;
  const cationLabel: AtomObject['label'] = {
    ...atom.label,
    element: metal,
    group: null,
    charge,
    hydrogens: null
  };
  const cationWidth =
    atomParts({ ...atom, label: cationLabel }).width + (charge > 0 ? fontSize * 0.3 : 0);

  const direction = neighbor
    ? normalize(sub(atom.position, neighbor))
    : { x: 0, y: -1 };
  const bondLength = neighbor
    ? Math.hypot(atom.position.x - neighbor.x, atom.position.y - neighbor.y)
    : fallbackDistance;
  const clearance = oxygenWidth / 2 + cationWidth / 2 + Math.max(6, fontSize * 0.3);
  const distance = Math.max(bondLength, clearance);

  return {
    oxygenLabel: {
      ...atom.label,
      element: 'O',
      group: null,
      charge: -1,
      hydrogens: null
    },
    cation: {
      element: metal,
      position: {
        x: atom.position.x + direction.x * distance,
        y: atom.position.y + direction.y * distance
      },
      charge,
      fontSize
    }
  };
}

/** 命中羟基标签的完整文字框（包括“OH”里的 H），供元素工具替换使用。 */
export function hydroxylAtomAt(atoms: AtomObject[], point: Vec): AtomObject | null {
  for (const atom of atoms) {
    if (!isHydroxylLabel(atom)) continue;
    const parts = atomParts(atom);
    const halfWidth = Math.max(28, parts.width + 18) / 2 + 4;
    const halfHeight = parts.fontSize * 0.62 + 4;
    if (
      Math.abs(point.x - atom.position.x) <= halfWidth &&
      Math.abs(point.y - atom.position.y) <= halfHeight
    ) {
      return atom;
    }
  }
  return null;
}
