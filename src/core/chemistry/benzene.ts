import type { BondObject, BondType, GroupObject, Style, VDrawDocument, Vec } from '../../types/document';
import { allObjects, getObject, getObjectBounds } from '../scene';
import { groupRingBonds as ringBondsFrom, ringGeometry as ringGeometryFrom } from './ring-geometry';

export type BenzeneStyle = 'pauling' | 'kekule';

export const CHEM_GROUP_STYLE: Style = {
  fill: { type: 'none' },
  stroke: {
    paint: { type: 'solid', color: '#1b1b1b' },
    width: 2.2,
    cap: 'round',
    join: 'round',
    dash: []
  },
  opacity: 1
};

/** 凯库勒式六元环的双键/单键顺序；鲍林式全部为单键，用内圆圈表达芳香性。 */
export function benzeneBondTypes(style: BenzeneStyle): BondType[] {
  return style === 'pauling'
    ? ['single', 'single', 'single', 'single', 'single', 'single']
    : ['double', 'single', 'double', 'single', 'double', 'single'];
}

/**
 * 判断环内双键的第二条线应落在哪一侧：法向量与「中点指向环心」同向即为 1。
 * 凯库勒式苯环据此让三条内线均分在六元环内侧。
 */
export function ringInnerSide(start: Vec, end: Vec, center: Vec): 1 | -1 {
  const normal = { x: -(end.y - start.y), y: end.x - start.x };
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dot = normal.x * (center.x - midpoint.x) + normal.y * (center.y - midpoint.y);
  return dot >= 0 ? 1 : -1;
}

export type { RingGeometry } from './ring-geometry';

function groupBondList(doc: VDrawDocument, groupId: string): BondObject[] {
  return allObjects(doc).filter(
    (obj): obj is BondObject => obj.type === 'bond' && obj.parentId === groupId
  );
}

/** 编组内真正构成环的键（环外取代基会被排除）。 */
export function groupRingBonds(doc: VDrawDocument, groupId: string): BondObject[] {
  return ringBondsFrom(groupBondList(doc, groupId));
}

/**
 * 环内键的朝心侧别；非 ringFrame 编组返回 null。
 * 键级切换生成双键/芳香键时用它保持“环内线”画法，而不是按单独键对称绘制。
 */
export function ringBondInnerSide(doc: VDrawDocument, bond: BondObject): 1 | -1 | null {
  if (!bond.parentId) return null;
  const parent = getObject(doc, bond.parentId);
  if (!parent || parent.type !== 'group' || !parent.ringFrame) return null;
  const geometry = ringGeometryFrom(groupBondList(doc, parent.id));
  const center = geometry?.center ?? {
    x: parent.x + parent.width / 2,
    y: parent.y + parent.height / 2
  };
  return ringInnerSide(bond.start, bond.end, center);
}

/**
 * 由环内键本身推导苯环几何，供渲染、命中与导出共用。
 * 内圈圆使用骨架顶点而不是编组包围盒，挂上取代基后不会错位。
 */
export function benzeneGeometry(
  doc: VDrawDocument,
  group: GroupObject
): import('./ring-geometry').RingGeometry | null {
  return ringGeometryFrom(groupBondList(doc, group.id));
}

export function isBenzeneGroup(obj: unknown): obj is GroupObject {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as GroupObject).type === 'group' &&
    ((obj as GroupObject).ringStyle === 'pauling' || (obj as GroupObject).ringStyle === 'kekule')
  );
}

/**
 * 切换已有苯环的式样：重排六个键的键级，并更新编组标记。
 * 键按围绕环心的角度排序，保证交替双键在视觉上间隔分布。
 */
export function applyBenzeneStyle(
  doc: VDrawDocument,
  groupId: string,
  style: BenzeneStyle
): VDrawDocument {
  const group = getObject(doc, groupId);
  if (!group || !isBenzeneGroup(group)) return doc;
  const groupBonds = allObjects(doc).filter(
    (obj): obj is BondObject => obj.type === 'bond' && obj.parentId === groupId
  );
  if (groupBonds.length === 0) return doc;

  // 只对成环的键重排键级：环外取代基（每条顶点只连一条环内键）保持原键级
  const geometry = benzeneGeometry(doc, group);
  const ringBonds = geometry?.ringBonds ?? groupRingBonds(doc, groupId);
  // 只重排环内键；环外取代基保持原键级（即使环已被擦断）
  const bonds = ringBonds.length >= 3 ? ringBonds : groupBonds;

  const bounds = getObjectBounds(group, doc);
  const cx = geometry ? geometry.center.x : bounds.x + bounds.width / 2;
  const cy = geometry ? geometry.center.y : bounds.y + bounds.height / 2;
  const sorted = [...bonds].sort((a, b) => {
    const angleA = Math.atan2((a.start.y + a.end.y) / 2 - cy, (a.start.x + a.end.x) / 2 - cx);
    const angleB = Math.atan2((b.start.y + b.end.y) / 2 - cy, (b.start.x + b.end.x) / 2 - cx);
    return angleA - angleB;
  });
  const order = new Map(sorted.map((bond, index) => [bond.id, index]));
  const types = benzeneBondTypes(style);

  return {
    ...doc,
    layers: doc.layers.map((layer) => ({
      ...layer,
      objects: layer.objects.map((obj) => {
        if (obj.type === 'group' && obj.id === groupId) {
          return { ...obj, ringStyle: style };
        }
        if (obj.type === 'bond' && obj.parentId === groupId) {
          const index = order.get(obj.id);
          if (index === undefined) return obj;
          const bondType = types[index % types.length];
          return {
            ...obj,
            bondType,
            aromaticSide: undefined,
            ringInnerSide:
              style === 'kekule' && bondType === 'double'
                ? ringInnerSide(obj.start, obj.end, { x: cx, y: cy })
                : undefined
          };
        }
        return obj;
      })
    }))
  };
}
