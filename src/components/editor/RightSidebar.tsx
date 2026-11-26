import { useState } from 'react';
import { getObject } from '../../core/scene';
import { isBenzeneGroup } from '../../core/chemistry/benzene';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { LayersPanel } from './LayersPanel';
import { ObjectPropertiesPanel } from './ObjectPropertiesPanel';

type SidebarTab = 'layers' | 'properties';

const TABS: SidebarTab[] = ['layers', 'properties'];

function tabId(tab: SidebarTab): string {
  return `sidebar-tab-${tab}`;
}

/**
 * 右侧栏：图层 / 属性页签，各占满高。
 *
 * 两级收起，行为必须保持可区分：
 * - 局部收起：图层区、对象区、属性区各自的按钮，只隐藏该区内容，面板宽度不变；
 * - 整体收起：表头按钮把整个面板收成窄轨，只保留展开入口，画布横向扩展。
 * 局部收起状态保存在本组件，切页签或整体收起再展开都能完整恢复。
 */
export function RightSidebar() {
  const tab = useAppStore((state) => state.sidebarTab);
  const setTab = useAppStore((state) => state.setSidebarTab);
  const selection = useAppStore((state) => state.selection);
  const doc = useAppStore((state) => state.doc);
  const rightDockOpen = useAppStore((state) => state.rightDockOpen);
  const toggleRightDock = useAppStore((state) => state.toggleRightDock);

  // 局部收起状态放在页签层：图层/属性内容卸载后仍能恢复。
  const [layersSectionCollapsed, setLayersSectionCollapsed] = useState(false);
  const [objectsSectionCollapsed, setObjectsSectionCollapsed] = useState(false);
  const [propertiesSectionCollapsed, setPropertiesSectionCollapsed] = useState(false);

  const primary = selection.length === 1 ? getObject(doc, selection[0]) : null;
  const typeLabel = primary
    ? primary.type === 'group'
      ? isBenzeneGroup(primary)
        ? '苯环'
        : '编组'
      : primary.name
    : '';
  const propertiesUnread = tab === 'layers' && selection.length > 0;

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    const current = TABS.indexOf(tab);
    const next =
      event.key === 'Home'
        ? TABS[0]
        : event.key === 'End'
          ? TABS[TABS.length - 1]
          : TABS[(current + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  // 整体收起：只保留一条窄轨和展开入口，宽度让给画布；局部收起不改变宽度。
  // 面板内容保持挂载（CSS 隐藏），展开时连图层滚动位置与临时菜单状态一起恢复。
  return (
    <aside
      className={`right-panel right-sidebar${rightDockOpen ? '' : ' right-sidebar--rail'}`}
      data-testid={rightDockOpen ? undefined : 'right-sidebar-rail'}
      aria-label={rightDockOpen ? undefined : '图层与属性面板已整体收起'}
    >
      {!rightDockOpen ? (
        <button
          type="button"
          className="right-sidebar__rail-expand"
          data-testid="right-sidebar-expand"
          title="整体展开「图层 / 属性」面板（恢复全部内容）"
          aria-label="整体展开图层与属性面板"
          aria-expanded={false}
          onClick={toggleRightDock}
        >
          <Icon name="chevronRight" size={14} className="rotate-180" />
          <span className="right-sidebar__rail-label">图层 / 属性</span>
        </button>
      ) : null}
      <div className="right-sidebar__main" aria-hidden={rightDockOpen ? undefined : true}>
      <div className="right-sidebar__head">
      <div
        className="panel-tabs panel-tabs--sidebar"
        role="tablist"
        aria-label="右侧面板"
        onKeyDown={onTabKeyDown}
      >
        <button
          type="button"
          role="tab"
          id={tabId('layers')}
          aria-selected={tab === 'layers'}
          aria-controls="sidebar-panel-layers"
          tabIndex={tab === 'layers' ? 0 : -1}
          className={`panel-tab${tab === 'layers' ? ' is-active' : ''}`}
          data-testid="sidebar-tab-layers"
          onClick={() => setTab('layers')}
        >
          <Icon name="layers" size={14} />
          图层
        </button>
        <button
          type="button"
          role="tab"
          id={tabId('properties')}
          aria-selected={tab === 'properties'}
          aria-controls="sidebar-panel-properties"
          tabIndex={tab === 'properties' ? 0 : -1}
          className={`panel-tab${tab === 'properties' ? ' is-active' : ''}`}
          data-testid="sidebar-tab-properties"
          title={typeLabel ? `属性 · ${typeLabel}` : '对象属性'}
          onClick={() => {
            setTab('properties');
            useAppStore.getState().openProperties();
          }}
        >
          <Icon name="properties" size={14} />
          <span className="panel-tab__label">属性</span>
          {selection.length > 0 ? <em>{selection.length}</em> : null}
          {propertiesUnread ? (
            <span className="panel-tab__dot" aria-hidden="true" title="有新的选择" />
          ) : null}
        </button>
      </div>
      <button
        type="button"
        className="icon-btn icon-btn--sm right-sidebar__collapse"
        data-testid="right-sidebar-collapse"
        title="整体收起「图层 / 属性」面板（隐藏全部内容，为画布腾出空间）"
        aria-label="整体收起图层与属性面板"
        aria-expanded={true}
        onClick={toggleRightDock}
      >
        <Icon name="chevronRight" size={14} />
      </button>
      </div>
      <div
        className="right-sidebar__body"
        id={`sidebar-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={tabId(tab)}
      >
        {tab === 'layers' ? (
          <LayersPanel
            layersCollapsed={layersSectionCollapsed}
            objectsCollapsed={objectsSectionCollapsed}
            onToggleLayers={() => setLayersSectionCollapsed((value) => !value)}
            onToggleObjects={() => setObjectsSectionCollapsed((value) => !value)}
          />
        ) : (
          <ObjectPropertiesPanel
            collapsed={propertiesSectionCollapsed}
            onToggleCollapsed={() => setPropertiesSectionCollapsed((value) => !value)}
          />
        )}
      </div>
      </div>
    </aside>
  );
}
