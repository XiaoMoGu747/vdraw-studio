import type { AtomLabelData, AtomObject, Vec } from '../../types/document';
import { supDisplayOf } from './sup-library';

export const ATOM_FONT_SIZE = 16;

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
  // 只有 supId 没有 group 文本时（例如从旧文件迁移），用 SUP 库的折叠显示名兜底。
  if (label.supId) {
    const supText = supDisplayOf(label.supId);
    if (supText) return supText;
  }
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

export function estimateAtomHitRadius(atom: AtomObject): number {
  return atomParts(atom).width / 2 + 9;
}

export function pointNearAtom(atom: AtomObject, point: Vec, tolerance = 2): boolean {
  return Math.hypot(atom.position.x - point.x, atom.position.y - point.y) <= tolerance;
}
