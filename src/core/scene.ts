import type {
  AtomObject,
  BondObject,
  PathNode,
  Rect,
  SceneObject,
  VDrawDocument,
  Vec
} from '../types/document';
import { ringGeometry } from './chemistry/ring-geometry';
import { atomLabelLayout, atomParts } from './chemistry/labels';
import { mapEraseHoles, mapEraseStrokes } from './eraseMask';

export const TEXT_LINE_HEIGHT = 1.32;

export function unionRects(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function boundsOfPoints(points: Vec[], pad = 0): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) + pad - minX,
    height: Math.max(...ys) + pad - minY
  };
}

export interface TextMeasureOptions {
  fontWeight?: number;
  fontFamily?: string;
  lineHeight?: number;
}

type TextMeasurer = (
  text: string,
  fontSize: number,
  letterSpacing: number,
  direction: 'horizontal' | 'vertical',
  options: Required<TextMeasureOptions>
) => { width: number; height: number };

const DEFAULT_TEXT_FAMILY = 'Segoe UI, Microsoft YaHei, sans-serif';
let textMeasurer: TextMeasurer | null = null;

/** 由渲染进程注入基于 Canvas 的真实度量；核心层保持无 DOM 依赖。 */
export function setTextMeasurer(measurer: TextMeasurer | null): void {
  textMeasurer = measurer;
}

export function measureText(
  text: string,
  fontSize: number,
  letterSpacing = 0,
  direction: 'horizontal' | 'vertical' = 'horizontal',
  options: TextMeasureOptions = {}
): { width: number; height: number } {
  const resolved: Required<TextMeasureOptions> = {
    fontWeight: options.fontWeight ?? 400,
    fontFamily: options.fontFamily ?? DEFAULT_TEXT_FAMILY,
    lineHeight: options.lineHeight ?? TEXT_LINE_HEIGHT
  };
  if (textMeasurer) {
    return textMeasurer(text, fontSize, letterSpacing, direction, resolved);
  }
  // 无 DOM 环境（单元测试 / 主进程）回退为字符数估算。
  const lines = text.split('\n');
  if (direction === 'vertical') {
    const characters = lines.join('').length;
    const spacing = Math.max(0, letterSpacing);
    return {
      width: Math.max(fontSize, fontSize + Math.abs(letterSpacing)),
      height: Math.max(
        fontSize,
        characters * fontSize * resolved.lineHeight + Math.max(0, characters - 1) * spacing
      )
    };
  }
  const longest = lines.reduce((max, line) => {
    let width = 0;
    const chars = [...line];
    for (const char of chars) {
      width += /[\u4e00-\u9fa5\uff00-\uffef]/.test(char) ? fontSize : fontSize * 0.58;
    }
    if (chars.length > 1) width += letterSpacing * (chars.length - 1);
    return Math.max(max, width);
  }, 0);
  return {
    width: Math.max(12, Math.ceil(longest) + 4),
    height: Math.max(
      fontSize,
      Math.ceil(fontSize + (lines.length - 1) * fontSize * resolved.lineHeight)
    )
  };
}

export function pathPoints(nodes: PathNode[]): Vec[] {
  const points: Vec[] = [];
  for (const node of nodes) {
    points.push({ x: node.x, y: node.y });
    if (node.handleIn) points.push({ x: node.x + node.handleIn.x, y: node.y + node.handleIn.y });
    if (node.handleOut) points.push({ x: node.x + node.handleOut.x, y: node.y + node.handleOut.y });
  }
  return points;
}

const boundsCache = new WeakMap<SceneObject, Rect>();

/**
 * 包围盒缓存：文档是不可变更新，对象引用不变时几何也不会变。
 * 编组依赖子对象、原子标签依赖相连键的朝向，均跳过缓存。
 */
export function getObjectBounds(obj: SceneObject, doc?: VDrawDocument): Rect {
  if (obj.type !== 'group' && obj.type !== 'atom') {
    const cached = boundsCache.get(obj);
    if (cached) return cached;
  }
  const bounds = computeObjectBounds(obj, doc);
  if (obj.type !== 'group' && obj.type !== 'atom') boundsCache.set(obj, bounds);
  return bounds;
}

