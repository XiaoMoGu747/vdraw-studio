import type {
  AtomObject,
  BondObject,
  BondType,
  GroupObject,
  PathNode,
  Rect,
  RectObject,
  SceneObject,
  VDrawDocument,
  Vec
} from '../types/document';
import { buildArrowGeometry } from './arrow';
import { atomParts } from './chemistry/labels';
import { chemBondShape } from './chemistry/render';
import { ringGeometry } from './chemistry/ring-geometry';
import { prevBondOrderType } from './chemistry/chain';
import {
  eraseRegionAlongPath,
  fillObjectHit,
  hasSolidStroke,
  isClosedShapeObject,
  isOpenLineObject
} from './eraserRegion';
import {
  allObjects,
  getObjectBounds,
  pointInPolygon,
  removeObjectsById,
  replaceObject,
  unionRects
} from './scene';

/**
 * 橡皮擦：按"擦除目标"生效的矢量橡皮。
 *
 * 四个选项对应三类目标（`outline` / `fill` / `chemistry`），
 * "全部擦除"只是把三类目标一起选中：
 * - outline：画笔、钢笔、直线、曲线、形状的线条/描边；沿轨迹只切断经过处；
 * - fill：只清除笔刷经过处的填充，保留描边与其余填充；
 * - chemistry：化学键、原子标签、环骨架（断环后芳香内圈自动解除）。
 *
 * 命中判定基于真实渲染几何（含线宽、旋转、圆角、键型与原子标签包围盒），
 * 不用包围盒一刀切：空心矩形内部、两个原子之间的空白、环形内部都不会误删。
 */

export type EraserTarget = 'outline' | 'fill' | 'chemistry';

export type EraserTargets = Record<EraserTarget, boolean>;

export const ERASER_TARGET_KEYS: EraserTarget[] = ['outline', 'fill', 'chemistry'];

export const ERASER_TARGET_OPTIONS: {
  key: EraserTarget;
  label: string;
  hint: string;
}[] = [
  {
    key: 'outline',
    label: '擦除线条/描边',
    hint: '沿笔刷轨迹切断画笔、钢笔与形状的线条/轮廓；只留下经过处的缺口，不碰填充'
  },
  {
    key: 'fill',
    label: '擦除填充',
    hint: '只挖掉笔刷经过的填充区域，描边与其余填充保持原样'
  },
  {
    key: 'chemistry',
    label: '擦除化学键',
    hint: '擦除化学键、原子标签与环骨架；擦断环键后芳香内圈自动解除'
  }
];

export function createEraserTargets(enabled: boolean): EraserTargets {
  return { outline: enabled, fill: enabled, chemistry: enabled };
}

export function isEraserAllTargets(targets: EraserTargets): boolean {
  return ERASER_TARGET_KEYS.every((key) => targets[key]);
}

export function isEraserEmptyTargets(targets: EraserTargets): boolean {
  return ERASER_TARGET_KEYS.every((key) => !targets[key]);
}

/** 单项切换；"全部擦除"由 UI 调用 createEraserTargets 统一设置。 */
export function toggleEraserTarget(
  targets: EraserTargets,
  key: EraserTarget
): EraserTargets {
  return { ...targets, [key]: !targets[key] };
}

/**
 * 旧偏好迁移：
 * - 旧版 line / stroke 两项目标合并为 outline（任一开启即保留）；
 * - 更旧的 eraserScope（全部/仅图形/仅化学）继续兼容。
 */
export function normalizeEraserTargets(
  value: unknown,
  legacyScope?: unknown
): EraserTargets {
  if (value && typeof value === 'object') {
    const source = value as Partial<Record<string, unknown>> & {
      line?: unknown;
      stroke?: unknown;
    };
    const outline =
      typeof source.outline === 'boolean'
        ? source.outline
        : source.line !== false || source.stroke !== false;
    return {
      outline,
      fill: source.fill !== false,
      chemistry: source.chemistry !== false
    };
  }
  if (legacyScope === 'chemistry') {
    return { outline: false, fill: false, chemistry: true };
  }
  if (legacyScope === 'vector') {
    return { outline: true, fill: true, chemistry: false };
  }
  return createEraserTargets(true);
}

