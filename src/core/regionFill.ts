import type { Vec } from '../types/document';

/**
 * 区域填充：把"可见线稿"栅格化成障碍，从点击点做连通填充，
 * 再沿像素边界追踪轮廓并简化为矢量多边形。
 * 纯函数部分（掩码/轮廓/简化）无 DOM 依赖，便于单测。
 */

export interface RegionFillResult {
  outline: Vec[];
  holes: Vec[][];
}

/** 从种子点做 4 邻域填充，返回连通区域掩码（1=区域内）。 */
export function floodRegionMask(
  blocked: Uint8Array,
  width: number,
  height: number,
  seed: { x: number; y: number }
): Uint8Array | null {
  const sx = Math.round(seed.x);
  const sy = Math.round(seed.y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const start = sy * width + sx;
  if (blocked[start]) return null;

  const mask = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  mask[start] = 1;

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = (index / width) | 0;
    if (x > 0 && !blocked[index - 1] && !mask[index - 1]) {
      mask[index - 1] = 1;
      queue[tail++] = index - 1;
    }
    if (x + 1 < width && !blocked[index + 1] && !mask[index + 1]) {
      mask[index + 1] = 1;
      queue[tail++] = index + 1;
    }
    if (y > 0 && !blocked[index - width] && !mask[index - width]) {
      mask[index - width] = 1;
      queue[tail++] = index - width;
    }
    if (y + 1 < height && !blocked[index + width] && !mask[index + width]) {
      mask[index + width] = 1;
      queue[tail++] = index + width;
    }
  }
  return mask;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Marching Squares：把 0/1 掩码转成边界线段。 */
function maskSegments(mask: Uint8Array, width: number, height: number): Segment[] {
  const segments: Segment[] = [];
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x]);

  const top = (x: number, y: number) => ({ x: x + 0.5, y });
  const right = (x: number, y: number) => ({ x: x + 1, y: y + 0.5 });
  const bottom = (x: number, y: number) => ({ x: x + 0.5, y: y + 1 });
  const left = (x: number, y: number) => ({ x, y: y + 0.5 });

  for (let y = -1; y < height; y += 1) {
    for (let x = -1; x < width; x += 1) {
      const a = at(x, y);
      const b = at(x + 1, y);
      const c = at(x + 1, y + 1);
      const d = at(x, y + 1);
      const code = a | (b << 1) | (c << 2) | (d << 3);
      if (code === 0 || code === 15) continue;
      const t = top(x, y);
      const r = right(x, y);
      const bt = bottom(x, y);
      const l = left(x, y);
      const push = (p: { x: number; y: number }, q: { x: number; y: number }) =>
        segments.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y });

      switch (code) {
        case 1:
        case 14:
          push(l, t);
          break;
        case 2:
        case 13:
          push(t, r);
          break;
        case 3:
        case 12:
          push(l, r);
          break;
        case 4:
        case 11:
          push(r, bt);
          break;
        case 6:
        case 9:
          push(t, bt);
          break;
        case 7:
        case 8:
          push(l, bt);
          break;
        // 对角冲突：拆成两段，避免轮廓自交
        case 5:
          push(l, t);
          push(r, bt);
          break;
        case 10:
          push(t, r);
          push(bt, l);
          break;
        default:
          break;
      }
    }
  }
  return segments;
}

const keyOf = (x: number, y: number) => `${Math.round(x * 2)}:${Math.round(y * 2)}`;

