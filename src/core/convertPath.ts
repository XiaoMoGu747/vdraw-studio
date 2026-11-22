import type {
  EllipseObject,
  LineObject,
  PathNode,
  PathObject,
  PolygonObject,
  RectObject,
  SceneObject,
  Vec
} from '../types/document';
import { boundsOfPoints } from './scene';

const KAPPA = 0.5522847498;

function rotatePointAround(point: Vec, center: Vec, degrees: number): Vec {
  if (!degrees) return point;
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

function rotateVector(vector: Vec, degrees: number): Vec {
  if (!degrees) return vector;
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
}

function node(
  id: string,
  point: Vec,
  handleIn: Vec | null = null,
  handleOut: Vec | null = null
): PathNode {
  return {
    id,
    x: point.x,
    y: point.y,
    handleIn,
    handleOut,
    type: handleIn && handleOut ? 'smooth' : 'corner'
  };
}

function bakeRotation(nodes: PathNode[], center: Vec, degrees: number): PathNode[] {
  if (!degrees) return nodes;
  return nodes.map((item) => {
    const point = rotatePointAround({ x: item.x, y: item.y }, center, degrees);
    return {
      ...item,
      x: point.x,
      y: point.y,
      handleIn: item.handleIn ? rotateVector(item.handleIn, degrees) : null,
      handleOut: item.handleOut ? rotateVector(item.handleOut, degrees) : null
    };
  });
}

function rectNodes(obj: RectObject): PathNode[] {
  const x = obj.x;
  const y = obj.y;
  const w = obj.width;
  const h = obj.height;
  const r = Math.max(0, Math.min(obj.cornerRadius ?? 0, w / 2, h / 2));
  const prefix = `${obj.id}-`;
  if (r <= 0.01) {
    return [
      node(`${prefix}n0`, { x, y }),
      node(`${prefix}n1`, { x: x + w, y }),
      node(`${prefix}n2`, { x: x + w, y: y + h }),
      node(`${prefix}n3`, { x, y: y + h })
    ];
  }
  const k = r * KAPPA;
  return [
    node(`${prefix}n0`, { x: x + r, y }, { x: -k, y: 0 }, null),
    node(`${prefix}n1`, { x: x + w - r, y }, null, { x: k, y: 0 }),
    node(`${prefix}n2`, { x: x + w, y: y + r }, { x: 0, y: -k }, null),
    node(`${prefix}n3`, { x: x + w, y: y + h - r }, null, { x: 0, y: k }),
    node(`${prefix}n4`, { x: x + w - r, y: y + h }, { x: k, y: 0 }, null),
    node(`${prefix}n5`, { x: x + r, y: y + h }, null, { x: -k, y: 0 }),
    node(`${prefix}n6`, { x, y: y + h - r }, { x: 0, y: k }, null),
    node(`${prefix}n7`, { x, y: y + r }, null, { x: 0, y: -k })
  ];
}

function ellipseNodes(obj: EllipseObject): PathNode[] {
  const cx = obj.x + obj.width / 2;
  const cy = obj.y + obj.height / 2;
  const rx = obj.width / 2;
  const ry = obj.height / 2;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const prefix = `${obj.id}-`;
  return [
    node(`${prefix}n0`, { x: cx, y: cy - ry }, { x: -kx, y: 0 }, { x: kx, y: 0 }),
    node(`${prefix}n1`, { x: cx + rx, y: cy }, { x: 0, y: -ky }, { x: 0, y: ky }),
    node(`${prefix}n2`, { x: cx, y: cy + ry }, { x: kx, y: 0 }, { x: -kx, y: 0 }),
    node(`${prefix}n3`, { x: cx - rx, y: cy }, { x: 0, y: ky }, { x: 0, y: -ky })
  ];
}

function polygonNodes(obj: PolygonObject): PathNode[] {
  return obj.points.map((point, index) => node(`${obj.id}-n${index}`, point));
}

function lineNodes(obj: LineObject): PathNode[] {
  return [
    node(`${obj.id}-n0`, obj.start),
    node(`${obj.id}-n1`, obj.end)
  ];
}

function asPath(obj: SceneObject, nodes: PathNode[], closed: boolean): PathObject | null {
  if (nodes.length < 2) return null;
  const points = nodes.flatMap((item) => {
    const list = [{ x: item.x, y: item.y }];
    if (item.handleIn) list.push({ x: item.x + item.handleIn.x, y: item.y + item.handleIn.y });
    if (item.handleOut) list.push({ x: item.x + item.handleOut.x, y: item.y + item.handleOut.y });
    return list;
  });
  const widest = obj.style.stroke.width;
  const bounds = boundsOfPoints(points, Math.max(2, widest));
  return {
    ...obj,
    type: 'path',
    nodes,
    closed,
    rotation: 0,
    holes: undefined,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

/** 单个形状转路径；不支持的类型返回 null。 */
export function convertObjectToPath(obj: SceneObject): PathObject | null {
  if (obj.type === 'rect') {
    const center = { x: obj.x + obj.width / 2, y: obj.y + obj.height / 2 };
    return asPath(obj, bakeRotation(rectNodes(obj), center, obj.rotation ?? 0), true);
  }
  if (obj.type === 'ellipse') {
    const center = { x: obj.x + obj.width / 2, y: obj.y + obj.height / 2 };
    return asPath(obj, bakeRotation(ellipseNodes(obj), center, obj.rotation ?? 0), true);
  }
  if (obj.type === 'polygon') return asPath(obj, polygonNodes(obj), true);
  if (obj.type === 'line') return asPath(obj, lineNodes(obj), false);
  return null;
}

/** 批量转换：返回新对象列表与跳过数量。 */
export function convertSelectionToPaths(
  objects: SceneObject[]
): { converted: Map<string, PathObject>; skipped: number } {
  const converted = new Map<string, PathObject>();
  let skipped = 0;
  for (const obj of objects) {
    // 编组/化学对象/文本/箭头不参与形状转换。
    if (obj.type === 'group' || obj.type === 'path' || obj.type === 'text') {
      skipped += 1;
      continue;
    }
    const path = convertObjectToPath(obj);
    if (!path) {
      skipped += 1;
      continue;
    }
    converted.set(obj.id, path);
  }
  return { converted, skipped };
}
