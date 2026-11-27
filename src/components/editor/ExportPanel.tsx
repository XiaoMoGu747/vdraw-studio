import { useEffect, useRef, useState } from 'react';
import { regionWidthForOutputWidth, safeRasterScale } from '../../core/io/raster';
import { pageRegionBounds, selectionExportRegion } from '../../core/io/region';
import { documentToSvgString, resolveExportBox } from '../../core/io/svg';
import { useAppStore } from '../../store/useAppStore';
import type { ExportFormat, ExportRegion } from '../../types/document';
import { Icon } from '../ui/Icon';
import { supportsTransparency, useFileActions } from './useFileActions';

const FORMAT_ITEMS: Array<{ id: ExportFormat; label: string; note: string }> = [
  { id: 'svg', label: 'SVG', note: '矢量 · 保留路径与文本' },
  { id: 'png', label: 'PNG', note: '位图 · 2× 分辨率 · 支持透明' },
  { id: 'jpg', label: 'JPG', note: '位图 · 2× 分辨率 · 体积小、必有底色' },
  { id: 'pdf', label: 'PDF', note: '矢量 · 单页白底' }
];

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  testId: string;
  onCommit: (value: number) => void;
}

/** 精确数值输入：输入过程不受外部 clamp 干扰，失焦后回归真实选区值。 */
function NumberField({ label, value, min, max, testId, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(Math.round(value)));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(Math.round(value)));
  }, [value, editing]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || raw.trim() === '') return;
    onCommit(Math.min(max, Math.max(min, parsed)));
  };

  return (
    <label className="export-panel__field">
      <span className="export-panel__field-label">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        step={1}
        min={min}
        max={max}
        data-testid={testId}
        value={draft}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          commit(draft);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
}

