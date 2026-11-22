import type { PathNode, Vec } from '../types/document';
import { createNodeId } from './id';

export interface StrokeIntersection {
  indexA: number;
  indexB: number;
  point: Vec;
}

interface StrokeIntersectionDetail extends StrokeIntersection {
  tA: number;
  tB: number;
}

interface IntersectionHit {
  point: Vec;
  t: number;
  u: number;
}

function segmentIntersection(a: Vec, b: Vec, c: Vec, d: Vec): IntersectionHit | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denominator;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denominator;
  // 端点相接不算自交（相邻段共享端点会被这里排除）
  if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) return null;
  return { point: { x: a.x + rx * t, y: a.y + ry * t }, t, u };
}

/**
 * 找中心线的全部自交（按弦段近似，忽略相邻段）。
 * 交点按路径先后排序，供切成多段使用；笔迹较短时直接跳过，避免无意义的 O(n²)。
 */
export function findStrokeSelfIntersections(nodes: PathNode[]): StrokeIntersectionDetail[] {
  if (nodes.length < 4) return [];
  const hits: StrokeIntersectionDetail[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) continue;
    for (let j = i + 2; j < nodes.length - 1; j += 1) {
      const c = nodes[j];
      const d = nodes[j + 1];
      if (Math.hypot(d.x - c.x, d.y - c.y) < 0.5) continue;
      const hit = segmentIntersection(a, b, c, d);
      if (hit) {
        hits.push({ indexA: i, indexB: j, point: hit.point, tA: hit.t, tB: hit.u });
      }
    }
  }
  return hits;
}

/** 兼容旧接口：只返回第一处自交。 */
export function findStrokeSelfIntersection(nodes: PathNode[]): StrokeIntersection | null {
  return findStrokeSelfIntersections(nodes)[0] ?? null;
}

function widthAlong(nodes: PathNode[], index: number, t: number): number | undefined {
  const start = nodes[index];
  const end = nodes[index + 1];
  const startWidth = start?.width;
  const endWidth = end?.width;
  if (typeof startWidth !== 'number' && typeof endWidth !== 'number') return undefined;
  const a = typeof startWidth === 'number' ? startWidth : endWidth!;
  const b = typeof endWidth === 'number' ? endWidth : startWidth!;
  return a + (b - a) * t;
}

function lerp(start: Vec, end: Vec, t: number): Vec {
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}

/** 用 de Casteljau 在参数 t 处切开三次贝塞尔，保留切线方向，避免切点变折线。 */
function splitSegment(nodes: PathNode[], index: number, t: number) {
  const a = nodes[index];
  const b = nodes[index + 1];
  const p0 = { x: a.x, y: a.y };
  const p1 = a.handleOut ? { x: a.x + a.handleOut.x, y: a.y + a.handleOut.y } : p0;
  const p3 = { x: b.x, y: b.y };
  const p2 = b.handleIn ? { x: b.x + b.handleIn.x, y: b.y + b.handleIn.y } : p3;
  const q0 = lerp(p0, p1, t);
  const q1 = lerp(p1, p2, t);
  const q2 = lerp(p2, p3, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const point = lerp(r0, r1, t);
  return {
    point,
    inHandle: { x: r0.x - point.x, y: r0.y - point.y },
    outHandle: { x: r1.x - point.x, y: r1.y - point.y }
  };
}

function copyNode(node: PathNode): PathNode {
  return {
    ...node,
    id: createNodeId(),
    handleIn: node.handleIn ? { ...node.handleIn } : null,
    handleOut: node.handleOut ? { ...node.handleOut } : null
  };
}

function cutNode(
  source: PathNode,
  point: Vec,
  width: number | undefined,
  handleIn: Vec | null,
  handleOut: Vec | null
): PathNode {
  return {
    id: createNodeId(),
    x: point.x,
    y: point.y,
    handleIn,
    handleOut,
    type: handleIn || handleOut ? 'smooth' : 'corner',
    ...(typeof width === 'number' ? { width } : {}),
    ...(typeof source.nibAngle === 'number' ? { nibAngle: source.nibAngle } : {}),
    ...(typeof source.nibAspect === 'number' ? { nibAspect: source.nibAspect } : {})
  };
}

/**
 * 在全部自交处把笔迹切成若干段：每段只在交叉点重叠，
 * 低不透明度绘制时会出现真实墨水式的叠色，而不是整条路径一个 opacity。
 */
export function splitStrokeAtSelfIntersection(nodes: PathNode[]): PathNode[][] | null {
  const hits = findStrokeSelfIntersections(nodes);
  if (hits.length === 0) return null;

  interface Cut {
    point: Vec;
    width?: number;
    inHandle: Vec;
    outHandle: Vec;
    segment: number;
    t: number;
  }

  const cuts: Cut[] = [];
  for (const hit of hits) {
    for (const [index, t] of [
      [hit.indexA, hit.tA],
      [hit.indexB, hit.tB]
    ] as const) {
      const split = splitSegment(nodes, index, t);
      cuts.push({
        point: split.point,
        width: widthAlong(nodes, index, t),
        inHandle: split.inHandle,
        outHandle: split.outHandle,
        segment: index,
        t
      });
    }
  }

  const bySegment = new Map<number, Cut[]>();
  for (const cut of cuts) {
    const list = bySegment.get(cut.segment) ?? [];
    // 同一段上参数几乎相同的交点只切一次，避免退化节点。
    if (!list.some((item) => Math.abs(item.t - cut.t) < 1e-4)) list.push(cut);
    bySegment.set(cut.segment, list);
  }
  for (const list of bySegment.values()) list.sort((a, b) => a.t - b.t);

  const parts: PathNode[][] = [];
  let current: PathNode[] = [copyNode(nodes[0])];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    for (const cut of bySegment.get(index) ?? []) {
      current.push(
        cutNode(nodes[index], cut.point, cut.width, cut.inHandle, null)
      );
      parts.push(current);
      current = [
        cutNode(nodes[index], cut.point, cut.width, null, cut.outHandle)
      ];
    }
    current.push(copyNode(nodes[index + 1]));
  }
  parts.push(current);

  const valid = parts.filter((part) => part.length >= 2);
  return valid.length >= 2 ? valid : null;
}
