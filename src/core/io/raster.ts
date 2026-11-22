import type { ExportRegion, VDrawDocument } from '../../types/document';
import { documentToSvgString, resolveExportBox } from './svg';

export type RasterFormat = 'png' | 'jpg';

export interface RasterExportOptions {
  /** 输出倍率，默认 2×。 */
  scale?: number;
  /** JPG 质量 0–1，默认 0.92；PNG 无此参数。 */
  quality?: number;
  /** 仅 PNG 有意义：省略纸张背景。JPG 不支持透明，会被忽略。 */
  transparent?: boolean;
  /** 只导出这块页面矩形；为空表示整页。 */
  region?: ExportRegion | null;
  /** 只导出这些对象（选中对象导出）；为空表示全部可见对象。 */
  includeIds?: string[] | null;
}

/**
 * 画布上限：单边超过 16384 时浏览器会静默返回空白画布，总面积过大则会
 * 直接耗尽显存。导出前先折减倍率，宁可分辨率低一点也不能导出失败。
 */
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 40_000_000;

/** 计算安全倍率：同时受单边与总面积约束。 */
export function safeRasterScale(width: number, height: number, scale: number): number {
  const side = Math.max(1, Math.max(width, height));
  const area = Math.max(1, width * height);
  const limit = Math.min(MAX_CANVAS_SIDE / side, Math.sqrt(MAX_CANVAS_AREA / area));
  return Math.min(scale, Math.max(0.05, limit));
}

/**
 * 反算选区宽度：让「输出像素宽」= round(width × safeRasterScale(width, height, base))。
 * 先从理想倍率估算，再按安全倍率迭代收敛（超大选区会被自动降倍率，不能简单除以 2）。
 */
export function regionWidthForOutputWidth(
  outputWidth: number,
  height: number,
  base = 2
): number {
  const target = Math.max(1, Math.round(outputWidth));
  const safeHeight = Math.max(1, height);
  let width = target / Math.max(0.05, base);
  for (let index = 0; index < 6; index += 1) {
    const scale = safeRasterScale(width, safeHeight, base);
    const next = target / Math.max(0.05, scale);
    if (Math.abs(next - width) < 0.5) {
      width = next;
      break;
    }
    width = next;
  }
  return Math.max(1, Math.round(width));
}

const MIME: Record<RasterFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg'
};

function loadSvgImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'sync';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('矢量内容渲染失败'));
    image.src = url;
  });
}

/** 把文档（或其中一块区域）光栅化成画布。 */
export async function documentToCanvas(
  doc: VDrawDocument,
  format: RasterFormat = 'png',
  options: RasterExportOptions = {}
): Promise<HTMLCanvasElement> {
  const { scale = 2, transparent = false, region, includeIds } = options;
  const solid = format === 'jpg' || !transparent;
  const box = resolveExportBox(doc, region);
  const svg = documentToSvgString(doc, { includeBackground: solid, region, includeIds });
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const image = await loadSvgImage(url);
    const safeScale = safeRasterScale(box.width, box.height, scale);
    const canvas = document.createElement('canvas');
    // 画布尺寸跟随导出框（区域导出时即选区尺寸），SVG 的 viewBox 已带偏移。
    canvas.width = Math.max(1, Math.round(box.width * safeScale));
    canvas.height = Math.max(1, Math.round(box.height * safeScale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建画布上下文');
    if (solid) {
      // JPG 没有 alpha 通道，必须先用纸张色铺底，否则透明区域会变黑。
      context.fillStyle = doc.page.background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 光栅导出为 base64（不带 data URL 前缀），供主进程或浏览器落盘。 */
export async function documentToRasterBase64(
  doc: VDrawDocument,
  format: RasterFormat,
  options: RasterExportOptions = {}
): Promise<string> {
  const canvas = await documentToCanvas(doc, format, options);
  const quality = format === 'jpg' ? Math.min(1, Math.max(0.1, options.quality ?? 0.92)) : undefined;
  const dataUrl = canvas.toDataURL(MIME[format], quality);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

export function documentToPngBase64(
  doc: VDrawDocument,
  scale = 2,
  transparent = false,
  region?: ExportRegion | null
): Promise<string> {
  return documentToRasterBase64(doc, 'png', { scale, transparent, region });
}