export interface EraseOptions {
  targets: EraserTargets;
  /** 橡皮半径（页面像素），与画笔同一单位。 */
  radius: number;
  /** 只擦该图层；null/undefined 表示所有可见可编辑图层。 */
  layerId?: string | null;
  /**
   * 本次手势内已经降过键级的化学键。
   * 一次按下→抬起只降一级：三键→双键→单键，同一次擦除里不重复降。
   */
  degradedBondIds?: Set<string>;
}

interface InkBand {
  points: Vec[];
  closed: boolean;
  /** 每段墨迹半宽（含画笔压感宽度），长度可小于段数，末项复用。 */
  halfWidths: number[];
}

interface ObjectInk {
  /** 描边/线条中心线及半宽。 */
  bands: InkBand[];
  /** 填充区域（外轮廓 + 孔洞，even-odd 判定）。 */
  fills: Vec[][];
  /** 由描边色填充的实心块（箭头、楔形键等）。 */
  strokeAreas: Vec[][];
}

type InkMode = 'ink' | 'stroke';

const EPSILON = 1e-9;
const CURVE_STEP = 6;
const MAX_CURVE_STEPS = 24;
const ELLIPSE_STEPS = 64;

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
    Math.abs(orientation(a, b, point)) < EPSILON &&
    point.x >= Math.min(a.x, b.x) - EPSILON &&
    point.x <= Math.max(a.x, b.x) + EPSILON &&
    point.y >= Math.min(a.y, b.y) - EPSILON &&
    point.y <= Math.max(a.y, b.y) + EPSILON
  );
}

function segmentsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const d1 = orientation(a, b, c);
  const d2 = orientation(a, b, d);
  const d3 = orientation(c, d, a);
  const d4 = orientation(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return (
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}

/** 两线段最短距离（相交为 0）。 */
function segmentDistance(a: Vec, b: Vec, c: Vec, d: Vec): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b)
  );
}

/** 折线到线段的最短距离；折线只有一个点时退化为点到线段。 */
function polylineToSegmentDistance(path: Vec[], start: Vec, end: Vec): number {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return pointSegmentDistance(path[0], start, end);
  let best = Infinity;
  for (let index = 0; index < path.length - 1; index += 1) {
    const distance = segmentDistance(path[index], path[index + 1], start, end);
    if (distance < best) best = distance;
    if (best <= 0) return 0;
  }
  return best;
}

/** even-odd：外轮廓与孔洞叠加时，孔洞内部视为"没有填充"。 */
function pointInLoops(point: Vec, loops: Vec[][]): boolean {
  let inside = false;
  for (const loop of loops) {
    if (loop.length >= 3 && pointInPolygon(point, loop)) inside = !inside;
  }
  return inside;
}

/**
 * 笔刷扫掠区是否碰到填充区域：轨迹点落在区域内，或轨迹与区域边界距离在半径内。
 * 快速划过时两端点都在区域外、但轨迹穿过区域，也会因为与边界相交而命中。
 */
function pathHitsLoops(path: Vec[], loops: Vec[][], radius: number): boolean {
  if (loops.length === 0) return false;
  for (const point of path) {
    if (pointInLoops(point, loops)) return true;
  }
  for (const loop of loops) {
    if (loop.length < 2) continue;
    for (let index = 0; index < loop.length; index += 1) {
      const start = loop[index];
      const end = loop[(index + 1) % loop.length];
      if (polylineToSegmentDistance(path, start, end) <= radius) return true;
    }
  }
  return false;
}

