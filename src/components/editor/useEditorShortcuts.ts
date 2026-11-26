import { useEffect } from 'react';
import type { ToolId } from '../../types/document';
import { TOOL_SHORTCUTS } from '../../core/tools';
import type { TemplateId } from '../../core/document';
import { useAppStore } from '../../store/useAppStore';
import { translateDocumentObjects } from '../../core/scene';
import { useFileActions } from './useFileActions';

export function useEditorShortcuts(): void {
  const setTool = useAppStore((state) => state.setTool);
  const zoomAt = useAppStore((state) => state.zoomAt);
  const setZoom = useAppStore((state) => state.setZoom);
  const fitToCanvas = useAppStore((state) => state.fitToCanvas);
  const toggleRulers = useAppStore((state) => state.toggleRulers);
  const startDocument = useAppStore((state) => state.startDocument);
  const notify = useAppStore((state) => state.notify);
  const doc = useAppStore((state) => state.doc);
  const viewportSize = useAppStore((state) => state.viewportSize);
  const canvasLeftInset = useAppStore((state) => state.canvasLeftInset);
  const undo = useAppStore((state) => state.undo);
  const redo = useAppStore((state) => state.redo);
  const selectAll = useAppStore((state) => state.selectAll);
  const copySelection = useAppStore((state) => state.copySelection);
  const pasteClipboard = useAppStore((state) => state.pasteClipboard);
  const duplicateSelection = useAppStore((state) => state.duplicateSelection);
  const clearSelection = useAppStore((state) => state.clearSelection);
  const deleteSelection = useAppStore((state) => state.deleteSelection);
  const groupSelection = useAppStore((state) => state.groupSelection);
  const ungroupSelection = useAppStore((state) => state.ungroupSelection);
  const fileActions = useFileActions();
  const toolShortcuts = useAppStore((state) => state.toolShortcuts);
  const toggleFocusCanvas = useAppStore((state) => state.toggleFocusCanvas);
  const toggleLeftDock = useAppStore((state) => state.toggleLeftDock);
  const toggleToolLabels = useAppStore((state) => state.toggleToolLabels);

  useEffect(() => {
    const center = {
      x: (viewportSize.width + canvasLeftInset) / 2,
      y: viewportSize.height / 2
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      // 浮层打开时，快捷键交给浮层自己处理（Esc 只关最上层），避免一次按键三连击。
      if (useAppStore.getState().overlayDepth > 0) return;

      const mod = event.ctrlKey || event.metaKey;
      if (mod) {
        const key = event.key.toLowerCase();
        if (key === 'z') {
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
          return;
        }
        if (key === 'y') {
          event.preventDefault();
          redo();
          return;
        }
        if (key === 'a') {
          event.preventDefault();
          selectAll();
          return;
        }
        if (key === 'c') {
          event.preventDefault();
          copySelection();
          return;
        }
        if (key === 'v') {
          event.preventDefault();
          pasteClipboard();
          return;
        }
        if (key === 'd' && event.shiftKey) {
          event.preventDefault();
          toggleFocusCanvas();
          return;
        }
        // 工具名标签是发现性的关键开关，给它一个可记忆的快捷键。
        if (key === 'b' && !event.shiftKey) {
          event.preventDefault();
          toggleToolLabels();
          return;
        }
        // 调色板收窄 / 展开。
        if (event.key === '\\') {
          event.preventDefault();
          toggleLeftDock();
          return;
        }
        if (key === 'd') {
          event.preventDefault();
          duplicateSelection();
          return;
        }
        if (key === 'g') {
          event.preventDefault();
          if (event.shiftKey) ungroupSelection();
          else groupSelection();
          return;
        }
        if (key === 'n') {
          event.preventDefault();
          startDocument(doc.templateId as TemplateId);
          return;
        }
        if (key === 'o') {
          event.preventDefault();
          void fileActions.open();
          return;
        }
        if (key === 's') {
          event.preventDefault();
          void fileActions.save(event.shiftKey);
          return;
        }
        // 导出面板：桌面端与网页端共用同一个入口，选项与预览完全一致。
        if (key === 'e' && !event.shiftKey) {
          event.preventDefault();
          useAppStore.getState().openExportPanel();
          return;
        }
        if (key === 'r' && event.shiftKey) {
          event.preventDefault();
          toggleRulers();
          return;
        }
        if (key === '=' || key === '+') {
          event.preventDefault();
          zoomAt(1.2, center);
          return;
        }
        if (key === '-') {
          event.preventDefault();
          zoomAt(1 / 1.2, center);
          return;
        }
        if (key === '0') {
          event.preventDefault();
          setZoom(1, center);
          return;
        }
        if (key === '1') {
          event.preventDefault();
          fitToCanvas();
          return;
        }
        if (key === '2') {
          event.preventDefault();
          useAppStore.getState().zoomToSelection();
          return;
        }
        return;
      }

      if (event.key === 'Escape') {
        // Esc 的优先级：先收起工具面板（不退出工具）→ 再清空选择并回到选择工具。
        if (useAppStore.getState().toolPanel) {
          useAppStore.getState().setToolPanel(null);
          return;
        }
        clearSelection();
        setTool('select');
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const state = useAppStore.getState();
        if (state.selection.length > 0) state.deleteSelection();
        else notify('没有选中的对象');
        return;
      }
      // 画笔/橡皮尺寸快捷调节：[ 缩小、] 放大；Shift + 方括号调不透明度。
      const isBracketGrow = event.key === ']' || event.code === 'BracketRight';
      const isBracketShrink = event.key === '[' || event.code === 'BracketLeft';
      if ((isBracketGrow || isBracketShrink) && !event.ctrlKey && !event.metaKey) {
        const store = useAppStore.getState();
        const grow = isBracketGrow;
        if (store.activeTool === 'eraser' || store.activeTool === 'eraser-live') {
          event.preventDefault();
          store.setEraserSize(store.eraserSize + (grow ? 2 : -2));
          return;
        }
        if (store.activeTool === 'brush') {
          event.preventDefault();
          if (event.shiftKey) {
            store.setBrushOpacity(store.brushOpacity + (grow ? 0.05 : -0.05));
          } else {
            const step = store.brushSize >= 12 ? 2 : 0.5;
            store.setBrushSize(store.brushSize + (grow ? step : -step));
          }
          return;
        }
      }

      // Shift+Y：循环对称模式（关闭 → 左右 → 上下 → 四象限）。
      if (!event.ctrlKey && !event.metaKey && event.shiftKey && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        useAppStore.getState().cycleSymmetry();
        return;
      }

      const lowerKey = event.key.toLowerCase();
      // 中文输入法激活时 event.key 可能是 'Process'，用物理键位 code 兜底。
      const codeKey =
        typeof event.code === 'string' && event.code.startsWith('Key')
          ? event.code.slice(3).toLowerCase()
          : '';
      const candidates = codeKey && codeKey !== lowerKey ? [lowerKey, codeKey] : [lowerKey];
      const customTool = Object.entries(toolShortcuts).find(
        ([, key]) => candidates.includes(key)
      )?.[0] as ToolId | undefined;
      const defaultTool = candidates
        .map((candidate) => TOOL_SHORTCUTS[candidate])
        .find((toolId): toolId is ToolId => Boolean(toolId));
      // 一旦某个工具配置了自定义键，它的默认键就应失效，避免两个键同时生效。
      const tool = customTool ?? (defaultTool && !toolShortcuts[defaultTool] ? defaultTool : undefined);
      if (tool) {
        event.preventDefault();
        setTool(tool);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    setTool,
    zoomAt,
    setZoom,
    fitToCanvas,
    toggleRulers,
    startDocument,
    notify,
    doc.templateId,
    viewportSize,
    canvasLeftInset,
    undo,
    redo,
    selectAll,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    clearSelection,
    deleteSelection,
    groupSelection,
    ungroupSelection,
    fileActions,
    toolShortcuts,
    toggleFocusCanvas,
    toggleLeftDock,
    toggleToolLabels
  ]);

  /**
   * 方向键微调：单独成 effect，避免文档每次更新重渲时把长按定时器清掉。
   * 第一次按下记录一次撤销快照，长按期间只移动不写历史。
   */
  useEffect(() => {
    const pressed = new Set<string>();
    let delay: number | null = null;
    let interval: number | null = null;
    let step = 1;

    const stop = () => {
      if (delay !== null) {
        window.clearTimeout(delay);
        delay = null;
      }
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
      pressed.clear();
    };

    const apply = (record: boolean) => {
      const state = useAppStore.getState();
      if (state.selection.length === 0 || state.overlayDepth > 0) {
        stop();
        return;
      }
      const dx =
        (pressed.has('ArrowRight') ? step : 0) -
        (pressed.has('ArrowLeft') ? step : 0);
      const dy =
        (pressed.has('ArrowDown') ? step : 0) -
        (pressed.has('ArrowUp') ? step : 0);
      if (dx === 0 && dy === 0) return;
      state.updateDoc(
        translateDocumentObjects(state.doc, state.selection, dx, dy),
        record
      );
    };

    const start = () => {
      if (delay !== null || interval !== null) return;
      delay = window.setTimeout(() => {
        delay = null;
        interval = window.setInterval(() => apply(false), 33);
      }, 260);
    };

    const isTyping = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(
        element &&
          (element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA' ||
            element.tagName === 'SELECT' ||
            element.isContentEditable)
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.key.startsWith('Arrow')) return;
      const state = useAppStore.getState();
      if (state.selection.length === 0 || state.overlayDepth > 0) return;
      if (isTyping(event.target)) return;
      event.preventDefault();
      // 浏览器自带的按键重复不可控且会多次写历史；长按由上面的定时器接管。
      if (event.repeat) return;
      const first = pressed.size === 0;
      pressed.add(event.key);
      step = event.shiftKey ? 10 : 1;
      apply(first);
      start();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.key.startsWith('Arrow')) return;
      pressed.delete(event.key);
      if (pressed.size === 0) stop();
    };

    const onBlur = () => stop();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      stop();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
