/**
 * 浏览器端的导出回退：没有 Electron 桥时用 Blob 下载，保证网页端与桌面端
 * 导出选项、交互完全一致。PDF 在浏览器里没有 printToPDF，改用打印窗口
 * （用户选择「另存为 PDF」），仍是同一份矢量内容。
 */

export interface BrowserDownloadPayload {
  fileName: string;
  mimeType: string;
  data: string;
  encoding: 'utf8' | 'base64';
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = window.atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([buffer], { type: mimeType });
}

/** 触发浏览器下载（blob URL 用完自动回收）。 */
export function downloadExportedFile(payload: BrowserDownloadPayload): void {
  const { fileName, mimeType, data, encoding } = payload;
  const blob =
    encoding === 'base64'
      ? base64ToBlob(data, mimeType)
      : new Blob([data], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 浏览器里用打印窗口生成 PDF：写入与桌面端 printToPDF 完全相同的
 * @page 尺寸与 SVG，保证页面大小、矢量质量一致。返回是否成功打开。
 */
export function printSvgAsPdf(svg: string, width: number, height: number, title: string): boolean {
  const printWindow = window.open('', '_blank');
  if (!printWindow) return false;
  const safeTitle = title.replace(/[<>&"]/g, '');
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>${safeTitle}</title>
<style>
  @page { size: ${width}px ${height}px; margin: 0; }
  html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; background: #ffffff; }
  svg { display: block; width: ${width}px; height: ${height}px; }
</style></head><body>${svg}</body></html>`);
  printWindow.document.close();
  // 写入完成后再断开 opener，避免新窗口反向操作本应用。
  try {
    printWindow.opener = null;
  } catch {
    /* 部分环境不允许置空 */
  }
  const trigger = () => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch {
      /* 用户已关闭打印窗口 */
    }
  };
  // 等 SVG 排版完成再唤起打印对话框。
  if (printWindow.document.readyState === 'complete') window.setTimeout(trigger, 240);
  else printWindow.addEventListener('load', () => window.setTimeout(trigger, 240), { once: true });
  return true;
}
