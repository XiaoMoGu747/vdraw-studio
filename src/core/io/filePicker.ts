import { ImportError, MAX_IMPORT_BYTES, formatFileSize } from './importError';
import {
  RASTER_FORMATS,
  detectRasterKind,
  isBitmapFileName,
  type RasterFormat
} from './imageImport';

export interface PickedBrowserFile {
  name: string;
  /** 文本格式（.vdraw / .json / .svg）。 */
  content?: string;
  /** 位图格式：按文件头重建的 data URL。 */
  dataUrl?: string;
  bytes: number;
}

/**
 * 网页端文件选择：创建一个临时 input[type=file]，复用浏览器原生选择器。
 * 桌面端不走这里（走主进程的原生对话框），但拖拽与网页端共用同一套校验。
 */
export function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.setAttribute('aria-hidden', 'true');

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file);
    };
    // 用户点「取消」时部分浏览器不派发 change：窗口重新获得焦点后兜底判定。
    const onFocus = () => {
      window.setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) finish(null);
      }, 400);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.oncancel = () => finish(null);
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new ImportError('invalid-image', '读取图片文件失败'));
    reader.readAsDataURL(file);
  });
}

function rasterMime(kind: ReturnType<typeof detectRasterKind>): string {
  if (kind === 'tiff') return 'image/tiff';
  if (kind === 'avif') return 'image/avif';
  if (kind) return RASTER_FORMATS[kind as RasterFormat].mime;
  return 'application/octet-stream';
}

/**
 * 浏览器端读取：用文件头判断位图，避免"PNG 被改名"时误走文本链路；
 * 位图统一转成 data URL，文本统一按 UTF-8 读取。
 */
export async function readPickedBrowserFile(file: File): Promise<PickedBrowserFile> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ImportError(
      'file-too-large',
      `文件 ${formatFileSize(file.size)} 超过 ${formatFileSize(MAX_IMPORT_BYTES)} 上限`,
      '请在 VDraw 中拆分文档或压缩图片后重试。'
    );
  }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = detectRasterKind(head);
  if (kind || isBitmapFileName(file.name)) {
    const raw = await readAsDataUrl(file);
    const comma = raw.indexOf(',');
    const base64 = comma >= 0 ? raw.slice(comma + 1) : '';
    return {
      name: file.name,
      dataUrl: `data:${rasterMime(kind)};base64,${base64}`,
      bytes: file.size
    };
  }
  return { name: file.name, content: await file.text(), bytes: file.size };
}
