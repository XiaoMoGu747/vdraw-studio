import type { AtomObject, BondObject, GroupObject, VDrawDocument, Vec } from '../../types/document';
import {
  allObjects,
  expandSelection,
  getLayerOfObject,
  getObject,
  getObjectBounds,
  unionRects
} from '../scene';

interface LayoutNode {
  key: string;
  position: Vec;
  atomIds: string[];
}

interface LayoutEdge {
  a: number;
  b: number;
  bondId: string;
}

interface LayoutComponent {
  nodes: number[];
  edges: LayoutEdge[];
}

interface CleanupResult {
  doc: VDrawDocument;
  /** 实际移动过的节点数。 */
  moved: number;
  /** 识别到的有机结构数量。 */
  structures: number;
  /** 与规范不一致、被重新排布的结构数量。 */
  changed: number;
}

const DEG = Math.PI / 180;
/** 常见二维结构式键角：三元环 / 方形 / 五元环 / sp3 / 六元环 / 七元环 / 八元环 / 直线。 */
const NORM_ANGLES = [60, 90, 108, 109.5, 120, 128.6, 135, 180];
const ANGLE_TOLERANCE = 10;

function keyOf(point: Vec): string {
  return `${Math.round(point.x * 2) / 2},${Math.round(point.y * 2) / 2}`;
}

function normalize(vec: Vec): Vec {
  const length = Math.hypot(vec.x, vec.y);
  return length > 0.0001 ? { x: vec.x / length, y: vec.y / length } : { x: 1, y: 0 };
}

function angleAt(vertex: Vec, a: Vec, b: Vec): number {
  const first = normalize({ x: a.x - vertex.x, y: a.y - vertex.y });
  const second = normalize({ x: b.x - vertex.x, y: b.y - vertex.y });
  const dot = Math.max(-1, Math.min(1, first.x * second.x + first.y * second.y));
  return Math.acos(dot) / DEG;
}

function rotate(vec: Vec, radians: number): Vec {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: vec.x * cos - vec.y * sin, y: vec.x * sin + vec.y * cos };
}

