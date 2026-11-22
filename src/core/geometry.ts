import type { Rect, Vec } from '../types/document';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, factor: number): Vec => ({ x: a.x * factor, y: a.y * factor });
export const length = (a: Vec): number => Math.hypot(a.x, a.y);

export function normalize(a: Vec): Vec {
  const len = length(a);
  if (len < 1e-9) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

export function perpendicular(a: Vec): Vec {
  return { x: -a.y, y: a.x };
}

export const distance = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

export function rectFromPoints(a: Vec, b: Vec): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

export function snapValue(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

export function snapPoint(point: Vec, step: number): Vec {
  return { x: snapValue(point.x, step), y: snapValue(point.y, step) };
}

export function pointInRect(point: Vec, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** 计算页面在视口中的适配缩放与居中偏移。 */
export function fitViewport(
  viewWidth: number,
  viewHeight: number,
  pageWidth: number,
  pageHeight: number,
  padding = 64
): { zoom: number; pan: Vec } {
  const availableW = Math.max(80, viewWidth - padding * 2);
  const availableH = Math.max(80, viewHeight - padding * 2);
  const zoom = clamp(Math.min(availableW / pageWidth, availableH / pageHeight), MIN_ZOOM, MAX_ZOOM);
  return {
    zoom,
    pan: {
      x: (viewWidth - pageWidth * zoom) / 2,
      y: (viewHeight - pageHeight * zoom) / 2
    }
  };
}

/** 屏幕坐标 -> 页面坐标 */
export function toPagePoint(screen: Vec, pan: Vec, zoom: number): Vec {
  return { x: (screen.x - pan.x) / zoom, y: (screen.y - pan.y) / zoom };
}

/** 页面坐标 -> 屏幕坐标 */
export function toScreenPoint(page: Vec, pan: Vec, zoom: number): Vec {
  return { x: page.x * zoom + pan.x, y: page.y * zoom + pan.y };
}

/**
 * 以视口内某个锚点缩放。anchor 为相对视口左上角的坐标。
 */
export function zoomAround(
  viewport: { zoom: number; pan: Vec },
  nextZoom: number,
  anchor: Vec
): { zoom: number; pan: Vec } {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const ratio = zoom / viewport.zoom;
  return {
    zoom,
    pan: {
      x: anchor.x - (anchor.x - viewport.pan.x) * ratio,
      y: anchor.y - (anchor.y - viewport.pan.y) * ratio
    }
  };
}

export function formatNumber(value: number, digits = 1): string {
  const rounded = round(value, digits);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(digits);
}
