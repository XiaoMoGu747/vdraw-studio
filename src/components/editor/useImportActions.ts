import { pickBrowserFiles, readPickedBrowserFile } from '../../core/io/filePicker';
import {
  IMPORT_ACCEPT,
  ImportError,
  MAX_IMPORT_FILES,
  documentImportToNewDocument,
  documentImportToReplacement,
  imageImportToNewDocument,
  imageImportToReplacement,
  importErrorInfo,
  importSourcesToDocument,
  svgImportToNewDocument,
  svgImportToReplacement,
  type ImportErrorInfo,
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
  /** 该文件读取失败（超限/不可读）；仍保留条目，由对话框逐条提示。 */
  error?: ImportErrorInfo;
}

function readErrorInfo(message: string): ImportErrorInfo {
  return {
    code: 'invalid-document',
    title: '读取文件失败',
    message,
    hint: '请确认文件可读且未超过单文件大小上限。'
  };
}

/**
 * 导入动作：桌面端走主进程原生多选对话框，网页端走 input[type=file][multiple]。
 * 两端拿到的是同一结构的文件数组，后续校验、批量写入与撤销逻辑完全一致。
 */
export function useImportActions() {
  const pickImportFiles = async (): Promise<PickedImportFile[]> => {
    const api = window.vdraw;
    if (api && typeof api.file.pickImportFiles === 'function') {
      const result = await api.file.pickImportFiles();
      if (result.canceled) return [];
      const entries =
        result.files && result.files.length > 0
          ? result.files
          : [
              {
                name: result.name ?? baseName(result.path ?? '') ?? '未命名',
                path: result.path,
                content: result.content,
                dataUrl: result.dataUrl,
                bytes: result.bytes
              }
            ];
      if (entries.length > MAX_IMPORT_FILES) {
        throw new ImportError(
          'file-too-large',
          `一次最多导入 ${MAX_IMPORT_FILES} 个文件`,
          '请分批导入，或先整理成一个工程文件。'
        );
      }
      return entries.map((entry) => {
        if (entry.error) {
          return { name: entry.name, path: entry.path, error: readErrorInfo(entry.error) };
        }
        if (entry.dataUrl) {
          return {
            name: entry.name,
            path: entry.path,
            dataUrl: entry.dataUrl,
            bytes: entry.bytes
          };
        }
        if (typeof entry.content === 'string') {
          return {
            name: entry.name,
            path: entry.path,
            content: entry.content,
            bytes: entry.bytes
          };
        }
        return {
          name: entry.name,
          path: entry.path,
          error: readErrorInfo('文件内容为空或无法读取')
        };
      });
    }

    const files = await pickBrowserFiles(IMPORT_ACCEPT);
    if (files.length === 0) return [];
    if (files.length > MAX_IMPORT_FILES) {
      throw new ImportError(
        'file-too-large',
        `一次最多导入 ${MAX_IMPORT_FILES} 个文件`,
        '请分批导入，或先整理成一个工程文件。'
      );
    }
    const picked: PickedImportFile[] = [];
    for (const file of files) {
      try {
        picked.push(await readPickedBrowserFile(file));
      } catch (error) {
        picked.push({
          name: file.name,
          bytes: file.size,
          error: importErrorInfo(error)
        });
      }
    }
    return picked;
  };

  /** 拖拽与网页端选择共用同一套读取/格式判断；单个失败不影响整批。 */
  const readDroppedFiles = async (files: File[]): Promise<PickedImportFile[]> => {
    if (files.length > MAX_IMPORT_FILES) {
      throw new ImportError(
        'file-too-large',
        `一次最多导入 ${MAX_IMPORT_FILES} 个文件`,
        '请分批拖入，或先整理成一个工程文件。'
      );
    }
    const picked: PickedImportFile[] = [];
    for (const file of files) {
      try {
        picked.push(await readPickedBrowserFile(file));
      } catch (error) {
        picked.push({
          name: file.name,
          bytes: file.size,
          error: importErrorInfo(error)
        });
      }
    }
    return picked;
  };

  /**
   * 把已校验的导入数据写入画布。
   * - replace / new：仅允许单文件。
   * - append / layer：整批文件共用一次 updateDoc，只产生一个撤销快照。
   */
  const applyImport = async (sources: ImportedSource[], mode: ImportMode): Promise<boolean> => {
    const store = useAppStore.getState();
    if (sources.length === 0) return false;
    // 启动页没有正在编辑的文档：单文件按"新建画布"处理，批量则提示逐个导入。
    const effectiveMode: ImportMode = store.route === 'editor' ? mode : 'new';

    if (effectiveMode === 'new' || effectiveMode === 'replace') {
      if (sources.length !== 1) {
        throw new ImportError(
          'unsupported-type',
          '覆盖画布 / 新建画布一次只能处理一个文件',
          '批量导入请改用「导入到当前图层」或「导入到新建图层」。'
        );
      }
    }

    if (effectiveMode === 'new' && store.route === 'editor' && store.isDirty) {
      if (window.vdraw?.isSmoke !== true) {
        const ok = window.confirm(
          '当前文档有未保存的修改，导入为新画布后这些修改会丢失。是否继续？'
        );
        if (!ok) return false;
      }
    }

    const source = sources[0];
    let extraWarnings: string[] = [];
    const validationWarnings = sources.flatMap((item) =>
      item.warnings.map((warning) => `「${item.fileName}」${warning}`)
    );

    if (effectiveMode === 'replace') {
      if (source.kind === 'document') {
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
      } else if (source.kind === 'image') {
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
        const result = svgImportToReplacement(store.doc, source);
        if (result.objects.length === 0) {
          throw new ImportError('empty-svg', 'SVG 中没有可导入的图元');
        }
        store.updateDoc(result.doc, true);
        store.setSelection(
          result.objects.filter((object) => !object.parentId).map((object) => object.id)
        );
        store.fitToCanvas();
        if (source.stats.width > store.doc.page.width || source.stats.height > store.doc.page.height) {
          extraWarnings = [`「${source.fileName}」画布尺寸大于页面，已保持原始尺寸`];
        }
        store.notify(
          `已用 SVG 覆盖当前画布（${result.objects.length} 个图元），可按 Ctrl+Z 撤销`,
          'success'
        );
      }
    } else if (effectiveMode === 'new') {
      if (source.kind === 'document') {
        const doc = documentImportToNewDocument(source, source.suggestedName);
        store.loadDocument(doc, '', true);
        if (source.editor) store.applyEditorSnapshot(source.editor);
        store.notify(
          `已从「${source.fileName}」新建画布：${source.stats.layers} 图层 · ${source.stats.objects} 对象`,
          'success'
        );
      } else if (source.kind === 'image') {
        const result = imageImportToNewDocument(source, source.suggestedName);
        store.loadDocument(result.doc, '', true);
        extraWarnings = result.warnings;
        store.notify(
          `已从「${source.fileName}」新建位图画布：${source.stats.width} × ${source.stats.height} px`,
          'success'
        );
      } else {
        const result = svgImportToNewDocument(source, source.suggestedName);
        if (result.objects.length === 0) {
          throw new ImportError(
            'empty-svg',
            'SVG 中没有可导入的图元',
            '文件里的形状可能尺寸为 0，或全部落在暂不支持的元素上。'
          );
        }
        store.loadDocument(result.doc, '', true);
        store.notify(
          `已从「${source.fileName}」新建画布：${result.objects.length} 个图元`,
          'success'
        );
      }
    } else {
      const built = importSourcesToDocument(store.doc, sources, effectiveMode);
      store.updateDoc(built.doc, true);
      store.setSelection(built.selection);
      extraWarnings = built.warnings;
      if (effectiveMode === 'append') {
        const layer = built.doc.layers.find((item) => item.id === built.layerIds[0]);
        store.notify(
          `已导入 ${sources.length} 个文件到「${layer?.name ?? '当前图层'}」：${built.objectsAdded} 个对象，可按 Ctrl+Z 撤销`,
          'success'
        );
      } else {
        store.notify(
          `已导入 ${sources.length} 个文件到新建图层：${built.layersAdded} 个图层 · ${built.objectsAdded} 个对象，可按 Ctrl+Z 撤销`,
          'success'
        );
      }
    }

    const warnings = [...validationWarnings, ...extraWarnings];
    if (warnings.length > 0) {
      store.notify(`导入提示：${warnings[0]}`, 'info');
    }
    return true;
  };

  return { pickImportFiles, readDroppedFiles, applyImport };
}
