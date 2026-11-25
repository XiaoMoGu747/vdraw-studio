import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { TemplateId } from '../../core/document';
import { Icon } from '../ui/Icon';
import type { IconName } from '../../types/ui';
import { useFileActions } from '../editor/useFileActions';
import { HeroArtwork } from './HeroArtwork';
import { NewCanvasDialog } from './NewCanvasDialog';

function formatRecentDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

interface UseCase {
  id: string;
  title: string;
  desc: string;
  name: string;
  templateId: TemplateId;
  icon: IconName;
  gridSize?: number;
  showGrid?: boolean;
}

/** 用途模板只预置画布类型、命名与网格；不改默认尺寸与键长（规范边界 4/5）。 */
const USE_CASES: UseCase[] = [
  {
    id: 'reaction',
    title: '反应式排版',
    desc: '化学图层 · A4 横版',
    name: '反应式',
    templateId: 'chem-sheet',
    icon: 'arrow',
    gridSize: 10,
    showGrid: true
  },
  {
    id: 'molecule',
    title: '分子结构',
    desc: '化学图层 · 单分子居中',
    name: '分子结构',
    templateId: 'chem-sheet',
    icon: 'molecule',
    gridSize: 10,
    showGrid: false
  },
  {
    id: 'paper',
    title: '论文插图',
    desc: 'A4 竖版 · 矢量导出',
    name: '论文插图',
    templateId: 'a4-portrait',
    icon: 'file',
    gridSize: 20,
    showGrid: false
  }
];

export function StartPage() {
  const recent = useAppStore((state) => state.recent);
  const removeRecent = useAppStore((state) => state.removeRecent);
  const notify = useAppStore((state) => state.notify);
  const startDocumentWith = useAppStore((state) => state.startDocumentWith);
  const openImportPanel = useAppStore((state) => state.openImportPanel);
  const fileActions = useFileActions();
  const bridge = window.vdraw;
  const [maximized, setMaximized] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    return bridge.window.onStateChange((state) => setMaximized(state.maximized));
  }, [bridge]);

  return (
    <div className="start-page start-page--launcher">
      <div className="start-page__glow" aria-hidden="true" />

      <header className="launcher-bar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="logo" size={18} strokeWidth={1.9} />
          </span>
          <span className="brand__text">
            VDraw <em>Studio</em>
          </span>
        </div>
        <div className="launcher-bar__actions">
          <button
            type="button"
            className="launcher-icon-btn"
            title="收起窗口"
            aria-label="收起窗口"
            disabled={!bridge}
            onClick={() => void bridge?.window.minimize()}
          >
            <Icon name="minimize" size={15} />
          </button>
          <button
            type="button"
            className="launcher-icon-btn"
            title={maximized ? '缩小窗口' : '全屏窗口'}
            aria-label={maximized ? '缩小窗口' : '全屏窗口'}
            disabled={!bridge}
            onClick={() => void bridge?.window.toggleMaximize()}
          >
            <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
          </button>
          <button
            type="button"
            className="launcher-icon-btn launcher-icon-btn--danger"
            title="关闭窗口"
            aria-label="关闭窗口"
            disabled={!bridge}
            onClick={() => void bridge?.window.close()}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>

      <main className="launcher-main">
        <section className="launcher-hero">
          <div className="launcher-hero__copy">
            <h1>
              矢量图形与有机化学结构，
              <br />
              在同一张画布完成
            </h1>
            <p>
              本地优先 · 无需账号 · A4 论文级插图。键长、键宽与原子标签按印刷标准预置。
            </p>
            <div className="launcher-hero__badges">
              <span className="status-pill">
                <span className="status-pill__dot" />
                离线可用
              </span>
              <span className="tiny-badge">SVG / PNG / PDF</span>
              <span className="tiny-badge tiny-badge--chem">矢量 + 化学</span>
            </div>
          </div>
          <div className="launcher-hero__art">
            <HeroArtwork />
          </div>
        </section>

        <div className="launcher-actions">
          <button
            type="button"
            className="launcher-card"
            data-testid="start-new"
            onClick={() => setDialogOpen(true)}
          >
            <span className="launcher-card__icon">
              <Icon name="plus" size={26} />
            </span>
            <strong>新建画布</strong>
            <em>从空白画布开始绘制</em>
          </button>
          <button
            type="button"
            className="launcher-card"
            data-testid="start-open"
            onClick={() => void fileActions.open()}
          >
            <span className="launcher-card__icon">
              <Icon name="folder" size={26} />
            </span>
            <strong>打开画布</strong>
            <em>选择本地 .vdraw 文件</em>
          </button>
          <button
            type="button"
            className="launcher-card"
            data-testid="start-import"
            onClick={openImportPanel}
          >
            <span className="launcher-card__icon">
              <Icon name="upload" size={26} />
            </span>
            <strong>导入文件</strong>
            <em>工程 / SVG / 位图 · 可多选</em>
          </button>
        </div>

        <section className="launcher-usecases" aria-label="用途模板">
          <div className="launcher-usecases__head">
            <h2>按用途开始</h2>
            <span>内置模板，不联网</span>
          </div>
          <div className="usecase-grid">
            {USE_CASES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="usecase-card"
                data-usecase={item.id}
                onClick={() =>
                  startDocumentWith({
                    name: item.name,
                    templateId: item.templateId,
                    gridSize: item.gridSize,
                    showGrid: item.showGrid
                  })
                }
              >
                <span className="usecase-card__icon">
                  <Icon name={item.icon} size={16} />
                </span>
                <span className="usecase-card__body">
                  <strong>{item.title}</strong>
                  <em>{item.desc}</em>
                </span>
                <Icon name="chevronRight" size={14} className="usecase-card__arrow" />
              </button>
            ))}
          </div>
        </section>

        <section className="launcher-recent">
          <div className="launcher-recent__head">
            <h2>最近文件</h2>
            <span>{recent.length > 0 ? `${recent.length} 条记录` : '仅保存在本机'}</span>
          </div>

          {recent.length > 0 ? (
            <ul className="recent-list recent-list--launcher">
              {recent.map((item) => (
                <li className="recent-item" key={item.id}>
                  <button
                    type="button"
                    className="recent-item__main"
                    data-testid="recent-row"
                    onClick={() => {
                      if (item.path) void fileActions.openPath(item.path);
                      else notify('该记录没有关联本地文件，请使用“打开画布”', 'warn');
                    }}
                  >
                    <span className="recent-item__icon">
                      <Icon name="file" size={16} />
                    </span>
                    <span className="recent-item__body">
                      <strong>{item.name}</strong>
                      <span>
                        {item.templateName} · {item.sizeLabel} · {formatRecentDate(item.openedAt)}
                      </span>
                    </span>
                    <Icon name="chevronRight" size={14} className="recent-item__arrow" />
                  </button>
                  <button
                    type="button"
                    className="recent-item__delete"
                    data-testid="recent-delete"
                    title="删除该记录"
                    aria-label={`删除 ${item.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeRecent(item.id);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="recent-empty recent-empty--launcher">
              <Icon name="history" size={20} />
              <div>
                <p>还没有最近文档</p>
                <span>新建或打开画布后，记录会显示在这里</span>
              </div>
            </div>
          )}
        </section>
      </main>

      <NewCanvasDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />

      <footer className="start-footer">
        <span>Electron{bridge?.versions.electron ? ` ${bridge.versions.electron}` : ''} · React · TypeScript</span>
        <span className="start-footer__dot" />
        <span>数据仅保存在本地</span>
        <span className="start-footer__spacer" />
        <span>VDraw Studio 0.2.0</span>
      </footer>
    </div>
  );
}
