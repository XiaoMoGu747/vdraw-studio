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

function groupTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const char of text) {
    if (/[A-Z]/.test(char) || tokens.length === 0) {
      tokens.push(char);
    } else {
      tokens[tokens.length - 1] += char;
    }
  }
  return tokens;
}

/** 与 KingDraw 一致：左侧取代基把标签按原子顺序掉转，使连接原子靠近键。 */
export function flipGroupText(text: string): string {
  return groupTokens(text).reverse().join('');
}

/** 真正与键相连的原子对应 token；左置标签掉转后连接原子在末尾。 */
function attachmentToken(text: string, flip: boolean): string {
  const tokens = groupTokens(text);
  if (tokens.length === 0) return text;
  return flip ? tokens[tokens.length - 1] : tokens[0];
}

export function measureLabelWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) width += fontSize;
    else if (/[₀-₉]/.test(char)) width += fontSize * 0.36;
    else if (/[A-Z]/.test(char)) width += fontSize * 0.66;
    else width += fontSize * 0.5;
  }
  return Math.max(fontSize * 0.7, width);
}

export function atomParts(
  atom: AtomObject,
  implicitHydrogens = false,
  flip = false
): AtomLabelParts {
  const label = atom.label;
  const fontSize = Math.max(8, label.fontSize ?? ATOM_FONT_SIZE);
  const base = atomMainText(label, implicitHydrogens);
  const main = flip && label.group ? flipGroupText(base) : base;
  const chargeMagnitude = Math.abs(label.charge);
  const charge =
    label.charge === 0
      ? null
      : `${chargeMagnitude === 1 ? '' : chargeMagnitude}${label.charge > 0 ? '+' : '−'}`;
  const radicalCount = label.radical === 'triplet' ? 2 : label.radical === 'none' ? 0 : 1;

  return {
    main,
    isotope: label.isotope ? String(label.isotope) : null,
    charge,
    radicalCount,
    lonePairs: label.lonePairs,
    width: measureLabelWidth(main, fontSize),
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
  /** 左侧键上的官能团需掉转文字，使连接原子靠近键。 */
  flip: boolean;
  /** 真正与键相连的原子在屏幕上的位置（Na 等成盐金属以此为基准）。 */
  attach: Vec;
}

/**
 * 端基标签布局：键连到“连接原子”的字形边缘，而不是整段文字中心。
 * 这样 COOH 的键落在 C 上、OH 的键落在 O 上，左侧则自动写成 HOOC / HO。
 */
export function atomLabelLayoutForNeighbor(
  atom: AtomObject,
  neighbor: Vec | null
): AtomLabelLayout {
  if (!neighbor) {
    return {
      dx: 0,
      dy: 0,
      clearance: atomRadius(atom),
      terminal: false,
      flip: false,
      attach: { x: atom.position.x, y: atom.position.y }
    };
  }
  const flip = neighbor.x > atom.position.x + 1;
  const parts = atomParts(atom, false, flip);
  const baseText = atomMainText(atom.label);
  const attachWidth = measureLabelWidth(attachmentToken(baseText, flip), parts.fontSize);
  const attachHeight = parts.fontSize * 1.2;
  const dx = atom.position.x - neighbor.x;
  const dy = atom.position.y - neighbor.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) {
    return {
      dx: 0,
      dy: 0,
      clearance: ATOM_LABEL_GAP,
      terminal: true,
      flip,
      attach: { x: atom.position.x, y: atom.position.y }
    };
  }
  const ux = dx / length;
  const uy = dy / length;
  const halfExtent =
    Math.abs(ux) * (attachWidth / 2) + Math.abs(uy) * (attachHeight / 2);
  const targetDistance = halfExtent + ATOM_LABEL_GAP;
  const attach: Vec = {
    x: atom.position.x + ux * targetDistance,
    y: atom.position.y + uy * targetDistance
  };
  const attachOffsetX = flip
    ? parts.width / 2 - attachWidth / 2
    : attachWidth / 2 - parts.width / 2;
  const centerX = attach.x - attachOffsetX;
  return {
    dx: centerX - atom.position.x,
    dy: attach.y - atom.position.y,
    clearance: ATOM_LABEL_GAP,
    terminal: true,
    flip,
    attach
  };
}

/** 原子标签布局：只有一个键的端基标签按连接原子定位，其余标签居中。 */
export function atomLabelLayout(atom: AtomObject, bonds: BondObject[]): AtomLabelLayout {
  const touching = bonds.filter((bond) => {
    const atStart =
      Math.abs(bond.start.x - atom.position.x) < 2.5 &&
      Math.abs(bond.start.y - atom.position.y) < 2.5;
    const atEnd =
      Math.abs(bond.end.x - atom.position.x) < 2.5 &&
      Math.abs(bond.end.y - atom.position.y) < 2.5;
    return atStart || atEnd;
  });
  if (touching.length !== 1) {
    return {
      dx: 0,
      dy: 0,
      clearance: atomRadius(atom),
      terminal: false,
      flip: false,
      attach: { x: atom.position.x, y: atom.position.y }
    };
  }
  const bond = touching[0];
  const atStart =
    Math.abs(bond.start.x - atom.position.x) < 2.5 &&
    Math.abs(bond.start.y - atom.position.y) < 2.5;
  return atomLabelLayoutForNeighbor(atom, atStart ? bond.end : bond.start);
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
