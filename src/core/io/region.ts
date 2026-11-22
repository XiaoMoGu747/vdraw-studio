import type { ExportRegion, VDrawDocument, Vec } from '../../types/document';
import { expandSelection, getObject, selectionBounds } from '../scene';

/** 导出选区的最小边长（px）。 */
export const MIN_EXPORT_SIZE = 1;

/** 选区八个方向的缩放把手。 */
export type RegionHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const REGION_HANDLES: RegionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** 页面可用范围，导出选区不允许越出纸张。 */
export interface RegionBounds {
  width: number;
  height: number;
}

export const pageRegionBounds = (page: { width: number; height: number }): RegionBounds => ({
  width: Math.max(MIN_EXPORT_SIZE, page.width),
  height: Math.max(MIN_EXPORT_SIZE, page.height)
});

/**
 * 首次进入框选时的默认矩形：页面居中的 70% 区域。
 * 不直接用整页，否则选框贴合纸边，用户没有「拖着改」的落手处。
 */
export function defaultExportRegion(bounds: RegionBounds): ExportRegion {
  const width = Math.max(MIN_EXPORT_SIZE, Math.round(bounds.width * 0.7));
  const height = Math.max(MIN_EXPORT_SIZE, Math.round(bounds.height * 0.7));
  return {
    x: Math.round((bounds.width - width) / 2),
    y: Math.round((bounds.height - height) / 2),
    width,
    height
  };
}

/** 把任意矩形收进纸张范围，并取整到整数像素，保证导出边缘清晰。 */
export function clampRegion(region: ExportRegion, bounds: RegionBounds): ExportRegion {
  const width = clampNumber(Math.round(region.width), MIN_EXPORT_SIZE, bounds.width);
  const height = clampNumber(Math.round(region.height), MIN_EXPORT_SIZE, bounds.height);
  return {
    x: clampNumber(Math.round(region.x), 0, Math.max(0, bounds.width - width)),
    y: clampNumber(Math.round(region.y), 0, Math.max(0, bounds.height - height)),
    width,
    height
  };
}

/** 两个对角点 → 规整矩形（拖拽框选）。 */
export function regionFromPoints(a: Vec, b: Vec, bounds: RegionBounds): ExportRegion {
  const start = {
    x: clampNumber(a.x, 0, bounds.width),
    y: clampNumber(a.y, 0, bounds.height)
  };
  const end = {
    x: clampNumber(b.x, 0, bounds.width),
    y: clampNumber(b.y, 0, bounds.height)
  };
  return clampRegion(
    {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    },
    bounds
  );
}

/** 平移选区（保持尺寸，越界时贴边）。 */
export function moveRegion(region: ExportRegion, delta: Vec, bounds: RegionBounds): ExportRegion {
  return clampRegion(
    { x: region.x + delta.x, y: region.y + delta.y, width: region.width, height: region.height },
    bounds
  );
}

/**
 * 拖动某个把手时计算新矩形：对侧边固定，移动边跟随指针。
 * 始终保证宽高不小于最小尺寸，不会翻转。
 */
export function resizeRegion(
  region: ExportRegion,
  handle: RegionHandle,
  point: Vec,
  bounds: RegionBounds
): ExportRegion {
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  const px = clampNumber(point.x, 0, bounds.width);
  const py = clampNumber(point.y, 0, bounds.height);

  let x1 = region.x;
  let y1 = region.y;
  let x2 = right;
  let y2 = bottom;

  if (handle.includes('w')) x1 = Math.min(px, right - MIN_EXPORT_SIZE);
  if (handle.includes('e')) x2 = Math.max(px, region.x + MIN_EXPORT_SIZE);
  if (handle.includes('n')) y1 = Math.min(py, bottom - MIN_EXPORT_SIZE);
  if (handle.includes('s')) y2 = Math.max(py, region.y + MIN_EXPORT_SIZE);

  return clampRegion({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, bounds);
}

/** 选中对象导出时给包围盒留的呼吸边（描边、标签不会被切边）。 */
export const SELECTION_EXPORT_PAD = 8;

/**
 * 把当前选中的对象换算成导出矩形：选区包围盒外扩 8px。
 *
 * 这里刻意不按纸张裁剪：贴着纸边或越出纸边的对象如果被裁，
 * 轻则描边被切、重则整块消失，用户会认为「导出的不是选中的东西」。
 * 越界部分由背景色块铺成纸张色，导出结果依然完整。
 * 没有选中对象时返回 null，由调用方给出空状态。
 */
export function selectionExportRegion(
  doc: VDrawDocument,
  ids: string[],
  pad = SELECTION_EXPORT_PAD
): ExportRegion | null {
  if (ids.length === 0) return null;
  const bounds = selectionBounds(doc, ids);
  if (!bounds) return null;
  // 直线/单点这类对象的包围盒可能某个方向为 0，pad 会把它们撑成有效矩形；
  // 只有宽高同时为 0 才算退化。
  if (bounds.width <= 0 && bounds.height <= 0) return null;
  // 包围盒按几何范围算，不含描边；粗描边会外溢，留白要覆盖它的一半。
  const strokePad = Math.ceil(maxStrokeWidth(doc, ids) / 2) + 1;
  const margin = Math.max(pad, strokePad);
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: bounds.width + margin * 2,
    height: bounds.height + margin * 2
  };
}

/** 选中对象（含分组后代）里最粗的描边宽度。 */
function maxStrokeWidth(doc: VDrawDocument, ids: string[]): number {
  let max = 0;
  for (const id of expandSelection(doc, ids)) {
    const obj = getObject(doc, id);
    const width = obj?.style?.stroke?.width ?? 0;
    if (Number.isFinite(width)) max = Math.max(max, width);
  }
  return max;
}

