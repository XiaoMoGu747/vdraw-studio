import type { BondObject, VDrawDocument, Vec } from '../../types/document';
import { findAtomAt } from '../scene';
import { normalize, sub } from '../geometry';
import { atomRadius } from './labels';
import { buildBondGeometry, type BondGeometry } from './bonds';

export interface ChemBondShape {
  start: Vec;
  end: Vec;
  geometry: BondGeometry;
}

/**
 * 将键的两端在带有原子标签的位置处截短，避免线条穿过元素符号。
 */
export function chemBondShape(doc: VDrawDocument, bond: BondObject): ChemBondShape {
  const startAtom = findAtomAt(doc, bond.start, 2.5);
  const endAtom = findAtomAt(doc, bond.end, 2.5);
  const startRadius = startAtom ? atomRadius(startAtom) : 0;
  const endRadius = endAtom ? atomRadius(endAtom) : 0;

  const direction = normalize(sub(bond.end, bond.start));
  let start = { x: bond.start.x + direction.x * startRadius, y: bond.start.y + direction.y * startRadius };
  let end = { x: bond.end.x - direction.x * endRadius, y: bond.end.y - direction.y * endRadius };
  if (Math.hypot(end.x - start.x, end.y - start.y) < 3) {
    start = bond.start;
    end = bond.end;
  }

  return {
    start,
    end,
    geometry: buildBondGeometry(bond.bondType, start, end, {
      // 先取创建时的基础间距，再随键的缩放倍率同步变化。
      spacing: Math.max(0.6, (bond.spacing ?? 4.2) * (bond.scale ?? 1)),
      aromaticSide: bond.aromaticSide ?? 1,
      innerSide: bond.ringInnerSide
    })
  };
}

export function bondSegments(doc: VDrawDocument, bond: BondObject) {
  return chemBondShape(doc, bond).geometry;
}
