import type { EraseStroke, PathObject, SceneObject, Vec } from '../types/document';

/**
 * 填充擦除的 mask 表示。
 *
 * 为什么不用「外轮廓 + 反向孔洞子路径」：
 * - nonzero 下多个重叠孔洞的绕序会相加，2 个以上重叠就重新变成非零填充（黑块）；
 * - 孔洞越过外轮廓时，外轮廓之外、孔洞之内的区域也会被涂上填充色（外泄）；
 * - 孔洞不合并还会有 240 个的上限，长手势会丢失最早擦除。
 *
 * mask 里黑色 = 擦掉、白色 = 保留：重叠黑块天然合并，黑块画到外轮廓之外也不会
 * 影响填充（填充路径本身只有外轮廓），因此没有反填、外泄和上限问题。
 */

const MASK_MARGIN = 2;

export function hasEraseMask(object: {
  holes?: Vec[][];
  eraseStrokes?: EraseStroke[];
}): boolean {
  return (
    (object.holes?.some((hole) => hole.length >= 3) ?? false) ||
    (object.eraseStrokes?.some((stroke) => stroke.points.length > 0 && stroke.radius > 0) ??
      false)
  );
}

export function eraseMaskId(id: string): string {
  return `erase-${id}`;
}

/** 线条/描边擦除轨迹（独立于填充 eraseStrokes）。 */
export function hasStrokeErase(object: { strokeEraseStrokes?: EraseStroke[] }): boolean {
  return (
    object.strokeEraseStrokes?.some(
      (stroke) => stroke.points.length > 0 && stroke.radius > 0
    ) ?? false
  );
}

export function strokeEraseMaskId(id: string): string {
  return `stroke-erase-${id}`;
}

function round(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 100) / 100);
}

function polygonData(points: Vec[]): string {
  if (points.length === 0) return '';
  return `M${points.map((point) => `${round(point.x)} ${round(point.y)}`).join('L')}Z`;
}

function polylineData(points: Vec[]): string {
  if (points.length === 0) return '';
  return `M${points.map((point) => `${round(point.x)} ${round(point.y)}`).join('L')}`;
}

type MaskBounds = { x: number; y: number; width: number; height: number };

function strokeParts(strokes: EraseStroke[]): string[] {
  const parts: string[] = [];
  for (const stroke of strokes) {
    if (stroke.points.length === 0 || stroke.radius <= 0) continue;
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      parts.push(
        `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="${round(
          stroke.radius
        )}" fill="#000"/>`
      );
    } else {
      parts.push(
        `<path d="${polylineData(stroke.points)}" fill="none" stroke="#000" stroke-width="${round(
          stroke.radius * 2
        )}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
  }
  return parts;
}

function maskElement(id: string, bounds: MaskBounds, parts: string[]): string {
  return (
    `<mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" ` +
    `x="${round(bounds.x)}" y="${round(bounds.y)}" width="${round(bounds.width)}" height="${round(
      bounds.height
    )}" style="mask-type:luminance">` +
    `<rect x="${round(bounds.x)}" y="${round(bounds.y)}" width="${round(
      bounds.width
    )}" height="${round(bounds.height)}" fill="#fff"/>${parts.join('')}</mask>`
  );
}

/** 填充 mask 区域：覆盖外轮廓（含贝塞尔控制点）即可。 */
export function eraseMaskBounds(object: PathObject): MaskBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (point: Vec) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };
  for (const node of object.nodes) {
    include({ x: node.x, y: node.y });
    if (node.handleIn) include({ x: node.x + node.handleIn.x, y: node.y + node.handleIn.y });
    if (node.handleOut) include({ x: node.x + node.handleOut.x, y: node.y + node.handleOut.y });
  }
  if (!Number.isFinite(minX)) {
    return {
      x: object.x - MASK_MARGIN,
      y: object.y - MASK_MARGIN,
      width: object.width + MASK_MARGIN * 2,
      height: object.height + MASK_MARGIN * 2
    };
  }
  return {
    x: minX - MASK_MARGIN,
    y: minY - MASK_MARGIN,
    width: maxX - minX + MASK_MARGIN * 2,
    height: maxY - minY + MASK_MARGIN * 2
  };
}

/** 填充擦除 mask：孔洞 + 擦除轨迹都只作用于 fill。 */
export function eraseMaskDef(object: PathObject): string {
  if (!hasEraseMask(object)) return '';
  const parts: string[] = [];
  for (const hole of object.holes ?? []) {
    if (hole.length < 3) continue;
    parts.push(`<path d="${polygonData(hole)}" fill="#000"/>`);
  }
  parts.push(...strokeParts(object.eraseStrokes ?? []));
  return maskElement(eraseMaskId(object.id), eraseMaskBounds(object), parts);
}

