import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { ExportFormat } from '../../types/document';
import { Icon } from '../ui/Icon';
import { useFileActions } from './useFileActions';

/** 顶部栏右侧动作区：撤销/重做、网格吸附、导出。 */
export function TopActions() {
  const showRulers = useAppStore((state) => state.showRulers);
  const toggleRulers = useAppStore((state) => state.toggleRulers);
  const past = useAppStore((state) => state.past);
  const future = useAppStore((state) => state.future);
  const undo = useAppStore((state) => state.undo);
  const redo = useAppStore((state) => state.redo);
  const exportTransparent = useAppStore((state) => state.exportTransparent);
  const toggleExportTransparent = useAppStore((state) => state.toggleExportTransparent);
  const openExportPanel = useAppStore((state) => state.openExportPanel);
  const fileActions = useFileActions();
  const goToStart = useAppStore((state) => state.goToStart);
  const openSettings = useAppStore((state) => state.openSettings);
  const isDirty = useAppStore((state) => state.isDirty);
  const leftDockOpen = useAppStore((state) => state.leftDockOpen);
  const rightDockOpen = useAppStore((state) => state.rightDockOpen);
  const focusCanvas = useAppStore((state) => state.focusCanvas);
  const toggleLeftDock = useAppStore((state) => state.toggleLeftDock);
  const toggleRightDock = useAppStore((state) => state.toggleRightDock);
  const toggleFocusCanvas = useAppStore((state) => state.toggleFocusCanvas);

  const [exportOpen, setExportOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveDir, setSaveDir] = useState('');
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void fileActions.getSaveDir().then((info) => {
      if (active && info) setSaveDir(info.directory);
    });
    return () => {
      active = false;
    };
  }, []);

  const saveDocument = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await fileActions.save();
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!exportOpen) return;
    const handler = (event: PointerEvent) => {
      if (exportRef.current && !exportRef.current.contains(event.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [exportOpen]);

  const exportFormat = (format: ExportFormat) => {
    setExportOpen(false);
    void fileActions.exportAs(format);
  };

  const exportRegion = () => {
    setExportOpen(false);
    openExportPanel();
  };

  return (
    <div className="top-actions">
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        data-testid="back-to-start"
        title="返回启动页（未保存的修改会先确认）"
        onClick={() => goToStart()}
      >
        <Icon name="logo" size={16} />
      </button>

      <span className="top-actions__divider" />

      <div className="top-actions__cluster">
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={past.length === 0}
          title="撤销（Ctrl+Z）"
          onClick={undo}
        >
          <Icon name="undo" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={future.length === 0}
          title="重做（Ctrl+Shift+Z）"
          onClick={redo}
        >
          <Icon name="redo" size={16} />
        </button>
      </div>

      <span className="top-actions__divider" />

      <div className="top-actions__cluster">
        <button
          type="button"
          className={`icon-btn icon-btn--sm${showRulers ? ' is-active' : ''}`}
          title="显示标尺（Ctrl+Shift+R）"
          aria-pressed={showRulers}
          onClick={toggleRulers}
        >
          <Icon name="ruler" size={16} />
        </button>
      </div>

      <span className="top-actions__divider" />

      <div className="top-actions__cluster">
        <button
          type="button"
          className={`icon-btn icon-btn--sm${leftDockOpen && !focusCanvas ? ' is-active' : ''}`}
          title={
            leftDockOpen
              ? '收起左侧调色板为色条（颜色仍可用，快捷键 Ctrl+\\）'
              : '展开左侧调色板（颜色、大小、不透明度）'
          }
          aria-pressed={leftDockOpen && !focusCanvas}
          data-testid="toggle-left-dock"
          onClick={toggleLeftDock}
        >
          <Icon name="palette" size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn icon-btn--sm${rightDockOpen && !focusCanvas ? ' is-active' : ''}`}
          title="显示/隐藏右侧图层与属性"
          aria-pressed={rightDockOpen && !focusCanvas}
          data-testid="toggle-right-dock"
          onClick={toggleRightDock}
        >
          <Icon name="layers" size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn icon-btn--sm${focusCanvas ? ' is-active' : ''}`}
          title="专注画布（Ctrl+Shift+D）"
          aria-pressed={focusCanvas}
          data-testid="toggle-focus-canvas"
          onClick={toggleFocusCanvas}
        >
          <Icon name="maximize" size={15} />
        </button>
      </div>

      <span className="top-actions__divider" />

      <button
        type="button"
        className="icon-btn icon-btn--sm"
        data-testid="settings-button"
        title="设置（界面、绘画、快捷键、化学）"
        onClick={openSettings}
      >
        <Icon name="settings" size={16} />
      </button>

      <button
        type="button"
        className={`btn btn--primary btn--sm top-actions__save${isDirty ? ' is-dirty' : ''}`}
        data-testid="save-button"
        disabled={saving}
        title={`保存（Ctrl+S）${saveDir ? `\n默认位置：${saveDir}` : ''}`}
        onClick={() => void saveDocument()}
      >
        <Icon name="save" size={15} />
        <span className="btn__label">{saving ? '保存中…' : '保存'}</span>
        {isDirty ? <span className="btn__dot" aria-label="有未保存修改" /> : null}
      </button>

      <div className="toolbar__export" ref={exportRef}>
        <button
          type="button"
          className="btn btn--outline btn--sm"
          data-testid="export-menu-button"
          title="导出（Ctrl+E 打开完整导出面板）"
          onClick={() => setExportOpen((value) => !value)}
        >
          <Icon name="download" size={15} />
          <span className="btn__label">导出</span>
          <Icon name="chevronDown" size={12} />
        </button>
        {exportOpen ? (
          <div className="export-menu">
            <button
              type="button"
              className={`export-menu__toggle${exportTransparent ? ' is-checked' : ''}`}
              data-testid="export-transparent"
              onClick={toggleExportTransparent}
            >
              <span className="export-menu__check">
                {exportTransparent ? <Icon name="check" size={12} strokeWidth={2.4} /> : null}
              </span>
              <span>无背景（PNG / SVG 透明）</span>
            </button>
            <div className="export-menu__sep" />
            <button type="button" data-export="svg" onClick={() => exportFormat('svg')}>
              <Icon name="file" size={14} />
              SVG 矢量图
              <em>{exportTransparent ? '透明背景' : '保留路径与文本'}</em>
            </button>
            <button type="button" data-export="png" onClick={() => exportFormat('png')}>
              <Icon name="grid4" size={14} />
              PNG 图片
              <em>{exportTransparent ? '透明背景' : '2× 分辨率'}</em>
            </button>
            <button type="button" data-export="jpg" onClick={() => exportFormat('jpg')}>
              <Icon name="image" size={14} />
              JPG 图片
              <em>2× 分辨率 · 体积小</em>
            </button>
            <button type="button" data-export="pdf" onClick={() => exportFormat('pdf')}>
              <Icon name="download" size={14} />
              PDF 文档
              <em>单页白底</em>
            </button>
            <div className="export-menu__sep" />
            <button
              type="button"
              data-testid="export-region-entry"
              onClick={exportRegion}
            >
              <Icon name="crop" size={14} />
              导出面板…
              <em>框选 · 精确尺寸 · 预览</em>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
