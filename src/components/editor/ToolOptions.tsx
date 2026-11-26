import { useMemo, useRef } from 'react';
import { BRUSH_PRESETS, TOOL_MAP, brushPresetOf } from '../../core/tools';
import { brushOutlineData, samplesToNodes, type BrushSample } from '../../core/brush';
import { pathData } from '../../core/io/svg';
import { parseBrushLibrary, serializeBrushLibrary } from '../../core/io/brushLibrary';
import { downloadExportedFile } from '../../core/io/browserExport';
import type { BrushPreset } from '../../core/tools';
import type { ToolId } from '../../types/document';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';

interface ToolOptionsProps {
  tool: ToolId;
  onClose: () => void;
  /** dock：停靠在左侧工具扩展栏；popover：浮层预览 */
  variant?: 'dock' | 'popover';
}

/**
 * 预设真实笔触预览：按预设的压感/渐隐参数生成一段 S 形笔迹，
 * 让"硬笔/铅笔/马克"在视觉上可区分，而不是只用一根粗细条表示。
 */
type BrushGlyphPreset = Pick<BrushPreset, 'width' | 'pressure' | 'taper'>;

function BrushGlyph({ preset }: { preset: BrushGlyphPreset }) {
  const path = useMemo(() => {
    const anchors = [
      { x: 6, y: 13 },
      { x: 24, y: 13 },
      { x: 44, y: 6 },
      { x: 64, y: 6 },
      { x: 84, y: 13 },
      { x: 112, y: 13 }
    ];
    const samples: BrushSample[] = anchors.map((point, index) => {
      const progress = index / (anchors.length - 1);
      return {
        x: point.x,
        y: point.y,
        // 中段加压，两端放松：直观体现压感支持
        pressure: 0.45 + 0.55 * Math.sin(Math.PI * progress),
        t: index * 16
      };
    });
    const { nodes } = samplesToNodes(samples, {
      smoothing: 0,
      pressure: preset.pressure,
      taper: preset.taper,
      width: Math.max(1.8, Math.min(7, preset.width * 0.8)),
      minRatio: 0.4
    });
    return brushOutlineData(nodes) ?? pathData(nodes, false);
  }, [preset]);
  return (
    <svg className="brush-glyph" viewBox="0 0 118 20" aria-hidden="true" focusable="false">
      <path d={path} fill="currentColor" />
    </svg>
  );
}

/**
 * 画笔工具选项：唯一仍使用停靠栏的工具。
 * 其他工具的选项统一在画布底部横栏/右侧属性中，避免同一设置出现两套实现。
 */
