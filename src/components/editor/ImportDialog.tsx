import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { drawLayer } from '../../core/document';
import {
  IMPORT_FORMAT_GUIDE,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILES,
  MAX_RASTER_BYTES,
  formatFileSize,
  importErrorInfo,
  validateImportContent,
  validateRasterImport,
  type ImportErrorInfo,
  type ImportMode,
  type ImportedSource
} from '../../core/io/importFile';
import { useAppStore } from '../../store/useAppStore';
import type { IconName } from '../../types/ui';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { useImportActions, type PickedImportFile } from './useImportActions';

type Phase = 'idle' | 'reading' | 'ready' | 'applying';

interface ImportEntry {
  id: string;
  name: string;
  source?: ImportedSource;
  error?: ImportErrorInfo;
}

interface ModeOption {
  id: ImportMode;
  label: string;
  icon: IconName;
  hint: string;
  disabled: boolean;
  disabledReason: string | null;
}

function formatSavedAt(value: string | null): string {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN');
}

function imageFormatLabel(format: string): string {
  return format === 'webp' ? 'WebP' : format === 'jpeg' ? 'JPEG' : format.toUpperCase();
}

function sourceBadge(source: ImportedSource): string {
  if (source.kind === 'document') return `VDraw v${source.stats.version}`;
  if (source.kind === 'svg') return 'SVG';
  return imageFormatLabel(source.stats.format);
}

function sourceMeta(source: ImportedSource): string {
  if (source.kind === 'document') {
    return `${source.stats.layers} 图层 · ${source.stats.objects} 对象`;
  }
  if (source.kind === 'svg') {
    return `${Math.round(source.stats.width)} × ${Math.round(source.stats.height)} px · ${source.stats.elements} 图元`;
  }
  return `${source.stats.width} × ${source.stats.height} px · ${imageFormatLabel(source.stats.format)}`;
}

function ImportErrorCard({ error, testId }: { error: ImportErrorInfo; testId?: string }) {
  return (
    <div className="import-error" data-testid={testId} role="alert">
      <Icon name="warning" size={16} />
      <div className="import-error__body">
        <strong>{error.title}</strong>
        <span>{error.message}</span>
        {error.hint ? <em>{error.hint}</em> : null}
      </div>
    </div>
  );
}

