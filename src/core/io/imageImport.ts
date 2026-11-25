import { baseName } from './serialize';
import { ImportError, MAX_RASTER_BYTES, formatFileSize } from './importError';

export type RasterFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp';

export type RasterKind = RasterFormat | 'tiff' | 'avif';

interface RasterFormatInfo {
  mime: string;
  label: string;
}

export const RASTER_FORMATS: Record<RasterFormat, RasterFormatInfo> = {
  png: { mime: 'image/png', label: 'PNG' },
  jpeg: { mime: 'image/jpeg', label: 'JPEG' },
  webp: { mime: 'image/webp', label: 'WebP' },
  gif: { mime: 'image/gif', label: 'GIF' },
  bmp: { mime: 'image/bmp', label: 'BMP' }
};

/** 单边像素上限：超过后浏览器解码与画布缓存都容易失败。 */
export const MAX_RASTER_SIDE = 12000;
/** 总像素上限：40MP 约等于 8000×5000，覆盖常见相机照片。 */
export const MAX_RASTER_PIXELS = 40_000_000;

const BITMAP_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'avif',
  'heic',
  'heif',
  'ico'
]);

const SUPPORTED_EXTENSIONS: Record<string, RasterFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp'
};

export function isBitmapFileName(fileName: string): boolean {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return Boolean(match && BITMAP_EXTENSIONS.has(match[1]));
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let value = '';
  for (let index = start; index < end && index < bytes.length; index += 1) {
    value += String.fromCharCode(bytes[index]);
  }
  return value;
}

/**
 * 只按文件头判断位图类型，不信任扩展名或 data URL 里的 MIME。
 * TIFF/AVIF 单独识别，用于给出"能识别但暂不支持"的明确提示。
 */
export function detectRasterKind(bytes: Uint8Array): RasterKind | null {
  if (bytes.length < 3) return null;
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const head = ascii(bytes, 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 2) === 'BM' && bytes.length >= 14) return 'bmp';
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return 'tiff';
  }
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (['avif', 'avis', 'heic', 'heix', 'heif', 'mif1', 'msf1'].includes(brand)) {
      return 'avif';
    }
  }
  return null;
}

function invalidImage(message: string, hint?: string): ImportError {
  return new ImportError('invalid-image', message, hint);
}

