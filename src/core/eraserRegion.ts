import type {
  EllipseObject,
  EraseStroke,
  LineObject,
  PathObject,
  PolygonObject,
  RectObject,
  SceneObject,
  Vec,
  VDrawDocument
} from '../types/document';
import { flattenNodes } from './brush';
import { pathHitsVisibleFill } from './eraseMask';
import { createPathObject, makeNode } from './factory';
import { allObjects, getObjectBounds } from './scene';

/**
 * 橡皮擦的区域擦除（线条/描边 与 填充各自独立）：
 *
 * - 线条/描边：沿笔刷轨迹切断画笔、钢笔、直线与形状轮廓，只留下经过处的缺口；
 * - 填充：只把笔刷轨迹写入 mask，描边与其余填充保持原样。
 *
 * 两种操作互不越权：填充只改 eraseStrokes（mask），线条/描边只改轮廓片段。
 */

export interface RegionEraseTargets {
  outline: boolean;
  fill: boolean;
}

export interface RegionEraseOptions {
  radius: number;
  targets: RegionEraseTargets;
  layerId?: string | null;
}

interface Outline {
  nodes: Vec[];
  widths: number[];
  closed: boolean;
}

const EPSILON = 1e-9;

export function isOpenLineObject(object: SceneObject): boolean {
  return object.type === 'line' || (object.type === 'path' && !object.closed);
}

export function isClosedShapeObject(object: SceneObject): boolean {
  return (
    object.type === 'rect' ||
    object.type === 'ellipse' ||
    object.type === 'polygon' ||
    (object.type === 'path' && object.closed)
  );
}

export function hasSolidFill(object: SceneObject): boolean {
  return isClosedShapeObject(object) && object.style.fill.type === 'solid';
}

export function hasSolidStroke(object: SceneObject): boolean {
  return (
    (isOpenLineObject(object) || isClosedShapeObject(object)) &&
    object.style.stroke.paint.type === 'solid' &&
    object.style.stroke.width > 0
  );
}

/** 空编组、断环标记与编组包围盒的收尾（与整对象删除共用）。 */

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointSegmentDistance(point: Vec, start: Vec, end: Vec): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < EPSILON) return dist(point, start);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq)
  );
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function orientation(a: Vec, b: Vec, c: Vec): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Vec, b: Vec, point: Vec): boolean {
  return (
    Math.abs(orientation(a, b, point)) < 1e-7 &&
    point.x >= Math.min(a.x, b.x) - 1e-7 &&
    point.x <= Math.max(a.x, b.x) + 1e-7 &&
    point.y >= Math.min(a.y, b.y) - 1e-7 &&
    point.y <= Math.max(a.y, b.y) + 1e-7
  );
}

function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (Math.abs(o1) < 1e-7 && onSegment(a, b, c)) return true;
  if (Math.abs(o2) < 1e-7 && onSegment(a, b, d)) return true;
  if (Math.abs(o3) < 1e-7 && onSegment(c, d, a)) return true;
  if (Math.abs(o4) < 1e-7 && onSegment(c, d, b)) return true;
  return false;
}

function segmentSegmentDistance(a: Vec, b: Vec, c: Vec, d: Vec): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b)
  );
}