/** 笔刷扫掠区是否碰到某条带宽线段（距离扣除该段半宽）。 */
function pathHitsBand(path: Vec[], band: InkBand, radius: number): boolean {
  if (band.points.length === 0) return false;
  if (band.points.length === 1) {
    const half = band.halfWidths[0] ?? 0;
    return polylineToSegmentDistance(path, band.points[0], band.points[0]) <= radius + half;
  }
  const segments = band.closed ? band.points.length : band.points.length - 1;
  for (let index = 0; index < segments; index += 1) {
    const start = band.points[index];
    const end = band.points[(index + 1) % band.points.length];
    const half = band.halfWidths[Math.min(index, band.halfWidths.length - 1)] ?? 0;
    if (polylineToSegmentDistance(path, start, end) <= radius + half) return true;
  }
  return false;
}

function hitInk(ink: ObjectInk, path: Vec[], radius: number, mode: InkMode): boolean {
  const strokeHit =
    ink.bands.some((band) => pathHitsBand(path, band, radius)) ||
    ink.strokeAreas.some((area) => pathHitsLoops(path, [area], radius));
  if (mode === 'stroke') return strokeHit;
  return strokeHit || pathHitsLoops(path, ink.fills, radius);
}

function band(points: Vec[], closed: boolean, halfWidth: number | number[]): InkBand {
  const halfWidths = Array.isArray(halfWidth)
    ? halfWidth
    : points.map(() => Math.max(0, halfWidth));
  return { points, closed, halfWidths };
}

/** 折线段的半宽：优先使用画笔笔迹的逐节点线宽。 */
function pathHalfWidths(nodes: PathNode[], fallback: number): number[] {
  const widths = nodes.map((node) =>
    Math.max(0.5, typeof node.width === 'number' ? node.width : fallback) / 2
  );
  if (widths.length === 0) return [Math.max(0.5, fallback) / 2];
  return widths;
}

/** 贝塞尔段扁平化；直线段不重采样，避免反复擦除后节点膨胀。 */
function flattenPath(nodes: PathNode[], closed: boolean): Vec[] {
  if (nodes.length === 0) return [];
  const points: Vec[] = [{ x: nodes[0].x, y: nodes[0].y }];
  const push = (point: Vec) => {
    const last = points[points.length - 1];
    if (!last || dist(last, point) > 0.01) points.push(point);
  };
  const segment = (from: PathNode, to: PathNode) => {
    if (!from.handleOut && !to.handleIn) {
      push({ x: to.x, y: to.y });
      return;
    }
    const p0 = { x: from.x, y: from.y };
    const p1 = { x: to.x, y: to.y };
    const c1 = from.handleOut
      ? { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y }
      : p0;
    const c2 = to.handleIn ? { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y } : p1;
    const length = dist(p0, c1) + dist(c1, c2) + dist(c2, p1);
    const steps = Math.max(4, Math.min(MAX_CURVE_STEPS, Math.ceil(length / CURVE_STEP)));
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      const mt = 1 - t;
      push({
        x: mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p1.x,
        y: mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p1.y
      });
    }
  };
  for (let index = 1; index < nodes.length; index += 1) {
    segment(nodes[index - 1], nodes[index]);
  }
  if (closed && nodes.length > 2) segment(nodes[nodes.length - 1], nodes[0]);
  if (closed && points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (dist(first, last) <= 0.01) points.pop();
  }
  return points;
}