/** 线条/描边 mask 区域：几何 + 描边/箭头/画笔宽度 + 橡皮半径的保守外扩。 */
export function strokeEraseMaskBounds(object: SceneObject): MaskBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (point: Vec) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };
  if (object.type === 'line') {
    include(object.start);
    include(object.end);
  } else if (object.type === 'polygon') {
    object.points.forEach(include);
  } else if (object.type === 'path') {
    for (const node of object.nodes) {
      include({ x: node.x, y: node.y });
      if (node.handleIn) include({ x: node.x + node.handleIn.x, y: node.y + node.handleIn.y });
      if (node.handleOut) include({ x: node.x + node.handleOut.x, y: node.y + node.handleOut.y });
    }
  } else if (object.type === 'rect' || object.type === 'ellipse') {
    // mask 包在无旋转的 <g> 上、子元素再旋转：区域按外接圆取，覆盖任意角度。
    const cx = object.x + object.width / 2;
    const cy = object.y + object.height / 2;
    const radius = Math.hypot(object.width, object.height) / 2;
    include({ x: cx - radius, y: cy - radius });
    include({ x: cx + radius, y: cy + radius });
  } else {
    include({ x: object.x, y: object.y });
    include({ x: object.x + object.width, y: object.y + object.height });
  }
  if (!Number.isFinite(minX)) {
    minX = object.x;
    minY = object.y;
    maxX = object.x + object.width;
    maxY = object.y + object.height;
  }
  const maxStroke = Math.max(
    1,
    object.style.stroke.width || 0,
    ...(object.type === 'path'
      ? object.nodes.map((node) => (typeof node.width === 'number' ? node.width : 0))
      : [])
  );
  const maxRadius = Math.max(
    0,
    ...(object.strokeEraseStrokes ?? []).map((stroke) => stroke.radius)
  );
  // 覆盖箭头（约 4×线宽）、画笔宽度和橡皮半径。
  const margin = Math.max(16, maxStroke * 6, maxRadius + maxStroke, maxStroke * 1.5);
  return {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2
  };
}

/** 线条/描边 mask：黑色轨迹只裁掉 stroke/ink，不碰 fill。 */
export function strokeEraseMaskDef(object: SceneObject): string {
  if (!hasStrokeErase(object)) return '';
  return maskElement(
    strokeEraseMaskId(object.id),
    strokeEraseMaskBounds(object),
    strokeParts(object.strokeEraseStrokes ?? [])
  );
}

// ---- 几何：让命中判定与 mask 使用同一套「并集」语义 ----

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointSegmentDistance(point: Vec, start: Vec, end: Vec): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return dist(point, start);
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

function pointInPolygon(point: Vec, polygon: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

function polylineDistance(point: Vec, points: Vec[]): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return dist(point, points[0]);
  let best = Infinity;
  for (let index = 0; index < points.length - 1; index += 1) {
    best = Math.min(best, pointSegmentDistance(point, points[index], points[index + 1]));
    if (best <= 0) return 0;
  }
  return best;
}

function polylineToPolylineDistance(path: Vec[], points: Vec[]): number {
  if (path.length === 0 || points.length === 0) return Infinity;
  if (path.length === 1) return polylineDistance(path[0], points);
  if (points.length === 1) return polylineDistance(points[0], path);
  let best = Infinity;
  for (let a = 0; a < path.length - 1; a += 1) {
    for (let b = 0; b < points.length - 1; b += 1) {
      best = Math.min(
        best,
        segmentSegmentDistance(path[a], path[a + 1], points[b], points[b + 1])
      );
      if (best <= 0) return 0;
    }
  }
  return best;
}

function polylineToPolygonDistance(path: Vec[], polygon: Vec[]): number {
  if (polygon.length < 2) return Infinity;
  let best = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const distance =
      path.length === 1
        ? pointSegmentDistance(path[0], a, b)
        : polylineToPolylineDistance(path, [a, b]);
    best = Math.min(best, distance);
    if (best <= 0) return 0;
  }
  return best;
}

/** 点是否落在已擦除区域（旧 holes 并集 + 新 eraseStrokes 并集）。 */
export function pointErasedFill(object: PathObject, point: Vec): boolean {
  for (const hole of object.holes ?? []) {
    if (hole.length >= 3 && pointInPolygon(point, hole)) return true;
  }
  for (const stroke of object.eraseStrokes ?? []) {
    if (stroke.radius > 0 && polylineDistance(point, stroke.points) <= stroke.radius) {
      return true;
    }
  }
  return false;
}

/**
 * 笔刷扫掠区是否碰到「仍然可见的填充」。
 * 可见填充 = 外轮廓内 && 不在任何 holes/eraseStrokes 内；
 * 边界命中按外轮廓边、孔洞边、擦除描边边分别计算。
 */
export function pathHitsVisibleFill(
  outer: Vec[],
  holes: Vec[][],
  strokes: EraseStroke[],
  path: Vec[],
  radius: number
): boolean {
  if (outer.length < 3 || path.length === 0) return false;
  for (const point of path) {
    if (
      pointInPolygon(point, outer) &&
      !holes.some((hole) => hole.length >= 3 && pointInPolygon(point, hole)) &&
      !strokes.some(
        (stroke) => stroke.radius > 0 && polylineDistance(point, stroke.points) <= stroke.radius
      )
    ) {
      return true;
    }
  }
  if (polylineToPolygonDistance(path, outer) <= radius) return true;
  for (const hole of holes) {
    if (hole.length >= 3 && polylineToPolygonDistance(path, hole) <= radius) return true;
  }
  for (const stroke of strokes) {
    if (stroke.radius <= 0) continue;
    const distance = polylineToPolylineDistance(path, stroke.points);
    if (Math.abs(distance - stroke.radius) <= radius) return true;
  }
  return false;
}

// ---- 对象变换：孔洞/擦除轨迹必须跟节点一起走 ----

export function mapEraseHoles(
  holes: Vec[][] | undefined,
  mapPoint: (point: Vec) => Vec
): Vec[][] | undefined {
  return holes?.map((hole) => hole.map(mapPoint));
}

export function mapEraseStrokes(
  strokes: EraseStroke[] | undefined,
  mapPoint: (point: Vec) => Vec,
  radiusScale: number
): EraseStroke[] | undefined {
  return strokes?.map((stroke) => ({
    points: stroke.points.map(mapPoint),
    radius: Math.max(0.1, stroke.radius * radiusScale)
  }));
}
