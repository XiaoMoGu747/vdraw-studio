import { useState } from 'react';
import { RAIL_CATALOG, railEntry, railShortcut } from '../../core/rail';
import type { RailEntry } from '../../core/rail';
import { RAIL_GROUPS } from '../../core/tools';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';

/** 最左侧竖向导轨：按用户配置的顺序渲染工具，并支持扩展管理。 */
export function ToolRail() {
  const activeTool = useAppStore((state) => state.activeTool);
  const setTool = useAppStore((state) => state.setTool);
  const setToolPanel = useAppStore((state) => state.setToolPanel);
  const setChem = useAppStore((state) => state.setChem);
  const chem = useAppStore((state) => state.chem);
  const symmetry = useAppStore((state) => state.symmetry);
  const setSymmetry = useAppStore((state) => state.setSymmetry);
  const guideMode = useAppStore((state) => state.guideMode);
  const setGuideMode = useAppStore((state) => state.setGuideMode);
  const railOrder = useAppStore((state) => state.railOrder);
  const setRailOrder = useAppStore((state) => state.setRailOrder);
  const toggleRailItem = useAppStore((state) => state.toggleRailItem);
  const showToolLabels = useAppStore((state) => state.showToolLabels);
  const toggleToolLabels = useAppStore((state) => state.toggleToolLabels);

  const [managerOpen, setManagerOpen] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  const activate = (entry: RailEntry) => {
    if (entry.chemistry) {
      // 先切到选择工具（会按规则清理别的面板），再展开化学横栏；
      // 顺序反过来会被 setTool 的清理逻辑立刻收掉。
      if (!entry.tools?.includes(activeTool)) setTool('select');
      setToolPanel('chem');
      return;
    }
    if (entry.key === 'shape') {
      useAppStore.getState().setSelection([]);
      if (!entry.tools?.includes(activeTool)) setTool('select');
      setToolPanel('shape');
      return;
    }
    // 形状工具面板是独立工具面板：切换到画笔/选择等工具时不主动收起，
    // 用户再次点击形状选项即可继续绘制。只有显式“关闭”或进入化学面板才收起。
    // 化学横栏例外：点「选择」只切换操作模式，横向面板保留，方便选中后继续画。
    const currentPanel = useAppStore.getState().toolPanel;
    if (currentPanel !== 'shape' && !(currentPanel === 'chem' && entry.tool === 'select')) {
      setToolPanel(null);
    }
    // 对称 / 辅助线互不影响；再次点击辅助线工具时确保绘画吸附开启
    if (entry.key === 'symmetry' && symmetry === 'none') setSymmetry('vertical');
    if (entry.key === 'guides') setGuideMode(guideMode === 'none' ? 'one-point' : guideMode);
    if (entry.atomCategory) setChem({ atomCategory: entry.atomCategory });
    if (entry.tools && entry.tools.length > 0) {
      setTool(entry.tools.includes(activeTool) ? activeTool : entry.tool);
      return;
    }
    setTool(entry.tool);
  };

  const isActive = (entry: RailEntry) => {
    if (entry.atomCategory) {
      return activeTool === entry.tool && chem.atomCategory === entry.atomCategory;
    }
    return activeTool === entry.tool || Boolean(entry.tools?.includes(activeTool));
  };

  const entries = railOrder.map((key) => railEntry(key)).filter((entry): entry is RailEntry => Boolean(entry));
  const allKeys = [
    ...railOrder,
    ...RAIL_CATALOG.filter((entry) => !railOrder.includes(entry.key)).map((entry) => entry.key)
  ];

  const reorder = (sourceKey: string | null, targetKey: string) => {
    if (!sourceKey || sourceKey === targetKey) return;
    const next = allKeys.filter((key) => key !== sourceKey);
    const index = next.indexOf(targetKey);
    next.splice(index < 0 ? next.length : index, 0, sourceKey);
    setRailOrder(next.filter((key) => railOrder.includes(key)));
  };

  return (
    <>
      <nav className="tool-rail" aria-label="工具" data-testid="tool-rail">
        {entries.map((entry, index) => {
          const previous = entries[index - 1];
          const shortcut = railShortcut(entry.key);
          const tip = shortcut ? `${entry.label} · ${shortcut}` : entry.label;
          const groupStart = !previous || previous.group !== entry.group;
          const groupLabel = RAIL_GROUPS.find((group) => group.id === entry.group)?.label;
          return (
            <div key={entry.key} className="tool-rail__group">
              {groupStart && index > 0 ? <span className="tool-rail__divider" /> : null}
              {groupStart && groupLabel ? (
                <span className="rail-group-label">{groupLabel}</span>
              ) : null}
              <button
                type="button"
                className={`rail-btn${isActive(entry) ? ' is-active' : ''}${
                  entry.chemistry ? ' rail-btn--chem' : ''
                }`}
                data-tool={entry.key}
                aria-pressed={isActive(entry)}
                aria-label={entry.label}
                title={tip}
                data-tip={tip}
                onClick={() => activate(entry)}
              >
                <Icon name={entry.icon} size={19} />
                <span className="rail-btn__label">{entry.label}</span>
                {entry.tools ? <span className="rail-btn__more" /> : null}
                {entry.chemistry ? <span className="rail-btn__chem" /> : null}
              </button>
            </div>
          );
        })}

        <div className="tool-rail__group tool-rail__group--tail">
          <span className="tool-rail__divider" />
          {/* 工具名开关放在导轨自身：默认纯图标时也一眼能看到「可以展开名字」。 */}
          <button
            type="button"
            className={`rail-btn${showToolLabels ? ' is-active' : ''}`}
            title={showToolLabels ? '收起工具名（Ctrl+B）' : '显示工具名（Ctrl+B）'}
            aria-pressed={showToolLabels}
            data-testid="rail-labels"
            onClick={toggleToolLabels}
          >
            <Icon name="alignLeft" size={17} />
            <span className="rail-btn__label">{showToolLabels ? '收起工具名' : '显示工具名'}</span>
          </button>
          <button
            type="button"
            className="rail-btn rail-btn--expand"
            title="扩展工具"
            data-testid="rail-expand"
            onClick={() => setManagerOpen(true)}
          >
            <Icon name="grid4" size={18} />
            <span className="rail-btn__label">扩展工具</span>
          </button>
        </div>
      </nav>

      {managerOpen ? (
        <Modal
          title="扩展工具"
          subtitle={`${railOrder.length} 个常驻 · 拖拽排序，点击眼睛增删；列表可滚动`}
          onClose={() => setManagerOpen(false)}
          footer={
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => setManagerOpen(false)}
            >
              完成
            </button>
          }
        >
          <div className="rail-manager-wrap">
            <div className="rail-manager" data-testid="rail-manager">
            {allKeys.map((key) => {
              const entry = railEntry(key);
              if (!entry) return null;
              const resident = railOrder.includes(key);
              return (
                <div
                  key={key}
                  className={`rail-manager__row${resident ? ' is-resident' : ''}${
                    dragging === key ? ' is-dragging' : ''
                  }`}
                  data-rail-row={key}
                  data-resident={resident}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', key);
                    setDragging(key);
                  }}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source =
                      event.dataTransfer.getData('text/plain') || dragging;
                    reorder(source, key);
                    setDragging(null);
                  }}
                >
                  <span className="rail-manager__handle" title="拖拽排序">
                    <Icon name="grid4" size={13} />
                  </span>
                  <span className="rail-manager__icon">
                    <Icon name={entry.icon} size={16} />
                  </span>
                  <span className="rail-manager__body">
                    <strong>{entry.label}</strong>
                    <em>{entry.group === 'chem' ? '化学子工具' : '主工具栏'}</em>
                  </span>
                  <button
                    type="button"
                    className={`rail-manager__toggle${resident ? ' is-on' : ''}`}
                    data-testid={`rail-toggle-${key}`}
                    title={
                      resident
                        ? '从常驻栏移除'
                        : entry.group === 'chem'
                          ? '添加为独立常驻工具；化学子工具也随“化学工具”父项显示'
                          : '添加到常驻栏'
                    }
                    onClick={() => toggleRailItem(key)}
                  >
                    <Icon name={resident ? 'eye' : 'eyeOff'} size={15} />
                  </button>
                </div>
              );
            })}
            </div>
            <div className="rail-manager__fade" aria-hidden="true" />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