function rectOutline(rect: RectObject): Vec[] {
  const width = Math.max(0, rect.width);
  const height = Math.max(0, rect.height);
  const radius = Math.max(0, Math.min(rect.cornerRadius ?? 0, width / 2, height / 2));
  const local: Vec[] = [];
  if (radius <= 0.5) {
    local.push(
      { x: rect.x, y: rect.y },
      { x: rect.x + width, y: rect.y },
      { x: rect.x + width, y: rect.y + height },
      { x: rect.x, y: rect.y + height }
    );
  } else {
    const arc = (cx: number, cy: number, from: number, to: number) => {
      const steps = 4;
      for (let index = 0; index <= steps; index += 1) {
        const theta = from + ((to - from) * index) / steps;
        local.push({ x: cx + Math.cos(theta) * radius, y: cy + Math.sin(theta) * radius });
      }
    };
    arc(rect.x + width - radius, rect.y + radius, -Math.PI / 2, 0);
    arc(rect.x + width - radius, rect.y + height - radius, 0, Math.PI / 2);
    arc(rect.x + radius, rect.y + height - radius, Math.PI / 2, Math.PI);
    arc(rect.x + radius, rect.y + radius, Math.PI, (Math.PI * 3) / 2);
  }
  if (!rect.rotation) return local;
  const center = { x: rect.x + width / 2, y: rect.y + height / 2 };
  return local.map((point) => rotateAround(point, center, rect.rotation));
}

function ellipseOutline(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number
): Vec[] {
  const rx = Math.max(0.01, width / 2);
  const ry = Math.max(0.01, height / 2);
  const center = { x: x + rx, y: y + ry };
  const points: Vec[] = [];
  for (let index = 0; index < ELLIPSE_STEPS; index += 1) {
    const theta = (index / ELLIPSE_STEPS) * Math.PI * 2;
    const point = { x: center.x + Math.cos(theta) * rx, y: center.y + Math.sin(theta) * ry };
    points.push(rotation ? rotateAround(point, center, rotation) : point);
  }
  return points;
}

function boxOutline(rect: Rect, rotation: number): Vec[] {
  const corners: Vec[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height }
  ];
  if (!rotation) return corners;
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  return corners.map((point) => rotateAround(point, center, rotation));
}

function arrowCurvePoints(start: Vec, end: Vec): Vec[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / length, y: dx / length };
  const offset = Math.min(90, length * 0.32);
  const control = {
    x: (start.x + end.x) / 2 + normal.x * offset,
    y: (start.y + end.y) / 2 + normal.y * offset
  };
  const points: Vec[] = [];
  for (let index = 0; index <= 20; index += 1) {
    const t = index / 20;
    const mt = 1 - t;
    points.push({
      x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
      y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y
    });
  }
  return points;
}

function lineArrowHead(line: { start: Vec; end: Vec; style: SceneObject['style'] }): Vec[] | null {
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.01) return null;
  const ux = dx / length;
  const uy = dy / length;
  const size = Math.max(7, line.style.stroke.width * 4);
  const wing = size * 0.45;
  const base = { x: line.end.x - ux * size, y: line.end.y - uy * size };
  return [
    { x: line.end.x, y: line.end.y },
    { x: base.x - uy * wing, y: base.y + ux * wing },
    { x: base.x + uy * wing, y: base.y - ux * wing }
  ];
}

function hasStroke(obj: SceneObject): boolean {
  return obj.style.stroke.paint.type === 'solid' && obj.style.stroke.width > 0;
}

function hasFill(obj: SceneObject): boolean {
  return obj.style.fill.type === 'solid';
}

/**
 * 墨迹几何缓存：文档不可变更新，对象引用不变时几何也不会变。
 * 长画笔笔迹（上万节点）在连续擦除时不必每一帧重新扁平化。
 * 化学键依赖文档里的原子位置（chemBondShape 会按原子截短），不缓存。
 */
const inkCache = new WeakMap<SceneObject, ObjectInk>();

function buildObjectInk(obj: SceneObject, doc: VDrawDocument): ObjectInk | null {
  const cacheable = obj.type !== 'bond';
  if (cacheable) {
    const cached = inkCache.get(obj);
    if (cached) return cached;
  }
  const ink = computeObjectInk(obj, doc);
  if (ink && cacheable) inkCache.set(obj, ink);
  return ink;
}

/**
 * 生成对象真实渲染几何（页面坐标）。
 * 化学键用 chemBondShape 的实际线段/多边形，原子用标签包围盒，
 * 形状含旋转与圆角，画笔笔迹按逐节点宽度计算墨迹半宽。
 */
