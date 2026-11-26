import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { MenuBar } from './MenuBar';
import { TopActions } from './TopActions';

export function TitleBar() {
  const docName = useAppStore((state) => state.doc.name);
  const isDirty = useAppStore((state) => state.isDirty);
  const filePath = useAppStore((state) => state.doc.filePath);
  const goToStart = useAppStore((state) => state.goToStart);
  const renameDocument = useAppStore((state) => state.renameDocument);
  const [maximized, setMaximized] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(docName);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const cancelled = useRef(false);
  const bridge = window.vdraw;

  useEffect(() => {
    if (!bridge) return;
    return bridge.window.onStateChange((state) => setMaximized(state.maximized));
  }, [bridge]);

  useEffect(() => {
    if (!editing) setDraft(docName);
  }, [docName, editing]);

  const finishRename = () => {
    if (!editing) return;
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(docName);
      return;
    }
    renameDocument(draft);
  };

  return (
    <>
    <header className="titlebar">
      <div className="titlebar__left">
        <button
          type="button"
          className="titlebar__brand"
          title="返回启动页"
          onClick={() => goToStart()}
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
        {editing ? (
          <input
            className="titlebar__doc-input"
            data-testid="doc-title-input"
            value={draft}
            aria-label="文档名称"
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                cancelled.current = true;
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span
            className="titlebar__doc"
            data-testid="doc-title"
            title={`${docName}（双击重命名）`}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setDraft(docName);
              setEditing(true);
            }}
          >
            {docName}
          </span>
        )}
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
              onClick={() => {
                if (isDirty) setLeaveConfirmOpen(true);
                else goToStart();
              }}
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
    {leaveConfirmOpen ? (
      <ConfirmDialog
        title="返回启动页"
        message="当前文档有未保存的修改，返回启动页后这些修改会丢失。"
        hint="可以先取消并保存文档，再返回启动页。"
        confirmLabel="仍要返回"
        cancelLabel="继续编辑"
        tone="danger"
        testId="leave-document-confirm"
        onConfirm={() => {
          setLeaveConfirmOpen(false);
          goToStart(true);
        }}
        onCancel={() => setLeaveConfirmOpen(false)}
      />
    ) : null}
    </>
  );
}
