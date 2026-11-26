import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { MenuBar } from './MenuBar';
import { TopActions } from './TopActions';
import { useFileActions } from './useFileActions';

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
  const fileActions = useFileActions();
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

  const exitCanvas = () => {
    if (isDirty) {
      setLeaveConfirmOpen(true);
      return;
    }
    goToStart(true);
  };

  const saveAndExit = async () => {
    const saved = await fileActions.save();
    if (!saved) return;
    setLeaveConfirmOpen(false);
    goToStart(true);
  };

  return (
    <>
    <header className="titlebar">
      <div className="titlebar__left">
        <div className="titlebar__brand" title="VDraw Studio">
          <span className="brand-mark brand-mark--sm">
            <Icon name="logo" size={14} strokeWidth={2} />
          </span>
          <span className="titlebar__app">
            VDraw <em>Studio</em>
          </span>
        </div>

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
              aria-label="退出画布"
              title="退出画布（未保存的修改会先确认）"
              onClick={exitCanvas}
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
        title="退出画布"
        message="当前文档有未保存的修改。"
        hint="可以直接退出并丢弃修改，也可以先保存再退出。"
        cancelLabel="取消"
        extraLabel="退出"
        extraTone="danger"
        confirmLabel="保存并退出"
        tone="success"
        testId="leave-document-confirm"
        onExtra={() => {
          setLeaveConfirmOpen(false);
          goToStart(true);
        }}
        onConfirm={() => void saveAndExit()}
        onCancel={() => setLeaveConfirmOpen(false)}
      />
    ) : null}
    </>
  );
}