function computeObjectInk(obj: SceneObject, doc: VDrawDocument): ObjectInk | null {
  switch (obj.type) {
    case 'rect': {
      const outline = rectOutline(obj);
      const half = hasStroke(obj) ? Math.max(0.5, obj.style.stroke.width) / 2 : 0;
      return {
        bands: hasStroke(obj) ? [band(outline, true, half)] : [],
        fills: hasFill(obj) ? [outline] : [],
        strokeAreas: []
      };
    }
    case 'ellipse': {
      const outline = ellipseOutline(obj.x, obj.y, obj.width, obj.height, obj.rotation);
      const half = hasStroke(obj) ? Math.max(0.5, obj.style.stroke.width) / 2 : 0;
      return {
        bands: hasStroke(obj) ? [band(outline, true, half)] : [],
        fills: hasFill(obj) ? [outline] : [],
        strokeAreas: []
      };
    }
    case 'polygon': {
      const points = obj.points;
      if (points.length < 2) return null;
      const half = hasStroke(obj) ? Math.max(0.5, obj.style.stroke.width) / 2 : 0;
      return {
        bands: hasStroke(obj) ? [band(points, true, half)] : [],
        fills: hasFill(obj) ? [points] : [],
        strokeAreas: []
      };
    }
    case 'line': {
      const half = hasStroke(obj) ? Math.max(0.5, obj.style.stroke.width) / 2 : 0;
      const head = obj.arrowEnd ? lineArrowHead(obj) : null;
      return {
        bands: hasStroke(obj) ? [band([obj.start, obj.end], false, half)] : [],
        fills: [],
        strokeAreas: head ? [head] : []
      };
    }
    case 'path': {
      const points = flattenPath(obj.nodes, obj.closed);
      if (points.length === 0) return null;
      const widths = pathHalfWidths(obj.nodes, obj.style.stroke.width || 2);
      const half = hasStroke(obj) ? widths : [];
      const fills: Vec[][] = [];
      if (hasFill(obj)) {
        fills.push(points);
        for (const hole of obj.holes ?? []) {
          if (hole.length >= 3) fills.push(hole);
        }
      }
      return {
        bands: hasStroke(obj) ? [band(points, obj.closed, half)] : [],
        fills,
        strokeAreas: []
      };
    }
    case 'text': {
      if (!hasFill(obj)) return null;
      const outline = boxOutline(
        { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
        obj.rotation
      );
      return { bands: [], fills: [outline], strokeAreas: [] };
    }
    case 'annotation': {
      const outline = boxOutline(
        { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
        obj.rotation
      );
      return { bands: [], fills: [outline], strokeAreas: [] };
    }
    case 'atom': {
      // 标签命中区按实际字形宽度收紧，不要用 28×28 的粗略包围盒：
      // 在标签正上方 13px 处点击不应该把原子擦掉。
      const parts = atomParts(obj, doc.implicitHydrogens === true);
      const width = Math.max(22, parts.width + 18);
      const height = Math.max(20, parts.fontSize * 1.45);
      return {
        bands: [],
        fills: [
          boxOutline(
            {
              x: obj.position.x - width / 2,
              y: obj.position.y - height / 2,
              width,
              height
            },
            0
          )
        ],
        strokeAreas: []
      };
    }
    case 'bond': {
      const geometry = chemBondShape(doc, obj).geometry;
      const half = Math.max(0.6, obj.style.stroke.width || 2) / 2;
      const bands = geometry.segments.map((segment) =>
        band(
          [
            { x: segment.x1, y: segment.y1 },
            { x: segment.x2, y: segment.y2 }
          ],
          false,
          half
        )
      );
      if (geometry.wavyPath && bands.length === 0) {
        // 波浪键是路径字符串：用两端连线 + 波幅作为包络，避免解析 SVG path。
        bands.push(band([obj.start, obj.end], false, half + 3));
      }
      return {
        bands,
        fills: [],
        strokeAreas: geometry.polygons
      };
    }
    case 'arrow': {
      const geometry = buildArrowGeometry(obj.arrowKind, obj.start, obj.end);
      const half = Math.max(0.6, obj.style.stroke.width || 1.8) / 2;
      const bands = geometry.lines.map((line) =>
        band(
          [
            { x: line.x1, y: line.y1 },
            { x: line.x2, y: line.y2 }
          ],
          false,
          half
        )
      );
      if (geometry.curve) {
        bands.push(band(arrowCurvePoints(obj.start, obj.end), false, half));
      }
      const fills: Vec[][] = [];
      if (obj.label) {
        // 反应箭头的文字标签也属于可见墨迹：点文字同样应能擦到。
        const lines = obj.label.split('\n');
        const lineHeight = 13;
        const width = Math.max(
          12,
          ...lines.map((line) =>
            [...line].reduce(
              (sum, char) => sum + (/[\u4e00-\u9fa5]/.test(char) ? 12 : 12 * 0.58),
              0
            )
          )
        );
        const centerX = (obj.start.x + obj.end.x) / 2;
        const centerY = (obj.start.y + obj.end.y) / 2 - 10;
        fills.push(
          boxOutline(
            {
              x: centerX - width / 2,
              y: centerY - lineHeight,
              width,
              height: lines.length * lineHeight + 4
            },
            0
          )
        );
      }
      return { bands, fills, strokeAreas: geometry.polygons };
    }
    default:
      return null;
  }
}

/** 化学对象：由"擦除化学键"负责，普通图形选项不处理。 */
function isChemistryObject(obj: SceneObject): boolean {
  if (obj.type === 'bond' || obj.type === 'atom' || obj.type === 'ring' || obj.type === 'arrow') {
    return true;
  }
  if (obj.type !== 'group') return false;
  const group = obj as GroupObject;
  return Boolean(
    group.ringStyle ||
      group.ringFrame ||
      group.ringCircleStyle ||
      (group.ringCenters && group.ringCenters.length > 0)
  );
}

/** 父级隐藏/锁定时子对象同样不可擦除。 */
function isEditable(obj: SceneObject, byId: Map<string, SceneObject>): boolean {
  if (!obj.visible || obj.locked) return false;
  let parentId = obj.parentId;
  let guard = 0;
  while (parentId && guard < 32) {
    const parent = byId.get(parentId);
    if (!parent) break;
    if (!parent.visible || parent.locked) return false;
    parentId = parent.parentId;
    guard += 1;
  }
  return true;
}

function boundsOverlapPath(
  bounds: Rect,
  path: Vec[],
  radius: number
): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of path) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return (
    bounds.x - radius <= maxX &&
    bounds.y - radius <= maxY &&
    bounds.x + bounds.width + radius >= minX &&
    bounds.y + bounds.height + radius >= minY
  );
}

