import type {
  AtomObject,
  BondObject,
  BondType,
  GroupObject,
  SceneObject,
  VDrawDocument,
  Vec
} from '../../types/document';
import { distance, normalize, sub } from '../geometry';
import { allObjects, distanceToSegment, getLayerOfObject, getObject, getObjectBounds } from '../scene';
import { groupRingBonds, ringGeometry } from './ring-geometry';
import { ATOM_FONT_SIZE } from './labels';
import { maxValenceFor } from './valence';
import {
  bondingState,
  hybridizationFor,
  hybridizationLabel,
  idealBondAngle,
  maxNewBondOrder,
  maxUpgradeOrder,
  type Hybridization
} from './electronic';

/** 标准键长（文档单位，与页面 px 一致）。 */
export const STANDARD_BOND_LENGTH = 40;
const TOUCH_EPS = 1.4;
const DEG = Math.PI / 180;

/** 隐藏/锁定图层不参与吸附、成键与结构判断。 */
function interactiveObject(doc: VDrawDocument, obj: { id: string; visible: boolean }): boolean {
  if (!obj.visible) return false;
  const layer = getLayerOfObject(doc, obj.id);
  return Boolean(layer?.visible && !layer.locked);
}

/** 一个可以被延伸的原子/键端点，以及它的化合价与所属片段。 */
export interface BondAnchor {
  point: Vec;
  atom: AtomObject | null;
  bonds: BondObject[];
  group: GroupObject | null;
  /** σ 键数量（显式键 + 氢 + 孤对） */
  sigma: number;
  /** π 键数量 */
  pi: number;
  /** σ+π 价层占用 */
  used: number;
  /** 主价态上限 */
  capacity: number;
  /** 剩余可成键数 */
  free: number;
  /** 参与杂化的轨道数（σ 键 + 孤对） */
  orbitals: number;
  /** 杂化状态（由 σ/π 推导） */
  hybridization: Hybridization;
  /** 是否为芳香环上的碳 */
  aromatic: boolean;
  /** 是否属于任意环骨架（含环己烷等非芳香环） */
  onRing: boolean;
  element: string;
}

export interface ChainBondGeometry {
  start: Vec;
  end: Vec;
  /** 与 x 轴正方向的夹角（度） */
  angle: number;
  length: number;
}

/**
 * 锚点所在结构式的等比缩放：优先已缩放键/环编组，孤立原子才用字号推导。
 * baseFontSize 传入当前设置的元素大小，避免默认字号变化被误判为结构缩放。
 */
export function bondAnchorScale(
  anchor: BondAnchor,
  baseFontSize = ATOM_FONT_SIZE
): number {
  const values: number[] = [];
  if (anchor.group?.ringScale) values.push(anchor.group.ringScale);
  for (const bond of anchor.bonds) {
    if (typeof bond.scale === 'number' && bond.scale > 0) values.push(bond.scale);
  }
  if (values.length === 0 && anchor.atom?.label.fontSize) {
    values.push(anchor.atom.label.fontSize / Math.max(1, baseFontSize));
  }
  if (values.length === 0) return 1;
  return Math.min(8, Math.max(0.05, Math.max(...values)));
}

export function bondsTouching(doc: VDrawDocument, point: Vec, eps = TOUCH_EPS): BondObject[] {
  return allObjects(doc).filter(
    (obj): obj is BondObject =>
      obj.type === 'bond' &&
      interactiveObject(doc, obj) &&
      (distance(obj.start, point) <= eps || distance(obj.end, point) <= eps)
  );
}

/** 取键上远离 point 的另一端。 */
function farEndpoint(bond: BondObject, point: Vec): Vec {
  return distance(bond.start, point) <= distance(bond.end, point) ? bond.end : bond.start;
}

function toAtomAt(doc: VDrawDocument, point: Vec, eps = 0.9): AtomObject | null {
  for (const obj of allObjects(doc)) {
    if (obj.type === 'atom' && interactiveObject(doc, obj) && distance(obj.position, point) <= eps) return obj;
  }
  return null;
}

/**
 * 命中可延伸的起点：优先原子标签，其次任意键端点（隐含碳）。
 * 返回化合价信息，供“按规范延伸碳链”判断方向与是否饱和。
 */