function computeObjectBounds(obj: SceneObject, doc?: VDrawDocument): Rect {
  switch (obj.type) {
    case 'rect':
    case 'ellipse':
    case 'text':
    case 'image': {
      if (!obj.rotation) return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
      const cx = obj.x + obj.width / 2;
      const cy = obj.y + obj.height / 2;
      const angle = (obj.rotation * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const corners = [
        { x: obj.x, y: obj.y },
        { x: obj.x + obj.width, y: obj.y },
        { x: obj.x + obj.width, y: obj.y + obj.height },
        { x: obj.x, y: obj.y + obj.height }
      ].map((point) => {
        const dx = point.x - cx;
        const dy = point.y - cy;
        return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
      });
      return boundsOfPoints(corners);
    }
    case 'line':
    case 'bond':
    case 'arrow':
      return boundsOfPoints([obj.start, obj.end], Math.max(4, obj.style.stroke.width * 2));
    case 'polygon':
      return boundsOfPoints(obj.points, Math.max(2, obj.style.stroke.width));
    case 'path': {
      let widest = obj.style.stroke.width;
      for (const node of obj.nodes) {
        if (typeof node.width === 'number') widest = Math.max(widest, node.width);
      }
      return boundsOfPoints(pathPoints(obj.nodes), Math.max(2, widest));
    }
    case 'atom': {
      // 标签宽度随元素/基团变化，不能用固定 40×32，否则选择框、对齐和适应窗口都会失真。
      const parts = atomParts(obj);
      const bonds: BondObject[] = doc
        ? doc.layers
            .flatMap((layer) => layer.objects)
            .filter((item): item is BondObject => item.type === 'bond')
        : [];
      const layout = atomLabelLayout(obj, bonds);
      const centerX = obj.position.x + layout.dx;
      const centerY = obj.position.y + layout.dy;
      const chargePad = obj.label.charge ? parts.fontSize * 0.34 : 0;
      const width = Math.max(30, parts.width + parts.fontSize * 0.34 + chargePad);
      const height = Math.max(30, parts.fontSize * 1.5);
      return {
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height
      };
    }
    case 'group': {
      const children = doc ? allObjects(doc).filter((child) => child.parentId === obj.id) : [];
      if (children.length === 0) {
        return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
      }
      return unionRects(children.map((child) => getObjectBounds(child, doc)));
    }
    default:
      return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
  }
}

export function allObjects(doc: VDrawDocument): SceneObject[] {
  return doc.layers.flatMap((layer) => layer.objects);
}

export function objectMap(doc: VDrawDocument): Map<string, SceneObject> {
  return new Map(allObjects(doc).map((obj) => [obj.id, obj]));
}

export function getObject(doc: VDrawDocument, id: string): SceneObject | null {
  for (const layer of doc.layers) {
    const found = layer.objects.find((obj) => obj.id === id);
    if (found) return found;
  }
  return null;
}

export function getLayerOfObject(doc: VDrawDocument, id: string) {
  return doc.layers.find((layer) => layer.objects.some((obj) => obj.id === id)) ?? null;
}

export function getAncestors(doc: VDrawDocument, id: string): SceneObject[] {
  const map = objectMap(doc);
  const result: SceneObject[] = [];
  let current = map.get(id);
  let guard = 0;
  while (current?.parentId && guard < 32) {
    const parent = map.get(current.parentId);
    if (!parent) break;
    result.push(parent);
    current = parent;
    guard += 1;
  }
  return result;
}

export function topLevelId(doc: VDrawDocument, id: string): string {
  const ancestors = getAncestors(doc, id);
  return ancestors.length > 0 ? ancestors[ancestors.length - 1].id : id;
}

export function descendantsOf(doc: VDrawDocument, id: string): SceneObject[] {
  const map = objectMap(doc);
  const result: SceneObject[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const obj of map.values()) {
      if (obj.parentId === current) {
        result.push(obj);
        queue.push(obj.id);
      }
    }
  }
  return result;
}

export function expandSelection(doc: VDrawDocument, ids: string[]): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    if (!getObject(doc, id)) continue;
    set.add(id);
    for (const child of descendantsOf(doc, id)) set.add(child.id);
  }
  return [...set];
}

export function sanitizeSelection(doc: VDrawDocument, ids: string[]): string[] {
  return ids.filter((id) => Boolean(getObject(doc, id)));
}

export function selectionBounds(doc: VDrawDocument, ids: string[]): Rect | null {
  const objects = ids.map((id) => getObject(doc, id)).filter(Boolean) as SceneObject[];
  if (objects.length === 0) return null;
  return unionRects(objects.map((obj) => getObjectBounds(obj, doc)));
}

export function pointInRect(point: Vec, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

export function distanceToSegment(point: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function pointInPolygon(point: Vec, points: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** 将一段贝塞尔曲线采样成折线，供路径命中与橡皮擦使用。 */
function samplePathSegment(
  start: PathNode,
  end: PathNode,
  steps = 18
): Vec[] {
  const p0 = { x: start.x, y: start.y };
  const p1 = { x: end.x, y: end.y };
  if (!start.handleOut && !end.handleIn) return [p0, p1];
  const c1 = start.handleOut
    ? { x: start.x + start.handleOut.x, y: start.y + start.handleOut.y }
    : p0;
  const c2 = end.handleIn ? { x: end.x + end.handleIn.x, y: end.y + end.handleIn.y } : p1;
  const points: Vec[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    points.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p1.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p1.y
    });
  }
  return points;
}

function distanceToPath(nodes: PathNode[], closed: boolean, point: Vec): number {
  if (nodes.length === 0) return Number.POSITIVE_INFINITY;
  if (nodes.length === 1) return Math.hypot(point.x - nodes[0].x, point.y - nodes[0].y);
  let best = Number.POSITIVE_INFINITY;
  const segments = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < segments; i += 1) {
    const samples = samplePathSegment(nodes[i], nodes[(i + 1) % nodes.length]);
    for (let j = 0; j < samples.length - 1; j += 1) {
      best = Math.min(best, distanceToSegment(point, samples[j], samples[j + 1]));
    }
  }
  return best;
}

