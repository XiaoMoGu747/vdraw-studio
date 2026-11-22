import type { SceneObject, VDrawDocument, Vec } from '../types/document';
import { pathData } from './io/svg';
import { floodRegionMask, maskToRegion, type RegionFillResult } from './regionFill';

export interface RegionRasterOptions {
  /** 断线闭合容差（页面像素）：线稿按此加粗后再做连通判定。 */
  gap: number;
  /** 区域外扩/收缩（页面像素），正值让填充更小。 */
  expand: number;
}

const MAX_SIDE = 2048;

function drawObject(ctx: CanvasRenderingContext2D, object: SceneObject, lineWidth: number): void {
  const stroke = object.style.stroke;
  const hasStroke = stroke.paint.type === 'solid' && stroke.width > 0;
  const hasFill = object.style.fill.type === 'solid';
  ctx.lineWidth = Math.max(1, lineWidth);
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const paintPath = (path: Path2D, closed: boolean) => {
    if (hasFill && closed) ctx.fill(path);
    if (hasStroke) ctx.stroke(path);
  };

  switch (object.type) {
    case 'line': {
      const path = new Path2D();
      path.moveTo(object.start.x, object.start.y);
      path.lineTo(object.end.x, object.end.y);
      if (hasStroke) ctx.stroke(path);
      break;
    }
    case 'rect': {
      const path = new Path2D();
      const radius = Math.max(
        0,
        Math.min(object.cornerRadius ?? 0, object.width / 2, object.height / 2)
      );
      if (typeof path.roundRect === 'function') {
        path.roundRect(object.x, object.y, object.width, object.height, radius);
      } else {
        path.rect(object.x, object.y, object.width, object.height);
      }
      paintPath(path, true);
      break;
    }
    case 'ellipse': {
      const path = new Path2D();
      path.ellipse(
        object.x + object.width / 2,
        object.y + object.height / 2,
        Math.max(0.5, object.width / 2),
        Math.max(0.5, object.height / 2),
        0,
        0,
        Math.PI * 2
      );
      paintPath(path, true);
      break;
    }
    case 'polygon': {
      const path = new Path2D();
      object.points.forEach((point, index) => {
        if (index === 0) path.moveTo(point.x, point.y);
        else path.lineTo(point.x, point.y);
      });
      path.closePath();
      paintPath(path, true);
      break;
    }
    case 'path': {
      const path = new Path2D(pathData(object.nodes, object.closed));
      if (hasFill && object.closed) ctx.fill(path);
      if (hasStroke) {
        const width = object.nodes.some((node) => typeof node.width === 'number')
          ? Math.max(...object.nodes.map((node) => node.width ?? 0))
          : stroke.width;
        ctx.lineWidth = Math.max(1, width + (lineWidth - Math.max(1, stroke.width)));
        ctx.stroke(path);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 把页面上的可见线稿栅格化，从点击点做连通填充，返回矢量轮廓。
 * 返回 null 表示点击位置是线条本身、区域过小或环境不支持。
 */
export function buildRegionFill(
  doc: VDrawDocument,
  point: Vec,
  options: RegionRasterOptions
): RegionFillResult | null {
  if (typeof document === 'undefined') return null;
  const page = doc.page;
  const scale = Math.min(2, MAX_SIDE / Math.max(1, Math.max(page.width, page.height)));
  const width = Math.max(8, Math.round(page.width * scale));
  const height = Math.max(8, Math.round(page.height * scale));
  if (width * height > 9_000_000) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, page.width, page.height);

  const gap = Math.max(0, options.gap);
  const expand = Math.max(-1.5, options.expand);
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (const object of layer.objects) {
      if (!object.visible) continue;
      const base = Math.max(0.5, object.style.stroke.width || 1);
      const lineWidth = base + gap * 2 + expand * 2;
      drawObject(ctx, object, lineWidth);
    }
  }

  const image = ctx.getImageData(0, 0, width, height).data;
  const blocked = new Uint8Array(width * height);
  for (let index = 0; index < blocked.length; index += 1) {
    blocked[index] = image[index * 4 + 3] > 24 ? 1 : 0;
  }

  const mask = floodRegionMask(blocked, width, height, {
    x: point.x * scale,
    y: point.y * scale
  });
  if (!mask) return null;
  return maskToRegion(mask, width, height, scale);
}