export function findBondAnchor(doc: VDrawDocument, point: Vec, tolerance = 7): BondAnchor | null {
  let bestPoint: Vec | null = null;
  let bestDistance = tolerance;
  let bestAtom: AtomObject | null = null;

  // 两段式扫描：原子（P1）优先于键端点（P2）。
  // 过去两者共用一条 bestDistance 竞争，等价距离时命中结果取决于对象遍历顺序；
  // 这里先找原子，只有半径内没有原子才退化到端点，结果由化学语义而非顺序决定。
  const objects = allObjects(doc).filter((obj) => interactiveObject(doc, obj));
  for (const obj of objects) {
    if (obj.type !== 'atom') continue;
    const d = distance(obj.position, point);
    if (d <= bestDistance) {
      bestDistance = d;
      bestPoint = obj.position;
      bestAtom = obj;
    }
  }

  if (!bestPoint) {
    let endpointPoint: Vec | null = null;
    let endpointDistance = tolerance;
    for (const obj of objects) {
      if (obj.type !== 'bond') continue;
      for (const endpoint of [obj.start, obj.end]) {
        const d = distance(endpoint, point);
        if (d < endpointDistance) {
          endpointDistance = d;
          endpointPoint = endpoint;
        }
      }
    }
    bestPoint = endpointPoint;
    bestAtom = null;
  }

  if (!bestPoint) return null;

  const origin = bestPoint;
  const bonds = bondsTouching(doc, origin);
  const atom = bestAtom ?? toAtomAt(doc, origin);

  let group: GroupObject | null = null;
  for (const bond of bonds) {
    if (!bond.parentId) continue;
    const parent = getObject(doc, bond.parentId);
    if (parent && parent.type === 'group') {
      group = parent;
      break;
    }
  }

  // 判断“环内键”必须基于整个编组，只看命中点附近的键会漏掉环的其余边
  const allGroupBonds = group
    ? allObjects(doc).filter(
        (obj): obj is BondObject => obj.type === 'bond' && obj.parentId === group?.id
      )
    : [];
  const ringIds = new Set(groupRingBonds(allGroupBonds).map((bond) => bond.id));
  const groupBonds = bonds.filter((bond) => ringIds.has(bond.id) || bond.parentId === group?.id);
  const ringBonds = groupBonds.filter((bond) => ringIds.has(bond.id));
  const aromatic = Boolean(group?.ringStyle) && ringBonds.length >= 2;

  const element = atom?.label.element ?? 'C';
  const capacity = maxValenceFor(element, atom?.label.charge ?? 0) ?? 4;
  const hydrogens = atom?.label.hydrogens ?? 0;
  const lonePairs = atom?.label.lonePairs ?? 0;
  const state = bondingState(bonds, hydrogens, lonePairs, aromatic, ringIds);
  const hybridization = aromatic ? 'sp2' : hybridizationFor(state.orbitals, state.pi);

  return {
    point: origin,
    atom,
    bonds,
    group,
    sigma: state.sigma,
    pi: state.pi,
    used: state.used,
    capacity,
    free: Math.max(0, capacity - state.used),
    orbitals: state.orbitals,
    hybridization,
    aromatic,
    onRing: Boolean(group) && ringBonds.length >= 2,
    element
  };
}

/**
 * 在闭合芳香环内部点击时，把锚点吸附到最近的环顶点。
 * 避免在环内/内圈上直接画出一条悬空的键。
 */
export function nearestRingAnchor(doc: VDrawDocument, point: Vec): BondAnchor | null {
  let best: BondAnchor | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const objects = allObjects(doc);
  for (const obj of objects) {
    if (obj.type !== 'group' || (!obj.ringStyle && !obj.ringFrame)) continue;
    if (!interactiveObject(doc, obj)) continue;
    const geometry = ringGeometry(
      objects.filter((item): item is BondObject => item.type === 'bond' && item.parentId === obj.id)
    );
    if (!geometry || !geometry.closed) continue;
    if (
      Math.hypot(point.x - geometry.center.x, point.y - geometry.center.y) >
      geometry.vertexRadius * 0.98
    ) {
      continue;
    }
    for (const vertex of geometry.vertices) {
      const d = Math.hypot(point.x - vertex.x, point.y - vertex.y);
      if (d >= bestDistance) continue;
      const anchor = findBondAnchor(doc, vertex, 2);
      if (!anchor) continue;
      bestDistance = d;
      best = anchor;
    }
  }
  return best;
}

