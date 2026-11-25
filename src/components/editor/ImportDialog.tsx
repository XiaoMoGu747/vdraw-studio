import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { drawLayer } from '../../core/document';
import {
  IMPORT_FORMAT_GUIDE,
  MAX_IMPORT_BYTES,
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

/** 导入对话框：格式与来源说明、结构校验反馈、覆盖/新建/合并三种落点。 */
export function ImportDialog() {
  const open = useAppStore((state) => state.importPanelOpen);
  const closeImportPanel = useAppStore((state) => state.closeImportPanel);
  const pushOverlay = useAppStore((state) => state.pushOverlay);
  const popOverlay = useAppStore((state) => state.popOverlay);
  const route = useAppStore((state) => state.route);
  const doc = useAppStore((state) => state.doc);
  const actions = useImportActions();

  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState('');
  const [source, setSource] = useState<ImportedSource | null>(null);
  const [error, setError] = useState<ImportErrorInfo | null>(null);
  const [mode, setMode] = useState<ImportMode>('replace');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const busy = phase === 'reading' || phase === 'applying';
  const hasCanvas = route === 'editor';
  const targetLayer = useMemo(() => drawLayer(doc), [doc]);
  const svgTargetReady = Boolean(targetLayer && !targetLayer.locked);

  useEffect(() => {
    if (!open) return;
    setPhase('idle');
    setFileName('');
    setSource(null);
    setError(null);
    setDragging(false);
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
    closeImportPanel();
  };

  const applySource = (next: ImportedSource) => {
    setSource(next);
    setError(null);
    setPhase('ready');
    // 校验通过后按当前文档能力自动落回一个可用选项，避免停在灰色选项上。
    const canReplace = hasCanvas && (next.kind === 'document' || svgTargetReady);
    const canAppend =
      hasCanvas && (next.kind === 'document' ? next.stats.objects > 0 : svgTargetReady);
    if (mode === 'replace' && !canReplace) setMode(canAppend ? 'append' : 'new');
    else if (mode === 'append' && !canAppend) setMode(canReplace ? 'replace' : 'new');
  };

  /** 文本走结构校验，位图走"文件头 + 解码"校验；两者最终都落到同一个 ImportedSource。 */
  const ingestPicked = async (picked: PickedImportFile) => {
    if (picked.dataUrl) {
      applySource(
        await validateRasterImport({
          fileName: picked.name,
          dataUrl: picked.dataUrl,
          bytes: picked.bytes
        })
      );
      return;
    }
    applySource(
      validateImportContent({ fileName: picked.name, content: picked.content ?? '' })
    );
  };

  const choose = async () => {
    if (busy) return;
    setSource(null);
    setError(null);
    setFileName('');
    setPhase('reading');
    try {
      const picked = await actions.pickImportFile();
      if (!picked) {
        setPhase('idle');
        return;
      }
      setFileName(picked.name);
      // 先让浏览器绘制"正在读取"，再执行可能较重的解析/解码。
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      await ingestPicked(picked);
    } catch (caught) {
      setSource(null);
      setError(importErrorInfo(caught));
      setPhase('idle');
    }
  };

  const ingestDroppedFile = async (file: File) => {
    if (busy) return;
    setSource(null);
    setError(null);
    setFileName(file.name);
    setPhase('reading');
    try {
      const picked = await actions.readDroppedFile(file);
      setFileName(picked.name);
      await ingestPicked(picked);
    } catch (caught) {
      setSource(null);
      setError(importErrorInfo(caught));
      setPhase('idle');
    }
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
    const file = event.dataTransfer.files?.[0];
    if (file) void ingestDroppedFile(file);
  };

  const confirm = async () => {
    if (!source || phase !== 'ready') return;
    setPhase('applying');
    setError(null);
    try {
      const applied = await actions.applyImport(source, mode);
      if (applied) closeImportPanel();
      else setPhase('ready');
    } catch (caught) {
      setError(importErrorInfo(caught));
      setPhase('ready');
    }
  };

  const svgHint = !hasCanvas
    ? '启动页没有正在编辑的文档；本次导入将直接新建画布。'
    : !targetLayer
      ? '当前没有可绘制图层，请先新建普通图层后再导入。'
      : targetLayer.locked
        ? `当前绘图层「${targetLayer.name}」已锁定，请先解锁。`
        : null;

  // 矢量图与位图都要落到当前绘图层；工程文件自带完整图层结构。
  const needsDrawLayer = source?.kind === 'svg' || source?.kind === 'image';

  const modeOptions: ModeOption[] = [
    {
      id: 'replace',
      label: '覆盖当前画布',
      icon: 'layers',
      hint:
        source?.kind === 'document'
          ? `保留当前文件名与保存位置，用文件内容整体替换页面（${source.stats.pageWidth} × ${source.stats.pageHeight} px）、图层与样式；可 Ctrl+Z 撤销。`
          : source?.kind === 'image'
            ? '清空画布现有对象，把位图按原始尺寸居中放入页面（超出页面时等比缩小）；可 Ctrl+Z 撤销。'
            : '清空画布现有对象后放入 SVG 图元，按页面等比缩放并居中；可 Ctrl+Z 撤销。',
      disabled: !hasCanvas || (needsDrawLayer && !svgTargetReady),
      disabledReason: !hasCanvas ? '启动页没有正在编辑的文档' : svgHint
    },
    {
      id: 'new',
      label: '新建画布',
      icon: 'plus',
      hint:
        source?.kind === 'svg'
          ? `按 SVG 尺寸（${Math.round(source.stats.width)} × ${Math.round(source.stats.height)} px）新建文档，不修改当前画布内容。`
          : source?.kind === 'image'
            ? `按图片像素尺寸（${source.stats.width} × ${source.stats.height} px）新建文档，位图铺满页面；不修改当前画布内容。`
            : '以文件的页面尺寸与图层新建文档，不关联原工程文件；当前画布会被切换（未保存时会先确认）。',
      disabled: false,
      disabledReason: null
    },
    {
      id: 'append',
      label: '合并到当前画布',
      icon: 'merge',
      hint:
        source?.kind === 'document'
          ? '把文件中的图层追加到当前文档，自动重映射图层与对象 ID，避免引用冲突。'
          : source?.kind === 'image'
            ? '把位图作为对象追加到当前绘图层，保留现有对象与图层结构。'
            : '把图元追加到当前绘图层，保留现有对象与图层结构。',
      disabled:
        !hasCanvas ||
        (source?.kind === 'document'
          ? source.stats.objects === 0
          : !svgTargetReady),
      disabledReason: !hasCanvas
        ? '启动页没有正在编辑的文档'
        : source?.kind === 'document' && source.stats.objects === 0
          ? '文件里没有可合并的对象'
          : svgHint
    }
  ];

  const saved = source?.kind === 'document' ? formatSavedAt(source.stats.savedAt) : null;

  return (
    <Modal
      title="导入文件"
      subtitle="从本机文件恢复图形、样式、图层，或放入位图 · 数据只在本机读取"
      className="modal--import"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn btn--outline btn--sm" disabled={phase === 'applying'} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            data-testid="import-confirm"
            disabled={!source || phase !== 'ready'}
            onClick={() => void confirm()}
          >
            <Icon name="upload" size={14} />
            {phase === 'applying' ? '导入中…' : '导入'}
          </button>
        </>
      }
    >
      <div className="import-dialog" data-testid="import-dialog">
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
            <strong>{fileName || '拖入文件，或选择本地文件'}</strong>
            <span>
              {fileName
                ? phase === 'reading'
                  ? '正在读取并校验…'
                  : error
                    ? '读取或校验失败，可重新选择文件'
                    : '已通过校验，可重新选择其他文件'
                : `.vdraw / .json / .svg / 位图 · 文本上限 ${formatFileSize(MAX_IMPORT_BYTES)} · 位图上限 ${formatFileSize(MAX_RASTER_BYTES)}`}
            </span>
          </span>
          <button
            type="button"
            className="btn btn--outline btn--sm import-drop__action"
            data-testid="import-choose"
            disabled={busy}
            onClick={() => void choose()}
          >
            <Icon name="folder" size={14} />
            {fileName ? '更换文件' : '选择文件'}
          </button>
        </div>

        {phase === 'reading' ? (
          <div className="import-status" data-testid="import-loading" role="status">
            <span className="import-spin" aria-hidden="true" />
            正在读取、解析并校验文件…
          </div>
        ) : null}

        {error ? (
          <div className="import-error" data-testid="import-error" role="alert">
            <Icon name="warning" size={16} />
            <div className="import-error__body">
              <strong>{error.title}</strong>
              <span>{error.message}</span>
              {error.hint ? <em>{error.hint}</em> : null}
            </div>
          </div>
        ) : null}

        {source ? (
          <>
            <section className="import-summary" data-testid="import-summary">
              <header className="import-summary__head">
                <span className="import-badge">
                  {source.kind === 'document'
                    ? `VDraw v${source.stats.version}`
                    : source.kind === 'svg'
                      ? 'SVG'
                      : source.stats.format === 'webp'
                        ? 'WebP'
                        : source.stats.format.toUpperCase()}
                </span>
                <strong title={source.fileName}>{source.fileName}</strong>
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
                      <dd>{source.stats.format.toUpperCase()}</dd>
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

            <section className="import-modes" aria-label="导入方式">
              <div className="import-modes__head">
                <strong>导入方式</strong>
                <span>{hasCanvas ? '覆盖/合并均可撤销' : '启动页导入将新建画布'}</span>
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
          </>
        ) : null}
      </div>
    </Modal>
  );
}