/** 把线段首尾相接成闭合环。 */
export function traceRegionLoops(mask: Uint8Array, width: number, height: number): Vec[][] {
  const segments = maskSegments(mask, width, height);
  if (segments.length === 0) return [];

  const endpointMap = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    const k1 = keyOf(segment.x1, segment.y1);
    const k2 = keyOf(segment.x2, segment.y2);
    if (!endpointMap.has(k1)) endpointMap.set(k1, []);
    if (!endpointMap.has(k2)) endpointMap.set(k2, []);
    endpointMap.get(k1)!.push(index);
    endpointMap.get(k2)!.push(index);
  });

  const used = new Uint8Array(segments.length);
  const loops: Vec[][] = [];

  for (let startIndex = 0; startIndex < segments.length; startIndex += 1) {
    if (used[startIndex]) continue;
    const first = segments[startIndex];
    used[startIndex] = 1;
    const points: Vec[] = [{ x: first.x1, y: first.y1 }, { x: first.x2, y: first.y2 }];
    let currentKey = keyOf(first.x2, first.y2);
    const startKey = keyOf(first.x1, first.y1);

    for (let guard = 0; guard < segments.length + 4; guard += 1) {
      if (currentKey === startKey) break;
      const candidates = endpointMap.get(currentKey) ?? [];
      const nextIndex = candidates.find((index) => !used[index]);
      if (nextIndex === undefined) break;
      used[nextIndex] = 1;
      const segment = segments[nextIndex];
      const nextPoint =
        keyOf(segment.x1, segment.y1) === currentKey
          ? { x: segment.x2, y: segment.y2 }
          : { x: segment.x1, y: segment.y1 };
      points.push(nextPoint);
      currentKey = keyOf(nextPoint.x, nextPoint.y);
    }

    if (points.length >= 4) {
      // 去掉闭合时重复的起点
      const last = points[points.length - 1];
      if (Math.hypot(last.x - points[0].x, last.y - points[0].y) < 0.01) points.pop();
      if (points.length >= 3) loops.push(points);
    }
  }
  return loops;
}

/** 有符号面积（正=逆时针）。 */
export function loopArea(points: Vec[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

/** Ramer–Douglas–Peucker：闭合多边形简化。 */
export function simplifyLoop(points: Vec[], epsilon: number): Vec[] {
  if (points.length <= 4 || epsilon <= 0) return points;
  const first = points[0];
  let farthest = 0;
  let distance = -1;
  for (let index = 1; index < points.length; index += 1) {
    const d = Math.hypot(points[index].x - first.x, points[index].y - first.y);
    if (d > distance) {
      distance = d;
      farthest = index;
    }
  }
  const partA = points.slice(0, farthest + 1);
  const partB = [...points.slice(farthest), points[0]];
  const simplified = [...rdp(partA, epsilon).slice(0, -1), ...rdp(partB, epsilon).slice(0, -1)];
  return simplified.length >= 3 ? simplified : points;
}

function rdp(points: Vec[], epsilon: number): Vec[] {
  if (points.length <= 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  let index = -1;
  let max = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = pointSegmentDistance(points[i], first, last);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (index !== -1 && max > epsilon) {
    const leftPart = rdp(points.slice(0, index + 1), epsilon);
    const rightPart = rdp(points.slice(index), epsilon);
    return [...leftPart.slice(0, -1), ...rightPart];
  }
  return [first, last];
}

function pointSegmentDistance(point: Vec, start: Vec, end: Vec): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

/**
 * 掩码 → 填充轮廓：最大环作为外轮廓，其余作为孔洞（统一绕序）。
 * scale 用于把像素坐标换算回页面坐标。
 */
export function maskToRegion(mask: Uint8Array, width: number, height: number, scale: number): RegionFillResult | null {
  const loops = traceRegionLoops(mask, width, height)
    .map((loop) => simplifyLoop(loop, 1.2))
    .filter((loop) => Math.abs(loopArea(loop)) > 6)
    .map((loop) => loop.map((point) => ({ x: point.x / scale, y: point.y / scale })));
  if (loops.length === 0) return null;

  const sorted = [...loops].sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
  const outline = sorted[0];
  const outlineSign = Math.sign(loopArea(outline)) || 1;
  const holes = sorted.slice(1).map((loop) => {
    const sign = Math.sign(loopArea(loop));
    const points = sign === outlineSign ? [...loop].reverse() : loop;
    return points;
  });
  return { outline, holes };
}