export function hitTestObject(
  obj: SceneObject,
  point: Vec,
  tolerance: number
): boolean {
  if (!obj.visible) return false;
  switch (obj.type) {
    case 'rect':
    case 'text':
    case 'image': {
      const cx = obj.x + obj.width / 2;
      const cy = obj.y + obj.height / 2;
      const angle = ((obj.rotation ?? 0) * Math.PI) / 180;
      const cos = Math.cos(-angle);
      const sin = Math.sin(-angle);
      const localX = (point.x - cx) * cos - (point.y - cy) * sin + cx;
      const localY = (point.x - cx) * sin + (point.y - cy) * cos + cy;
      return (
        localX >= obj.x - tolerance &&
        localX <= obj.x + obj.width + tolerance &&
        localY >= obj.y - tolerance &&
        localY <= obj.y + obj.height + tolerance
      );
    }
    case 'ellipse': {
      const rx = Math.max(1, obj.width / 2);
      const ry = Math.max(1, obj.height / 2);
      const cx = obj.x + rx;
      const cy = obj.y + ry;
      const angle = ((obj.rotation ?? 0) * Math.PI) / 180;
      const cos = Math.cos(-angle);
      const sin = Math.sin(-angle);
      const localX = (point.x - cx) * cos - (point.y - cy) * sin;
      const localY = (point.x - cx) * sin + (point.y - cy) * cos;
      const nx = localX / (rx + tolerance);
      const ny = localY / (ry + tolerance);
      return nx * nx + ny * ny <= 1;
    }
    case 'line':
    case 'bond':
    case 'arrow': {
      const distance = distanceToSegment(point, obj.start, obj.end);
      return distance <= tolerance + Math.max(2, obj.style.stroke.width / 2);
    }
    case 'polygon': {
      if (obj.style.fill.type !== 'none' && pointInPolygon(point, obj.points)) return true;
      return obj.points.some((a, index) => {
        const b = obj.points[(index + 1) % obj.points.length];
        return distanceToSegment(point, a, b) <= tolerance;
      });
    }
    case 'path': {
      const nodes = obj.nodes;
      const points = nodes.map((node) => ({ x: node.x, y: node.y }));
      if (obj.closed && obj.style.fill.type !== 'none' && pointInPolygon(point, points)) {
        return true;
      }
      // 笔迹命中必须计入线宽：粗笔迹的墨迹边界离中心线可达 30px，
      // 只按中心线判定会出现"点在墨上却选不中"。
      let widest = obj.style.stroke.width;
      for (const node of nodes) {
        if (typeof node.width !== 'number') continue;
        // 扁笔尖在短轴方向的墨迹更宽：命中按最大支撑宽度保守判定。
        const aspect = node.nibAspect;
        const inkWidth =
          typeof aspect === 'number' && aspect > 0.3 && aspect < 0.995
            ? node.width / Math.sqrt(aspect)
            : node.width;
        widest = Math.max(widest, inkWidth);
      }
      return distanceToPath(nodes, obj.closed, point) <= tolerance + widest / 2;
    }
    case 'atom':
      return (
        Math.hypot(point.x - obj.position.x, point.y - obj.position.y) <=
        Math.max(14, atomParts(obj).width / 2 + 6) + tolerance
      );
    default:
      return false;
  }
}

export function hitTestDocument(
  doc: VDrawDocument,
  point: Vec,
  tolerance: number
): SceneObject | null {
  for (let l = doc.layers.length - 1; l >= 0; l -= 1) {
    const layer = doc.layers[l];
    if (!layer.visible || layer.locked) continue;
    for (let i = layer.objects.length - 1; i >= 0; i -= 1) {
      const obj = layer.objects[i];
      if (!obj.visible || obj.locked) continue;
      let hit = false;
      if (obj.type === 'group') {
        if (obj.ringFrame && obj.ringCenters && obj.ringCenters.length > 0) {
          // 稠环外层把多个环心收在同一个编组里，点任一环内部都选整个稠环体系。
          hit = obj.ringCenters.some(
            (center) =>
              Math.hypot(point.x - center.x, point.y - center.y) <=
              32 * (obj.ringScale ?? 1) + tolerance
          );
        } else if (obj.ringStyle || obj.ringFrame) {
          // 与渲染共用同一份环骨架几何，避免命中区域和内圈错位；
          // 任意闭合环（吡啶/环己烷/呋喃等）都允许通过点击内部选中整个环。
          const geometry = ringGeometry(
            layer.objects.filter(
              (item): item is BondObject => item.type === 'bond' && item.parentId === obj.id
            )
          );
          hit =
            Boolean(geometry?.closed) &&
            Math.hypot(
              point.x - (geometry?.center.x ?? 0),
              point.y - (geometry?.center.y ?? 0)
            ) <=
              (geometry?.vertexRadius ?? 0) * 0.96;
        }
      } else {
        hit = hitTestObject(obj, point, tolerance);
      }
      if (hit) {
        const rootId = topLevelId(doc, obj.id);
        return getObject(doc, rootId);
      }
    }
  }
  return null;
}