/** 去掉连续重合点：零长度线段会让法线/距离判定退化。 */
function dedupePath(path: Vec[]): Vec[] {
  const points: Vec[] = [];
  for (const point of path) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const last = points[points.length - 1];
    if (last && dist(last, point) <= 0.01) continue;
    points.push({ x: point.x, y: point.y });
  }
  return points;
}

/** 对象在当前目标下是否会被擦到（用于悬停预览，不修改文档）。 */
function wouldErase(
  obj: SceneObject,
  ink: ObjectInk,
  path: Vec[],
  options: EraseOptions
): boolean {
  const { targets, radius } = options;
  if (isChemistryObject(obj)) {
    return targets.chemistry && hitInk(ink, path, radius, 'ink');
  }
  // 开放线条（画笔/钢笔/直线）与形状轮廓片段都归“线条/描边”管：
  // 只按描边带判定，填充/化学目标不越权。
  if (isOpenLineObject(obj)) {
    return (
      targets.outline &&
      hasSolidStroke(obj) &&
      hitInk(ink, path, radius, 'stroke')
    );
  }
  // 闭合图形：填充只看填充区，线条/描边只看轮廓带，避免点图形内部误判线条。
  if (isClosedShapeObject(obj)) {
    if (targets.fill && fillObjectHit(obj, path, radius)) return true;
    if (targets.outline && hasSolidStroke(obj) && hitInk(ink, path, radius, 'stroke')) {
      return true;
    }
  }
  return false;
}