function median(values: number[]): number {
  if (values.length === 0) return 40;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function degreeMap(component: LayoutComponent): number[] {
  const degrees = new Array(component.nodes.length).fill(0);
  for (const edge of component.edges) {
    degrees[edge.a] += 1;
    degrees[edge.b] += 1;
  }
  return degrees;
}

function componentAdjacency(component: LayoutComponent): { node: number; edge: LayoutEdge }[][] {
  const adjacency: { node: number; edge: LayoutEdge }[][] = component.nodes.map(() => []);
  for (const edge of component.edges) {
    adjacency[edge.a].push({ node: edge.b, edge });
    adjacency[edge.b].push({ node: edge.a, edge });
  }
  return adjacency;
}

function edgeLengths(nodes: LayoutNode[], edges: LayoutEdge[]): number[] {
  return edges.map((edge) => {
    const a = nodes[edge.a].position;
    const b = nodes[edge.b].position;
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
}

/**
 * 判断结构是否已经符合规范：所有键长接近，且每个节点键角落在常见规范角上。
 * 规范结构直接跳过，避免“整理”把用户已经画好的结构轻微挪动。
 */
function isRegularComponent(
  nodes: LayoutNode[],
  component: LayoutComponent,
  ideal: number
): boolean {
  if (component.nodes.length === 0) return true;
  const lengths = edgeLengths(nodes, component.edges);
  const lengthTolerance = Math.max(0.75, ideal * 0.035);
  if (lengths.some((length) => Math.abs(length - ideal) > lengthTolerance)) return false;

  const adjacency = componentAdjacency(component);
  for (let index = 0; index < component.nodes.length; index += 1) {
    const neighbors = adjacency[index];
    if (neighbors.length < 2) continue;
    const angles: number[] = [];
    for (let i = 0; i < neighbors.length; i += 1) {
      for (let j = i + 1; j < neighbors.length; j += 1) {
        angles.push(
          angleAt(
            nodes[index].position,
            nodes[neighbors[i].node].position,
            nodes[neighbors[j].node].position
          )
        );
      }
    }
    if (neighbors.length === 2) {
      const angle = angles[0];
      if (!NORM_ANGLES.some((expected) => Math.abs(angle - expected) <= ANGLE_TOLERANCE)) {
        return false;
      }
      continue;
    }
    if (angles.some((angle) => angle < 52)) return false;
    if (
      !angles.some((angle) =>
        [90, 109.5, 120, 135].some((expected) => Math.abs(angle - expected) <= ANGLE_TOLERANCE)
      )
    ) {
      return false;
    }
  }
  return true;
}

function translateToCentroid(positions: Vec[], originals: Vec[]): void {
  const oldCenter = originals.reduce(
    (acc, point) => ({ x: acc.x + point.x / originals.length, y: acc.y + point.y / originals.length }),
    { x: 0, y: 0 }
  );
  const newCenter = positions.reduce(
    (acc, point) => ({ x: acc.x + point.x / positions.length, y: acc.y + point.y / positions.length }),
    { x: 0, y: 0 }
  );
  const dx = oldCenter.x - newCenter.x;
  const dy = oldCenter.y - newCenter.y;
  for (const position of positions) {
    position.x += dx;
    position.y += dy;
  }
}

/** 单环：保持中心与第一个顶点方向，整理成标准正多边形。 */
function layoutCycle(
  nodes: LayoutNode[],
  component: LayoutComponent,
  ideal: number
): Vec[] | null {
  if (component.edges.length !== component.nodes.length || component.nodes.length < 3) return null;
  const adjacency = componentAdjacency(component);
  if (adjacency.some((neighbors) => neighbors.length !== 2)) return null;

  const ordered: number[] = [];
  let previous = -1;
  // component.nodes 存全局索引，而布局函数内部只用局部下标。
  let current = 0;
  while (ordered.length < component.nodes.length && current !== undefined) {
    ordered.push(current);
    const next = adjacency[current].find(
      (item) => item.node !== previous && !ordered.includes(item.node)
    );
    if (!next) break;
    previous = current;
    current = next.node;
  }
  if (ordered.length !== component.nodes.length) return null;

  const originals = ordered.map((index) => nodes[index].position);
  const center = originals.reduce(
    (acc, point) => ({ x: acc.x + point.x / originals.length, y: acc.y + point.y / originals.length }),
    { x: 0, y: 0 }
  );
  const area = originals.reduce((sum, point, index) => {
    const next = originals[(index + 1) % originals.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  const direction = area >= 0 ? 1 : -1;
  const startAngle =
    originals[0].x === center.x && originals[0].y === center.y
      ? 0
      : Math.atan2(originals[0].y - center.y, originals[0].x - center.x);
  const radius = ideal / (2 * Math.sin(Math.PI / ordered.length));
  const next: Vec[] = new Array(component.nodes.length);
  ordered.forEach((nodeIndex, index) => {
    const angle = startAngle + direction * index * (Math.PI * 2) / ordered.length;
    next[nodeIndex] = {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius
    };
  });
  return next;
}

/** 无环结构：从叶子出发按 120° 锯齿排布，保留分支方向与整体中心。 */
function layoutTree(
  nodes: LayoutNode[],
  component: LayoutComponent,
  ideal: number
): Vec[] | null {
  if (component.edges.length !== component.nodes.length - 1) return null;
  const adjacency = componentAdjacency(component);
  const degrees = degreeMap(component);
  const localIndices = component.nodes.map((_, index) => index);
  const root = localIndices.find((index) => degrees[index] === 1) ?? localIndices[0];
  // 叶子根能让链首方向原样保留，避免整条链被无缘无故旋转。
  if (root === undefined) return null;

  const positions: Vec[] = new Array(component.nodes.length);
  positions[root] = { ...nodes[root].position };
  const queue: number[] = [root];
  const visited = new Set<number>([root]);

  const nearestAssignment = (candidates: Vec[], children: number[], parent: number): Map<number, Vec> => {
    const assignment = new Map<number, Vec>();
    const remaining = [...children];
    for (const candidate of candidates) {
      if (remaining.length === 0) break;
      let best = remaining[0];
      let bestScore = -Infinity;
      for (const child of remaining) {
        const current = normalize({
          x: nodes[child].position.x - nodes[parent].position.x,
          y: nodes[child].position.y - nodes[parent].position.y
        });
        const score = current.x * candidate.x + current.y * candidate.y;
        if (score > bestScore) {
          bestScore = score;
          best = child;
        }
      }
      assignment.set(best, candidate);
      remaining.splice(remaining.indexOf(best), 1);
    }
    return assignment;
  };

  while (queue.length > 0) {
    const index = queue.shift()!;
    const parent = (() => {
      // 父节点取已入队且与当前节点相连的节点；根节点没有父节点。
      if (index === root) return null;
      return adjacency[index].find((item) => visited.has(item.node) && positions[item.node])?.node ?? null;
    })();
    const parentPoint = positions[index];
    const children = adjacency[index]
      .map((item) => item.node)
      .filter((node) => node !== parent && !visited.has(node));
    if (children.length === 0) continue;

    let directions: Vec[];
    if (parent === null) {
      const currentDirs = children.map((child) =>
        normalize({
          x: nodes[child].position.x - nodes[index].position.x,
          y: nodes[child].position.y - nodes[index].position.y
        })
      );
      const spread =
        children.length === 2 ? 120 : 360 / Math.max(1, children.length);
      const base = Math.atan2(currentDirs[0].y, currentDirs[0].x);
      const candidates = children.map((_, childIndex) => {
        const angle = base + childIndex * spread * DEG;
        return { x: Math.cos(angle), y: Math.sin(angle) };
      });
      directions = candidates;
    } else {
      const inDir = normalize({
        x: positions[index].x - positions[parent].x,
        y: positions[index].y - positions[parent].y
      });
      const angles =
        children.length >= 3 ? [-60, 0, 60] : children.length === 2 ? [-60, 60] : [60, -60];
      directions = angles.map((angle) => rotate(inDir, angle * DEG));
    }

    const assignment = nearestAssignment(directions, children, index);
    for (const child of children) {
      const direction = assignment.get(child) ?? directions[0];
      positions[child] = {
        x: parentPoint.x + direction.x * ideal,
        y: parentPoint.y + direction.y * ideal
      };
      visited.add(child);
      queue.push(child);
    }
  }

  if (positions.some((position) => !position)) return null;
  translateToCentroid(
    positions,
    component.nodes.map((_, localIndex) => nodes[localIndex].position)
  );
  return positions;
}

/** 稠环/复杂分支的兜底：弹簧 + 斥力松弛，仍保持整体中心与大致方向。 */
function layoutRelaxed(
  nodes: LayoutNode[],
  component: LayoutComponent,
  ideal: number
): Vec[] {
  const positions = component.nodes.map((_, localIndex) => ({ ...nodes[localIndex].position }));
  const localEdges = component.edges;
  const iterations = Math.min(240, Math.max(80, 70 + component.nodes.length * 5));
  for (let step = 0; step < iterations; step += 1) {
    const forces = positions.map(() => ({ x: 0, y: 0 }));
    for (const edge of localEdges) {
      const a = positions[edge.a];
      const b = positions[edge.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.max(0.001, Math.hypot(dx, dy));
      const correction = (length - ideal) * 0.24;
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
  translateToCentroid(
    positions,
    component.nodes.map((_, localIndex) => nodes[localIndex].position)
  );
  return positions;
}

/**
 * 结构自动整理：只处理与规范不符的连通结构。
 * - 单环排成正多边形；
 * - 无环结构按 120° 锯齿展开；
 * - 稠环/复杂分支用弹簧松弛兜底；
 * - 已符合键长与键角规范的结构保持原样。
 */
export function cleanupStructure(doc: VDrawDocument, scopeIds: string[] = []): CleanupResult {
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
  if (bonds.length === 0) {
    return { doc, moved: 0, structures: 0, changed: 0 };
  }

  const nodes: LayoutNode[] = [];
  const indexByKey = new Map<string, number>();
  const ensureNode = (point: Vec): number => {
    const key = keyOf(point);
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = nodes.length;
    indexByKey.set(key, index);
    nodes.push({ key, position: { ...point }, atomIds: [] });
    return index;
  };

  const edges: LayoutEdge[] = [];
  for (const bond of bonds) {
    const a = ensureNode(bond.start);
    const b = ensureNode(bond.end);
    if (a === b) continue;
    edges.push({ a, b, bondId: bond.id });
  }
  for (const atom of atoms) {
    const index = indexByKey.get(keyOf(atom.position));
    if (index !== undefined) nodes[index].atomIds.push(atom.id);
  }

  const adjacency: number[][] = nodes.map(() => []);
  for (const edge of edges) {
    adjacency[edge.a].push(edge.b);
    adjacency[edge.b].push(edge.a);
  }

  const components: LayoutComponent[] = [];
  const visited = new Set<number>();
  for (let start = 0; start < nodes.length; start += 1) {
    if (visited.has(start)) continue;
    const queue = [start];
    visited.add(start);
    const nodeSet = new Set<number>([start]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adjacency[current]) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        nodeSet.add(neighbor);
        queue.push(neighbor);
      }
    }
    const nodeList = [...nodeSet];
    const localIndex = new Map<number, number>();
    nodeList.forEach((node, index) => localIndex.set(node, index));
    const componentEdges = edges
      .filter((edge) => nodeSet.has(edge.a) && nodeSet.has(edge.b))
      .map((edge) => ({
        ...edge,
        a: localIndex.get(edge.a)!,
        b: localIndex.get(edge.b)!
      }));
    if (componentEdges.length > 0) {
      components.push({ nodes: nodeList, edges: componentEdges });
    }
  }

  const nextPositions = nodes.map((node) => ({ ...node.position }));
  let moved = 0;
  let changed = 0;

  for (const component of components) {
    const localNodes = component.nodes.map((index) => nodes[index]);
    const lengths = edgeLengths(
      component.nodes.map((index) => nodes[index]),
      component.edges
    );
    const ideal = Math.max(2, Math.round(median(lengths) * 2) / 2);
    if (isRegularComponent(localNodes, component, ideal)) continue;

    const layout =
      layoutCycle(localNodes, component, ideal) ??
      layoutTree(localNodes, component, ideal) ??
      layoutRelaxed(localNodes, component, ideal);
    let componentMoved = 0;
    component.nodes.forEach((globalIndex, localIndex) => {
      const next = layout[localIndex];
      if (!next) return;
      if (Math.hypot(next.x - nodes[globalIndex].position.x, next.y - nodes[globalIndex].position.y) > 0.15) {
        componentMoved += 1;
      }
      nextPositions[globalIndex] = next;
    });
    if (componentMoved > 0) {
      changed += 1;
      moved += componentMoved;
    }
  }

  if (changed === 0) {
    return { doc, moved: 0, structures: components.length, changed: 0 };
  }

  const positionFor = (point: Vec): Vec | null => {
    const index = indexByKey.get(keyOf(point));
    if (index === undefined) return null;
    return nextPositions[index];
  };

  // 稠环内圈圆心依附于环骨架：用整组节点的相似变换同步更新，避免内圈错位。
  const groupUpdates = new Map<
    string,
    { ringCenters?: Vec[]; ringScale?: number }
  >();
  for (const obj of objects) {
    if (obj.type !== 'group' || !obj.ringCenters || obj.ringCenters.length === 0) continue;
    const group = obj as GroupObject;
    const childBonds = group.childIds
      .map((id) => getObject(doc, id))
      .filter((child): child is BondObject => Boolean(child && child.type === 'bond'));
    const points: Vec[] = [];
    for (const bond of childBonds) {
      for (const point of [bond.start, bond.end]) {
        if (!points.some((item) => Math.hypot(item.x - point.x, item.y - point.y) < 0.5)) {
          points.push(point);
        }
      }
    }
    if (points.length < 2) continue;
    const mapped = points.map((point) => positionFor(point));
    if (mapped.some((point) => !point)) continue;
    const mappedPoints = mapped.filter((point): point is Vec => point !== null);
    const rawCenters = group.ringCenters ?? [];
    let first = 0;
    let second = 1;
    let maxDistance = 0;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const distance = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
        if (distance > maxDistance) {
          maxDistance = distance;
          first = i;
          second = j;
        }
      }
    }
    if (maxDistance < 0.1) continue;
    if (rawCenters.length === 1) {
      // 单环：内圈圆心直接取新骨架的几何中心，半径按新旧平均半径同比缩放。
      const oldCenter = points.reduce(
        (acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }),
        { x: 0, y: 0 }
      );
      const newCenter = mappedPoints.reduce(
        (acc, point) => ({
          x: acc.x + point.x / mappedPoints.length,
          y: acc.y + point.y / mappedPoints.length
        }),
        { x: 0, y: 0 }
      );
      const oldRadius =
        points.reduce(
          (sum, point) => sum + Math.hypot(point.x - oldCenter.x, point.y - oldCenter.y),
          0
        ) / points.length;
      const newRadius =
        mappedPoints.reduce(
          (sum, point) =>
            sum + Math.hypot(point.x - newCenter.x, point.y - newCenter.y),
          0
        ) / mappedPoints.length;
      if (oldRadius > 0.1) {
        groupUpdates.set(group.id, {
          ringCenters: [newCenter],
          ringScale: Math.max(0.05, (group.ringScale ?? 1) * (newRadius / oldRadius))
        });
        continue;
      }
    }
    const oldVector = {
      x: points[second].x - points[first].x,
      y: points[second].y - points[first].y
    };
    const newVector = {
      x: mappedPoints[second].x - mappedPoints[first].x,
      y: mappedPoints[second].y - mappedPoints[first].y
    };
    const scale = Math.hypot(newVector.x, newVector.y) / maxDistance;
    const rotation = Math.atan2(newVector.y, newVector.x) - Math.atan2(oldVector.y, oldVector.x);
    const anchor = mappedPoints[first];
    const centers = rawCenters.map((center) => {
      const relative = {
        x: (center.x - points[first].x) * scale,
        y: (center.y - points[first].y) * scale
      };
      const rotated = rotate(relative, rotation);
      return { x: anchor.x + rotated.x, y: anchor.y + rotated.y };
    });
    groupUpdates.set(group.id, {
      ringCenters: centers,
      ringScale: Math.max(0.05, (group.ringScale ?? 1) * scale)
    });
  }

  const nextLayers = doc.layers.map((layer) => ({
    ...layer,
    objects: layer.objects.map((obj) => {
      if (obj.type === 'bond') {
        const start = positionFor(obj.start) ?? obj.start;
        const end = positionFor(obj.end) ?? obj.end;
        return { ...obj, start, end };
      }
      if (obj.type === 'atom') {
        const position = positionFor(obj.position);
        return position ? { ...obj, position } : obj;
      }
      if (obj.type === 'group' && groupUpdates.has(obj.id)) {
        return { ...obj, ...groupUpdates.get(obj.id) };
      }
      return obj;
    })
  }));

  let nextDoc: VDrawDocument = {
    ...doc,
    layers: nextLayers,
    updatedAt: new Date().toISOString()
  };

  // 编组的 x/y/width/height 跟随子对象包围盒，保持选框与命中区域一致。
  nextDoc = {
    ...nextDoc,
    layers: nextDoc.layers.map((layer) => ({
      ...layer,
      objects: layer.objects.map((obj) => {
        if (obj.type !== 'group' || !groupUpdates.has(obj.id)) return obj;
        const children = obj.childIds
          .map((id) => getObject(nextDoc, id))
          .filter((child): child is NonNullable<typeof child> => Boolean(child));
        if (children.length === 0) return obj;
        const bounds = unionRects(children.map((child) => getObjectBounds(child, nextDoc)));
        return { ...obj, ...bounds };
      })
    }))
  };

  return { doc: nextDoc, moved, structures: components.length, changed };
}
