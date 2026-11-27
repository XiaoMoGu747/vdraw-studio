import { TEMPLATE_MAP } from '../../core/document';
import { downloadExportedFile, printSvgAsPdf } from '../../core/io/browserExport';
import { documentToRasterBase64 } from '../../core/io/raster';
import { baseName, parseDocumentFile, serializeDocument } from '../../core/io/serialize';
import { documentToSvgString, resolveExportBox } from '../../core/io/svg';
import { useAppStore } from '../../store/useAppStore';
import type { EditorSnapshot, ExportFormat, ExportRegion } from '../../types/document';

export type { ExportFormat };

export interface ExportOptions {
  /** 只导出这块页面矩形；为空表示整页。 */
  region?: ExportRegion | null;
  /** 只导出这些对象（选中对象导出）；为空表示全部可见对象。 */
  onlyIds?: string[] | null;
}

interface FormatMeta {
  extension: string;
  label: string;
  /** 通知里用的短名 */
  filter: string;
  mime: string;
}

const FORMAT_META: Record<ExportFormat, FormatMeta> = {
  svg: { extension: 'svg', label: 'SVG 矢量图', filter: 'SVG', mime: 'image/svg+xml' },
  png: { extension: 'png', label: 'PNG 图片', filter: 'PNG', mime: 'image/png' },
  jpg: { extension: 'jpg', label: 'JPG 图片', filter: 'JPG', mime: 'image/jpeg' },
  pdf: { extension: 'pdf', label: 'PDF 文档', filter: 'PDF', mime: 'application/pdf' }
};

/** 只有 PNG / SVG 支持透明；JPG 无 alpha，PDF 固定白底。 */
export const supportsTransparency = (format: ExportFormat): boolean =>
  format === 'png' || format === 'svg';