/** 悬停预览：返回笔刷当前位置会命中的最上层对象。 */
export function findErasableAt(
  doc: VDrawDocument,
  point: Vec,
  options: EraseOptions
): SceneObject | null {
  if (isEraserEmptyTargets(options.targets)) return null;
  const byId = new Map(allObjects(doc).map((obj) => [obj.id, obj]));
  const path = [point];
  for (let layerIndex = doc.layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layer = doc.layers[layerIndex];
    if (!layer.visible || layer.locked) continue;
    if (options.layerId && layer.id !== options.layerId) continue;
    for (let index = layer.objects.length - 1; index >= 0; index -= 1) {
      const obj = layer.objects[index];
      if (obj.type === 'group' || !isEditable(obj, byId)) continue;
      if (!boundsOverlapPath(getObjectBounds(obj, doc), path, options.radius)) continue;
      const ink = buildObjectInk(obj, doc);
      if (!ink) continue;
      if (wouldErase(obj, ink, path, options)) return obj;
    }
  }
  return null;
}

/** 删除原子时连带删除与之相连的键，避免留下悬空键线。 */
function connectedBondIds(doc: VDrawDocument, atomIds: Set<string>): string[] {
  if (atomIds.size === 0) return [];
  const atoms = allObjects(doc).filter(
    (obj): obj is AtomObject => obj.type === 'atom' && atomIds.has(obj.id)
  );
  if (atoms.length === 0) return [];
  const ids = new Set<string>();
  for (const obj of allObjects(doc)) {
    if (obj.type !== 'bond' || ids.has(obj.id)) continue;
    for (const atom of atoms) {
      if (dist(obj.start, atom.position) <= 1.5 || dist(obj.end, atom.position) <= 1.5) {
        ids.add(obj.id);
        break;
      }
    }
  }
  return [...ids];
}

/**
 * 沿一条笔刷扫掠轨迹擦除。
 *
 * 手势按 pointermove 分片调用即可：每片只与新增线段求距离，
 * 不会出现"整条轨迹重算"的成本，也不会漏掉快速划过的区段。
 */
export function eraseAlongPath(
  doc: VDrawDocument,
  path: Vec[],
  options: EraseOptions
): VDrawDocument {
  const { targets, radius } = options;
  if (path.length === 0 || radius <= 0) return doc;
  if (isEraserEmptyTargets(targets)) return doc;
  const gesture = dedupePath(path);
  if (gesture.length === 0) return doc;

  let next = doc;

  // 化学键按「键级阶梯」擦除：三键 → 双键 → 单键 → 删除；
  // 同一次手势（一次按下→抬起）对同一条键只降一级，避免快速划动连降两次。
  if (targets.chemistry) {
    const byId = new Map(allObjects(doc).map((obj) => [obj.id, obj]));
    const removeIds = new Set<string>();
    const downgrades = new Map<string, BondType>();
    for (const layer of doc.layers) {
      if (!layer.visible || layer.locked) continue;
      if (options.layerId && layer.id !== options.layerId) continue;
      for (const obj of layer.objects) {
        if (obj.type === 'group' || !isEditable(obj, byId)) continue;
        if (!isChemistryObject(obj)) continue;
        if (!boundsOverlapPath(getObjectBounds(obj, doc), gesture, radius)) continue;
        const ink = buildObjectInk(obj, doc);
        if (!ink || !hitInk(ink, gesture, radius, 'ink')) continue;
        if (obj.type === 'bond') {
          if (options.degradedBondIds?.has(obj.id)) continue;
          const downgraded = prevBondOrderType(obj.bondType);
          if (downgraded) {
            options.degradedBondIds?.add(obj.id);
            downgrades.set(obj.id, downgraded);
            continue;
          }
        }
        removeIds.add(obj.id);
      }
    }
    const atomIds = new Set(
      [...removeIds].filter((id) => byId.get(id)?.type === 'atom')
    );
    for (const id of connectedBondIds(doc, atomIds)) {
      removeIds.add(id);
      // 键随原子一起消失时，降级没有意义。
      downgrades.delete(id);
    }
    for (const [id, bondType] of downgrades) {
      next = replaceObject(next, id, (obj) =>
        obj.type === 'bond'
          ? {
              ...obj,
              bondType,
              // 双键的第二条线只对双键有意义；降成单键时清掉环内侧标记。
              ringInnerSide: bondType === 'double' ? obj.ringInnerSide : undefined
            }
          : obj
      );
    }
    if (removeIds.size > 0) next = eraseObjects(next, [...removeIds]);
  }

  // 线条/描边 与 填充：沿轨迹做区域擦除，两者互不越权。
  if (targets.outline || targets.fill) {
    next = eraseRegionAlongPath(next, gesture, {
      radius,
      layerId: options.layerId,
      targets: {
        outline: targets.outline,
        fill: targets.fill
      }
    });
  }

  if (next === doc) return doc;
  return cleanupAfterErase(next);
}

