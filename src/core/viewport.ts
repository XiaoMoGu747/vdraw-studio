import type { Rect, SceneObject, Viewport } from '../types/document';

/**
 * 当前视口对应的页面坐标矩形（含余量）。
 * 渲染时只画落在这个矩形内的对象，避免超大文档把整份场景都塞进 DOM。
 */
export function viewRectForViewport(
  size: { width: number; height: number },
  viewport: Viewport,
  margin = 96
): Rect {
  const zoom = viewport.zoom || 1;
  return {
    x: -viewport.pan.x / zoom - margin,
    y: -viewport.pan.y / zoom - margin,
    width: Math.max(1, size.width / zoom) + margin * 2,
    height: Math.max(1, size.height / zoom) + margin * 2
  };
}

/**
 * 对象是否与视口相交。
 * 用对象自身的包围盒（x/y/width/height）做快速判断，避免每条路径都重算节点包围盒；
 * 旋转对象按半对角线放宽容差，宁可多画也不漏画。
 */
export function objectInView(object: SceneObject, rect: Rect): boolean {
  const rotationPad = object.rotation ? Math.hypot(object.width, object.height) / 2 : 0;
  const pad = 32 + rotationPad + (object.style?.stroke?.width ?? 0) / 2;
  return (
    object.x - pad < rect.x + rect.width &&
    object.x + object.width + pad > rect.x &&
    object.y - pad < rect.y + rect.height &&
    object.y + object.height + pad > rect.y
  );
}
