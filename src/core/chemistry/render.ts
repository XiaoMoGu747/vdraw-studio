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
 * 化学键几何：原子标签半径交给 buildBondGeometry 逐条平行线避让，
 * 这样双键/三键的每条线都能停在元素符号边缘，不会越界或错位。
 */
export function chemBondShape(doc: VDrawDocument, bond: BondObject): ChemBondShape {
  const total = Math.hypot(bond.end.x - bond.start.x, bond.end.y - bond.start.y);
  if (total < 0.5) {
    return {
      start: bond.start,
      end: bond.end,
      geometry: buildBondGeometry(bond.bondType, bond.start, bond.end, {
        spacing: Math.max(0.6, (bond.spacing ?? 4.2) * (bond.scale ?? 1)),
        aromaticSide: bond.aromaticSide ?? 1,
        innerSide: bond.ringInnerSide
      })
    };
  }

  const startAtom = findAtomAt(doc, bond.start, 2.5);
  const endAtom = findAtomAt(doc, bond.end, 2.5);
  let startClearance = startAtom ? atomRadius(startAtom) : 0;
  let endClearance = endAtom ? atomRadius(endAtom) : 0;
  // 键本身比两个标签还短时退回不裁切，避免整根键被“吃”掉。
  if (total - startClearance - endClearance < 3) {
    startClearance = 0;
    endClearance = 0;
  }

  const direction = normalize(sub(bond.end, bond.start));
  const start = {
    x: bond.start.x + direction.x * startClearance,
    y: bond.start.y + direction.y * startClearance
  };
  const end = {
    x: bond.end.x - direction.x * endClearance,
    y: bond.end.y - direction.y * endClearance
  };

  return {
    start,
    end,
    geometry: buildBondGeometry(bond.bondType, bond.start, bond.end, {
      // 先取创建时的基础间距，再随键的缩放倍率同步变化。
      spacing: Math.max(0.6, (bond.spacing ?? 4.2) * (bond.scale ?? 1)),
      aromaticSide: bond.aromaticSide ?? 1,
      innerSide: bond.ringInnerSide,
      startClearance,
      endClearance
    })
  };
}

export function bondSegments(doc: VDrawDocument, bond: BondObject) {
  return chemBondShape(doc, bond).geometry;
}
