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
 * 右侧栏：图层 / 属性页签，各占满高，只有一层滚动。
 * 选中对象不自动切页签，只在“属性”页签上显示未读点；显式“属性/双击”才切换。
 */
export function RightSidebar() {
  const tab = useAppStore((state) => state.sidebarTab);
  const setTab = useAppStore((state) => state.setSidebarTab);
  const selection = useAppStore((state) => state.selection);
  const doc = useAppStore((state) => state.doc);

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

  return (
    <aside className="right-panel right-sidebar">
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
      <div
        className="right-sidebar__body"
        id={`sidebar-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={tabId(tab)}
      >
        {tab === 'layers' ? <LayersPanel /> : <ObjectPropertiesPanel />}
      </div>
    </aside>
  );
}