/** 键型的键级（用于化合价校验）。 */
export function bondOrderForType(type: BondType): number {
  if (type === 'double') return 2;
  if (type === 'triple') return 3;
  if (type === 'aromatic') return 1.5;
  return 1;
}

/**
 * 同一编组内真正构成环的键：两端都至少还连着另一条同组键。
 * 用于把环外取代基排除在“环内键”之外。
 */
function uniqueDirections(bonds: BondObject[], origin: Vec): Vec[] {
  const dirs: Vec[] = [];
  for (const bond of bonds) {
    const dir = normalize(sub(farEndpoint(bond, origin), origin));
    if (dir.x === 0 && dir.y === 0) continue;
    const duplicate = dirs.some((existing) => existing.x * dir.x + existing.y * dir.y > 0.995);
    if (!duplicate) dirs.push(dir);
  }
  return dirs;
}

function rotate(vec: Vec, radians: number): Vec {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: vec.x * cos - vec.y * sin, y: vec.x * sin + vec.y * cos };
}

function cross(a: Vec, b: Vec): number {
  return a.x * b.y - a.y * b.x;
}

/** 已有多个取代基时，新键落入最大的空闲夹角（苯环碳即环外侧径向）。 */
function largestGapDirection(dirs: Vec[]): Vec {
  const angles = dirs.map((dir) => Math.atan2(dir.y, dir.x)).sort((a, b) => a - b);
  let bestGap = -1;
  let bestAngle = 0;
  for (let index = 0; index < angles.length; index += 1) {
    const current = angles[index];
    const next = index + 1 < angles.length ? angles[index + 1] : angles[0] + Math.PI * 2;
    const gap = next - current;
    if (gap > bestGap) {
      bestGap = gap;
      bestAngle = current + gap / 2;
    }
  }
  return { x: Math.cos(bestAngle), y: Math.sin(bestAngle) };
}

/**
 * 有多个已有键时，优先选择“指针所在扇区”的空闲夹角；
 * 只有指针方向退化时才回退到最大夹角，避免分支方向完全由算法决定。
 */
function preferredGapDirection(dirs: Vec[], preferred: Vec): Vec {
  const angles = dirs.map((dir) => Math.atan2(dir.y, dir.x)).sort((a, b) => a - b);
  const preferredAngle = Math.atan2(preferred.y, preferred.x);
  let bestScore = -Infinity;
  let bestAngle: number | null = null;
  for (let index = 0; index < angles.length; index += 1) {
    const current = angles[index];
    const next = index + 1 < angles.length ? angles[index + 1] : angles[0] + Math.PI * 2;
    const gap = next - current;
    // 小于 90° 的缝隙通常是环内空间，不能因为指针在环内就生成穿环键。
    if (gap < Math.PI / 2) continue;
    const candidate = current + gap / 2;
    // 夹角中心与指针方向的余弦相似度；同时轻微偏好更大的空隙。
    const score = Math.cos(candidate - preferredAngle) + gap * 0.05;
    if (score > bestScore) {
      bestScore = score;
      bestAngle = candidate;
    }
  }
  if (bestAngle === null) return largestGapDirection(dirs);
  return { x: Math.cos(bestAngle), y: Math.sin(bestAngle) };
}

/**
 * 从一个末端原子继续延伸时选择 120° 的两侧之一：
 * 优先用户拖拽方向 → 与上一段交替的锯齿方向 → 默认向上。
 */
function pickChainDirection(
  doc: VDrawDocument,
  anchor: BondAnchor,
  back: Vec,
  preferred: Vec | null,
  angleDeg: number
): Vec {
  const candidates = [rotate(back, angleDeg * DEG), rotate(back, -angleDeg * DEG)];

  if (preferred) {
    const preferredDir = normalize(preferred);
    return candidates.reduce((best, candidate) =>
      candidate.x * preferredDir.x + candidate.y * preferredDir.y >
      best.x * preferredDir.x + best.y * preferredDir.y
        ? candidate
        : best
    );
  }

  const neighborBond = anchor.bonds[0];
  if (neighborBond) {
    const neighbor = farEndpoint(neighborBond, anchor.point);
    const previous = bondsTouching(doc, neighbor).filter((bond) => bond.id !== neighborBond.id);
    if (previous.length === 1) {
      const grand = farEndpoint(previous[0], neighbor);
      const incoming = normalize(sub(neighbor, grand));
      const toOrigin = normalize(sub(anchor.point, neighbor));
      const previousTurn = cross(incoming, toOrigin);
      if (Math.abs(previousTurn) > 0.08) {
        return candidates.reduce((best, candidate) =>
          Math.abs(cross(toOrigin, candidate) + previousTurn) <
          Math.abs(cross(toOrigin, best) + previousTurn)
            ? candidate
            : best
        );
      }
    }
  }

  // 没有上一段参考时，优先朝上，其次朝右
  return candidates.reduce((best, candidate) => {
    if (Math.abs(candidate.y - best.y) > 0.01) return candidate.y < best.y ? candidate : best;
    return candidate.x > best.x ? candidate : best;
  });
}