/**
 * 油漆桶专用命中：先按常规命中，再允许"未填充的闭合路径/多边形内部"被命中。
 * 锁定图层上的命中也会返回（locked=true），让调用方能给出"图层已锁定"而不是"请点击图形"。
 */
export function findFillTarget(
  doc: VDrawDocument,
  point: Vec,
  tolerance: number
): { object: SceneObject; locked: boolean } | null {
  const interiorHit = (obj: SceneObject): boolean => {
    if (!obj.visible) return false;
    if (obj.type === 'polygon') return pointInPolygon(point, obj.points);
    if (obj.type === 'path' && obj.closed) {
      return pointInPolygon(
        point,
        obj.nodes.map((node) => ({ x: node.x, y: node.y }))
      );
    }
    return false;
  };

  for (const layer of [...doc.layers].reverse()) {
    for (const obj of [...layer.objects].reverse()) {
      if (!obj.visible || obj.locked) continue;
      if (layer.locked) {
        if (hitTestObject(obj, point, tolerance) || interiorHit(obj)) {
          return { object: obj, locked: true };
        }
        continue;
      }
      if (hitTestObject(obj, point, tolerance) || interiorHit(obj)) {
        return { object: obj, locked: false };
      }
    }
  }
  return null;
}

export function translateObject<T extends SceneObject>(obj: T, dx: number, dy: number): T {
  const next: SceneObject = { ...obj, x: obj.x + dx, y: obj.y + dy };
  switch (next.type) {
    case 'line':
    case 'bond':
    case 'arrow':
      next.start = { x: next.start.x + dx, y: next.start.y + dy };
      next.end = { x: next.end.x + dx, y: next.end.y + dy };
      break;
    case 'polygon':
      next.points = next.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
      break;
    case 'path':
      next.nodes = next.nodes.map((node) => ({
        ...node,
        x: node.x + dx,
        y: node.y + dy
      }));
      next.holes = mapEraseHoles(next.holes, (point) => ({ x: point.x + dx, y: point.y + dy }));
      next.eraseStrokes = mapEraseStrokes(
        next.eraseStrokes,
        (point) => ({ x: point.x + dx, y: point.y + dy }),
        1
      );
      break;
    case 'atom':
      next.position = { x: next.position.x + dx, y: next.position.y + dy };
      break;
    case 'group':
      if (next.ringCenters) {
        next.ringCenters = next.ringCenters.map((point) => ({
          x: point.x + dx,
          y: point.y + dy
        }));
      }
      break;
    default:
      break;
  }
  // 线条/描边擦除 mask 与几何同源：所有对象类型都要跟着平移。
  next.strokeEraseStrokes = mapEraseStrokes(
    next.strokeEraseStrokes,
    (point) => ({ x: point.x + dx, y: point.y + dy }),
    1
  );
  return next as T;
}

/**
 * 统一的「笔画类尺寸」缩放因子。
 *
 * 缩放语义（单一口径，所有对象类型一致）：
 * - 几何坐标 / 包围盒按 sx、sy 分别缩放；
 * - 笔画类尺寸（文本字号、原子标签字号、笔迹节点宽度）按本因子等比缩放；
 * - `style.stroke.width` 保持不变（与矢量编辑器默认「缩放描边关闭」一致）。
 *
 * `scaleObject`（无旋转框）与 `scaleObjectInFrame`（旋转框）必须共用它，
 * 否则同一支笔在旋转前后缩放会得到不同粗细。
 */
export function scalePaintFactor(sx: number, sy: number): number {
  return Math.max(0.01, (Math.abs(sx) + Math.abs(sy)) / 2);
}