export function ToolOptions({ tool, onClose, variant = 'popover' }: ToolOptionsProps) {
  const toolDef = TOOL_MAP[tool];
  const setTool = useAppStore((state) => state.setTool);
  const setBrushPreset = useAppStore((state) => state.setBrushPreset);
  const brushPreset = useAppStore((state) => state.brushPreset);
  const brushSize = useAppStore((state) => state.brushSize);
  const setBrushSize = useAppStore((state) => state.setBrushSize);
  const brushOpacity = useAppStore((state) => state.brushOpacity);
  const setBrushOpacity = useAppStore((state) => state.setBrushOpacity);
  const brushSmoothing = useAppStore((state) => state.brushSmoothing);
  const setBrushSmoothing = useAppStore((state) => state.setBrushSmoothing);
  const brushHardness = useAppStore((state) => state.brushHardness);
  const setBrushHardness = useAppStore((state) => state.setBrushHardness);
  const brushSpacing = useAppStore((state) => state.brushSpacing);
  const setBrushSpacing = useAppStore((state) => state.setBrushSpacing);
  const brushTexture = useAppStore((state) => state.brushTexture);
  const setBrushTexture = useAppStore((state) => state.setBrushTexture);
  const brushFlow = useAppStore((state) => state.brushFlow);
  const setBrushFlow = useAppStore((state) => state.setBrushFlow);
  const brushBlendMode = useAppStore((state) => state.brushBlendMode);
  const setBrushBlendMode = useAppStore((state) => state.setBrushBlendMode);
  const brushPressureCurve = useAppStore((state) => state.brushPressureCurve);
  const setBrushPressureCurve = useAppStore((state) => state.setBrushPressureCurve);
  const customBrushes = useAppStore((state) => state.customBrushes);
  const importBrushLibrary = useAppStore((state) => state.importBrushLibrary);
  const saveCustomBrush = useAppStore((state) => state.saveCustomBrush);
  const applyCustomBrush = useAppStore((state) => state.applyCustomBrush);
  const deleteCustomBrush = useAppStore((state) => state.deleteCustomBrush);
  const brushFileRef = useRef<HTMLInputElement | null>(null);
  const notify = useAppStore((state) => state.notify);

  /** 导出笔刷库：桌面端走原生保存对话框，网页端回退到浏览器下载。 */
  const exportBrushLibrary = async () => {
    if (customBrushes.length === 0) {
      notify('还没有自定义笔刷可导出', 'info');
      return;
    }
    const payload = customBrushes.map((brush) => ({
      ...brush,
      flow: brush.flow ?? 1,
      blendMode:
        brush.blendMode === 'multiply' ? ('multiply' as const) : ('normal' as const)
    }));
    const fileName = `vdraw-brushes-${new Date().toISOString().slice(0, 10)}.vbrush`;
    const data = serializeBrushLibrary(payload);
    try {
      const api = window.vdraw;
      if (api) {
        const result = await api.file.exportFile({
          data,
          encoding: 'utf8',
          defaultName: fileName,
          filters: [{ name: 'VDraw 笔刷库', extensions: ['vbrush'] }]
        });
        if (result.canceled || !result.path) return;
        notify(`已导出笔刷库：${result.path}`, 'success');
        return;
      }
      downloadExportedFile({
        fileName,
        mimeType: 'application/json',
        data,
        encoding: 'utf8'
      });
      notify(`已下载笔刷库：${fileName}`, 'success');
    } catch (error) {
      notify(
        error instanceof Error ? `笔刷库导出失败：${error.message}` : '笔刷库导出失败',
        'warn'
      );
    }
  };

  if (tool !== 'brush') {
    return (
      <div className="tool-popover tool-popover--dock" data-testid="tool-options">
        <div className="tool-popover__head">
          <span className="tool-popover__icon">
            <Icon name={toolDef.icon} size={16} />
          </span>
          <div className="tool-popover__title">
            <strong>{toolDef.label}</strong>
            <span>工具提示</span>
          </div>
          <button type="button" className="icon-btn icon-btn--sm" title="关闭" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="tool-popover__body">
          <p className="chem-hint">{toolDef.hint}</p>
          <button type="button" className="ghost-action" onClick={() => setTool('select')}>
            切回选择工具
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`tool-popover${variant === 'dock' ? ' tool-popover--dock' : ''}`}
      data-testid="tool-options"
      data-tool-panel={tool}
      role="dialog"
      aria-label={`${toolDef.label}工具选项`}
    >
      <div className="tool-popover__head">
        <span className="tool-popover__icon">
          <Icon name={toolDef.icon} size={16} />
        </span>
        <div className="tool-popover__title">
          <strong>{toolDef.label}</strong>
          <span>{toolDef.shortcut ? `快捷键 ${toolDef.shortcut}` : '工具选项'}</span>
        </div>
        <button type="button" className="icon-btn icon-btn--sm" title="关闭" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="tool-popover__body">
        <div className="chem-section__head">
          <span>笔刷</span>
          <em>{BRUSH_PRESETS.length} 种</em>
        </div>
        <div className="brush-grid">
          {BRUSH_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-brush={preset.id}
              className={`brush-card${brushPreset === preset.id ? ' is-active' : ''}`}
              title={preset.hint}
              aria-pressed={brushPreset === preset.id}
              onClick={() => setBrushPreset(preset.id)}
            >
              <BrushGlyph preset={preset} />
              <span className="brush-card__name">{preset.name}</span>
              {preset.pressure ? <span className="brush-card__tag">压感</span> : null}
            </button>
          ))}
        </div>
        <div className="field-row field-row--stroke">
          <span className="field-row__label">粗细</span>
          <input
            className="range range--stroke"
            type="range"
            min={0.5}
            max={60}
            step={0.5}
            value={brushSize}
            aria-label="画笔粗细"
            aria-valuetext={`${brushSize} 像素`}
            data-testid="brush-size"
            onChange={(event) => setBrushSize(Number(event.target.value))}
          />
          <input
            className="input brush-number"
            type="number"
            min={0.5}
            max={60}
            step={0.5}
            value={brushSize}
            aria-label="画笔粗细数值"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) setBrushSize(next);
            }}
          />
          <em className="brush-value">px</em>
        </div>
        <div className="field-row field-row--stroke">
          <span className="field-row__label">不透明度</span>
          <input
            className="range range--stroke"
            type="range"
            min={5}
            max={100}
            step={1}
            value={Math.round(brushOpacity * 100)}
            aria-label="画笔不透明度"
            aria-valuetext={`${Math.round(brushOpacity * 100)}%`}
            data-testid="brush-opacity"
            onChange={(event) => setBrushOpacity(Number(event.target.value) / 100)}
          />
          <input
            className="input brush-number"
            type="number"
            min={5}
            max={100}
            step={1}
            value={Math.round(brushOpacity * 100)}
            aria-label="画笔不透明度数值"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) setBrushOpacity(next / 100);
            }}
          />
          <em className="brush-value">%</em>
        </div>
        <div className="field-row field-row--stroke">
          <span className="field-row__label">平滑</span>
          <input
            className="range range--stroke"
            type="range"
            min={0}
            max={100}
            step={1}
            value={brushSmoothing}
            aria-label="画笔平滑"
            aria-valuetext={`${brushSmoothing}%`}
            data-testid="brush-smoothing"
            onChange={(event) => setBrushSmoothing(Number(event.target.value))}
          />
          <input
            className="input brush-number"
            type="number"
            min={0}
            max={100}
            step={1}
            value={brushSmoothing}
            aria-label="画笔平滑数值"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) setBrushSmoothing(next);
            }}
          />
          <em className="brush-value">%</em>
        </div>
        <div className="field-row field-row--stroke">
          <span className="field-row__label">硬度</span>
          <input
            className="range range--stroke"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(brushHardness * 100)}
            aria-label="画笔硬度"
            data-testid="brush-hardness"
            onChange={(event) => setBrushHardness(Number(event.target.value) / 100)}
          />
          <em className="brush-value">{Math.round(brushHardness * 100)}%</em>
        </div>
        <div className="field-row field-row--stroke">
          <span className="field-row__label">间距</span>
          <input
            className="range range--stroke"
            type="range"
            min={5}
            max={120}
            step={5}
            value={Math.round(brushSpacing * 100)}
            aria-label="画笔间距"
            data-testid="brush-spacing"
            onChange={(event) => setBrushSpacing(Number(event.target.value) / 100)}
          />
          <em className="brush-value">{Math.round(brushSpacing * 100)}%</em>
        </div>
        <div className="field-row field-row--stroke">
          <span className="field-row__label">纹理</span>
          <input
            className="range range--stroke"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(brushTexture * 100)}
            aria-label="画笔纹理"
            data-testid="brush-texture"
            onChange={(event) => setBrushTexture(Number(event.target.value) / 100)}
          />
          <em className="brush-value">{Math.round(brushTexture * 100)}%</em>
        </div>
        <div className="field-row field-row--stroke">
          <span className="field-row__label">流量</span>
          <input
            className="range range--stroke"
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(brushFlow * 100)}
            aria-label="画笔流量"
            data-testid="brush-flow"
            onChange={(event) => setBrushFlow(Number(event.target.value) / 100)}
          />
          <em className="brush-value">{Math.round(brushFlow * 100)}%</em>
        </div>
        <div className="field-row field-row--stroke">
          <span className="field-row__label">混合</span>
          <div className="option-grid" style={{ flex: 1 }}>
            {(['normal', 'multiply'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-brush-blend-mode={mode}
                className={`option-tile${brushBlendMode === mode ? ' is-active' : ''}`}
                onClick={() => setBrushBlendMode(mode)}
              >
                {mode === 'normal' ? '正常' : '正片叠底'}
              </button>
            ))}
          </div>
        </div>
        <div className="field-row field-row--stroke">
          <span className="field-row__label">压感曲线</span>
          <input
            className="range range--stroke"
            type="range"
            min={0.4}
            max={2}
            step={0.1}
            value={brushPressureCurve}
            aria-label="压感曲线"
            data-testid="brush-pressure-curve"
            onChange={(event) => setBrushPressureCurve(Number(event.target.value))}
          />
          <em className="brush-value">{brushPressureCurve.toFixed(1)}</em>
        </div>
        <div className="brush-actions">
          <button
            type="button"
            className="ghost-action"
            data-testid="brush-reset"
            onClick={() => {
              // 走预设切换逻辑：尺寸/透明度/材质/压感/渐隐一起回到默认。
              setBrushPreset(brushPreset);
            }}
          >
            恢复预设默认
          </button>
          <span className="brush-actions__meta">
            {brushPresetOf(brushPreset).pressure ? '支持压感' : '等宽'} ·{' '}
            {brushPresetOf(brushPreset).taper > 0 ? '起收笔渐隐' : '平头'}
          </span>
        </div>
        <div className="brush-custom">
          <button
            type="button"
            className="ghost-action"
            data-testid="brush-custom-save"
            onClick={() => {
              const name = saveCustomBrush();
              if (name) notify(`已保存「${name}」`, 'success');
            }}
          >
            保存当前为预设
          </button>
          {customBrushes.length > 0 ? (
            <div className="brush-custom__list">
              {customBrushes.map((brush) => (
                <span className="brush-custom__chip" key={brush.id}>
                  <span className="brush-custom__glyph" aria-hidden="true">
                    <BrushGlyph preset={brush} />
                  </span>
                  <button
                    type="button"
                    className="brush-custom__apply"
                    data-testid={`brush-custom-apply-${brush.id}`}
                    title={`套用「${brush.name}」：${brush.width}px · 硬度 ${Math.round(brush.hardness * 100)}% · 纹理 ${Math.round(brush.texture * 100)}% · 流量 ${Math.round((brush.flow ?? 1) * 100)}% · ${brush.blendMode === 'multiply' ? '正片叠底' : '正常'}`}
                    onClick={() => {
                      if (applyCustomBrush(brush.id)) notify(`已套用「${brush.name}」`, 'success');
                    }}
                  >
                    {brush.name}
                  </button>
                  <button
                    type="button"
                    className="brush-custom__delete"
                    data-testid={`brush-custom-delete-${brush.id}`}
                    aria-label={`删除预设 ${brush.name}`}
                    onClick={() => deleteCustomBrush(brush.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="brush-actions">
          <button
            type="button"
            className="ghost-action"
            data-testid="brush-library-export"
            onClick={() => void exportBrushLibrary()}
          >
            导出笔刷库
          </button>
          <button
            type="button"
            className="ghost-action"
            data-testid="brush-library-import"
            onClick={() => brushFileRef.current?.click()}
          >
            导入笔刷库
          </button>
          <input
            ref={brushFileRef}
            type="file"
            accept=".vbrush,application/json"
            hidden
            data-testid="brush-library-file"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              if (file.size > 2 * 1024 * 1024) {
                notify('笔刷库文件过大（上限 2MB）', 'warn');
                return;
              }
              try {
                const { brushes, skipped } = parseBrushLibrary(await file.text());
                const added = importBrushLibrary(brushes);
                if (added === 0) {
                  notify('自定义笔刷已达上限 200，未导入', 'warn');
                } else if (added < brushes.length) {
                  notify(`已导入 ${added} 支，超出上限丢弃 ${brushes.length - added} 支`, 'warn');
                } else {
                  notify(
                    `已导入 ${added} 支笔刷${skipped > 0 ? `，跳过 ${skipped} 条无效数据` : ''}`,
                    'success'
                  );
                }
              } catch (error) {
                notify(
                  error instanceof Error ? error.message : '笔刷库导入失败',
                  'warn'
                );
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
