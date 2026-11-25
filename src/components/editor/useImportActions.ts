import { pickBrowserFile, readPickedBrowserFile } from '../../core/io/filePicker';
import {
  IMPORT_ACCEPT,
  ImportError,
  documentImportToAppend,
  documentImportToNewDocument,
  documentImportToReplacement,
  imageImportToAppend,
  imageImportToNewDocument,
  imageImportToReplacement,
  svgImportToAppend,
  svgImportToNewDocument,
  svgImportToReplacement,
  type ImportMode,
  type ImportedSource
} from '../../core/io/importFile';
import { baseName } from '../../core/io/serialize';
import { useAppStore } from '../../store/useAppStore';

export interface PickedImportFile {
  name: string;
  path?: string;
  /** 文本格式内容；位图时为空。 */
  content?: string;
  /** 位图 data URL；文本格式时为空。 */
  dataUrl?: string;
  bytes?: number;
}

/**
 * 导入动作：桌面端走主进程原生对话框，网页端退回 input[type=file]。
 * 两端拿到的都是文件文本，后续校验与落盘逻辑完全一致。
 */
export function useImportActions() {
  const pickImportFile = async (): Promise<PickedImportFile | null> => {
    const api = window.vdraw;
    if (api && typeof api.file.pickImportFile === 'function') {
      const result = await api.file.pickImportFile();
      if (result.canceled) return null;
      const name = result.name || baseName(result.path ?? '') || '未命名';
      if (typeof result.dataUrl === 'string' && result.dataUrl) {
        return { name, path: result.path, dataUrl: result.dataUrl, bytes: result.bytes };
      }
      if (typeof result.content !== 'string') return null;
      return { name, path: result.path, content: result.content, bytes: result.bytes };
    }

    const file = await pickBrowserFile(IMPORT_ACCEPT);
    if (!file) return null;
    return readPickedBrowserFile(file);
  };

  /** 拖拽与网页端选择共用同一套读取/格式判断。 */
  const readDroppedFile = (file: File): Promise<PickedImportFile> =>
    readPickedBrowserFile(file);

  /**
   * 把已校验的导入数据写入画布。
   * replace / append 走 updateDoc（可 Ctrl+Z 撤销），new 走 loadDocument（新文档）。
   */
  const applyImport = async (source: ImportedSource, mode: ImportMode): Promise<boolean> => {
    const store = useAppStore.getState();
    // 启动页没有正在编辑的文档，覆盖/合并没有意义，统一按"新建画布"处理。
    const effectiveMode: ImportMode = store.route === 'editor' ? mode : 'new';

    if (effectiveMode === 'new' && store.route === 'editor' && store.isDirty) {
      if (window.vdraw?.isSmoke !== true) {
        const ok = window.confirm(
          '当前文档有未保存的修改，导入为新画布后这些修改会丢失。是否继续？'
        );
        if (!ok) return false;
      }
    }

    let extraWarnings: string[] = [];

    if (source.kind === 'document') {
      if (effectiveMode === 'new') {
        const doc = documentImportToNewDocument(source, source.suggestedName);
        store.loadDocument(doc, '', true);
        if (source.editor) store.applyEditorSnapshot(source.editor);
        store.notify(
          `已从「${source.fileName}」新建画布：${source.stats.layers} 图层 · ${source.stats.objects} 对象`,
          'success'
        );
      } else if (effectiveMode === 'replace') {
        // 先关对称：否则 updateDoc 会按当前对称轴重算导入文档里的镜像对象。
        if (store.symmetry !== 'none') store.setSymmetry('none');
        store.updateDoc(documentImportToReplacement(store.doc, source), true);
        if (source.editor) store.applyEditorSnapshot(source.editor);
        store.setSelection([]);
        store.fitToCanvas();
        store.notify(
          `已覆盖当前画布（${source.stats.layers} 图层 · ${source.stats.objects} 对象），可按 Ctrl+Z 撤销`,
          'success'
        );
      } else {
        const result = documentImportToAppend(store.doc, source);
        if (result.layersAdded === 0) {
          throw new ImportError('empty-file', '文件里没有可合并的图层');
        }
        store.updateDoc(result.doc, true);
        store.setSelection([]);
        store.notify(
          `已合并 ${result.layersAdded} 个图层 · ${result.objectsAdded} 个对象`,
          'success'
        );
      }
    } else if (source.kind === 'image') {
      if (effectiveMode === 'new') {
        const result = imageImportToNewDocument(source, source.suggestedName);
        store.loadDocument(result.doc, '', true);
        extraWarnings = result.warnings;
        store.notify(
          `已从「${source.fileName}」新建位图画布：${source.stats.width} × ${source.stats.height} px`,
          'success'
        );
      } else if (effectiveMode === 'replace') {
        const result = imageImportToReplacement(store.doc, source);
        store.updateDoc(result.doc, true);
        store.setSelection(result.objects.map((object) => object.id));
        store.fitToCanvas();
        extraWarnings = result.warnings;
        store.notify(
          `已用「${source.fileName}」覆盖当前画布，可按 Ctrl+Z 撤销`,
          'success'
        );
      } else {
        const result = imageImportToAppend(store.doc, source);
        store.updateDoc(result.doc, true);
        store.setSelection(result.objects.map((object) => object.id));
        extraWarnings = result.warnings;
        const layer = store.doc.layers.find((item) => item.id === result.layerId);
        store.notify(
          `已导入位图到「${layer?.name ?? '当前图层'}」`,
          'success'
        );
      }
    } else if (effectiveMode === 'new') {
      const result = svgImportToNewDocument(source, source.suggestedName);
      if (result.objects.length === 0) {
        throw new ImportError(
          'empty-svg',
          'SVG 中没有可导入的图元',
          '文件里的形状可能尺寸为 0，或全部落在暂不支持的元素上。'
        );
      }
      store.loadDocument(result.doc, '', true);
      store.notify(`已从「${source.fileName}」新建画布：${result.objects.length} 个图元`, 'success');
    } else if (effectiveMode === 'replace') {
      const result = svgImportToReplacement(store.doc, source);
      if (result.objects.length === 0) {
        throw new ImportError('empty-svg', 'SVG 中没有可导入的图元');
      }
      store.updateDoc(result.doc, true);
      store.setSelection([]);
      store.fitToCanvas();
      store.notify(
        `已用 SVG 覆盖当前画布（${result.objects.length} 个图元），可按 Ctrl+Z 撤销`,
        'success'
      );
    } else {
      const result = svgImportToAppend(store.doc, source);
      if (result.objects.length === 0) {
        throw new ImportError('empty-svg', 'SVG 中没有可导入的图元');
      }
      store.updateDoc(result.doc, true);
      store.setSelection(
        result.objects.filter((object) => !object.parentId).map((object) => object.id)
      );
      const layer = store.doc.layers.find((item) => item.id === result.layerId);
      store.notify(
        `已导入 ${result.objects.length} 个图元到「${layer?.name ?? '当前图层'}」`,
        'success'
      );
    }

    if (source.warnings.length > 0) {
      store.notify(`导入时已自动处理：${source.warnings[0]}`, 'info');
    }
    if (extraWarnings.length > 0) {
      store.notify(`导入提示：${extraWarnings[0]}`, 'info');
    }
    return true;
  };

  return { pickImportFile, readDroppedFile, applyImport };
}