export function scaleObject(
  obj: SceneObject,
  origin: Vec,
  sx: number,
  sy: number
): SceneObject {
  const mapPoint = (point: Vec): Vec => ({
    x: origin.x + (point.x - origin.x) * sx,
    y: origin.y + (point.y - origin.y) * sy
  });
  const next: SceneObject = { ...obj };
  switch (next.type) {
    case 'rect':
    case 'ellipse':
    case 'image': {
      const topLeft = mapPoint({ x: next.x, y: next.y });
      next.x = topLeft.x;
      next.y = topLeft.y;
      next.width = Math.max(1, next.width * Math.abs(sx));
      next.height = Math.max(1, next.height * Math.abs(sy));
      break;
    }
    case 'text': {
      const topLeft = mapPoint({ x: next.x, y: next.y });
      next.x = topLeft.x;
      next.y = topLeft.y;
      const factor = scalePaintFactor(sx, sy);
      next.fontSize = Math.max(6, next.fontSize * factor);
      next.width = Math.max(8, next.width * Math.abs(sx));
      next.height = Math.max(8, next.height * Math.abs(sy));
      break;
    }
    case 'line':
    case 'arrow':
      next.start = mapPoint(next.start);
      next.end = mapPoint(next.end);
      break;
    case 'bond':
      next.start = mapPoint(next.start);
      next.end = mapPoint(next.end);
      // 双键/三键的平行线间距跟随缩放，保持化学结构比例。
      next.scale = Math.max(0.05, (next.scale ?? 1) * scalePaintFactor(sx, sy));
      break;
    case 'polygon':
      next.points = next.points.map(mapPoint);
      break;
    case 'path': {
      // 笔迹宽度随缩放同步变化，否则放大后笔迹会相对变细。
      const widthScale = scalePaintFactor(sx, sy);
      next.nodes = next.nodes.map((node) => ({
        ...node,
        ...mapPoint({ x: node.x, y: node.y }),
        ...(typeof node.width === 'number' ? { width: node.width * widthScale } : {}),
        handleIn: node.handleIn ? { x: node.handleIn.x * sx, y: node.handleIn.y * sy } : null,
        handleOut: node.handleOut ? { x: node.handleOut.x * sx, y: node.handleOut.y * sy } : null
      }));
      next.holes = mapEraseHoles(next.holes, mapPoint);
      next.eraseStrokes = mapEraseStrokes(next.eraseStrokes, mapPoint, widthScale);
      break;
    }
    case 'atom': {
      next.position = mapPoint(next.position);
      const factor = scalePaintFactor(sx, sy);
      next.label = {
        ...next.label,
        fontSize: Math.max(8, (next.label.fontSize ?? 16) * factor)
      };
      break;
    }
    case 'group':
      if (next.ringCenters) next.ringCenters = next.ringCenters.map(mapPoint);
      // 稠环内圈半径独立于顶点坐标，必须单独记录缩放倍率。
      next.ringScale = Math.max(0.05, (next.ringScale ?? 1) * scalePaintFactor(sx, sy));
      break;
    case 'ring':
      next.scale = Math.max(0.05, (next.scale ?? 1) * scalePaintFactor(sx, sy));
      next.width = Math.max(1, next.width * Math.abs(sx));
      next.height = Math.max(1, next.height * Math.abs(sy));
      break;
    default:
      break;
  }
  // 描边擦除 mask 随对象缩放；stroke.width 不缩放，但擦除半径属于页面几何。
  next.strokeEraseStrokes = mapEraseStrokes(
    next.strokeEraseStrokes,
    mapPoint,
    scalePaintFactor(sx, sy)
  );
  return next;
}

