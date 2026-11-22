import type {
  GroupObject,
  SceneObject,
  SymmetryAxis,
  SymmetryMode,
  VDrawDocument,
  Vec
} from '../types/document';
import { createId } from './id';
import { getObjectBounds, unionRects } from './scene';

type MirrorKind = 'x' | 'y' | 'xy';

function mirrorPoint(point: Vec, kind: MirrorKind, ax: number, ay: number): Vec {
  if (kind === 'x') return { x: 2 * ax - point.x, y: point.y };
  if (kind === 'y') return { x: point.x, y: 2 * ay - point.y };
  return { x: 2 * ax - point.x, y: 2 * ay - point.y };
}

/** 镜像后笔尖长轴方向：左右翻转取补角，上下翻转取反，四象限再加 π。 */
function mirrorAngle(angle: number, kind: MirrorKind): number {
  const next = kind === 'x' ? Math.PI - angle : kind === 'y' ? -angle : angle + Math.PI;
  return Math.atan2(Math.sin(next), Math.cos(next));
}

function mirrorKinds(mode: SymmetryMode): MirrorKind[] {
  if (mode === 'vertical') return ['x'];
  if (mode === 'horizontal') return ['y'];
  if (mode === 'both') return ['x', 'y', 'xy'];
  return [];
}

function mirrorOne(object: SceneObject, kind: MirrorKind, ax: number, ay: number): SceneObject | null {
  const next: SceneObject = { ...object, id: createId(object.type) };
  switch (next.type) {
    case 'rect':
    case 'ellipse':
    case 'text': {
      const topLeft = mirrorPoint({ x: next.x, y: next.y }, kind, ax, ay);
      const bottomRight = mirrorPoint(
        { x: next.x + next.width, y: next.y + next.height },
        kind,
        ax,
        ay
      );
      next.x = Math.min(topLeft.x, bottomRight.x);
      next.y = Math.min(topLeft.y, bottomRight.y);
      next.rotation =
        kind === 'xy' ? next.rotation ?? 0 : (-(next.rotation ?? 0) + 360) % 360;
      if (next.type === 'text' && kind !== 'y') {
        // 文本镜像保持可读，但左右对齐要跟着翻转，否则镜像列会向轴外溢出。
        next.align = next.align === 'left' ? 'right' : next.align === 'right' ? 'left' : 'center';
      }
      break;
    }
    case 'line':
    case 'bond':
    case 'arrow': {
      next.start = mirrorPoint(next.start, kind, ax, ay);
      next.end = mirrorPoint(next.end, kind, ax, ay);
      break;
    }
    case 'polygon': {
      next.points = next.points.map((point) => mirrorPoint(point, kind, ax, ay));
      break;
    }
    case 'path': {
      next.nodes = next.nodes.map((node) => ({
        ...node,
        id: createId('node'),
        ...mirrorPoint(node, kind, ax, ay),
        handleIn: node.handleIn ? mirrorPoint(node.handleIn, kind, 0, 0) : null,
        handleOut: node.handleOut ? mirrorPoint(node.handleOut, kind, 0, 0) : null,
        ...(typeof node.nibAngle === 'number'
          ? { nibAngle: mirrorAngle(node.nibAngle, kind) }
          : {})
      }));
      break;
    }
    case 'atom': {
      next.position = mirrorPoint(next.position, kind, ax, ay);
      break;
    }
    case 'group':
      return null;
    default:
      return null;
  }
  return next;
}

/** 把单个点按对称轴映射出所有镜像点。 */
export function mirrorPointList(
  point: Vec,
  axis: SymmetryAxis,
  mode: SymmetryMode,
  pageWidth: number,
  pageHeight: number
): Vec[] {
  const ax = axis.x * pageWidth;
  const ay = axis.y * pageHeight;
  return mirrorKinds(mode).map((kind) => mirrorPoint(point, kind, ax, ay));
}

/** 镜像一个场景对象；编组请使用 mirrorGroupWithChildren。 */
export function mirrorObject(
  object: SceneObject,
  axis: SymmetryAxis,
  mode: SymmetryMode,
  pageWidth: number,
  pageHeight: number
): SceneObject[] {
  const ax = axis.x * pageWidth;
  const ay = axis.y * pageHeight;
  return mirrorKinds(mode).flatMap((kind) => {
    const next = mirrorOne(object, kind, ax, ay);
    return next ? [{ ...next, mirrorOf: object.id, mirrorKind: kind }] : [];
  });
}

/**
 * 重新生成所有镜像：以源对象的最新几何/样式覆盖镜像副本（保持镜像 id 不变）。
 * 源对象被删除的镜像会被丢弃。
 */
export function regenerateMirrors(
  doc: VDrawDocument,
  axis: SymmetryAxis,
  mode: SymmetryMode,
  pageWidth: number,
  pageHeight: number
): { doc: VDrawDocument; changed: number; removed: number } {
  if (mode === 'none') return { doc, changed: 0, removed: 0 };
  const ax = axis.x * pageWidth;
  const ay = axis.y * pageHeight;
  const sources = new Map<string, SceneObject>();
  for (const layer of doc.layers) {
    for (const object of layer.objects) {
      if (!object.mirrorOf) sources.set(object.id, object);
    }
  }

  let changed = 0;
  let removed = 0;
  const layers = doc.layers.map((layer) => {
    const objects: SceneObject[] = [];
    for (const object of layer.objects) {
      // 编组镜像涉及父子重建，交给 mirrorGroupWithChildren，重新生成时原样保留。
      if (!object.mirrorOf || object.type === 'group') {
        objects.push(object);
        continue;
      }
      const source = sources.get(object.mirrorOf);
      if (!source) {
        removed += 1;
        continue;
      }
      const kind = object.mirrorKind ?? 'x';
      const next = mirrorOne(source, kind, ax, ay);
      if (!next) {
        removed += 1;
        continue;
      }
      objects.push({
        ...next,
        id: object.id,
        layerId: layer.id,
        name: object.name,
        mirrorOf: source.id,
        mirrorKind: kind
      });
      changed += 1;
    }
    return { ...layer, objects };
  });

  return { doc: { ...doc, layers }, changed, removed };
}

/**
 * 镜像一个编组及其子对象。
 * 子对象保留形状与层级关系，parentId 指向新的编组，包围盒重新计算。
 */
export function mirrorGroupWithChildren(
  group: GroupObject,
  children: SceneObject[],
  axis: SymmetryAxis,
  mode: SymmetryMode,
  pageWidth: number,
  pageHeight: number
): Array<{ group: GroupObject; children: SceneObject[] }> {
  const ax = axis.x * pageWidth;
  const ay = axis.y * pageHeight;
  return mirrorKinds(mode).map((kind) => {
    const groupId = createId('group');
    const nextChildren = children.flatMap((child) => {
      const next = mirrorOne(child, kind, ax, ay);
      return next ? [{ ...next, parentId: groupId }] : [];
    });
    const bounds = unionRects(nextChildren.map((child) => getObjectBounds(child)));
    const nextGroup: GroupObject = {
      ...group,
      id: groupId,
      parentId: null,
      childIds: nextChildren.map((child) => child.id),
      rotation: kind === 'xy' ? group.rotation ?? 0 : (-(group.rotation ?? 0) + 360) % 360,
      x: bounds.x - 8,
      y: bounds.y - 8,
      width: bounds.width + 16,
      height: bounds.height + 16
    };
    return { group: nextGroup, children: nextChildren };
  });
}