function base64ToBytes(base64: string, byteCount: number): Uint8Array {
  const slice = base64.slice(0, Math.min(base64.length, Math.ceil(byteCount / 3) * 4));
  const padded = slice + '='.repeat((4 - (slice.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw invalidImage('图片数据不是有效的 base64 编码', '请重新选择文件；文件可能在传输过程中被截断。');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function i32le(bytes: Uint8Array, offset: number): number {
  const value =
    bytes[offset] +
    (bytes[offset + 1] << 8) +
    (bytes[offset + 2] << 16) +
    (bytes[offset + 3] << 24);
  return value;
}

/**
 * 从文件头读取像素尺寸：在真正解码前拦住超大图片，
 * 避免一张几 KB 但声明 50000×50000 的 PNG 直接把渲染进程拖死。
 */
export function readRasterSize(
  kind: RasterKind,
  bytes: Uint8Array
): { width: number; height: number } | null {
  if (kind === 'png') {
    if (bytes.length < 24 || ascii(bytes, 12, 16) !== 'IHDR') return null;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (kind === 'gif') {
    if (bytes.length < 10) return null;
    return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }
  if (kind === 'bmp') {
    if (bytes.length < 26) return null;
    return { width: Math.abs(i32le(bytes, 18)), height: Math.abs(i32le(bytes, 22)) };
  }
  if (kind === 'webp') {
    const chunk = ascii(bytes, 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits =
        bytes[21] + (bytes[22] << 8) + (bytes[23] << 16) + bytes[24] * 0x1000000;
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (
      chunk === 'VP8 ' &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    }
  }
  return null;
}

export interface RasterHeader {
  base64: string;
  format: RasterFormat;
  mime: string;
  label: string;
  bytes: number;
  /** 文件头声明的像素尺寸；JPEG 等无法从头部稳定解析时为 null。 */
  width: number | null;
  height: number | null;
  warnings: string[];
}

export interface RasterHeaderInput {
  fileName: string;
  dataUrl: string;
  /** 原始文件字节数（可选）；缺失时按 base64 长度估算。 */
  bytes?: number;
}

/**
 * 位图头校验：扩展名只用于提示，实际类型以文件头为准。
 * 与文本导入一样抛出带错误码的 ImportError，供对话框统一渲染。
 */
export function validateRasterHeader(input: RasterHeaderInput): RasterHeader {
  const match = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(input.dataUrl.trim());
  if (!match) {
    if (/^data:image\/svg\+xml/i.test(input.dataUrl)) {
      throw new ImportError(
        'unsupported-type',
        'SVG 不是位图文件',
        '请选择 .vdraw / .svg 走矢量导入，或选择 PNG / JPEG / WebP / GIF / BMP 位图。'
      );
    }
    throw invalidImage('图片数据格式无效', '仅支持内嵌 base64 的本地图片文件。');
  }

  const base64 = match[2].replace(/\s+/g, '');
  if (!base64) {
    throw new ImportError('empty-file', '图片文件是空的，没有可导入的内容');
  }
  const normalized = base64.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]+$/.test(normalized)) {
    throw invalidImage('图片数据不是有效的 base64 编码', '请重新选择文件；文件可能已损坏。');
  }

  const estimated = Math.floor((normalized.length * 3) / 4);
  const bytes = Math.max(estimated, Number.isFinite(input.bytes) ? Number(input.bytes) : 0);
  if (bytes > MAX_RASTER_BYTES) {
    throw new ImportError(
      'file-too-large',
      `位图 ${formatFileSize(bytes)} 超过 ${formatFileSize(MAX_RASTER_BYTES)} 上限`,
      '请先在系统看图工具或压缩工具中缩小图片后重试；工程文件仍可保存更大的内嵌图片。'
    );
  }

  const kind = detectRasterKind(base64ToBytes(base64, 32));
  const extension = (input.fileName.toLowerCase().match(/\.([a-z0-9]+)$/) ?? [])[1] ?? '';
  const expected = SUPPORTED_EXTENSIONS[extension];

  if (!kind) {
    if (extension === 'ico') {
      throw new ImportError(
        'unsupported-type',
        '暂不支持 ICO 图标文件',
        '请先将图标转换为 PNG 或 JPEG 后再导入。'
      );
    }
    if (BITMAP_EXTENSIONS.has(extension)) {
      const head = ascii(base64ToBytes(base64, 256), 0, 256);
      if (/<svg[\s>]/i.test(head)) {
        throw new ImportError(
          'unsupported-type',
          `文件实际是 SVG 内容（扩展名 .${extension}）`,
          '请把扩展名改为 .svg 后重试，矢量内容会按 SVG 导入。'
        );
      }
      throw invalidImage(
        `文件内容不是有效的图片（扩展名 .${extension}）`,
        '文件可能已损坏或被改过扩展名；请用系统看图工具确认后再导入。'
      );
    }
    throw new ImportError(
      'unsupported-type',
      '无法识别图片格式',
      '支持 PNG / JPEG / WebP / GIF / BMP。'
    );
  }
  if (kind === 'tiff' || kind === 'avif') {
    const label = kind === 'tiff' ? 'TIFF' : 'AVIF / HEIC';
    throw new ImportError(
      'unsupported-type',
      `暂不支持 ${label} 位图`,
      '浏览器与 VDraw 渲染管线无法稳定解码该格式；请先转换为 PNG 或 JPEG。'
    );
  }

  const size = readRasterSize(kind, base64ToBytes(base64, 4096));
  if (
    size &&
    (size.width > MAX_RASTER_SIDE ||
      size.height > MAX_RASTER_SIDE ||
      size.width * size.height > MAX_RASTER_PIXELS)
  ) {
    throw new ImportError(
      'file-too-large',
      `图片像素尺寸 ${size.width} × ${size.height} 超过导入上限`,
      `单边最大 ${MAX_RASTER_SIDE}px、总像素最大 40 MP；请先缩小图片后再导入。`
    );
  }

  const warnings: string[] = [];
  if (expected && expected !== kind) {
    warnings.push(`扩展名与实际格式不一致，已按 ${RASTER_FORMATS[kind].label} 处理`);
  }
  if (kind === 'gif') {
    warnings.push('GIF 动图在 PNG / JPG / PDF 导出中按第一帧处理，SVG 保留原始动画数据');
  }
  if (input.dataUrl.length > 2_500_000) {
    warnings.push('图片数据较大，本地自动恢复点可能无法写入；请及时保存 .vdraw 工程');
  }

  return {
    base64,
    format: kind,
    mime: RASTER_FORMATS[kind].mime,
    label: RASTER_FORMATS[kind].label,
    bytes,
    width: size?.width ?? null,
    height: size?.height ?? null,
    warnings
  };
}

export interface ImportedImageStats {
  width: number;
  height: number;
  bytes: number;
  format: RasterFormat;
  mime: string;
}

export interface ImportedImageSource {
  kind: 'image';
  format: RasterFormat;
  fileName: string;
  suggestedName: string;
  dataUrl: string;
  mime: string;
  warnings: string[];
  stats: ImportedImageStats;
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(
        new ImportError(
          'invalid-image',
          '当前环境不支持图片解码',
          '请使用桌面应用或现代浏览器打开 VDraw。'
        )
      );
      return;
    }
    const image = new Image();
    image.decoding = 'async';
    const timer = window.setTimeout(() => {
      image.src = '';
      reject(invalidImage('图片解码超时', '图片可能过大或已损坏，请缩小后重试。'));
    }, 20_000);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(
        invalidImage(
          '图片数据损坏或格式不受支持',
          '请用系统看图工具确认文件能正常打开；TIFF / AVIF / HEIC 暂不支持。'
        )
      );
    };
    image.src = dataUrl;
  });
}