export function useFileActions() {
  const notify = useAppStore((state) => state.notify);

  const bridge = () => {
    if (!window.vdraw) {
      notify('文件读写仅在桌面应用内可用', 'warn');
      return null;
    }
    return window.vdraw;
  };

  const confirmDiscard = (action: string): boolean => {
    if (window.vdraw?.isSmoke) return true;
    if (!useAppStore.getState().isDirty) return true;
    return window.confirm(`当前文档有未保存的修改，${action}后这些修改会丢失。是否继续？`);
  };

  const registerRecent = (path: string, name: string) => {
    const store = useAppStore.getState();
    const template = TEMPLATE_MAP[store.doc.templateId];
    store.addRecent({
      id: store.doc.id,
      name,
      path,
      templateId: store.doc.templateId,
      templateName: template?.name ?? '自定义',
      sizeLabel: template?.sizeLabel ?? `${store.doc.page.width} × ${store.doc.page.height}`,
      openedAt: new Date().toISOString()
    });
  };

  const save = async (saveAs = false): Promise<boolean> => {
    const api = bridge();
    if (!api) return false;
    const store = useAppStore.getState();
    const doc = store.doc;
    // 编辑器环境（对称/辅助线）随文档保存，换机或重开后手感一致。
    const editor: EditorSnapshot = {
      symmetry: store.symmetry,
      symmetryAxis: store.symmetryAxis,
      guideMode: store.guideMode,
      guideSettings: store.guideSettings,
      guideAssist: store.guideAssist,
      guideDensity: store.guideDensity,
      guideSpacing: store.guideSpacing,
      customBrushes: store.customBrushes
    };
    try {
      const result = await api.file.saveDocument({
        content: serializeDocument(doc, editor),
        path: saveAs ? null : doc.filePath,
        suggestedName: doc.name || '未命名',
        forceDialog: saveAs
      });
      if (result.canceled || !result.path) return false;
      // 普通保存保留用户在标题/最近文件里改过的名称；另存为才以新文件名称为准。
      const name =
        !saveAs && doc.filePath && doc.name ? doc.name : baseName(result.path);
      store.markSaved(result.path, name);
      registerRecent(result.path, name);
      notify(
        result.fallback
          ? `安装目录不可写，已保存到：${result.path}`
          : `已保存：${result.path}`,
        result.fallback ? 'info' : 'success'
      );
      return true;
    } catch (error) {
      notify(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'warn');
      return false;
    }
  };

  const getSaveDir = async (): Promise<{ directory: string; fallback: boolean } | null> => {
    if (!window.vdraw) return null;
    const api = bridge();
    if (!api) return null;
    try {
      return await api.file.getSaveDir();
    } catch {
      return null;
    }
  };

  const openSaveDir = async (): Promise<void> => {
    if (!window.vdraw) return;
    const api = bridge();
    if (!api) return;
    try {
      const result = await api.file.openSaveDir();
      if (result.error) notify(`无法打开保存文件夹：${result.error}`, 'warn');
    } catch (error) {
      notify(`无法打开保存文件夹：${error instanceof Error ? error.message : '未知错误'}`, 'warn');
    }
  };

  const open = async (): Promise<void> => {
    const api = bridge();
    if (!api) return;
    if (!confirmDiscard('打开其他文档')) return;
    try {
      const result = await api.file.openDocument();
      if (result.canceled || !result.content || !result.path) return;
      const store = useAppStore.getState();
      const { doc, editor } = parseDocumentFile(result.content);
      // 最近文件里的重命名优先于磁盘文件内嵌的旧标题。
      const recentName = store.recent.find((item) => item.path === result.path)?.name;
      const name = recentName || baseName(result.path);
      store.loadDocument({ ...doc, name }, result.path);
      if (editor) store.applyEditorSnapshot(editor);
      registerRecent(result.path, name);
      notify(`已打开：${name}`, 'success');
    } catch (error) {
      notify(`打开失败：${error instanceof Error ? error.message : '文件格式无效'}`, 'warn');
    }
  };

  const openPath = async (path: string): Promise<void> => {
    const api = bridge();
    if (!api) return;
    if (!confirmDiscard('打开其他文档')) return;
    try {
      const result = await api.file.openPath(path);
      if (result.canceled || !result.content) return;
      const store = useAppStore.getState();
      const { doc, editor } = parseDocumentFile(result.content);
      // 启动页重命名后的记录名要延续到画布标题，避免重新打开又变回“未命名”。
      const recentName = store.recent.find((item) => item.path === path)?.name;
      const name = recentName || baseName(path);
      store.loadDocument({ ...doc, name }, path);
      if (editor) store.applyEditorSnapshot(editor);
      registerRecent(path, name);
      notify(`已打开：${name}`, 'success');
    } catch (error) {
      notify(`打开失败：${error instanceof Error ? error.message : '文件不存在或已损坏'}`, 'warn');
    }
  };

  const exportAs = async (format: ExportFormat, options: ExportOptions = {}): Promise<boolean> => {
    const store = useAppStore.getState();
    const doc = store.doc;
    const hideCharges = store.chemHideCharges;
    const meta = FORMAT_META[format];
    const region = options.region ?? null;
    const includeIds = options.onlyIds ?? null;
    const box = resolveExportBox(doc, region);
    const transparent = store.exportTransparent && supportsTransparency(format);
    const scopeLabel = region ? `范围 ${Math.round(box.width)} × ${Math.round(box.height)}` : '';
    const suffix = [scopeLabel, transparent ? '透明背景' : ''].filter(Boolean).join(' · ');
    try {
      let data = '';
      let encoding: 'utf8' | 'base64' = 'utf8';

      if (format === 'pdf') {
        const svg = documentToSvgString(doc, {
          includeBackground: true,
          region,
          includeIds,
          // PDF 打印管线对 mix-blend-mode 的支持不稳定：导出前把 multiply 预乘到纸张底色。
          bakeMultiply: true,
          hideCharges
        });
        const api = window.vdraw;
        if (!api) {
          // 网页端没有 printToPDF：用打印窗口输出同一份矢量页面。
          if (!printSvgAsPdf(svg, box.width, box.height, `${doc.name}.pdf`)) {
            notify('浏览器拦截了打印窗口，请允许弹窗后重试', 'warn');
            return false;
          }
          notify(
            `已在打印窗口打开${scopeLabel ? `（${scopeLabel}）` : ''}，选择「另存为 PDF」即可保存`,
            'info'
          );
          return true;
        }
        // PDF 走主进程 printToPDF，保留矢量路径和可选中文字。
        const result = await api.file.exportPdf({
          svg,
          defaultName: `${doc.name}.pdf`,
          width: box.width,
          height: box.height
        });
        if (result.canceled || !result.path) return false;
        notify(
          `已导出 PDF${suffix ? `（${suffix}）` : ''}：${baseName(result.path)}.pdf`,
          'success'
        );
        return true;
      }

      if (format === 'svg') {
        data = documentToSvgString(doc, {
          includeBackground: !transparent,
          region,
          includeIds,
          hideCharges
        });
      } else {
        // PNG / JPG 共用同一份 SVG 光栅化管线，尺寸与质量口径完全一致。
        data = await documentToRasterBase64(doc, format, {
          scale: 2,
          quality: store.exportQuality,
          transparent,
          region,
          includeIds,
          hideCharges
        });
        encoding = 'base64';
      }

      const fileName = `${doc.name}.${meta.extension}`;
      const api = window.vdraw;
      if (!api) {
        downloadExportedFile({ fileName, mimeType: meta.mime, data, encoding });
        notify(
          `已下载 ${meta.filter}${suffix ? `（${suffix}）` : ''}：${fileName}`,
          'success'
        );
        return true;
      }
      const result = await api.file.exportFile({
        data,
        encoding,
        defaultName: fileName,
        filters: [{ name: meta.label, extensions: [meta.extension] }]
      });
      if (result.canceled || !result.path) return false;
      notify(
        `已导出 ${meta.filter}${suffix ? `（${suffix}）` : ''}：${baseName(result.path)}.${meta.extension}`,
        'success'
      );
      return true;
    } catch (error) {
      notify(`导出失败：${error instanceof Error ? error.message : '未知错误'}`, 'warn');
      return false;
    }
  };

  return { save, open, openPath, exportAs, getSaveDir, openSaveDir };
}
