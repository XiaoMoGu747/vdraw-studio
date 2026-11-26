import { TOOL_MAP, brushPresetOf } from '../../core/tools';
import { BOND_TYPE_LABEL } from '../../core/chemistry/presets';
import { formatNumber } from '../../core/geometry';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';

/**
 * 状态栏只负责：当前工具提示、坐标、对象数、网格与吸附。
 * 缩放控件归画布右下角的 zoom 坞，避免同一信息出现两套控件。
 */
export function StatusBar() {
  const activeTool = useAppStore((state) => state.activeTool);
  const cursor = useAppStore((state) => state.cursor);
  const showGrid = useAppStore((state) => state.showGrid);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const selection = useAppStore((state) => state.selection);
  const toggleGrid = useAppStore((state) => state.toggleGrid);
  const toggleSnap = useAppStore((state) => state.toggleSnap);
  const clipToSelection = useAppStore((state) => state.clipToSelection);
  const alphaLock = useAppStore((state) => state.alphaLock);
  const toggleClipToSelection = useAppStore((state) => state.toggleClipToSelection);
  const toggleAlphaLock = useAppStore((state) => state.toggleAlphaLock);
  const doc = useAppStore((state) => state.doc);
  const brushSize = useAppStore((state) => state.brushSize);
  const brushOpacity = useAppStore((state) => state.brushOpacity);
  const brushSmoothing = useAppStore((state) => state.brushSmoothing);
  const brushPreset = useAppStore((state) => state.brushPreset);
  const chem = useAppStore((state) => state.chem);
  const viewport = useAppStore((state) => state.viewport);
  const viewportSize = useAppStore((state) => state.viewportSize);
  const zoomAt = useAppStore((state) => state.zoomAt);
  const setZoom = useAppStore((state) => state.setZoom);
  const fitToCanvas = useAppStore((state) => state.fitToCanvas);

  const tool = TOOL_MAP[activeTool];
  const objectCount = doc.layers.reduce(
    (total, layer) => total + layer.objects.filter((obj) => !obj.parentId).length,
    0
  );
  // 工具提示里已经说明 Shift 语义（选择/直线/曲线各不相同）时不再追加，避免重复或误导。
  const hint =
    selection.length > 1
      ? `已选 ${selection.length} 个对象 · Shift+点击可继续加选或减选`
      : selection.length === 1 && !tool.hint.includes('Shift')
        ? `${tool.hint} · Shift+点击可加选`
        : tool.hint;
  // 当前键型放到状态栏，化学横栏就不必再多一段会推挤布局的状态文字。
  const bondHint =
    activeTool === 'bond'
      ? `${hint} · 当前 ${BOND_TYPE_LABEL[chem.bondType]}${
          chem.bondFixed ? '（固定化学键）' : ''
        }`
      : hint;
  const zoomPercent = Math.round(viewport.zoom * 100);
  const center = {
    x: Math.max(0, viewportSize.width / 2),
    y: Math.max(0, viewportSize.height / 2)
  };

  return (
    <footer className="statusbar">
      <div className="statusbar__left">
        <span
          className="statusbar__tool"
          title={`${tool.label}\n${bondHint}`}
        >
          <span className="statusbar__dot" />
          <strong data-testid="status-tool">{tool.label}</strong>
        </span>
      </div>

      <div className="statusbar__right">
        <span className="statusbar__coord">
          X {cursor ? formatNumber(cursor.x, 0) : '—'} · Y {cursor ? formatNumber(cursor.y, 0) : '—'}
        </span>
        {selection.length > 0 ? (
          <span className="statusbar__meta" data-testid="selection-count">
            {selection.length} 个选中
          </span>
        ) : null}
        <span className="statusbar__meta">{objectCount} 个对象</span>

        {activeTool === 'brush' ? (
          <span className="statusbar__brush" data-testid="status-brush">
            {brushPresetOf(brushPreset).name} {brushSize}px · {Math.round(brushOpacity * 100)}% ·
            平滑 {brushSmoothing}%
          </span>
        ) : null}

        <button
          type="button"
          className={`statusbar__toggle${clipToSelection ? ' is-active' : ''}`}
          data-testid="clip-to-selection"
          title="选区内绘制：新对象只显示在选中的图形内部"
          aria-pressed={clipToSelection}
          onClick={toggleClipToSelection}
        >
          选区内绘制
        </button>
        <button
          type="button"
          className={`statusbar__toggle${alphaLock ? ' is-active' : ''}`}
          data-testid="alpha-lock"
          title="alpha 锁：新对象只显示在当前图层已有墨迹范围内"
          aria-pressed={alphaLock}
          onClick={toggleAlphaLock}
        >
          alpha 锁
        </button>
        <button
          type="button"
          className={`statusbar__toggle${showGrid ? ' is-active' : ''}`}
          title="显示/隐藏网格"
          aria-pressed={showGrid}
          onClick={toggleGrid}
        >
          <Icon name="grid4" size={13} />
          网格
        </button>
        <button
          type="button"
          className={`statusbar__toggle${snapEnabled ? ' is-active' : ''}`}
          title="开启/关闭吸附"
          aria-pressed={snapEnabled}
          onClick={toggleSnap}
        >
          <Icon name="snap" size={13} />
          吸附
        </button>

        <div
          className="zoom-dock zoom-dock--status"
          data-testid="status-zoom"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title="缩小"
            data-testid="status-zoom-out"
            onClick={() => zoomAt(1 / 1.2, center)}
          >
            <Icon name="minus" size={13} />
          </button>
          <button
            type="button"
            className="zoom-dock__value"
            title="恢复到 100%"
            data-testid="status-zoom-value"
            onClick={() => setZoom(1, center)}
          >
            {zoomPercent}%
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title="放大"
            data-testid="status-zoom-in"
            onClick={() => zoomAt(1.2, center)}
          >
            <Icon name="plus" size={13} />
          </button>
          <span className="zoom-dock__sep" />
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title="适应窗口（Ctrl+1）"
            data-testid="status-zoom-fit"
            onClick={() => fitToCanvas()}
          >
            <Icon name="fit" size={13} />
          </button>
        </div>
      </div>
    </footer>
  );
}