export function rotatePoint(point: Vec, center: Vec, angleDeg: number): Vec {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

export function rotateObject(obj: SceneObject, center: Vec, angleDeg: number): SceneObject {
  const next: SceneObject = { ...obj };
  switch (next.type) {
    case 'rect':
    case 'ellipse':
    case 'text':
    case 'image': {
      const objectCenter = { x: next.x + next.width / 2, y: next.y + next.height / 2 };
      const rotated = rotatePoint(objectCenter, center, angleDeg);
      next.x = rotated.x - next.width / 2;
      next.y = rotated.y - next.height / 2;
      next.rotation = (((next.rotation ?? 0) + angleDeg) % 360 + 360) % 360;
      break;
    }
    case 'line':
    case 'bond':
    case 'arrow':
      next.start = rotatePoint(next.start, center, angleDeg);
      next.end = rotatePoint(next.end, center, angleDeg);
      break;
    case 'polygon':
      next.points = next.points.map((point) => rotatePoint(point, center, angleDeg));
      break;
    case 'path': {
      const rotateHandle = (handle: Vec | null): Vec | null => {
        if (!handle) return null;
        const radians = (angleDeg * Math.PI) / 180;
        return {
          x: handle.x * Math.cos(radians) - handle.y * Math.sin(radians),
          y: handle.x * Math.sin(radians) + handle.y * Math.cos(radians)
        };
      };
      next.nodes = next.nodes.map((node) => {
        const point = rotatePoint({ x: node.x, y: node.y }, center, angleDeg);
        return {
          ...node,
          x: point.x,
          y: point.y,
          handleIn: rotateHandle(node.handleIn),
          handleOut: rotateHandle(node.handleOut)
        };
      });
      next.holes = mapEraseHoles(next.holes, (point) => rotatePoint(point, center, angleDeg));
      next.eraseStrokes = mapEraseStrokes(
        next.eraseStrokes,
        (point) => rotatePoint(point, center, angleDeg),
        1
      );
      break;
    }
    case 'atom':
      next.position = rotatePoint(next.position, center, angleDeg);
      break;
    case 'group':
      if (next.ringCenters) {
        next.ringCenters = next.ringCenters.map((point) => rotatePoint(point, center, angleDeg));
      }
      break;
    default:
      break;
  }
  // 描边擦除 mask 随对象旋转（mask 包在无旋转的 <g> 上，不会二次旋转）。
  next.strokeEraseStrokes = mapEraseStrokes(
    next.strokeEraseStrokes,
    (point) => rotatePoint(point, center, angleDeg),
    1
  );
  return next;
}

interface AtomMove {
  from: Vec;
  to: Vec;
}

function syncBonds(
  doc: VDrawDocument,
  changedIds: Set<string>,
  atomMoves: AtomMove[]
): VDrawDocument {
  if (atomMoves.length === 0) return doc;
  return {
    ...doc,
    layers: doc.layers.map((layer) => ({
      ...layer,
      objects: layer.objects.map((obj) => {
        if (obj.type !== 'bond' || changedIds.has(obj.id)) return obj;
        let start = obj.start;
        let end = obj.end;
        for (const move of atomMoves) {
          if (Math.hypot(start.x - move.from.x, start.y - move.from.y) < 1.2) start = move.to;
          if (Math.hypot(end.x - move.from.x, end.y - move.from.y) < 1.2) end = move.to;
        }
        if (start === obj.start && end === obj.end) return obj;
        return { ...obj, start, end };
      })
    }))
  };
}

function applyToSelection(
  doc: VDrawDocument,
  ids: string[],
  transform: (obj: SceneObject) => SceneObject
): { doc: VDrawDocument; atomMoves: AtomMove[]; changed: Set<string> } {
  const expanded = new Set(expandSelection(doc, ids));
  const atomMoves: AtomMove[] = [];
  const next: VDrawDocument = {
    ...doc,
    layers: doc.layers.map((layer) => ({
      ...layer,
      objects: layer.objects.map((obj) => {
        if (!expanded.has(obj.id)) return obj;
        const transformed = transform(obj);
        if (obj.type === 'atom' && transformed.type === 'atom') {
          atomMoves.push({ from: obj.position, to: transformed.position });
        }
        return transformed;
      })
    }))
  };
  return { doc: next, atomMoves, changed: expanded };
}

export function translateDocumentObjects(
  doc: VDrawDocument,
  ids: string[],
  dx: number,
  dy: number
): VDrawDocument {
  if (dx === 0 && dy === 0) return doc;
  const result = applyToSelection(doc, ids, (obj) => translateObject(obj, dx, dy));
  return syncBonds(result.doc, result.changed, result.atomMoves);
}

export function scaleDocumentObjects(
  doc: VDrawDocument,
  ids: string[],
  origin: Vec,
  sx: number,
  sy: number
): VDrawDocument {
  const result = applyToSelection(doc, ids, (obj) => scaleObject(obj, origin, sx, sy));
  return syncBonds(result.doc, result.changed, result.atomMoves);
}

export function rotateDocumentObjects(
  doc: VDrawDocument,
  ids: string[],
  center: Vec,
  angle: number
): VDrawDocument {
  const result = applyToSelection(doc, ids, (obj) => rotateObject(obj, center, angle));
  return syncBonds(result.doc, result.changed, result.atomMoves);
}

export interface SelectionFrame {
  /** 未旋转时的对象盒（页面坐标） */
  bounds: Rect;
  /** 选中对象整体旋转角度 */
  rotation: number;
  center: Vec;
}

/**
 * 对象自身的“未旋转盒子”。
 *
 * rect / ellipse / text / image 的旋转由渲染期的 `rotate(angle cx cy)` 承担，几何字段
 * 本身仍是不旋转的，因此它们的局部盒就是 x/y/width/height；其它类型（直线、多边形、
 * 路径、化学对象）旋转已烘焙进坐标，直接取几何包围盒。
 *
 * 注意：`getObjectBounds` 对旋转过的 rect/ellipse/text 返回的是**旋转后的轴对齐包围盒**，
 * 不能直接当选中框用（会与渲染期的旋转叠加，选框描边看起来“没跟着转”）。
 */
export function objectLocalBounds(obj: SceneObject, doc?: VDrawDocument): Rect {
  switch (obj.type) {
    case 'rect':
    case 'ellipse':
    case 'text':
    case 'image':
      return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
    default:
      return getObjectBounds(obj, doc);
  }
}

/**
 * 渲染期真的会应用 `rotation` 的类型（SVG `rotate(angle cx cy)` 变换）。
 * 其它类型（分组、路径、直线、化学对象）的旋转已烘焙进几何，`rotation` 字段
 * 不参与绘制；选框必须与渲染保持一致，否则会多转一次。
 */
export function hasOwnRotation(obj: SceneObject): boolean {
  return (
    obj.type === 'rect' ||
    obj.type === 'ellipse' ||
    obj.type === 'text' ||
    obj.type === 'image'
  );
}

/** 选中框的局部坐标框：单对象沿用自身盒与旋转角，多选使用轴对齐包围盒。 */
export function selectionFrame(doc: VDrawDocument, ids: string[]): SelectionFrame | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) {
    const obj = getObject(doc, ids[0]);
    if (obj) {
      const bounds = objectLocalBounds(obj, doc);
      return {
        bounds,
        rotation: hasOwnRotation(obj) ? obj.rotation ?? 0 : 0,
        center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      };
    }
  }
  const bounds = selectionBounds(doc, ids);
  if (!bounds) return null;
  return {
    bounds,
    rotation: 0,
    center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  };
}