/** 导入对话框：批量文件校验、格式说明、三种落点（覆盖 / 当前图层 / 新建图层）。 */
export function ImportDialog() {
  const open = useAppStore((state) => state.importPanelOpen);
  const closeImportPanel = useAppStore((state) => state.closeImportPanel);
  const pushOverlay = useAppStore((state) => state.pushOverlay);
  const popOverlay = useAppStore((state) => state.popOverlay);
  const route = useAppStore((state) => state.route);
  const doc = useAppStore((state) => state.doc);
  const actions = useImportActions();

  const [phase, setPhase] = useState<Phase>('idle');
  const [entries, setEntries] = useState<ImportEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<ImportErrorInfo | null>(null);
  const [mode, setMode] = useState<ImportMode>('replace');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const dragDepth = useRef(0);
  const readToken = useRef(0);
  const entrySeq = useRef(0);
  const entriesRef = useRef<ImportEntry[]>([]);

  const commitEntries = (next: ImportEntry[]) => {
    entriesRef.current = next;
    setEntries(next);
  };

  const busy = phase === 'reading' || phase === 'applying';
  const hasCanvas = route === 'editor';
  const targetLayer = useMemo(() => drawLayer(doc), [doc]);
  const svgTargetReady = Boolean(targetLayer && !targetLayer.locked);

  const sources = useMemo(
    () => entries.flatMap((entry) => (entry.source ? [entry.source] : [])),
    [entries]
  );
  const activeEntry =
    entries.find((entry) => entry.id === activeId) ??
    entries.find((entry) => entry.source) ??
    entries[0];
  const source = activeEntry?.source ?? null;
  const failCount = entries.filter((entry) => entry.error).length;

  useEffect(() => {
    if (!open) return;
    readToken.current += 1;
    entrySeq.current = 0;
    entriesRef.current = [];
    setPhase('idle');
    setEntries([]);
    setActiveId(null);
    setError(null);
    setDragging(false);
    setProgress(null);
    dragDepth.current = 0;
    setMode(useAppStore.getState().route === 'editor' ? 'replace' : 'new');
  }, [open]);

  // 浮层栈：打开时全局快捷键让位，Esc 只关闭当前对话框。
  useEffect(() => {
    if (!open) return;
    pushOverlay();
    return () => popOverlay();
  }, [open, pushOverlay, popOverlay]);

  // 拖到对话框外时浏览器默认会用文件替换当前页面：对话框打开期间全局拦截。
  useEffect(() => {
    if (!open) return;
    const prevent = (event: globalThis.DragEvent) => event.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, [open]);

  if (!open) return null;

  const close = () => {
    if (phase === 'applying') return;
    readToken.current += 1;
    closeImportPanel();
  };

  /** 依据当前文档能力计算四种落点；批量时覆盖/新建自动禁用。 */
  const buildModes = (list: ImportedSource[]): ModeOption[] => {
    const count = list.length;
    const single = count === 1 ? list[0] : null;
    const hasImportableContent = list.some((item) =>
      item.kind === 'document' ? item.stats.objects > 0 : true
    );
    const appendReady = hasCanvas && Boolean(targetLayer) && !targetLayer?.locked;
    return [
      {
        id: 'replace',
        label: '覆盖当前画布',
        icon: 'layers',
        hint:
          single?.kind === 'document'
            ? `保留当前文件名与保存位置，整体替换页面（${single.stats.pageWidth} × ${single.stats.pageHeight} px）、图层与样式；可 Ctrl+Z 撤销。`
            : single?.kind === 'image'
              ? '清空画布现有对象，把位图按原始尺寸居中放入页面；超出页面也不缩放、不裁剪，可 Ctrl+Z 撤销。'
              : '清空画布现有对象后放入 SVG 图元，保持原始尺寸并居中；可 Ctrl+Z 撤销。',
        disabled:
          !hasCanvas || count !== 1 || (single?.kind !== 'document' && !svgTargetReady),
        disabledReason: !hasCanvas
          ? '启动页没有正在编辑的文档'
          : count !== 1
            ? '批量导入请使用「导入到当前图层」或「导入到新建图层」'
            : svgTargetReady
              ? null
              : targetLayer?.locked
                ? `当前绘图层「${targetLayer.name}」已锁定，请先解锁`
                : '当前没有可绘制图层，请先新建普通图层'
      },
      {
        id: 'new',
        label: '新建画布',
        icon: 'plus',
        hint:
          single?.kind === 'svg'
            ? `按 SVG 尺寸（${Math.round(single.stats.width)} × ${Math.round(single.stats.height)} px）新建文档，不修改当前画布内容。`
            : single?.kind === 'image'
              ? `按图片像素尺寸（${single.stats.width} × ${single.stats.height} px）新建文档，位图铺满页面；不修改当前画布内容。`
              : '以文件的页面尺寸与图层新建文档，不关联原工程文件；当前画布会被切换（未保存时会先确认）。',
        disabled: count !== 1,
        disabledReason: count !== 1 ? '新建画布一次只能处理一个文件' : null
      },
      {
        id: 'append',
        label: '导入到当前图层',
        icon: 'merge',
        hint:
          count > 1
            ? `把 ${count} 个文件写入当前绘图层；工程文件会摊平图层并重映射 ID，保留现有对象。`
            : single?.kind === 'document'
              ? '把文件中的图形摊平写入当前绘图层，自动重映射图层与对象 ID，保留现有对象。'
              : single?.kind === 'image'
                ? '把位图按原始尺寸居中放入当前绘图层，超出页面也不缩放、不裁剪。'
                : '把 SVG 图元按原始尺寸居中放进当前绘图层，保留现有对象与图层结构。',
        disabled: !appendReady || !hasImportableContent,
        disabledReason: !hasCanvas
          ? '启动页没有正在编辑的文档'
          : !targetLayer
            ? '当前没有可绘制图层，请先新建普通图层'
            : targetLayer.locked
              ? `当前绘图层「${targetLayer.name}」已锁定，请先解锁`
              : !hasImportableContent
                ? '文件里没有可导入的对象'
                : null
      },
      {
        id: 'layer',
        label: '导入到新建图层',
        icon: 'layers',
        hint:
          count > 1
            ? `每个文件新建一个图层（按文件名命名），整批只产生一次撤销记录，可整体移动或缩放。`
            : '新建一个以文件名命名的图层，把内容放进去；不修改现有图层，可 Ctrl+Z 撤销。',
        disabled: !hasCanvas || !hasImportableContent,
        disabledReason: !hasCanvas
          ? '启动页没有正在编辑的文档'
          : !hasImportableContent
            ? '文件里没有可导入的对象'
            : null
      }
    ];
  };

  const modeOptions = buildModes(sources);
  const currentMode = modeOptions.find((option) => option.id === mode);
  const canApply = sources.length > 0 && phase === 'ready' && Boolean(currentMode && !currentMode.disabled);

  const autoSelectMode = (list: ImportedSource[]) => {
    const options = buildModes(list);
    setMode((current) => {
      // 继续添加时尽量保留用户已经选的落点，只有当前落点不再可用才自动切换。
      const currentOption = options.find((option) => option.id === current);
      if (currentOption && !currentOption.disabled) return current;
      const preferred = list.length > 1 ? 'layer' : current;
      const preferredOption = options.find((option) => option.id === preferred);
      if (preferredOption && !preferredOption.disabled) return preferredOption.id;
      return options.find((option) => !option.disabled)?.id ?? 'new';
    });
  };

  const ingestPicked = async (picked: PickedImportFile[], append = false) => {
    if (picked.length === 0) {
      setPhase(entriesRef.current.length > 0 ? 'ready' : 'idle');
      return;
    }
    const token = ++readToken.current;
    const baseEntries = append ? entriesRef.current : [];
    setActiveId(append ? activeId : null);
    setError(null);
    setProgress({ done: 0, total: picked.length });
    setPhase('reading');
    commitEntries(baseEntries);

    const next = [...baseEntries];
    for (let index = 0; index < picked.length; index += 1) {
      if (token !== readToken.current) return;
      const item = picked[index];
      entrySeq.current += 1;
      const id = `import-${entrySeq.current}`;
      let entry: ImportEntry;
      try {
        if (item.error) {
          entry = { id, name: item.name, error: item.error };
        } else {
          const parsed = item.dataUrl
            ? await validateRasterImport({
                fileName: item.name,
                dataUrl: item.dataUrl,
                bytes: item.bytes
              })
            : validateImportContent({
                fileName: item.name,
                content: item.content ?? ''
              });
          entry = { id, name: item.name, source: parsed };
        }
      } catch (caught) {
        entry = { id, name: item.name, error: importErrorInfo(caught) };
      }
      next.push(entry);
      if (token !== readToken.current) return;
      commitEntries([...next]);
      setActiveId((current) => current ?? (entry.source ? entry.id : current));
      setProgress({ done: index + 1, total: picked.length });
      // 让浏览器绘制进度后再继续解析下一个文件。
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (token !== readToken.current) return;

    setPhase('ready');
    setProgress(null);
    const firstNewOk = next.slice(baseEntries.length).find((entry) => entry.source);
    const firstOk = next.find((entry) => entry.source);
    setActiveId(firstNewOk?.id ?? activeId ?? firstOk?.id ?? next[0]?.id ?? null);
    autoSelectMode(next.flatMap((entry) => (entry.source ? [entry.source] : [])));
  };

  const choose = async (append = false) => {
    if (busy) return;
    setError(null);
    setPhase('reading');
    try {
      const picked = await actions.pickImportFiles();
      if (picked.length === 0) {
        setPhase(entriesRef.current.length > 0 ? 'ready' : 'idle');
        return;
      }
      await ingestPicked(picked, append);
    } catch (caught) {
      setError(importErrorInfo(caught));
      setPhase(entriesRef.current.length > 0 ? 'ready' : 'idle');
    }
  };

  const ingestDroppedFiles = async (files: File[]) => {
    if (busy || files.length === 0) return;
    setError(null);
    setPhase('reading');
    try {
      const picked = await actions.readDroppedFiles(files);
      await ingestPicked(picked, entriesRef.current.length > 0);
    } catch (caught) {
      setError(importErrorInfo(caught));
      setPhase(entriesRef.current.length > 0 ? 'ready' : 'idle');
    }
  };

  const removeEntry = (id: string) => {
    if (busy) return;
    const next = entriesRef.current.filter((entry) => entry.id !== id);
    commitEntries(next);
    if (activeId === id) {
      const fallback = next.find((entry) => entry.source) ?? next[0];
      setActiveId(fallback?.id ?? null);
    }
    if (next.length === 0) {
      setPhase('idle');
      setError(null);
    }
    autoSelectMode(next.flatMap((entry) => (entry.source ? [entry.source] : [])));
  };

  const clearEntries = () => {
    if (busy || entriesRef.current.length === 0) return;
    readToken.current += 1;
    commitEntries([]);
    setActiveId(null);
    setPhase('idle');
    setError(null);
    setProgress(null);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (busy) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) void ingestDroppedFiles(files);
  };

  const confirm = async () => {
    if (!canApply) return;
    setPhase('applying');
    setError(null);
    try {
      const applied = await actions.applyImport(sources, mode);
      if (applied) closeImportPanel();
      else setPhase('ready');
    } catch (caught) {
      setError(importErrorInfo(caught));
      setPhase('ready');
    }
  };

  const saved = source?.kind === 'document' ? formatSavedAt(source.stats.savedAt) : null;
  const showBatch = entries.length > 1;
  const fileLabel =
    entries.length > 1 ? `${entries.length} 个文件` : entries[0]?.name ?? '';

  return (
    <Modal
      title="导入文件"
      subtitle="从本机文件恢复图形、样式、图层，或放入位图 · 支持一次选择多个文件"
      className="modal--import"
      onClose={close}
      footer={
        <>
          <button
            type="button"
            className="btn btn--outline btn--sm"
            disabled={phase === 'applying'}
            onClick={close}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            data-testid="import-confirm"
            disabled={!canApply}
            onClick={() => void confirm()}
          >
            <Icon name="upload" size={14} />
            {phase === 'applying'
              ? '导入中…'
              : sources.length > 1
                ? `导入 ${sources.length} 个文件`
                : '导入'}
          </button>
        </>
      }
    >
      <div className="import-dialog" data-testid="import-dialog">
        {entries.length === 0 ? (
          <section className="import-formats" aria-label="支持的导入格式">
            <div className="import-formats__head">
              <h3>支持的文件</h3>
              <span>来源：本机文件，不上传</span>
            </div>
            <p className="import-formats__line">
              <code>.vdraw / .json</code> 工程 · <code>.svg</code> 矢量图 ·
              <code>PNG / JPEG / WebP / GIF / BMP</code> 位图
            </p>
            <details className="import-formats__more">
              <summary>格式细节与限制</summary>
              <ul>
                {IMPORT_FORMAT_GUIDE.map((item) => (
                  <li key={item.id} data-supported={item.supported ? 'true' : 'false'}>
                    <code>{item.extension}</code>
                    <strong>{item.label}</strong>
                    <span>
                      {item.detail}
                      {item.supported ? null : <em>（不支持导入）</em>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        ) : null}

        <div
          className={`import-drop${dragging ? ' is-dragging' : ''}`}
          data-testid="import-drop"
          onDragEnter={handleDragEnter}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <span className="import-drop__icon">
            <Icon name="upload" size={18} />
          </span>
          <span className="import-drop__body">
            <strong>{fileLabel || '拖入文件，或选择本地文件'}</strong>
            <span>
              {phase === 'reading'
                ? progress
                  ? `正在读取并校验 ${progress.done}/${progress.total}…`
                  : '正在读取文件…'
                : entries.length > 0
                  ? `${sources.length} 个可导入${failCount > 0 ? ` · ${failCount} 个失败` : ''} · 可重新选择`
                  : `.vdraw / .json / .svg / 位图 · 一次最多 ${MAX_IMPORT_FILES} 个 · 文本 ${formatFileSize(MAX_IMPORT_BYTES)} / 位图 ${formatFileSize(MAX_RASTER_BYTES)}`}
            </span>
          </span>
          <button
            type="button"
            className="btn btn--outline btn--sm import-drop__action"
            data-testid="import-choose"
            disabled={busy}
            onClick={() => void choose(entries.length > 0)}
          >
            <Icon name={entries.length > 0 ? 'plus' : 'folder'} size={14} />
            {entries.length > 0 ? '添加文件' : '选择文件'}
          </button>
        </div>

        {phase === 'reading' ? (
          <div className="import-status" data-testid="import-loading" role="status">
            <span className="import-spin" aria-hidden="true" />
            {progress
              ? `正在读取并校验 ${progress.done}/${progress.total}…`
              : '正在读取、解析并校验文件…'}
          </div>
        ) : null}

        {error ? <ImportErrorCard error={error} testId="import-error" /> : null}

        {!hasCanvas && sources.length > 1 ? (
          <div className="import-status" data-testid="import-batch-hint" role="status">
            <Icon name="info" size={14} />
            启动页一次只能导入一个文件；请先新建或打开画布后再批量导入。
          </div>
        ) : null}

        {entries.length === 1 && entries[0].error ? (
          <ImportErrorCard error={entries[0].error} testId="import-error" />
        ) : null}

        {showBatch ? (
          <section className="import-batch" data-testid="import-batch" aria-label="已选择的文件">
            <div className="import-batch__head">
              <div className="import-batch__title">
                <strong>已选择 {entries.length} 个文件</strong>
                <span>
                  {sources.length} 个可导入
                  {failCount > 0 ? ` · ${failCount} 个失败` : ''}
                </span>
              </div>
              <div className="import-batch__actions">
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  data-testid="import-add-more"
                  disabled={busy}
                  onClick={() => void choose(true)}
                >
                  <Icon name="plus" size={13} />
                  继续添加
                </button>
                <button
                  type="button"
                  className="ghost-action"
                  data-testid="import-clear"
                  disabled={busy}
                  onClick={clearEntries}
                >
                  清空
                </button>
              </div>
            </div>
            <ul
              className="import-batch__list"
              data-testid="import-batch-list"
              onWheel={(event) => event.stopPropagation()}
            >
              {entries.map((entry) => {
                const active = entry.id === activeEntry?.id;
                return (
                  <li
                    key={entry.id}
                    className={`import-batch__item${active ? ' is-active' : ''}`}
                    data-ok={entry.source ? 'true' : 'false'}
                    data-testid="import-batch-row"
                  >
                    <button
                      type="button"
                      className="import-batch__button"
                      aria-pressed={active}
                      title={
                        entry.source && entry.source.warnings.length > 0
                          ? `${entry.name}\n${entry.source.warnings.join('\n')}`
                          : entry.name
                      }
                      onClick={() => setActiveId(entry.id)}
                    >
                      <span
                        className={`import-badge${entry.error ? ' import-badge--error' : ''}`}
                      >
                        {entry.source ? sourceBadge(entry.source) : '失败'}
                      </span>
                      <span className="import-batch__name">{entry.name}</span>
                      <span className="import-batch__meta">
                        {entry.source ? sourceMeta(entry.source) : '无法导入'}
                      </span>
                      <Icon name={entry.source ? 'check' : 'warning'} size={14} />
                    </button>
                    <button
                      type="button"
                      className="import-batch__remove"
                      data-testid="import-remove"
                      aria-label={`移除 ${entry.name}`}
                      title={`移除 ${entry.name}`}
                      disabled={busy}
                      onClick={() => removeEntry(entry.id)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                    {entry.error ? (
                      <div
                        className="import-batch__error"
                        role="alert"
                        title={entry.error.hint ?? entry.error.message}
                      >
                        <strong>{entry.error.title}</strong>
                        <span>{entry.error.message}</span>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {entries.length > 1 && source && source.warnings.length > 0 ? (
          <ul className="import-warnings">
            {source.warnings.map((warning) => (
              <li key={warning}>· {warning}</li>
            ))}
          </ul>
        ) : null}

        {source && entries.length === 1 ? (
          <>
            <section className="import-summary" data-testid="import-summary">
              <header className="import-summary__head">
                <span className="import-badge">{sourceBadge(source)}</span>
                <strong title={source.fileName}>{source.fileName}</strong>
                <button
                  type="button"
                  className="import-summary__remove"
                  data-testid="import-remove-single"
                  aria-label={`移除 ${source.fileName}`}
                  title={`移除 ${source.fileName}`}
                  disabled={busy}
                  onClick={() => {
                    if (activeEntry) removeEntry(activeEntry.id);
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </header>
              <dl>
                <div>
                  <dt>
                    {source.kind === 'document'
                      ? '页面尺寸'
                      : source.kind === 'svg'
                        ? '画布尺寸'
                        : '图片尺寸'}
                  </dt>
                  <dd>
                    {source.kind === 'document'
                      ? `${source.stats.pageWidth} × ${source.stats.pageHeight} px`
                      : `${Math.round(source.stats.width)} × ${Math.round(source.stats.height)} px`}
                  </dd>
                </div>
                {source.kind === 'document' ? (
                  <>
                    <div>
                      <dt>图层 / 对象</dt>
                      <dd>
                        {source.stats.layers} / {source.stats.objects}
                      </dd>
                    </div>
                    <div>
                      <dt>画布模板</dt>
                      <dd>{source.stats.templateName}</dd>
                    </div>
                    <div>
                      <dt>保存时间</dt>
                      <dd>{saved}</dd>
                    </div>
                  </>
                ) : source.kind === 'svg' ? (
                  <>
                    <div>
                      <dt>图元数量</dt>
                      <dd>{source.stats.elements}</dd>
                    </div>
                    <div>
                      <dt>跳过元素</dt>
                      <dd>{source.stats.skipped}</dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <dt>文件大小</dt>
                      <dd>{formatFileSize(source.stats.bytes)}</dd>
                    </div>
                    <div>
                      <dt>位图格式</dt>
                      <dd>{imageFormatLabel(source.stats.format)}</dd>
                    </div>
                  </>
                )}
              </dl>
              {source.warnings.length > 0 ? (
                <ul className="import-warnings">
                  {source.warnings.map((warning) => (
                    <li key={warning}>· {warning}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          </>
        ) : null}

        {sources.length > 0 ? (
            <section className="import-modes" aria-label="导入方式">
              <div className="import-modes__head">
                <strong>导入方式</strong>
                <span>
                  {hasCanvas
                    ? sources.length > 1
                      ? '整批一次写入，可 Ctrl+Z 撤销'
                      : '覆盖/导入均可撤销'
                    : '启动页一次只能导入一个文件'}
                </span>
              </div>
              {modeOptions.map((option) => {
                const active = mode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`import-mode${active ? ' is-active' : ''}`}
                    data-testid={`import-mode-${option.id}`}
                    disabled={option.disabled || phase === 'applying'}
                    aria-pressed={active}
                    title={option.disabled ? option.disabledReason ?? '当前不可用' : option.hint}
                    onClick={() => setMode(option.id)}
                  >
                    <span className="import-mode__radio">
                      <span />
                    </span>
                    <span className="import-mode__body">
                      <strong>
                        <Icon name={option.icon} size={13} /> {option.label}
                      </strong>
                      <span>
                        {option.disabled ? option.disabledReason ?? '当前不可用' : option.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </section>
        ) : null}
      </div>
    </Modal>
  );
}