function rotateAround(point: Vec, center: Vec, degrees: number): Vec {
  if (!degrees) return point;
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

function rectOutline(object: RectObject): Vec[] {
  const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  const radius = Math.max(0, Math.min(object.cornerRadius ?? 0, object.width / 2, object.height / 2));
  const local: Vec[] = [];
  if (radius > 0.5) {
    const arc = (cx: number, cy: number, from: number, to: number) => {
      const steps = Math.max(2, Math.ceil((Math.abs(to - from) * radius) / 2));
      for (let index = 1; index <= steps; index += 1) {
        const theta = from + ((to - from) * index) / steps;
        local.push({ x: cx + Math.cos(theta) * radius, y: cy + Math.sin(theta) * radius });
      }
    };
    local.push({ x: object.x + radius, y: object.y });
    local.push({ x: object.x + object.width - radius, y: object.y });
    arc(object.x + object.width - radius, object.y + radius, -Math.PI / 2, 0);
    local.push({ x: object.x + object.width, y: object.y + object.height - radius });
    arc(object.x + object.width - radius, object.y + object.height - radius, 0, Math.PI / 2);
    local.push({ x: object.x + radius, y: object.y + object.height });
    arc(object.x + radius, object.y + object.height - radius, Math.PI / 2, Math.PI);
    local.push({ x: object.x, y: object.y + radius });
    arc(object.x + radius, object.y + radius, Math.PI, (Math.PI * 3) / 2);
  } else {
    local.push(
      { x: object.x, y: object.y },
      { x: object.x + object.width, y: object.y },
      { x: object.x + object.width, y: object.y + object.height },
      { x: object.x, y: object.y + object.height }
    );
  }
  return local.map((point) => rotateAround(point, center, object.rotation ?? 0));
}

function ellipseOutline(object: EllipseObject): Vec[] {
  const rx = object.width / 2;
  const ry = object.height / 2;
  const center = { x: object.x + rx, y: object.y + ry };
  const points: Vec[] = [];
  for (let index = 0; index < 64; index += 1) {
    const angle = (index / 64) * Math.PI * 2;
    points.push(
      rotateAround(
        { x: center.x + Math.cos(angle) * rx, y: center.y + Math.sin(angle) * ry },
        center,
        object.rotation ?? 0
      )
    );
  }
  return points;
}

function outlineOf(object: SceneObject): Outline | null {
  const strokeWidth = Math.max(0.5, object.style.stroke.width || 2);
  switch (object.type) {
    case 'line': {
      const line = object as LineObject;
      return {
        nodes: [line.start, line.end],
        widths: [strokeWidth, strokeWidth],
        closed: false
      };
    }
    case 'rect': {
      const points = rectOutline(object as RectObject);
      return {
        nodes: points,
        widths: points.map(() => strokeWidth),
        closed: true
      };
    }
    case 'ellipse': {
      const points = ellipseOutline(object as EllipseObject);
      return {
        nodes: points,
        widths: points.map(() => strokeWidth),
        closed: true
      };
    }
    case 'polygon': {
      const polygon = object as PolygonObject;
      return {
        nodes: polygon.points,
        widths: polygon.points.map(() => strokeWidth),
        closed: true
      };
    }
    case 'path': {
      const path = object as PathObject;
      const flattened = flattenNodes(path.nodes, path.closed, 0.75, strokeWidth, true);
      return {
        nodes: flattened.map((point) => ({ x: point.x, y: point.y })),
        widths: flattened.map((point) => point.width || strokeWidth),
        closed: path.closed
      };
    }
    default:
      return null;
  }
}

/**
 * 精确接触判定：橡皮轨迹与轮廓中心线的最近距离 ≤ 半径 + 墨迹半宽。
 *
 * 不采样、不切几何：只决定要不要写 mask。切线/极短接触也不会漏判，
 * 而且不会出现“碰到上沿就把整条 20px 横截面切掉”的中心线切割问题。
 */
function strokeTouchesInk(
  outline: Outline,
  from: Vec,
  to: Vec,
  radius: number
): boolean {
  const nodes = outline.nodes;
  if (nodes.length < 2) return false;
  const points = outline.closed ? [...nodes, nodes[0]] : nodes;
  const widths = outline.closed ? [...outline.widths, outline.widths[0]] : outline.widths;
  for (let index = 0; index < points.length - 1; index += 1) {
    const half = Math.max(widths[index] ?? 2, widths[index + 1] ?? 2) / 2;
    if (segmentSegmentDistance(points[index], points[index + 1], from, to) <= radius + half) {
      return true;
    }
  }
  return false;
}

function convertShapeToPath(
  object: SceneObject,
  outline: Outline,
  holes: Vec[][],
  eraseStrokes: EraseStroke[] = []
): PathObject {
  const path = createPathObject(
    object.layerId,
    object.style,
    outline.nodes.map((point) => makeNode(point.x, point.y)),
    true
  );
  return {
    ...path,
    id: object.id,
    name: object.name,
    parentId: object.parentId,
    visible: object.visible,
    locked: object.locked,
    rotation: 0,
    clipIds: object.clipIds,
    mirrorOf: object.mirrorOf,
    mirrorKind: object.mirrorKind,
    holes,
    eraseStrokes: eraseStrokes.length > 0 ? eraseStrokes : undefined
  };
}

function makeEraseStroke(from: Vec, to: Vec, radius: number): EraseStroke {
  const points =
    Math.hypot(to.x - from.x, to.y - from.y) < 0.01
      ? [{ x: from.x, y: from.y }]
      : [
          { x: from.x, y: from.y },
          { x: to.x, y: to.y }
        ];
  return { points, radius };
}

/** 连续 pointermove 合并成一条轨迹；mask 用粗描边渲染，重叠天然合并。 */
function appendEraseStroke(existing: EraseStroke[], next: EraseStroke): EraseStroke[] {
  const last = existing[existing.length - 1];
  if (last && Math.abs(last.radius - next.radius) < 0.01 && next.points.length > 0) {
    const lastPoint = last.points[last.points.length - 1];
    const firstPoint = next.points[0];
    if (Math.hypot(lastPoint.x - firstPoint.x, lastPoint.y - firstPoint.y) < 0.01) {
      const points = [...last.points];
      for (const point of next.points.slice(1)) {
        const previous = points[points.length - 1];
        if (Math.hypot(previous.x - point.x, previous.y - point.y) > 0.01) {
          points.push({ x: point.x, y: point.y });
        }
      }
      if (points.length === last.points.length) return existing;
      return [...existing.slice(0, -1), { ...last, points }];
    }
  }
  return [...existing, next];
}

/** 可见填充命中：外轮廓内且不在任何已擦区域；用于悬停与擦除入口。 */
export function fillObjectHit(object: SceneObject, path: Vec[], radius: number): boolean {
  if (!hasSolidFill(object) || !isClosedShapeObject(object)) return false;
  const outline = outlineOf(object);
  if (!outline || !outline.closed || outline.nodes.length < 3) return false;
  const holes = object.type === 'path' ? object.holes ?? [] : [];
  const strokes = object.type === 'path' ? object.eraseStrokes ?? [] : [];
  return pathHitsVisibleFill(outline.nodes, holes, strokes, path, radius);
}

/**
 * 线条/描边目标：只写一条 2D mask 轨迹。
 *
 * 不再切中心线：中心线切割会把整条 stroke 的横截面一起删掉
 * （20px 线碰到上沿时下沿也消失）。mask 只把橡皮圆覆盖到的墨迹变透明，
 * 因此接触上沿只出现上沿缺口，下沿保持。
 */
function addStrokeErase(
  object: SceneObject,
  from: Vec,
  to: Vec,
  radius: number
): SceneObject | null {
  if (!hasSolidStroke(object)) return null;
  if (!isOpenLineObject(object) && !isClosedShapeObject(object)) return null;
  const outline = outlineOf(object);
  if (!outline) return null;
  // 与命中判定共用同一套“半径 + 墨迹半宽”接触判定；没碰到就不写 mask。
  if (!strokeTouchesInk(outline, from, to, radius)) return null;
  const merged = appendEraseStroke(
    object.strokeEraseStrokes ?? [],
    makeEraseStroke(from, to, radius)
  );
  return { ...object, strokeEraseStrokes: merged };
}

/** 填充目标：只写擦除轨迹，描边与其余填充保持原样。 */
function addFillErase(
  object: SceneObject,
  from: Vec,
  to: Vec,
  radius: number
): SceneObject | null {
  if (!hasSolidFill(object) || !isClosedShapeObject(object)) return null;
  const outline = outlineOf(object);
  if (!outline || !outline.closed || outline.nodes.length < 3) return null;
  const holes = object.type === 'path' ? object.holes ?? [] : [];
  const strokes = object.type === 'path' ? object.eraseStrokes ?? [] : [];
  const gesture =
    Math.hypot(to.x - from.x, to.y - from.y) < 0.01 ? [from] : [from, to];
  if (!pathHitsVisibleFill(outline.nodes, holes, strokes, gesture, radius)) return null;
  const merged = appendEraseStroke(strokes, makeEraseStroke(from, to, radius));
  if (object.type === 'path') {
    return { ...object, eraseStrokes: merged };
  }
  return convertShapeToPath(object, outline, holes, merged);
}

function actionsFor(
  object: SceneObject,
  targets: RegionEraseTargets
): { fill: boolean; outline: boolean } | null {
  if (isOpenLineObject(object)) {
    return targets.outline && hasSolidStroke(object)
      ? { fill: false, outline: true }
      : null;
  }
  if (isClosedShapeObject(object)) {
    const fill = targets.fill && hasSolidFill(object);
    const outline = targets.outline && hasSolidStroke(object);
    return fill || outline ? { fill, outline } : null;
  }
  return null;
}

/** 父编组隐藏/锁定时，子对象也不可被擦除。 */
function isEditableInDoc(object: SceneObject, byId: Map<string, SceneObject>): boolean {
  let current: SceneObject | undefined = object;
  const seen = new Set<string>();
  while (current) {
    if (!current.visible || current.locked) return false;
    if (seen.has(current.id)) break;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return true;
}

function boundsOverlapCapsule(
  bounds: { x: number; y: number; width: number; height: number },
  from: Vec,
  to: Vec,
  radius: number,
  margin: number
): boolean {
  const minX = Math.min(from.x, to.x) - radius - margin;
  const maxX = Math.max(from.x, to.x) + radius + margin;
  const minY = Math.min(from.y, to.y) - radius - margin;
  const maxY = Math.max(from.y, to.y) + radius + margin;
  return (
    bounds.x <= maxX &&
    bounds.x + bounds.width >= minX &&
    bounds.y <= maxY &&
    bounds.y + bounds.height >= minY
  );
}

function applySegment(
  doc: VDrawDocument,
  from: Vec,
  to: Vec,
  options: RegionEraseOptions
): VDrawDocument {
  const radius = Math.max(0.5, options.radius);
  const byId = new Map(allObjects(doc).map((object) => [object.id, object]));
  let docChanged = false;
  const layers = doc.layers.map((layer) => {
    if (!layer.visible || layer.locked) return layer;
    if (options.layerId && layer.id !== options.layerId) return layer;
    let layerChanged = false;
    const objects: SceneObject[] = [];
    for (const object of layer.objects) {
      if (object.type === 'group' || !isEditableInDoc(object, byId)) {
        objects.push(object);
        continue;
      }
      const actions = actionsFor(object, options.targets);
      if (!actions) {
        objects.push(object);
        continue;
      }
      const margin = Math.max(2, object.style.stroke.width || 0);
      if (!boundsOverlapCapsule(getObjectBounds(object, doc), from, to, radius, margin)) {
        objects.push(object);
        continue;
      }
      let produced: SceneObject[] = [object];
      let current: SceneObject = object;
      if (actions.fill) {
        const filled = addFillErase(current, from, to, radius);
        if (filled) {
          produced = [filled];
          current = filled;
          layerChanged = true;
        }
      }
      if (actions.outline && produced.length === 1) {
        const masked = addStrokeErase(current, from, to, radius);
        if (masked) {
          produced = [masked];
          current = masked;
          layerChanged = true;
        }
      }
      objects.push(...produced);
    }
    if (!layerChanged) return layer;
    docChanged = true;
    return { ...layer, objects };
  });
  return docChanged ? { ...doc, layers } : doc;
}

/**
 * 沿轨迹逐段做区域擦除。逐段处理能让上一段切出的片段继续参与下一段，
 * 快速划过多段时缺口首尾相接，不会漏掉中间区段。
 */
export function eraseRegionAlongPath(
  doc: VDrawDocument,
  path: Vec[],
  options: RegionEraseOptions
): VDrawDocument {
  const points: Vec[] = [];
  for (const point of path) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const last = points[points.length - 1];
    if (last && Math.hypot(last.x - point.x, last.y - point.y) <= 0.01) continue;
    points.push({ x: point.x, y: point.y });
  }
  if (points.length === 0) return doc;
  let next = doc;
  if (points.length === 1) {
    return applySegment(next, points[0], points[0], options);
  }
  for (let index = 1; index < points.length; index += 1) {
    next = applySegment(next, points[index - 1], points[index], options);
  }
  return next;
}