function scaleObjectInFrame(
  obj: SceneObject,
  mapPoint: (point: Vec) => Vec,
  mapLocal: (point: Vec) => Vec,
  sx: number,
  sy: number,
  angleRad: number
): SceneObject {
  const next: SceneObject = { ...obj };
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const mapHandle = (handle: Vec | null): Vec | null => {
    if (!handle) return null;
    const x = handle.x * sx;
    const y = handle.y * sy;
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  };
  switch (next.type) {
    // rect / ellipse / text 的 x/y/w/h 是**未旋转的本地坐标**，缩放必须在本地系里做；
    // 用页面坐标的中心回填会让旋转后的图形在缩放时整体漂移。
    case 'rect':
    case 'ellipse':
    case 'image': {
      const center = mapLocal({ x: next.x + next.width / 2, y: next.y + next.height / 2 });
      next.width = Math.max(1, next.width * Math.abs(sx));
      next.height = Math.max(1, next.height * Math.abs(sy));
      next.x = center.x - next.width / 2;
      next.y = center.y - next.height / 2;
      break;
    }
    case 'text': {
      const center = mapLocal({ x: next.x + next.width / 2, y: next.y + next.height / 2 });
      const factor = scalePaintFactor(sx, sy);
      next.fontSize = Math.max(6, next.fontSize * factor);
      next.width = Math.max(8, next.width * Math.abs(sx));
      next.height = Math.max(8, next.height * Math.abs(sy));
      // 自动换行宽度要跟框一起缩放，否则拖完手柄文字还按旧宽度折行，与选框对不上。
      if (next.maxWidth) next.maxWidth = Math.max(8, next.maxWidth * Math.abs(sx));
      next.x = center.x - next.width / 2;
      next.y = center.y - next.height / 2;
      break;
    }
    case 'line':
    case 'arrow':
      next.start = mapPoint(next.start);
      next.end = mapPoint(next.end);
      break;
    case 'bond':
      next.start = mapPoint(next.start);
      next.end = mapPoint(next.end);
      next.scale = Math.max(0.05, (next.scale ?? 1) * scalePaintFactor(sx, sy));
      break;
    case 'polygon':
      next.points = next.points.map(mapPoint);
      break;
    case 'path': {
      // 与 scaleObject 保持同一口径：旋转框缩放也要同步改变笔迹节点宽度。
      const widthScale = scalePaintFactor(sx, sy);
      next.nodes = next.nodes.map((node) => ({
        ...node,
        ...mapPoint({ x: node.x, y: node.y }),
        ...(typeof node.width === 'number' ? { width: node.width * widthScale } : {}),
        handleIn: mapHandle(node.handleIn),
        handleOut: mapHandle(node.handleOut)
      }));
      next.holes = mapEraseHoles(next.holes, mapPoint);
      next.eraseStrokes = mapEraseStrokes(next.eraseStrokes, mapPoint, widthScale);
      break;
    }
    case 'atom': {
      next.position = mapPoint(next.position);
      const factor = scalePaintFactor(sx, sy);
      next.label = {
        ...next.label,
        fontSize: Math.max(8, (next.label.fontSize ?? 16) * factor)
      };
      break;
    }
    case 'group':
      if (next.ringCenters) next.ringCenters = next.ringCenters.map(mapPoint);
      next.ringScale = Math.max(0.05, (next.ringScale ?? 1) * scalePaintFactor(sx, sy));
      break;
    case 'ring':
      next.scale = Math.max(0.05, (next.scale ?? 1) * scalePaintFactor(sx, sy));
      next.width = Math.max(1, next.width * Math.abs(sx));
      next.height = Math.max(1, next.height * Math.abs(sy));
      break;
    default:
      break;
  }
  // 旋转框缩放同样同步描边擦除 mask。
  next.strokeEraseStrokes = mapEraseStrokes(
    next.strokeEraseStrokes,
    mapPoint,
    scalePaintFactor(sx, sy)
  );
  return next;
}

/** 选中框本地坐标 → 页面坐标（未旋转时原样返回）。 */
export function frameLocalToWorld(frame: SelectionFrame, point: Vec): Vec {
  const angle = frame.rotation ?? 0;
  if (!angle) return point;
  return rotatePoint(point, frame.center, angle);
}

/**
 * 在选中框的局部坐标系内缩放：先反向旋转到对象本地坐标，缩放后再旋转回页面坐标。
 * 这样旋转后的对象拖动控制点时，缩放方向与选框保持一致。
 *
 * `anchor` 是**页面坐标**下的缩放锚点；本地锚点需先用 `frameLocalToWorld` 换算，
 * 否则旋转后锚点会多转一次，缩放时图形会漂移。
 */
export function scaleDocumentObjectsInFrame(
  doc: VDrawDocument,
  ids: string[],
  frame: SelectionFrame,
  anchor: Vec,
  sx: number,
  sy: number
): VDrawDocument {
  const angle = frame.rotation ?? 0;
  if (angle === 0) return scaleDocumentObjects(doc, ids, anchor, sx, sy);
  const center = frame.center;
  const rect = (angle * Math.PI) / 180;
  const cos = Math.cos(rect);
  const sin = Math.sin(rect);
  const toLocal = (point: Vec): Vec => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
  };
  const toWorld = (point: Vec): Vec => ({
    x: center.x + point.x * cos - point.y * sin,
    y: center.y + point.x * sin + point.y * cos
  });
  const localAnchor = toLocal(anchor);
  /** 以锚点为中心、在“相对选中框中心”的本地坐标里缩放。 */
  const scaleRelative = (relative: Vec): Vec => ({
    x: localAnchor.x + (relative.x - localAnchor.x) * sx,
    y: localAnchor.y + (relative.y - localAnchor.y) * sy
  });
  // 已烘焙几何（路径/多边形/直线等）：输入输出都是页面坐标
  const mapPoint = (point: Vec): Vec => toWorld(scaleRelative(toLocal(point)));
  // 未烘焙几何（rect/ellipse/text）：输入输出都是对象的本地坐标
  const mapLocal = (point: Vec): Vec => {
    const relative = scaleRelative({ x: point.x - center.x, y: point.y - center.y });
    return { x: center.x + relative.x, y: center.y + relative.y };
  };
  const result = applyToSelection(doc, ids, (obj) =>
    scaleObjectInFrame(obj, mapPoint, mapLocal, sx, sy, rect)
  );
  return syncBonds(result.doc, result.changed, result.atomMoves);
}