/**
 * 删除对象并做结构善后：
 * - 递归清理空编组；
 * - 环被擦断后解除芳香内圈标记；
 * - 重算编组包围盒，避免选择框/命中区停留在旧位置。
 */
export function eraseObjects(doc: VDrawDocument, ids: string[]): VDrawDocument {
  if (ids.length === 0) return doc;
  return cleanupAfterErase(doc, ids);
}

/** 区域擦除后的同款善后：空编组、断环标记与编组包围盒。 */
export function cleanupAfterErase(
  doc: VDrawDocument,
  removedIds: string[] = []
): VDrawDocument {
  let next = removedIds.length > 0 ? removeObjectsById(doc, removedIds) : doc;

  for (let guard = 0; guard < 16; guard += 1) {
    const objects = allObjects(next);
    const parents = new Set(
      objects.map((obj) => obj.parentId).filter((id): id is string => Boolean(id))
    );
    const emptyGroups = objects
      .filter((obj) => obj.type === 'group' && !parents.has(obj.id))
      .map((obj) => obj.id);
    if (emptyGroups.length === 0) break;
    next = removeObjectsById(next, emptyGroups);
  }

  next = {
    ...next,
    layers: next.layers.map((layer) => {
      const objects = layer.objects;
      return {
        ...layer,
        objects: objects.map((obj): SceneObject => {
          if (obj.type !== 'group') return obj;
          const children = objects.filter((child) => child.parentId === obj.id);
          let group = obj;
          const geometry = ringGeometry(
            children.filter((child): child is BondObject => child.type === 'bond')
          );
          const closed = Boolean(geometry && geometry.closed);
          if (obj.ringStyle && !closed) {
            group = { ...group, ringStyle: undefined };
          }
          // 稠环的内圈圆心同样依附于闭合骨架：骨架断开后不能留下孤立圆圈。
          if (!closed && (obj.ringCircleStyle || obj.ringCenters)) {
            group = { ...group, ringCircleStyle: undefined, ringCenters: undefined };
          }
          if (children.length > 0) {
            const bounds = unionRects(children.map((child) => getObjectBounds(child, next)));
            group = {
              ...group,
              // 区域擦除会把子对象切成片段：同步 childIds，图层面板才能继续挂在编组下。
              childIds: children.map((child) => child.id),
              x: bounds.x - 8,
              y: bounds.y - 8,
              width: bounds.width + 16,
              height: bounds.height + 16
            };
          }
          return group;
        })
      };
    })
  };

  return next;
}
