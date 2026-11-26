import { useEffect, useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { CanvasStage } from './CanvasStage';
import { ChemReportModal } from './ChemReportModal';
import { CommandPalette } from './CommandPalette';
import { ShortcutOverlay } from './ShortcutOverlay';
import { LeftDock } from './LeftDock';
import { RightSidebar } from './RightSidebar';
import { SettingsModal } from './SettingsModal';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { ToolRail } from './ToolRail';
import { useEditorShortcuts } from './useEditorShortcuts';

/** 一次性提示的落地标记：只在本机第一次进入编辑器时出现。 */
const RAIL_LABEL_HINT_KEY = 'vdraw.hint.rail-labels.v1';

export function EditorView() {
  useEditorShortcuts();
  const leftDockOpen = useAppStore((state) => state.leftDockOpen);
  const focusCanvas = useAppStore((state) => state.focusCanvas);
  const setLeftDockOpen = useAppStore((state) => state.setLeftDockOpen);
  const notify = useAppStore((state) => state.notify);
  const hinted = useRef(false);

  const hintCollapsed = () => {
    if (hinted.current) return;
    hinted.current = true;
    notify('调色板已收起为左侧色块，点击色块或顶栏面板图标可展开', 'info');
  };

  // 首次进入编辑器的一次性提示：工具名默认收起，必须让人知道能展开。
  useEffect(() => {
    if (window.vdraw?.isSmoke) return;
    try {
      if (localStorage.getItem(RAIL_LABEL_HINT_KEY)) return;
      localStorage.setItem(RAIL_LABEL_HINT_KEY, '1');
    } catch {
      return;
    }
    const timer = window.setTimeout(
      () => notify('左侧工具栏可展开为带名称的图标条，按 Ctrl+B 切换', 'info'),
      1400
    );
    return () => window.clearTimeout(timer);
  }, [notify]);

  // 1120–1199 断点：左 dock 折叠为 46px 色块条（仍可改颜色），窗口变宽再展开。
  useEffect(() => {
    let previous = window.innerWidth;
    const apply = () => {
      const width = window.innerWidth;
      if (width < 1200 && previous >= 1200) {
        setLeftDockOpen(false);
        hintCollapsed();
      }
      if (width >= 1200 && previous < 1200) setLeftDockOpen(true);
      previous = width;
    };
    if (window.innerWidth < 1200) setLeftDockOpen(false);
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [setLeftDockOpen]);

  return (
    <div
      className={`editor-shell${focusCanvas ? ' is-focus-canvas' : ''}`}
      data-focus-canvas={focusCanvas ? 'true' : 'false'}
    >
      <TitleBar />
      <div className="workspace">
        <ToolRail />
        {!focusCanvas ? <LeftDock collapsed={!leftDockOpen} /> : null}
        <CanvasStage />
        {!focusCanvas ? <RightSidebar /> : null}
      </div>
      <StatusBar />
      <ChemReportModal />
      <ShortcutOverlay />
      <CommandPalette />
      <SettingsModal />
    </div>
  );
}
