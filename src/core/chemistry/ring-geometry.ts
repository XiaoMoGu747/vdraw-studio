import type { BondObject, Vec } from '../../types/document';

const vertexKey = (point: Vec): string =>
  `${Math.round(point.x / 2)}:${Math.round(point.y / 2)}`;

export interface RingGeometry {
  center: Vec;
  /** 环顶点到环心的半径 */
  vertexRadius: number;
  /** 内圈半径：与骨架同心，不随取代基变化 */
  circleRadius: number;
  vertices: Vec[];
  ringBonds: BondObject[];
  /** 环是否仍然闭合（擦断任意一条环键后为 false） */
  closed: boolean;
}

interface Edge {
  key: string;
  bond: BondObject;
}

/**
 * 找出编组中真正构成环的键。
 * 仅按顶点度数会把延伸出去的第二段取代基误判成环键（导致环闭合判断失败），
 * 因此改为在键图中搜索简单环，取最长的 5–8 元环。
 */
export function groupRingBonds(bonds: BondObject[]): BondObject[] {
  if (bonds.length < 4) return [];
  const adjacency = new Map<string, Edge[]>();
  const addEdge = (from: string, to: string, bond: BondObject) => {
    const list = adjacency.get(from) ?? [];
    list.push({ key: to, bond });
    adjacency.set(from, list);
  };
  for (const bond of bonds) {
    const start = vertexKey(bond.start);
    const end = vertexKey(bond.end);
    if (start === end) continue;
    addEdge(start, end, bond);
    addEdge(end, start, bond);
  }

  const cycles = new Map<string, BondObject[]>();
  const maxDepth = 8;

  const walk = (
    start: string,
    current: string,
    visited: Set<string>,
    path: BondObject[]
  ) => {
    if (path.length >= maxDepth) return;
    for (const edge of adjacency.get(current) ?? []) {
      if (edge.key === start && path.length >= 4) {
        const cycle = [...path, edge.bond];
        if (cycle.length >= 5 && cycle.length <= maxDepth) {
          const signature = cycle
            .map((bond) => bond.id)
            .sort()
            .join('|');
          if (!cycles.has(signature)) cycles.set(signature, cycle);
        }
        continue;
      }
      if (visited.has(edge.key)) continue;
      if (edge.key < start) continue; // 每个环只从最小顶点出发一次
      visited.add(edge.key);
      walk(start, edge.key, visited, [...path, edge.bond]);
      visited.delete(edge.key);
    }
  };

  for (const start of [...adjacency.keys()].sort()) {
    walk(start, start, new Set([start]), []);
  }

  let best: BondObject[] = [];
  for (const cycle of cycles.values()) {
    if (cycle.length > best.length) best = cycle;
  }
  return best;
}

/**
 * 由环内键本身推导环几何：内圈圆使用骨架顶点而不是编组包围盒，
 * 这样挂上取代基后内圈仍与六元环同心同径，不会错位。
 */
export function ringGeometry(bonds: BondObject[]): RingGeometry | null {
  const ringBonds = groupRingBonds(bonds);
  if (ringBonds.length < 3) return null;

  const vertices: Vec[] = [];
  for (const bond of ringBonds) {
    for (const point of [bond.start, bond.end]) {
      if (!vertices.some((item) => Math.hypot(item.x - point.x, item.y - point.y) < 0.5)) {
        vertices.push({ x: point.x, y: point.y });
      }
    }
  }
  if (vertices.length < 3) return null;

  const center = vertices.reduce(
    (acc, point) => ({
      x: acc.x + point.x / vertices.length,
      y: acc.y + point.y / vertices.length
    }),
    { x: 0, y: 0 }
  );
  const vertexRadius =
    vertices.reduce(
      (sum, point) => sum + Math.hypot(point.x - center.x, point.y - center.y),
      0
    ) / vertices.length;

  const degree = new Map<string, number>();
  for (const bond of ringBonds) {
    degree.set(vertexKey(bond.start), (degree.get(vertexKey(bond.start)) ?? 0) + 1);
    degree.set(vertexKey(bond.end), (degree.get(vertexKey(bond.end)) ?? 0) + 1);
  }
  const closed =
    vertices.every((point) => (degree.get(vertexKey(point)) ?? 0) === 2) &&
    ringBonds.length >= 5;

  return {
    center,
    vertexRadius,
    // 标准鲍林式内圈：约为外接圆半径的 0.55，避免贴边
    circleRadius: vertexRadius * 0.55,
    vertices,
    ringBonds,
    closed
  };
}
