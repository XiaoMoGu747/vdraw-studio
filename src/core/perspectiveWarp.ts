import type { GuideSettings, Rect, SceneObject, Vec, VDrawDocument } from '../types/document';
import { applyHomography, solveHomography, type Homography } from './homography';
import { getObjectBounds } from './scene';

export function quadOfBounds(bounds: Rect): Vec[] {
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height }
  ];
}

/**
 * 依据两点透视的消失点间距生成目标梯形：上边收窄、下边保持原宽。
 * 消失点越远，收窄越明显；这不是任意缩放，而是由 VP 决定的透视倾向。
 */
export function perspectiveQuad(
  bounds: Rect,
  settings: GuideSettings,
  page: { width: number; height: number }
): Vec[] {
  const spread = Math.max(0.2, settings.vpRight - settings.vpLeft);
  const shrink = Math.min(0.55, Math.max(0.15, spread * 0.18));
  const centerX = bounds.x + bounds.width / 2;
  const topHalf = (bounds.width * (1 - shrink)) / 2;
  const bottomHalf = bounds.width / 2;
  const horizon = settings.horizon * page.height;
  const top = bounds.y + (horizon - bounds.y) * 0.06;
  const bottom = bounds.y + bounds.height;
  return [
    { x: centerX - topHalf, y: top },
    { x: centerX + topHalf, y: top },
    { x: centerX + bottomHalf, y: bottom },
    { x: centerX - bottomHalf, y: bottom }
  ];
}

function warpRelativeHandle(
  h: Homography,
  node: Vec,
  handle: { x: number; y: number } | null,
  mapped: Vec
): { x: number; y: number } | null {
  if (!handle) return null;
  const end = applyHomography(h, { x: node.x + handle.x, y: node.y + handle.y });
  return { x: end.x - mapped.x, y: end.y - mapped.y };
}

/** 把对象的可变形几何映射到透视四边形；不支持的类型返回 null。 */
export function warpObjectGeometry(object: SceneObject, h: Homography): SceneObject | null {
  if (object.type === 'path') {
    return {
      ...object,
      nodes: object.nodes.map((node) => {
        const mapped = applyHomography(h, { x: node.x, y: node.y });
        return {
          ...node,
          ...mapped,
          handleIn: warpRelativeHandle(h, node, node.handleIn, mapped),
          handleOut: warpRelativeHandle(h, node, node.handleOut, mapped)
        };
      })
    };
  }
  if (object.type === 'polygon') {
    return { ...object, points: object.points.map((point) => applyHomography(h, point)) };
  }
  if (object.type === 'line') {
    return {
      ...object,
      start: applyHomography(h, object.start),
      end: applyHomography(h, object.end)
    };
  }
  if (object.type === 'rect' || object.type === 'ellipse' || object.type === 'text') {
    // 这些类型没有可变形顶点：用映射后的四角求外接框近似（不是真梯形）。
    const corners = quadOfBounds({
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height
    }).map((point) => applyHomography(h, point));
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
      ...object,
      x,
      y,
      width: Math.max(1, Math.max(...xs) - x),
      height: Math.max(1, Math.max(...ys) - y)
    };
  }
  return null;
}

export interface WarpResult {
  doc: VDrawDocument;
  changed: number;
  unsupported: number;
}

/** 对选中的对象批量应用透视变形（每个对象按自身包围盒求解）。 */
export function warpSelection(
  doc: VDrawDocument,
  ids: string[],
  settings: GuideSettings,
  page: { width: number; height: number }
): WarpResult {
  if (ids.length === 0) return { doc, changed: 0, unsupported: 0 };
  const selected = new Set(ids);
  let changed = 0;
  let unsupported = 0;
  const layers = doc.layers.map((layer) => ({
    ...layer,
    objects: layer.objects.map((object) => {
      if (!selected.has(object.id)) return object;
      const bounds = getObjectBounds(object, doc);
      if (bounds.width < 2 || bounds.height < 2) {
        unsupported += 1;
        return object;
      }
      const h = solveHomography(
        quadOfBounds(bounds),
        perspectiveQuad(bounds, settings, page)
      );
      if (!h) {
        unsupported += 1;
        return object;
      }
      const warped = warpObjectGeometry(object, h);
      if (!warped) {
        unsupported += 1;
        return object;
      }
      changed += 1;
      return warped;
    })
  }));
  return { doc: { ...doc, layers }, changed, unsupported };
}