export function replaceObject(
  doc: VDrawDocument,
  id: string,
  updater: (obj: SceneObject) => SceneObject
): VDrawDocument {
  let found = false;
  const next = {
    ...doc,
    layers: doc.layers.map((layer) => {
      if (!layer.objects.some((obj) => obj.id === id)) return layer;
      found = true;
      return {
        ...layer,
        objects: layer.objects.map((obj) => (obj.id === id ? updater(obj) : obj))
      };
    })
  };
  return found ? next : doc;
}

export function removeObjectsById(
  doc: VDrawDocument,
  ids: string[]
): VDrawDocument {
  const remove = new Set(ids);
  return {
    ...doc,
    layers: doc.layers.map((layer) => ({
      ...layer,
      objects: layer.objects
        .filter((obj) => !remove.has(obj.id))
        .map((obj) =>
          obj.type === 'group'
            ? { ...obj, childIds: obj.childIds.filter((id) => !remove.has(id)) }
            : obj
        )
    }))
  };
}

export function addObjectsToLayer(
  doc: VDrawDocument,
  layerId: string,
  objects: SceneObject[]
): VDrawDocument {
  return {
    ...doc,
    layers: doc.layers.map((layer) =>
      layer.id === layerId ? { ...layer, objects: [...layer.objects, ...objects] } : layer
    ),
    updatedAt: new Date().toISOString()
  };
}

/** 在图层内指定下标插入对象：数组顺序即绘制顺序，越靠后越在上层。 */
export function insertObjectsIntoLayer(
  doc: VDrawDocument,
  layerId: string,
  objects: SceneObject[],
  index: number
): VDrawDocument {
  return {
    ...doc,
    layers: doc.layers.map((layer) => {
      if (layer.id !== layerId) return layer;
      const next = [...layer.objects];
      const at = Math.max(0, Math.min(index, next.length));
      next.splice(at, 0, ...objects);
      return { ...layer, objects: next };
    }),
    updatedAt: new Date().toISOString()
  };
}

export function topLevelObjectsInLayer(
  doc: VDrawDocument,
  layerId: string
): SceneObject[] {
  const layer = doc.layers.find((item) => item.id === layerId);
  if (!layer) return [];
  return layer.objects.filter((obj) => !obj.parentId);
}

export function groupChildIds(doc: VDrawDocument, groupId: string): string[] {
  return allObjects(doc)
    .filter((obj) => obj.parentId === groupId)
    .map((obj) => obj.id);
}

export function selectableObjects(doc: VDrawDocument): SceneObject[] {
  return allObjects(doc).filter((obj) => obj.type !== 'group' && !obj.parentId);
}

/** 精确命中原子中心；化学键裁切必须用它，不能被邻近标签的大选框误吸。 */
export function findAtomAtPosition(
  doc: VDrawDocument,
  point: Vec,
  tolerance = 1.5
): AtomObject | null {
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (const obj of layer.objects) {
      if (obj.type !== 'atom') continue;
      if (Math.hypot(obj.position.x - point.x, obj.position.y - point.y) <= tolerance) {
        return obj;
      }
    }
  }
  return null;
}

export function findAtomAt(
  doc: VDrawDocument,
  point: Vec,
  tolerance = 1.5
): AtomObject | null {
  const bonds = allObjects(doc).filter(
    (obj): obj is BondObject => obj.type === 'bond'
  );
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (const obj of layer.objects) {
      if (obj.type !== 'atom') continue;
      const parts = atomParts(obj);
      const layout = atomLabelLayout(obj, bonds);
      const centerX = obj.position.x + layout.dx;
      const centerY = obj.position.y + layout.dy;
      const chargePad = obj.label.charge ? parts.fontSize * 0.34 : 0;
      const halfWidth = Math.max(28, parts.width + parts.fontSize * 0.34 + chargePad) / 2;
      const halfHeight = Math.max(30, parts.fontSize * 1.5) / 2;
      if (
        Math.abs(point.x - centerX) <= halfWidth + tolerance &&
        Math.abs(point.y - centerY) <= halfHeight + tolerance
      ) {
        return obj;
      }
    }
  }
  return null;
}

export function objectRotationTransform(obj: SceneObject): string {
  if (!hasOwnRotation(obj) || !obj.rotation) return '';
  const centerX = obj.x + obj.width / 2;
  const centerY = obj.y + obj.height / 2;
  return `rotate(${obj.rotation} ${centerX} ${centerY})`;
}
