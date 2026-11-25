/**
 * 导入链路的公共错误与单位换算。
 *
 * 单独成文件是为了让「文本/工程」与「位图」两条解析链路共用同一套
 * ImportError 错误码和提示口径，避免两套错误处理在对话框里表现不一致。
 */

/** 导入文件上限：与主进程读取校验保持一致，避免大文件把渲染进程卡死。 */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
/** 位图上限：base64 还会膨胀 1/3，32MB 原图已足够覆盖常见截图/照片。 */
export const MAX_RASTER_BYTES = 32 * 1024 * 1024;

export type ImportErrorCode =
  | 'empty-file'
  | 'file-too-large'
  | 'unsupported-type'
  | 'binary-content'
  | 'invalid-json'
  | 'invalid-document'
  | 'unsupported-version'
  | 'invalid-page'
  | 'invalid-layers'
  | 'duplicate-ids'
  | 'invalid-svg'
  | 'empty-svg'
  | 'invalid-image'
  | 'no-draw-layer'
  | 'locked-layer';

const ERROR_TITLES: Record<ImportErrorCode, string> = {
  'empty-file': '文件为空',
  'file-too-large': '文件过大',
  'unsupported-type': '不支持的文件格式',
  'binary-content': '文件不是文本格式',
  'invalid-json': 'JSON 解析失败',
  'invalid-document': '文档结构无效',
  'unsupported-version': '文件版本不受支持',
  'invalid-page': '页面数据无效',
  'invalid-layers': '图层或对象数据损坏',
  'duplicate-ids': '对象 ID 重复',
  'invalid-svg': 'SVG 解析失败',
  'empty-svg': 'SVG 没有可导入的图元',
  'invalid-image': '图片解析失败',
  'no-draw-layer': '没有可用的绘图层',
  'locked-layer': '绘图层已锁定'
};

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly hint: string | null;

  constructor(code: ImportErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.hint = hint ?? null;
  }
}

export interface ImportErrorInfo {
  code: ImportErrorCode;
  title: string;
  message: string;
  hint: string | null;
}

export function importErrorInfo(error: unknown): ImportErrorInfo {
  if (error instanceof ImportError) {
    return {
      code: error.code,
      title: ERROR_TITLES[error.code],
      message: error.message,
      hint: error.hint
    };
  }
  return {
    code: 'invalid-document',
    title: '导入失败',
    message: error instanceof Error ? error.message : '文件无法读取',
    hint: null
  };
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
