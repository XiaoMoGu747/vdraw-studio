import type { AtomObject, BondObject, VDrawDocument, Vec } from '../../types/document';
import { allObjects, expandSelection, getLayerOfObject } from '../scene';

interface LayoutNode {
  position: Vec;
  atomIds: string[];
}

interface LayoutEdge {
  a: number;
  b: number;
  bondId: string;
}

function keyOf(point: Vec): string {
  return `${Math.round(point.x * 2) / 2},${Math.round(point.y * 2) / 2}`;
}

/**
 * 基础结构整理：以键长为弹簧、节点间斥力为约束做 2D 松弛，
 * 让环系趋于正多边形、链状结构键角展开。仅处理平面几何，不涉及构象或 3D。
 */
export function cleanupStructure(
  doc: VDrawDocument,
  scopeIds: string[] = []
): { doc: VDrawDocument; moved: number } {
  const scope = scopeIds.length > 0 ? new Set(expandSelection(doc, scopeIds)) : null;
  const visibleUnlocked = (obj: { id: string }) => {
    const layer = getLayerOfObject(doc, obj.id);
    return Boolean(layer?.visible && !layer.locked);
  };
  let objects = allObjects(doc).filter((obj) => visibleUnlocked(obj));
  if (scope) {
    const scopedBonds = objects.filter(
      (obj): obj is BondObject => obj.type === 'bond' && scope.has(obj.id)
    );
    // 选中一根键时，端点上的显式原子也必须一起移动，否则键会被拉回原位。
    for (const atom of objects) {
      if (atom.type !== 'atom') continue;
      if (
        scopedBonds.some(
          (bond) =>
            Math.hypot(atom.position.x - bond.start.x, atom.position.y - bond.start.y) < 1.2 ||
            Math.hypot(atom.position.x - bond.end.x, atom.position.y - bond.end.y) < 1.2
        )
      ) {
        scope.add(atom.id);
      }
    }
    objects = objects.filter((obj) => scope.has(obj.id));
  }
  const bonds = objects.filter((obj): obj is BondObject => obj.type === 'bond');
  const atoms = objects.filter((obj): obj is AtomObject => obj.type === 'atom');

  if (bonds.length === 0) return { doc, moved: 0 };

  const nodeMap = new Map<string, LayoutNode>();
  const edges: LayoutEdge[] = [];

  const ensureNode = (point: Vec): number => {
    const key = keyOf(point);
    const existing = nodeMap.get(key);
    if (existing) return [...nodeMap.keys()].indexOf(key);
    nodeMap.set(key, { position: { x: point.x, y: point.y }, atomIds: [] });
    return nodeMap.size - 1;
  };

  const indexByKey = new Map<string, number>();
  const ensure = (point: Vec): number => {
    const key = keyOf(point);
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = ensureNode(point);
    indexByKey.set(key, index);
    return index;
  };

  for (const bond of bonds) {
    const a = ensure(bond.start);
    const b = ensure(bond.end);
    if (a === b) continue;
    edges.push({ a, b, bondId: bond.id });
  }

  const nodes = [...nodeMap.values()];
  for (const atom of atoms) {
    const key = keyOf(atom.position);
    const index = indexByKey.get(key);
    if (index !== undefined) nodes[index].atomIds.push(atom.id);
  }

  if (nodes.length === 0 || edges.length === 0) return { doc, moved: 0 };

  const lengths = edges.map((edge) => {
    const a = nodes[edge.a].position;
    const b = nodes[edge.b].position;
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
  const sorted = [...lengths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 42;
  const ideal = Math.min(52, Math.max(34, median));

  const positions = nodes.map((node) => ({ ...node.position }));
  const degrees = nodes.map(() => 0);
  for (const edge of edges) {
    degrees[edge.a] += 1;
    degrees[edge.b] += 1;
  }

  // 节点越多，固定 220 次 O(n²) 越容易卡顿；按规模收敛，小结构也足够展开键角。
  const iterations = Math.min(220, Math.max(60, 60 + nodes.length * 4));
  for (let step = 0; step < iterations; step += 1) {
    const forces = positions.map(() => ({ x: 0, y: 0 }));

    for (const edge of edges) {
      const a = positions[edge.a];
      const b = positions[edge.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.max(0.001, Math.hypot(dx, dy));
      const correction = (length - ideal) * 0.22;
      const ux = dx / length;
      const uy = dy / length;
      forces[edge.a].x += ux * correction;
      forces[edge.a].y += uy * correction;
      forces[edge.b].x -= ux * correction;
      forces[edge.b].y -= uy * correction;
    }

    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const dx = positions[j].x - positions[i].x;
        const dy = positions[j].y - positions[i].y;
        const distance = Math.max(0.001, Math.hypot(dx, dy));
        if (distance > ideal * 2.4) continue;
        const strength = Math.min(2.2, (ideal * 0.9) / (distance * distance)) * 0.6;
        const ux = dx / distance;
        const uy = dy / distance;
        forces[i].x -= ux * strength;
        forces[i].y -= uy * strength;
        forces[j].x += ux * strength;
        forces[j].y += uy * strength;
      }
    }

    for (let i = 0; i < positions.length; i += 1) {
      const fx = forces[i].x;
      const fy = forces[i].y;
      const magnitude = Math.hypot(fx, fy);
      const limit = 3.2;
      if (magnitude > limit) {
        positions[i].x += (fx / magnitude) * limit;
        positions[i].y += (fy / magnitude) * limit;
      } else {
        positions[i].x += fx;
        positions[i].y += fy;
      }
    }
  }

  let shiftX = 0;
  let shiftY = 0;
  for (let i = 0; i < positions.length; i += 1) {
    shiftX += positions[i].x - nodes[i].position.x;
    shiftY += positions[i].y - nodes[i].position.y;
  }
  shiftX /= positions.length;
  shiftY /= positions.length;
  for (const position of positions) {
    position.x = Math.round((position.x - shiftX) * 2) / 2;
    position.y = Math.round((position.y - shiftY) * 2) / 2;
  }

  const indexForPoint = (point: Vec): number | undefined => indexByKey.get(keyOf(point));
  const nodePosition = (point: Vec): Vec | null => {
    const index = indexForPoint(point);
    return index === undefined ? null : positions[index];
  };

  const nextLayers = doc.layers.map((layer) => ({
    ...layer,
    objects: layer.objects.map((obj) => {
      if (obj.type === 'bond') {
        const start = nodePosition(obj.start) ?? obj.start;
        const end = nodePosition(obj.end) ?? obj.end;
        return { ...obj, start, end };
      }
      if (obj.type === 'atom') {
        const position = nodePosition(obj.position);
        return position ? { ...obj, position } : obj;
      }
      return obj;
    })
  }));

  return {
    doc: { ...doc, layers: nextLayers, updatedAt: new Date().toISOString() },
    moved: nodes.length
  };
}
