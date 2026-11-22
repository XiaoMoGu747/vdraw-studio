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
    const center = { x: viewportSize.width / 2, y: viewportSize.height / 2 };

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
      if (event.key.startsWith('Arrow')) {
        const state = useAppStore.getState();
        if (state.selection.length === 0) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        state.updateDoc(
          translateDocumentObjects(state.doc, state.selection, dx, dy),
          true
        );
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
}
