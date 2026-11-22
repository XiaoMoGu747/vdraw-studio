import { useEffect, useState } from 'react';
import { TOOLS } from '../../core/tools';
import { useAppStore } from '../../store/useAppStore';
import { Modal } from '../ui/Modal';

const COMMANDS: { keys: string; label: string }[] = [
  { keys: 'Ctrl+Z / Ctrl+Shift+Z', label: '撤销 / 重做' },
  { keys: 'Ctrl+C / Ctrl+V / Ctrl+D', label: '复制 / 粘贴 / 创建副本' },
  { keys: 'Ctrl+G / Ctrl+Shift+G', label: '编组 / 解组' },
  { keys: 'Ctrl+A / Delete', label: '全选 / 删除' },
  { keys: 'Ctrl+S / Ctrl+Shift+S', label: '保存 / 另存为' },
  { keys: 'Ctrl+O / Ctrl+N', label: '打开 / 新建' },
  { keys: 'Ctrl+E', label: '导出面板' },
  { keys: 'Ctrl+= / Ctrl+- / Ctrl+0', label: '放大 / 缩小 / 100%' },
  { keys: 'Ctrl+1 / Ctrl+2', label: '适应窗口 / 缩放到选中' },
  { keys: 'Ctrl+Shift+R', label: '显示/隐藏标尺' },
  { keys: 'Ctrl+Shift+D', label: '专注画布' },
  { keys: 'Ctrl+\\', label: '收起/展开调色板' },
  { keys: 'Ctrl+B', label: '显示/隐藏工具名' },
  { keys: 'Ctrl+K', label: '命令面板（搜索工具与命令）' },
  { keys: '空格拖拽 / 中键', label: '临时平移' },
  { keys: '[ / ]', label: '画笔/橡皮尺寸（Shift 调画笔不透明度）' },
  { keys: 'Shift+Y', label: '循环对称模式' },
  { keys: '?', label: '打开本速查表' }
];

/** 快捷键速查：覆盖全部已注册的工具键与常用命令键。 */
export function ShortcutOverlay() {
  const [open, setOpen] = useState(false);
  const toolShortcuts = useAppStore((state) => state.toolShortcuts);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
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
      if (event.key === '?') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    const openHandler = () => setOpen(true);
    window.addEventListener('keydown', handler);
    window.addEventListener('vdraw:shortcut-overlay', openHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('vdraw:shortcut-overlay', openHandler);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const { pushOverlay, popOverlay } = useAppStore.getState();
    pushOverlay();
    return () => popOverlay();
  }, [open]);

  if (!open) return null;

  return (
    <Modal
      title="快捷键一览"
      subtitle={`${TOOLS.length} 个工具 · ? 再次关闭 · Ctrl+K 搜索命令`}
      onClose={() => setOpen(false)}
      footer={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setOpen(false)}>
          关闭
        </button>
      }
    >
      <div className="shortcut-sheet">
        <section>
          <h3>工具</h3>
          <ul className="shortcut-list">
            {TOOLS.map((tool) => {
              const key = toolShortcuts[tool.id] ?? tool.shortcut;
              return (
                <li key={tool.id}>
                  <span>{tool.label}</span>
                  <kbd>{key ? key.toUpperCase() : '未设置'}</kbd>
                </li>
              );
            })}
          </ul>
        </section>
        <section>
          <h3>命令</h3>
          <ul className="shortcut-list">
            {COMMANDS.map((item) => (
              <li key={item.keys}>
                <span>{item.label}</span>
                <kbd>{item.keys}</kbd>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}