/**
 * 计算“点击延伸”应当落下的新键：标准键长 + 规范键角。
 * 返回 null 表示该原子已无剩余化合价。
 */
export function nextChainBond(
  doc: VDrawDocument,
  anchor: BondAnchor,
  preferred: Vec | null = null,
  bondOrder = 1,
  /** 目标键长：由「设置 → 化学 → 默认键长」传入，缺省用标准键长。 */
  length = STANDARD_BOND_LENGTH
): ChainBondGeometry | null {
  if (anchor.free <= 0) return null;
  const dirs = uniqueDirections(anchor.bonds, anchor.point);
  // 新键会新增 1 个 σ 轨道和 (bondOrder-1) 个 π，由此得到成键后的杂化与理想键角
  const resulting = hybridizationFor(
    anchor.orbitals + 1,
    anchor.pi + Math.max(0, bondOrder - 1)
  );
  const angleDeg = idealBondAngle(resulting);

  let direction: Vec;
  const preferredLength = preferred ? Math.hypot(preferred.x, preferred.y) : 0;
  const hasPreferred = preferredLength > 2;
  if (dirs.length === 0) {
    direction = hasPreferred ? normalize(preferred!) : { x: 1, y: 0 };
  } else if (dirs.length === 1) {
    direction = pickChainDirection(doc, anchor, dirs[0], hasPreferred ? preferred : null, angleDeg);
  } else {
    direction = hasPreferred ? preferredGapDirection(dirs, preferred!) : largestGapDirection(dirs);
  }

  const end = {
    x: anchor.point.x + direction.x * length,
    y: anchor.point.y + direction.y * length
  };
  return {
    start: anchor.point,
    end,
    angle: Math.atan2(direction.y, direction.x) / DEG,
    length
  };
}

export function bondExistsBetween(
  doc: VDrawDocument,
  a: Vec,
  b: Vec,
  tolerance = 2
): boolean {
  return allObjects(doc).some(
    (obj) =>
      obj.type === 'bond' &&
      ((distance(obj.start, a) <= tolerance && distance(obj.end, b) <= tolerance) ||
        (distance(obj.start, b) <= tolerance && distance(obj.end, a) <= tolerance))
  );
}

/** 命中键身（排除两端，避免和“从原子延伸”冲突）。 */
export function findBondAt(
  doc: VDrawDocument,
  point: Vec,
  tolerance = 6,
  endpointGap = 9
): BondObject | null {
  let best: BondObject | null = null;
  let bestDistance = tolerance;
  for (const obj of allObjects(doc)) {
    if (obj.type !== 'bond' || !interactiveObject(doc, obj)) continue;
    if (distance(point, obj.start) <= endpointGap || distance(point, obj.end) <= endpointGap) continue;
    const d = distanceToSegment(point, obj.start, obj.end);
    if (d < bestDistance) {
      bestDistance = d;
      best = obj;
    }
  }
  return best;
}

/** 点击已有键时循环键级：单 → 双 → 三 → 单。 */
export function nextBondOrderType(type: BondType): BondType {
  if (type === 'single') return 'double';
  if (type === 'double') return 'triple';
  return 'single';
}

/**
 * 橡皮擦降键：三 → 双 → 单。
 * 返回 null 表示该键已无可降的键级，橡皮应直接擦除整个键。
 */
export function prevBondOrderType(type: BondType): BondType | null {
  if (type === 'triple') return 'double';
  if (type === 'double') return 'single';
  return null;
}

