import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { MenuBar } from './MenuBar';
import { TopActions } from './TopActions';

export function TitleBar() {
  const docName = useAppStore((state) => state.doc.name);
  const isDirty = useAppStore((state) => state.isDirty);
  const filePath = useAppStore((state) => state.doc.filePath);
  const goToStart = useAppStore((state) => state.goToStart);
  const [maximized, setMaximized] = useState(false);
  const bridge = window.vdraw;

  useEffect(() => {
    if (!bridge) return;
    return bridge.window.onStateChange((state) => setMaximized(state.maximized));
  }, [bridge]);

  return (
    <header className="titlebar">
      <div className="titlebar__left">
        <button
          type="button"
          className="titlebar__brand"
          title="返回启动页"
          onClick={goToStart}
        >
          <span className="brand-mark brand-mark--sm">
            <Icon name="logo" size={14} strokeWidth={2} />
          </span>
          <span className="titlebar__app">
            VDraw <em>Studio</em>
          </span>
        </button>

        <MenuBar />
      </div>

      <div className="titlebar__center">
        <span className="titlebar__doc" title={docName}>
          {docName}
        </span>
        <span
          className={`titlebar__unsaved${isDirty ? '' : filePath ? ' is-saved' : ' is-new'}`}
          title={filePath ?? '文档尚未写入本地文件'}
        >
          {isDirty ? '未保存' : filePath ? '已保存' : '新文档'}
        </span>
      </div>

      <div className="titlebar__right">
        <TopActions />

        <div className="titlebar__controls">
        {bridge ? (
          <>
            <button
              type="button"
              className="window-btn"
              aria-label="最小化"
              onClick={() => void bridge.window.minimize()}
            >
              <Icon name="minimize" size={14} />
            </button>
            <button
              type="button"
              className="window-btn"
              aria-label={maximized ? '还原' : '最大化'}
              onClick={() => void bridge.window.toggleMaximize()}
            >
              <Icon name={maximized ? 'restore' : 'maximize'} size={13} />
            </button>
            <button
              type="button"
              className="window-btn window-btn--close"
              aria-label="返回启动页"
              title="返回启动页（未保存的修改会先确认）"
              onClick={goToStart}
            >
              <Icon name="close" size={14} />
            </button>
          </>
        ) : (
          <span className="titlebar__browser">浏览器预览</span>
        )}
        </div>
      </div>
    </header>
  );
}