/** 位图完整校验：头校验 → 解码 → 像素上限 → 生成可落盘的导入源。 */
export async function validateRasterImport(input: RasterHeaderInput): Promise<ImportedImageSource> {
  const header = validateRasterHeader(input);
  const dataUrl = `data:${header.mime};base64,${header.base64}`;
  const image = await decodeImage(dataUrl);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) {
    throw invalidImage('图片尺寸为 0，无法导入', '请确认图片文件完整且未被截断。');
  }
  if (width > MAX_RASTER_SIDE || height > MAX_RASTER_SIDE) {
    throw new ImportError(
      'file-too-large',
      `图片像素尺寸 ${width} × ${height} 超过单边 ${MAX_RASTER_SIDE}px 上限`,
      '请先缩小图片后再导入；过大的图片会拖慢画布渲染与导出。'
    );
  }
  if (width * height > MAX_RASTER_PIXELS) {
    throw new ImportError(
      'file-too-large',
      `图片总像素 ${(width * height) / 1_000_000} MP 超过 40 MP 上限`,
      '请先缩小图片后再导入。'
    );
  }

  return {
    kind: 'image',
    format: header.format,
    fileName: input.fileName,
    suggestedName: baseName(input.fileName) || '导入图片',
    dataUrl,
    mime: header.mime,
    warnings: header.warnings,
    stats: {
      width,
      height,
      bytes: header.bytes,
      format: header.format,
      mime: header.mime
    }
  };
}

export interface ImagePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 为放入页面而缩小的比例；1 表示原始尺寸。 */
  scale: number;
}

/** 页面内放置：优先原始尺寸；超出页面时等比缩小并居中。 */
export function imagePlacement(
  naturalWidth: number,
  naturalHeight: number,
  pageWidth: number,
  pageHeight: number
): ImagePlacement {
  const safeWidth = Math.max(1, naturalWidth);
  const safeHeight = Math.max(1, naturalHeight);
  const scale = Math.min(1, pageWidth / safeWidth, pageHeight / safeHeight);
  const width = Math.max(1, safeWidth * scale);
  const height = Math.max(1, safeHeight * scale);
  return {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
    scale
  };
}

/** 位图对象名：优先文件名，避免图层面板里出现一排「位图」。 */
export function imageObjectName(source: ImportedImageSource): string {
  return source.suggestedName || '位图';
}