/** 新增键时可用的最高键级，完全由价层 σ/π 容量推导。 */
export function maxNewBondOrderForAnchor(anchor: BondAnchor): number {
  return maxNewBondOrder(anchor.capacity, {
    sigma: anchor.sigma,
    pi: anchor.pi
  });
}

/**
 * 键级升级校验：芳香环内部键级是“共振式表达”由环样式统一控制；
 * 其余键一律由两端原子的价层 σ/π 容量与杂化状态推导。
 */
export function validateBondUpgrade(
  doc: VDrawDocument,
  bond: BondObject,
  nextType: BondType
): { ok: boolean; reason?: string } {
  const nextOrder = bondOrderForType(nextType);
  if (nextOrder <= 1) return { ok: true };

  const parent = bond.parentId ? getObject(doc, bond.parentId) : null;
  if (parent && parent.type === 'group' && parent.ringStyle) {
    const groupBonds = allObjects(doc).filter(
      (obj): obj is BondObject => obj.type === 'bond' && obj.parentId === parent.id
    );
    const internal = ringGeometry(groupBonds)?.ringBonds.some((item) => item.id === bond.id) ?? false;
    if (internal) {
      return { ok: false, reason: '芳香环内部键级由共振式（环样式）统一表达' };
    }
  }

  const start = findBondAnchor(doc, bond.start, 3);
  const end = findBondAnchor(doc, bond.end, 3);
  const currentOrder = bondOrderForType(bond.bondType);
  const limits: { anchor: BondAnchor; max: number }[] = [];
  if (start) {
    limits.push({
      anchor: start,
      max: maxUpgradeOrder(start.capacity, { sigma: start.sigma, pi: start.pi }, currentOrder)
    });
  }
  if (end) {
    limits.push({
      anchor: end,
      max: maxUpgradeOrder(end.capacity, { sigma: end.sigma, pi: end.pi }, currentOrder)
    });
  }
  const limiting = limits.reduce<{ anchor: BondAnchor; max: number } | null>(
    (best, item) => (!best || item.max < best.max ? item : best),
    null
  );
  if (limiting && nextOrder > limiting.max) {
    return {
      ok: false,
      reason:
        `${limiting.anchor.element} 原子 σ=${limiting.anchor.sigma}、π=${Number(
          limiting.anchor.pi.toFixed(1)
        )}，` +
        `${hybridizationLabel(limiting.anchor.hybridization)} 杂化最多容纳 ${limiting.max} 重键`
    };
  }
  return { ok: true };
}

/**
 * 把新对象并入片段编组：
 * 这样移动/旋转苯环时，新长出的取代基会一起变换，而不是留在原地。
 */
export function attachObjectsToGroup(
  doc: VDrawDocument,
  groupId: string,
  objects: SceneObject[]
): VDrawDocument | null {
  const group = getObject(doc, groupId);
  if (!group || group.type !== 'group' || objects.length === 0) return null;
  const layerIndex = doc.layers.findIndex((layer) => layer.id === group.layerId);
  if (layerIndex < 0) return null;

  const children = objects.map((obj) => ({ ...obj, parentId: groupId })) as SceneObject[];
  const padding = 16;
  let left = group.x;
  let top = group.y;
  let right = group.x + group.width;
  let bottom = group.y + group.height;
  for (const child of children) {
    const bounds = getObjectBounds(child, doc);
    left = Math.min(left, bounds.x - padding);
    top = Math.min(top, bounds.y - padding);
    right = Math.max(right, bounds.x + bounds.width + padding);
    bottom = Math.max(bottom, bounds.y + bounds.height + padding);
  }

  return {
    ...doc,
    layers: doc.layers.map((layer, index) => {
      if (index !== layerIndex) return layer;
      const next: SceneObject[] = layer.objects.map((obj) => {
        if (obj.type !== 'group' || obj.id !== groupId) return obj;
        return {
          ...obj,
          childIds: [...obj.childIds, ...children.map((child) => child.id)],
          x: left,
          y: top,
          width: right - left,
          height: bottom - top
        };
      });
      return { ...layer, objects: [...next, ...children] };
    })
  };
}

/** 把新键并入起点所在的片段编组。 */
export function attachBondToGroup(
  doc: VDrawDocument,
  groupId: string,
  bond: BondObject
): VDrawDocument | null {
  return attachObjectsToGroup(doc, groupId, [bond]);
}
