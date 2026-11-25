import { useEffect, useMemo, useRef, useState } from 'react';
import { TOOLS } from '../../core/tools';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { useFileActions } from './useFileActions';

interface CommandItem {
  id: string;
  label: string;
  group: string;
  keywords: string;
  run: () => void;
}

/** Ctrl+K 命令面板：工具与常用命令统一搜索，解决"功能藏在菜单里"的发现问题。 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileActions = useFileActions();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        // 其他浮层（设置、导出、颜色选择器）打开时让位，避免叠两层。
        if (useAppStore.getState().overlayDepth > 0) return;
        event.preventDefault();
        setOpen((value) => !value);
        setQuery('');
        setIndex(0);
      }
    };
    const openHandler = () => setOpen(true);
    window.addEventListener('keydown', handler);
    window.addEventListener('vdraw:command-palette', openHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('vdraw:command-palette', openHandler);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const { pushOverlay, popOverlay } = useAppStore.getState();
    pushOverlay();
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      window.clearTimeout(timer);
      popOverlay();
    };
  }, [open]);

  const commands = useMemo<CommandItem[]>(() => {
    const state = () => useAppStore.getState();
    const tools = TOOLS.map<CommandItem>((tool) => ({
      id: `tool:${tool.id}`,
      label: `工具：${tool.label}`,
      group: '工具',
      keywords: `${tool.label} ${tool.id} ${tool.shortcut ?? ''}`,
      run: () => state().setTool(tool.id)
    }));
    const actions: CommandItem[] = [
      {
        id: 'undo',
        label: '撤销',
        group: '命令',
        keywords: 'undo 撤销',
        run: () => state().undo()
      },
      {
        id: 'redo',
        label: '重做',
        group: '命令',
        keywords: 'redo 重做',
        run: () => state().redo()
      },
      {
        id: 'save',
        label: '保存文档',
        group: '文件',
        keywords: 'save 保存',
        run: () => void fileActions.save()
      },
      {
        id: 'open',
        label: '打开文档…',
        group: '文件',
        keywords: 'open 打开',
        run: () => void fileActions.open()
      },
      {
        id: 'import',
        label: '导入文件…',
        group: '文件',
        keywords: 'import 导入 vdraw svg json png jpg webp gif bmp 位图 图片 恢复',
        run: () => state().openImportPanel()
      },
      {
        id: 'export',
        label: '打开导出面板…',
        group: '文件',
        keywords: 'export 导出 png svg pdf jpg',
        run: () => state().openExportPanel()
      },
      {
        id: 'settings',
        label: '打开设置…',
        group: '命令',
        keywords: 'settings 设置 偏好',
        run: () => state().openSettings()
      },
      {
        id: 'fit',
        label: '适应窗口',
        group: '视图',
        keywords: 'fit zoom 适应 缩放',
        run: () => state().fitToCanvas()
      },
      {
        id: 'zoom-selection',
        label: '缩放到选中对象',
        group: '视图',
        keywords: 'zoom selection 选中 缩放',
        run: () => state().zoomToSelection()
      },
      {
        id: 'grid',
        label: '显示/隐藏网格',
        group: '视图',
        keywords: 'grid 网格',
        run: () => state().toggleGrid()
      },
      {
        id: 'rulers',
        label: '显示/隐藏标尺',
        group: '视图',
        keywords: 'ruler 标尺',
        run: () => state().toggleRulers()
      },
      {
        id: 'snap',
        label: '开启/关闭吸附',
        group: '视图',
        keywords: 'snap 吸附',
        run: () => state().toggleSnap()
      },
      {
        id: 'shortcuts',
        label: '查看快捷键一览',
        group: '帮助',
        keywords: 'shortcut 快捷键 help 帮助',
        run: () => window.dispatchEvent(new Event('vdraw:shortcut-overlay'))
      }
    ];
    return [...tools, ...actions];
  }, [fileActions]);

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return commands;
    return commands.filter(
      (item) =>
        item.label.toLowerCase().includes(text) || item.keywords.toLowerCase().includes(text)
    );
  }, [commands, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const runAt = (position: number) => {
    const item = filtered[position];
    if (!item) return;
    setOpen(false);
    item.run();
  };

  return (
    <div className="command-backdrop" onPointerDown={() => setOpen(false)}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette__search">
          <Icon name="zoom" size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索工具或命令（例如：矩形、导出、吸附）"
            aria-label="搜索工具或命令"
            data-testid="command-input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIndex((value) => Math.min(filtered.length - 1, value + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((value) => Math.max(0, value - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runAt(index);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-palette__list" role="listbox">
          {filtered.length === 0 ? (
            <p className="command-palette__empty">没有匹配的工具或命令</p>
          ) : (
            filtered.map((item, position) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={position === index}
                className={`command-palette__item${position === index ? ' is-active' : ''}`}
                onPointerEnter={() => setIndex(position)}
                onClick={() => runAt(position)}
              >
                <span>{item.label}</span>
                <em>{item.group}</em>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