/** 导出面板：格式、整页 / 框选区域、精确尺寸与实时预览。 */
export function ExportPanel() {
  const open = useAppStore((state) => state.exportPanelOpen);
  const format = useAppStore((state) => state.exportFormat);
  const scope = useAppStore((state) => state.exportScope);
  const region = useAppStore((state) => state.exportRegion);
  const doc = useAppStore((state) => state.doc);
  const selection = useAppStore((state) => state.selection);
  const exportTransparent = useAppStore((state) => state.exportTransparent);
  const toggleExportTransparent = useAppStore((state) => state.toggleExportTransparent);
  const closeExportPanel = useAppStore((state) => state.closeExportPanel);
  const setExportFormat = useAppStore((state) => state.setExportFormat);
  const setExportScope = useAppStore((state) => state.setExportScope);
  const setExportRegion = useAppStore((state) => state.setExportRegion);
  const exportQuality = useAppStore((state) => state.exportQuality);
  const setExportQuality = useAppStore((state) => state.setExportQuality);
  const hideCharges = useAppStore((state) => state.chemHideCharges);
  const fileActions = useFileActions();
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const bounds = pageRegionBounds(doc.page);
  const activeRegion: ExportRegion =
    region ?? { x: 0, y: 0, width: bounds.width, height: bounds.height };
  // 选中对象导出跟随当前选区实时变化：换一个对象，预览与输出尺寸立刻跟着变。
  const selectionRegion = selectionExportRegion(doc, selection);
  const box =
    scope === 'selection'
      ? resolveExportBox(doc, selectionRegion)
      : scope === 'region'
        ? resolveExportBox(doc, activeRegion)
        : resolveExportBox(doc, null);
  const exportRegionForScope =
    scope === 'selection' ? selectionRegion : scope === 'region' ? activeRegion : null;
  // 选中对象导出只输出所选对象本身，避免同范围内未选中的对象混进来。
  const onlyIds = scope === 'selection' && selection.length > 0 ? selection : null;
  const onlyIdsKey = onlyIds ? onlyIds.join('|') : '';
  const emptySelection = scope === 'selection' && !selectionRegion;
  const canTransparent = supportsTransparency(format);
  const transparent = exportTransparent && canTransparent;

  /**
   * 实时预览直接用导出管线（同一份 documentToSvgString），所以预览内容与
   * 落盘结果天然一致。拖拽时按 50ms 合并重算，避免大文档卡住手柄。
   */
  const [previewSrc, setPreviewSrc] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    if (!open) {
      setPreviewSrc('');
      setPreviewLoading(false);
      setPreviewError(false);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(false);
    const timer = window.setTimeout(() => {
      try {
        const svg = documentToSvgString(doc, {
          includeBackground: !transparent,
          region: exportRegionForScope
            ? { x: box.x, y: box.y, width: box.width, height: box.height }
            : null,
          includeIds: onlyIds,
          hideCharges
        });
        setPreviewSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      } catch {
        setPreviewSrc('');
        setPreviewError(true);
      } finally {
        setPreviewLoading(false);
      }
    }, 50);
    return () => window.clearTimeout(timer);
    // box / onlyIdsKey 用原始值做依赖，画布重渲染不会触发重新序列化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc, transparent, scope, box.x, box.y, box.width, box.height, onlyIdsKey, hideCharges]);

  // 浮层栈：面板打开时全局快捷键让位，Esc 只关闭面板。
  useEffect(() => {
    if (!open) return;
    const { pushOverlay, popOverlay } = useAppStore.getState();
    pushOverlay();
    return () => popOverlay();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeExportPanel();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, closeExportPanel]);

  if (!open) return null;

  const outputScale =
    format === 'png' || format === 'jpg' ? safeRasterScale(box.width, box.height, 2) : 1;
  const outputWidth = Math.round(box.width * outputScale);
  const outputHeight = Math.round(box.height * outputScale);

  const patchRegion = (patch: Partial<ExportRegion>) =>
    setExportRegion({ ...activeRegion, ...patch });

  const confirm = async () => {
    if (busy || emptySelection) return;
    setBusy(true);
    try {
      const done = await fileActions.exportAs(format, {
        region: exportRegionForScope,
        onlyIds
      });
      if (done) closeExportPanel();
    } finally {
      setBusy(false);
    }
  };

  const scopeHint =
    scope === 'selection'
      ? emptySelection
        ? '未选中对象'
        : `选中 ${selection.length} 个对象 ${box.width} × ${box.height} px`
      : scope === 'region'
        ? `框选区域 ${box.width} × ${box.height} px`
        : `整页 ${box.width} × ${box.height} px`;

  return (
    <div
      ref={rootRef}
      className="export-panel"
      data-testid="export-panel"
      role="dialog"
      aria-label="导出"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <header className="export-panel__head">
        <div>
          <h2>导出</h2>
          <p data-testid="export-scope-hint">{scopeHint}</p>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          title="关闭（Esc）"
          aria-label="关闭导出面板"
          onClick={closeExportPanel}
        >
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="export-panel__body">
        <div className="export-panel__row">
          <span className="export-panel__label">格式</span>
          <div className="export-panel__segment" role="group" aria-label="导出格式">
            {FORMAT_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={format === item.id ? 'is-active' : ''}
                data-testid={`export-format-${item.id}`}
                title={item.note}
                onClick={() => setExportFormat(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {format === 'jpg' ? (
          <div className="export-panel__row" data-testid="export-quality-row">
            <span className="export-panel__label">质量</span>
            <input
              className="export-panel__range"
              type="range"
              min={50}
              max={100}
              step={1}
              value={Math.round(exportQuality * 100)}
              aria-label="JPG 质量"
              data-testid="export-quality"
              onChange={(event) => setExportQuality(Number(event.target.value) / 100)}
            />
            <span className="export-panel__range-value">{Math.round(exportQuality * 100)}%</span>
          </div>
        ) : null}

        <div className="export-panel__row">
          <span className="export-panel__label">范围</span>
          <div className="export-panel__segment" role="group" aria-label="导出范围">
            <button
              type="button"
              className={scope === 'page' ? 'is-active' : ''}
              data-testid="export-scope-page"
              onClick={() => setExportScope('page')}
            >
              整页
            </button>
            <button
              type="button"
              className={scope === 'region' ? 'is-active' : ''}
              data-testid="export-scope-region"
              onClick={() => setExportScope('region')}
            >
              <Icon name="crop" size={12} />
              框选区域
            </button>
            <button
              type="button"
              className={scope === 'selection' ? 'is-active' : ''}
              data-testid="export-scope-selection"
              title="只导出当前选中的对象（包围盒外扩 8px）"
              onClick={() => setExportScope('selection')}
            >
              <Icon name="select" size={12} />
              选中对象
            </button>
          </div>
        </div>

        {scope === 'region' ? (
          <div className="export-panel__fields" data-testid="export-region-fields">
            <NumberField
              label="X"
              value={box.x}
              min={0}
              max={Math.max(0, bounds.width - box.width)}
              testId="export-region-x"
              onCommit={(value) => patchRegion({ x: value })}
            />
            <NumberField
              label="Y"
              value={box.y}
              min={0}
              max={Math.max(0, bounds.height - box.height)}
              testId="export-region-y"
              onCommit={(value) => patchRegion({ y: value })}
            />
            <NumberField
              label="宽"
              value={box.width}
              min={1}
              max={Math.max(1, bounds.width - box.x)}
              testId="export-region-width"
              onCommit={(value) => patchRegion({ width: value })}
            />
            <NumberField
              label="高"
              value={box.height}
              min={1}
              max={Math.max(1, bounds.height - box.y)}
              testId="export-region-height"
              onCommit={(value) => patchRegion({ height: value })}
            />
            {/* 直接填想要的输出像素宽，按导出倍率反算选区宽度，省掉手算 ÷2。 */}
            {format === 'png' || format === 'jpg' ? (
              <NumberField
                label="输出宽"
                value={outputWidth}
                min={1}
                max={Math.round(Math.max(1, bounds.width - box.x) * 2)}
                testId="export-output-width"
                onCommit={(value) =>
                  patchRegion({ width: regionWidthForOutputWidth(value, box.height, 2) })
                }
              />
            ) : null}
          </div>
        ) : null}

        <div className="export-panel__preview" data-transparent={transparent ? 'true' : 'false'}>
          {emptySelection ? (
            <span className="export-panel__preview-empty">
              先在画布上选中要导出的对象
            </span>
          ) : previewSrc ? (
            <img src={previewSrc} alt="导出预览" draggable={false} />
          ) : previewLoading || !previewError ? (
            <span className="export-panel__preview-empty" data-testid="export-preview-loading">
              正在生成预览…
            </span>
          ) : (
            <span className="export-panel__preview-empty">预览不可用</span>
          )}
        </div>

        <div className="export-panel__meta">
          <span data-testid="export-output-size">
            {emptySelection
              ? '输出 —'
              : `输出 ${outputWidth} × ${outputHeight} px${
                  outputScale !== 1 ? ` · ${Number(outputScale.toFixed(2))}×` : ''
                }`}
          </span>
          <span>
            {transparent
              ? '透明背景'
              : format === 'pdf'
                ? '白底单页'
                : format === 'jpg'
                  ? '必有底色'
                  : '纸张背景'}
          </span>
        </div>

        <button
          type="button"
          className="export-panel__toggle"
          aria-pressed={transparent}
          disabled={!canTransparent}
          title={
            canTransparent ? 'PNG / SVG 省略纸张背景' : 'JPG 与 PDF 不支持透明背景'
          }
          onClick={toggleExportTransparent}
        >
          <span className={`export-panel__check${transparent ? ' is-checked' : ''}`}>
            {transparent ? <Icon name="check" size={11} strokeWidth={2.6} /> : null}
          </span>
          无背景
        </button>
      </div>

      <footer className="export-panel__foot">
        <button type="button" className="btn btn--outline btn--sm" onClick={closeExportPanel}>
          取消
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          data-testid="export-confirm"
          disabled={busy || emptySelection}
          title={emptySelection ? '请先在画布上选中对象' : undefined}
          onClick={() => void confirm()}
        >
          <Icon name="download" size={14} />
          {busy ? '导出中…' : `导出 ${format.toUpperCase()}`}
        </button>
      </footer>
    </div>
  );
}
