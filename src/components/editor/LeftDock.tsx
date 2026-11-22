import { SHAPE_TOOL_IDS, TOOL_MAP, hasToolOptions } from '../../core/tools';
import { allObjects, expandSelection, replaceObject } from '../../core/scene';
import type { Style } from '../../types/document';
import { useAppStore } from '../../store/useAppStore';
import { ColorPanel } from '../ui/ColorPanel';
import { Icon } from '../ui/Icon';
import { ToolOptions } from './ToolOptions';

/**
 * 画布左侧停靠栏：颜色、宽度/透明度、当前工具的扩展面板。
 * 全部位于布局流内，不会覆盖画布；面板不会因为点击画布而关闭。
 */
export function LeftDock({ collapsed = false }: { collapsed?: boolean }) {
  const activeTool = useAppStore((state) => state.activeTool);
  const setLeftDockOpen = useAppStore((state) => state.setLeftDockOpen);
  const setTool = useAppStore((state) => state.setTool);
  const doc = useAppStore((state) => state.doc);
  const selection = useAppStore((state) => state.selection);
  const defaultStyle = useAppStore((state) => state.defaultStyle);
  const brushSize = useAppStore((state) => state.brushSize);
  const brushOpacity = useAppStore((state) => state.brushOpacity);
  const eraserSize = useAppStore((state) => state.eraserSize);
  const eraserCurrentLayer = useAppStore((state) => state.eraserCurrentLayer);
  const setEraserCurrentLayer = useAppStore((state) => state.setEraserCurrentLayer);
  const setBrushSize = useAppStore((state) => state.setBrushSize);
  const setBrushOpacity = useAppStore((state) => state.setBrushOpacity);
  const setEraserSize = useAppStore((state) => state.setEraserSize);
  const beginTransaction = useAppStore((state) => state.beginTransaction);
  const endTransaction = useAppStore((state) => state.endTransaction);

  const hasSelection = selection.length > 0;
  const expanded = new Set(expandSelection(doc, selection));
  const styleSource =
    allObjects(doc).find((obj) => expanded.has(obj.id) && obj.type !== 'group') ?? null;
  const style = styleSource?.style ?? defaultStyle;
  const isBrushTool = activeTool === 'brush';
  // 画笔有自己的颜色/尺寸/不透明度状态，不能跟随选中对象，否则调参看似无效。
  const brushColor = defaultStyle.fill.type === 'solid' ? defaultStyle.fill.color : null;
  const fillColor = isBrushTool
    ? brushColor
    : style.fill.type === 'solid'
      ? style.fill.color
      : null;
  const strokeColor = style.stroke.paint.type === 'solid' ? style.stroke.paint.color : null;

  const applyStyle = (patch: Partial<Style>, record = true) => {
    if (!hasSelection) return;
    const state = useAppStore.getState();
    const ids = new Set(expandSelection(state.doc, state.selection));
    let next = state.doc;
    for (const obj of allObjects(state.doc)) {
      if (!ids.has(obj.id)) continue;
      next = replaceObject(next, obj.id, (item) => ({
        ...item,
        style: { ...item.style, ...patch }
      }));
    }
    state.updateDoc(next, record);
  };

  const setFill = (color: string | null) => {
    const state = useAppStore.getState();
    // 选色同时更新“当前颜色”：无论是否选中对象，后续新图形/油漆桶/画笔都沿用这次选择。
    state.setDefaultFill(color);
    if (!hasSelection || isBrushTool) return;
    applyStyle({ fill: color ? { type: 'solid', color } : { type: 'none' } });
  };

  const setStroke = (color: string | null) => {
    const state = useAppStore.getState();
    if (color === null) {
      // 无描边：只作用于选中对象，未选中时保持默认样式可继续绘制。
      applyStyle({ stroke: { ...style.stroke, paint: { type: 'none' } } });
      return;
    }
    state.setDefaultStroke(color);
    if (!hasSelection || isBrushTool) return;
    applyStyle({ stroke: { ...style.stroke, paint: { type: 'solid', color } } });
  };

  const setWidth = (width: number, record = true) => {
    if (!hasSelection) {
      useAppStore.getState().setStrokeWidth(width);
      return;
    }
    applyStyle({ stroke: { ...style.stroke, width } }, record);
  };

  const setOpacity = (opacity: number, record = true) => {
    if (isBrushTool) {
      setBrushOpacity(opacity);
      return;
    }
    if (!hasSelection) {
      useAppStore.getState().setDefaultOpacity(opacity);
      return;
    }
    applyStyle({ opacity }, record);
  };

  const opacityPercent = Math.round((isBrushTool ? brushOpacity : style.opacity) * 100);
  const isEraserTool = activeTool === 'eraser' || activeTool === 'eraser-live';
  const sizeValue = isBrushTool ? brushSize : isEraserTool ? eraserSize : style.stroke.width;
  const sizeMax = isBrushTool || isEraserTool ? 60 : 24;
  const applySize = (value: number, record = true) => {
    const next = Math.max(0, value);
    if (isBrushTool) {
      setBrushSize(next);
    } else if (isEraserTool) {
      setEraserSize(Math.max(2, next));
    } else {
      setWidth(next, record);
    }
  };
  const tool = TOOL_MAP[activeTool];
  // 对称 / 辅助线 / 化学 / 油漆桶 / 形状 / 文本使用画布内统一操作条
  const canvasDockTools = [
    'symmetry',
    'guides',
    'bond',
    'atom',
    'ring',
    'arrow',
    'eraser',
    'bucket',
    'text',
    ...SHAPE_TOOL_IDS
  ];
  const hasOptions = hasToolOptions(activeTool) && !canvasDockTools.includes(activeTool);

  return (
    <aside
      className={`left-dock${collapsed ? ' left-dock--mini' : ''}`}
      aria-label={
        collapsed ? '调色板（已收窄为色条，颜色仍可使用）' : '画布属性与工具扩展'
      }
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {/* 折叠态保留两个色块：1120 最小窗口下颜色入口仍然可达。 */}
      <div className="dock-block dock-block--palette" data-testid="left-dock-palette">
        <ColorPanel
          fill={fillColor}
          stroke={strokeColor}
          onChangeFill={setFill}
          onChangeStroke={setStroke}
        />
      </div>

      {collapsed ? (
        <button
          type="button"
          className="left-dock__brush"
          data-testid="left-dock-brush"
          title="展开画笔大小与不透明度"
          aria-label="展开画笔大小与不透明度"
          onClick={() => setLeftDockOpen(true)}
        >
          <Icon name="brush" size={16} />
        </button>
      ) : null}

      <button
        type="button"
        className="left-dock__expand"
        data-testid="left-dock-expand"
        title={collapsed ? '展开调色板' : '收窄为左侧色条'}
        aria-label={collapsed ? '展开调色板' : '收窄为左侧色条'}
        onClick={() => setLeftDockOpen(collapsed)}
      >
        <Icon name="chevronRight" size={13} />
        <span>收起</span>
      </button>

      <div className="dock-block dock-block--indicator">
        <span
          className="dock-color-square"
          data-testid="brush-color-indicator"
          style={{ background: (isBrushTool ? brushColor : strokeColor) ?? '#1b1b1b' }}
          title="当前画笔颜色"
        />
        <div className="dock-block__label">
          <strong>{isBrushTool ? '画笔颜色' : '描边颜色'}</strong>
          <span data-testid="selection-count">
            {(isBrushTool ? brushColor : strokeColor) ?? '#1B1B1B'}
            {hasSelection && !isBrushTool ? ` · ${selection.length} 个选中` : ''}
          </span>
        </div>
      </div>

      <div className="dock-block dock-block--sliders">
        <div className="dock-slider">
          <div className="dock-slider__head">
            <span>大小</span>
            <div className="input-unit input-unit--compact">
              <input
                className="input"
                type="number"
                min={isBrushTool ? 0.5 : 0}
                max={60}
                step={0.5}
                aria-label="大小"
                value={sizeValue}
                onFocus={beginTransaction}
                onBlur={endTransaction}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (!Number.isNaN(next)) applySize(next, false);
                }}
              />
              <em>px</em>
            </div>
          </div>
          <input
            className="range"
            type="range"
            min={isBrushTool ? 0.5 : 0}
            max={sizeMax}
            step={0.5}
            value={Math.min(sizeMax, sizeValue)}
            aria-label="大小滑杆"
            data-testid="stroke-width-range"
            onPointerDown={beginTransaction}
            onPointerUp={endTransaction}
            onChange={(event) => applySize(Number(event.target.value), false)}
          />
          <p className="dock-slider__hint">
            {isBrushTool ? '调节画笔大小' : isEraserTool ? '调节橡皮大小' : '调节描边宽度'}
          </p>
          {isEraserTool ? (
            <label className="dock-check" title="关闭后 Alt 仍可临时切换为全图层擦除">
              <input
                type="checkbox"
                data-testid="eraser-current-layer"
                checked={eraserCurrentLayer}
                onChange={(event) => setEraserCurrentLayer(event.target.checked)}
              />
              <span>仅擦当前图层</span>
              <em>Alt 临时全图层</em>
            </label>
          ) : null}
          {activeTool === 'eraser-live' ? (
            <p className="dock-slider__hint">擦除对象在画布下方横栏多选</p>
          ) : null}
        </div>

        <div className="dock-slider">
          <div className="dock-slider__head">
            <span>不透明度</span>
            <div className="input-unit input-unit--compact">
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                step={1}
                aria-label="不透明度"
                value={opacityPercent}
                onFocus={beginTransaction}
                onBlur={endTransaction}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (!Number.isNaN(next)) setOpacity(Math.min(100, Math.max(0, next)) / 100, false);
                }}
              />
              <em>%</em>
            </div>
          </div>
          <input
            className="range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={opacityPercent}
            aria-label="不透明度滑杆"
            data-testid="opacity-range"
            onPointerDown={beginTransaction}
            onPointerUp={endTransaction}
            onChange={(event) => setOpacity(Number(event.target.value) / 100, false)}
          />
          <div className="dock-slider__ends" aria-hidden="true">
            <span>透明</span>
            <span>实色</span>
          </div>
        </div>
      </div>

      <div className="dock-tools">
        <div className="dock-tools__head">
          <span>{tool.label}</span>
          <em>{hasOptions ? '工具扩展' : '操作提示'}</em>
        </div>
        {hasOptions ? (
          <ToolOptions tool={activeTool} variant="dock" onClose={() => setTool('select')} />
        ) : (
          <p className="dock-tools__hint">{tool.hint}</p>
        )}
      </div>
    </aside>
  );
}
