import type { AtomObject, BondObject, Vec } from '../../types/document';
import { normalize, sub } from '../geometry';
import {
  atomLabelLayout,
  atomLabelLayoutForNeighbor,
  atomLabelTokens,
  atomMainText,
  measureLabelWidth,
  type AtomLabelLayout
} from './labels';

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
  /** 酸根中真正与金属相邻的连接原子位置。 */
  attach: Vec;
  /** 羟基/羧基/磺酸基中带酸性 H 的 O 的字形中心（Na 距离以此为基准）。 */
  acidO: Vec;
}

/**
 * 从标签的 token 序列定位酸性 O 的字形中心。
 * layout.attach 是键连接的 C/O（token 0），酸性 O 在其后若干个 token。
 */
function acidOxygenCenter(
  atom: AtomObject,
  text: string,
  layout: AtomLabelLayout
): Vec {
  const tokens = atomLabelTokens(text);
  let oxygenIndex = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].startsWith('O')) oxygenIndex = index;
  }
  if (oxygenIndex <= 0) return { x: layout.attach.x, y: layout.attach.y };
  const fontSize = atom.label.fontSize ?? 16;
  const widths = tokens.map((token) => measureLabelWidth(token, fontSize));
  let offset = 0;
  for (let index = 0; index < oxygenIndex; index += 1) offset += widths[index];
  offset += (widths[oxygenIndex] - widths[0]) / 2;
  return {
    x: layout.attach.x + (layout.flip ? -offset : offset),
    y: layout.attach.y
  };
}

/**
 * 把酸性官能团上的 H 替换为金属阳离子：
 * - OH/HO → O⁻；COOH → COO⁻；SO₃H → SO₃⁻；
 * - 金属沿键轴延长线，或垂直于键轴的侧向摆放；
 * - 左侧官能团自动把侧向金属放到左边，避免伸进苯环；
 * - distance 就是金属到连接原子的距离；0 表示完全重叠。
 */
export function planAcidicSalt(
  atom: AtomObject,
  metal: string,
  neighbor: Vec | null,
  _fallbackDistance: number,
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
  // 以“脱氢后的酸根”计算标签锚点：键真正连接在 O / 羧基 C 的字形上。
  const layout = atomLabelLayoutForNeighbor(acidAtom, neighbor);
  const attach = layout.attach;
  const acidO = acidOxygenCenter(acidAtom, atomMainText(acidLabel), layout);

  const side = neighbor && acidO.x < neighbor.x - 1 ? -1 : 1;
  const direction =
    placement === 'right'
      ? { x: side, y: 0 }
      : neighbor
        ? normalize(sub(acidO, neighbor))
        : { x: 0, y: -1 };

  // distance 就是金属中心到酸性 O 字形中心的距离；0 表示完全重叠。
  const resolved = distance;

  return {
    acidLabel,
    cation: {
      element: metal,
      position: {
        x: acidO.x + direction.x * resolved,
        y: acidO.y + direction.y * resolved
      },
      charge,
      fontSize
    },
    attach,
    acidO
  };
}

/** 当前酸性官能团中带 H 的 O 的字形中心；用于光标提示与验证。 */
export function acidOxygenAt(atom: AtomObject, bonds: BondObject[]): Vec | null {
  const group = atom.label.group ?? '';
  const deprotonated = [
    'COO',
    'COO⁻',
    'COO-',
    'CO₂',
    'CO2',
    'SO₃',
    'SO3',
    'SO₃⁻',
    'SO3-'
  ].includes(group);
  const isAnion = atom.label.element === 'O' && atom.label.charge === -1;
  if (!isAcidicGroupLabel(atom) && !isAnion && !deprotonated) return null;
  const layout = atomLabelLayout(atom, bonds);
  return acidOxygenCenter(atom, atomMainText(atom.label), layout);
}

/** 命中酸性官能团标签的完整文字框（包括 OH 里的 H、COOH/SO₃H 的整段文字）。 */
export function acidicGroupAtomAt(
  atoms: AtomObject[],
  bonds: BondObject[],
  point: Vec
): AtomObject | null {
  for (const atom of atoms) {
    if (!isAcidicGroupLabel(atom)) continue;
    const layout = atomLabelLayout(atom, bonds);
    const text = atomMainText(atom.label);
    const oxygenToken =
      atomLabelTokens(text).find((token) => token.startsWith('O')) ?? 'O';
    const acidO = acidOxygenCenter(atom, text, layout);
    const fontSize = atom.label.fontSize ?? 16;
    const halfWidth = Math.max(14, measureLabelWidth(oxygenToken, fontSize) / 2 + 10);
    const halfHeight = Math.max(18, fontSize * 0.6 + 10);
    if (
      Math.abs(point.x - acidO.x) <= halfWidth &&
      Math.abs(point.y - acidO.y) <= halfHeight
    ) {
      return atom;
    }
  }
  return null;
}
