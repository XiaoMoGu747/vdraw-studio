import type { AtomLabelData, AtomObject, BondObject, Vec } from '../../types/document';

export const ATOM_FONT_SIZE = 16;
/** 标签近端与键端点之间保留的固定空隙；与标签宽度无关。 */
export const ATOM_LABEL_GAP = 5;

const SUBSCRIPTS: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉'
};

const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹'
};

export function subscript(value: number): string {
  return String(value)
    .split('')
    .map((char) => SUBSCRIPTS[char] ?? char)
    .join('');
}

export function superscript(value: number): string {
  return String(value)
    .split('')
    .map((char) => SUPERSCRIPTS[char] ?? char)
    .join('');
}

export interface AtomLabelParts {
  main: string;
  isotope: string | null;
  charge: string | null;
  radicalCount: number;
  lonePairs: number;
  width: number;
  fontSize: number;
}

export function atomMainText(label: AtomLabelData, implicitHydrogens = false): string {
  if (label.group) return label.group;
  const hydrogens = label.hydrogens ?? 0;
  // 隐式氢：只影响显示/导出，不修改原子对象里的氢数。
  if (hydrogens > 0 && !implicitHydrogens) return `${label.element}H${subscript(hydrogens)}`;
  return label.element;
}

export function atomParts(atom: AtomObject, implicitHydrogens = false): AtomLabelParts {
  const label = atom.label;
  const fontSize = Math.max(8, label.fontSize ?? ATOM_FONT_SIZE);
  const main = atomMainText(label, implicitHydrogens);
  const chargeMagnitude = Math.abs(label.charge);
  const charge =
    label.charge === 0
      ? null
      : `${chargeMagnitude === 1 ? '' : chargeMagnitude}${label.charge > 0 ? '+' : '−'}`;
  const radicalCount = label.radical === 'triplet' ? 2 : label.radical === 'none' ? 0 : 1;

  let width = 0;
  for (const char of main) {
    if (/[\u4e00-\u9fa5]/.test(char)) width += fontSize;
    else if (/[₀-₉]/.test(char)) width += fontSize * 0.36;
    else if (/[A-Z]/.test(char)) width += fontSize * 0.66;
    else width += fontSize * 0.5;
  }

  return {
    main,
    isotope: label.isotope ? String(label.isotope) : null,
    charge,
    radicalCount,
    lonePairs: label.lonePairs,
    width: Math.max(fontSize * 0.7, width),
    fontSize
  };
}

export function atomRadius(atom: AtomObject): number {
  return atomParts(atom).width / 2 + 5;
}

export interface AtomLabelLayout {
  /** 标签文字中心相对原子位置的偏移。 */
  dx: number;
  dy: number;
  /** 与键相接一侧需要让出的距离；端基标签为固定小间隙。 */
  clearance: number;
  /** 是否为单键端基（标签沿键轴向外展开）。 */
  terminal: boolean;
}

/** 单键端基：标签沿键轴向外移，近端只留固定间隙，避免宽官能团把键挤短。 */
export function terminalLabelShift(
  position: Vec,
  neighbor: Vec,
  width: number,
  height: number,
  gap = ATOM_LABEL_GAP
): Vec {
  const dx = position.x - neighbor.x;
  const dy = position.y - neighbor.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return { x: 0, y: 0 };
  const ux = dx / length;
  const uy = dy / length;
  // 标签是水平文字：沿键轴方向的半宽由文字宽/高在该方向上的投影决定。
  const halfExtent = Math.abs(ux) * (width / 2) + Math.abs(uy) * (height / 2);
  const shift = Math.max(0, halfExtent - gap);
  return { x: ux * shift, y: uy * shift };
}

/**
 * 原子标签布局：只有一个键的端基标签向外展开，其余标签居中。
 * 这样 COOH / SO₃H 等宽标签不会因为按整段文字宽度裁键而把键压得过短。
 */
export function atomLabelLayout(atom: AtomObject, bonds: BondObject[]): AtomLabelLayout {
  const parts = atomParts(atom);
  const touching = bonds.filter((bond) => {
    const atStart =
      Math.abs(bond.start.x - atom.position.x) < 2.5 &&
      Math.abs(bond.start.y - atom.position.y) < 2.5;
    const atEnd =
      Math.abs(bond.end.x - atom.position.x) < 2.5 &&
      Math.abs(bond.end.y - atom.position.y) < 2.5;
    return atStart || atEnd;
  });
  if (touching.length === 1) {
    const bond = touching[0];
    const atStart =
      Math.abs(bond.start.x - atom.position.x) < 2.5 &&
      Math.abs(bond.start.y - atom.position.y) < 2.5;
    const neighbor = atStart ? bond.end : bond.start;
    const shift = terminalLabelShift(
      atom.position,
      neighbor,
      parts.width,
      Math.max(30, parts.fontSize * 1.5)
    );
    return {
      dx: shift.x,
      dy: shift.y,
      clearance: ATOM_LABEL_GAP,
      terminal: true
    };
  }
  return { dx: 0, dy: 0, clearance: atomRadius(atom), terminal: false };
}

/** 键在原子一端应让出的距离：端基标签只需固定间隙，其它按标签半径。 */
export function atomBondClearance(atom: AtomObject, bonds: BondObject[]): number {
  return atomLabelLayout(atom, bonds).clearance;
}

export function estimateAtomHitRadius(atom: AtomObject): number {
  return atomParts(atom).width / 2 + 9;
}

export function pointNearAtom(atom: AtomObject, point: Vec, tolerance = 2): boolean {
  return Math.hypot(atom.position.x - point.x, atom.position.y - point.y) <= tolerance;
}
