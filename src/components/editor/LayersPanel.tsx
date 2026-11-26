import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { TEMPLATE_MAP } from '../../core/document';
import { getObject } from '../../core/scene';
import type { Layer, LayerBlendMode, SceneObject } from '../../types/document';
import type { IconName } from '../../types/ui';
import { useAppStore, type LayerDropPosition } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';

const KIND_LABEL: Record<string, string> = {
  vector: '矢量',
  chemistry: '化学',
  annotation: '标注',
  folder: '文件夹'
};

const TYPE_ICON: Record<string, IconName> = {
  rect: 'rect',
  ellipse: 'ellipse',
  polygon: 'polygon',
  line: 'line',
  path: 'pen',
  text: 'text',
  bond: 'bond',
  atom: 'atom',
  ring: 'ring',
  group: 'layers',
  arrow: 'arrow',
  annotation: 'info',
  image: 'image'
};

export function LayersPanel() {
  const doc = useAppStore((state) => state.doc);
  const selection = useAppStore((state) => state.selection);
  const showGrid = useAppStore((state) => state.showGrid);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const setActiveLayer = useAppStore((state) => state.setActiveLayer);
  const toggleLayerVisible = useAppStore((state) => state.toggleLayerVisible);
  const toggleLayerLock = useAppStore((state) => state.toggleLayerLock);
  const setLayerBlendMode = useAppStore((state) => state.setLayerBlendMode);
  const addLayer = useAppStore((state) => state.addLayer);
  const addLayerFolder = useAppStore((state) => state.addLayerFolder);
  const duplicateLayer = useAppStore((state) => state.duplicateLayer);
  const mergeLayerDown = useAppStore((state) => state.mergeLayerDown);
  const moveLayerTo = useAppStore((state) => state.moveLayerTo);
  const deleteLayer = useAppStore((state) => state.deleteLayer);
  const renameLayer = useAppStore((state) => state.renameLayer);
  const setPageBackground = useAppStore((state) => state.setPageBackground);
  const setPageBackgroundVisible = useAppStore((state) => state.setPageBackgroundVisible);
  const setSelection = useAppStore((state) => state.setSelection);
  const updateDoc = useAppStore((state) => state.updateDoc);
  const duplicateObject = useAppStore((state) => state.duplicateObject);
  const deleteObject = useAppStore((state) => state.deleteObject);
  const moveObjectTo = useAppStore((state) => state.moveObjectTo);

  const template = TEMPLATE_MAP[doc.templateId];
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [objectScope, setObjectScope] = useState<'current' | 'all'>('current');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: LayerDropPosition } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [objectMenu, setObjectMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [objectDrop, setObjectDrop] = useState<{
    id: string;
    placement: 'above' | 'below';
  } | null>(null);
  const [objectDraggingId, setObjectDraggingId] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-layer-menu]')) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  useEffect(() => {
    if (!objectMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-object-menu]')) setObjectMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setObjectMenu(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [objectMenu]);

  const activeLayer = doc.layers.find((layer) => layer.id === doc.activeLayerId) ?? doc.layers[0];
  const currentObjects =
    activeLayer && activeLayer.kind !== 'folder' ? activeLayer.objects : [];
  const allObjects = doc.layers.flatMap((layer) =>
    layer.kind === 'folder'
      ? []
      : layer.objects
          .filter((object) => !object.parentId)
          .slice()
          .reverse()
          .map((object) => ({ object, layerName: layer.name }))
  );
  const objects = objectScope === 'current' ? currentObjects : allObjects.map((item) => item.object);
  const folderChildren = activeLayer
    ? doc.layers.filter((layer) => layer.parentId === activeLayer.id).length
    : 0;
  const objectsCollapsed =
    objectScope === 'current' && activeLayer ? collapsed.includes(activeLayer.id) : false;

  const toggleObjectVisible = (objectId: string) => {
    const object = getObject(doc, objectId);
    if (!object) return;
    updateDoc(
      {
        ...doc,
        layers: doc.layers.map((layer) => ({
          ...layer,
          objects: layer.objects.map((item) =>
            item.id === objectId ? { ...item, visible: !item.visible } : item
          )
        }))
      },
      true
    );
  };

  const toggleObjectLocked = (objectId: string) => {
    const object = getObject(doc, objectId);
    if (!object) return;
    updateDoc(
      {
        ...doc,
        layers: doc.layers.map((layer) => ({
          ...layer,
          objects: layer.objects.map((item) =>
            item.id === objectId ? { ...item, locked: !item.locked } : item
          )
        }))
      },
      true
    );
  };

  const commitRename = (layerId: string) => {
    renameLayer(layerId, renameDraft);
    setRenamingId(null);
  };

  const toggleCollapsed = (layerId: string) => {
    setCollapsed((prev) =>
      prev.includes(layerId) ? prev.filter((id) => id !== layerId) : [...prev, layerId]
    );
  };

  const dragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);

  const layerAtPoint = (
    clientX: number,
    clientY: number
  ): { layer: Layer; position: LayerDropPosition } | null => {
    const element = document.elementFromPoint(clientX, clientY)?.closest('[data-layer-row]');
    if (!element) return null;
    const layer = doc.layers.find((item) => item.id === element.getAttribute('data-layer-id'));
    if (!layer) return null;
    const rect = element.getBoundingClientRect();
    const ratio = (clientY - rect.top) / Math.max(1, rect.height);
    const position: LayerDropPosition =
      layer.kind === 'folder'
        ? ratio < 0.28
          ? 'before'
          : ratio > 0.72
            ? 'after'
            : 'inside'
        : ratio < 0.5
          ? 'before'
          : 'after';
    return { layer, position };
  };

  const startLayerDrag = (event: ReactPointerEvent<HTMLDivElement>, layer: Layer) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, label')) return;
    dragRef.current = { id: layer.id, startX: event.clientX, startY: event.clientY, active: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 合成事件忽略 */
    }
  };

  const moveLayerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      drag.active = true;
      setDraggingId(drag.id);
    }
    const hit = layerAtPoint(event.clientX, event.clientY);
    setDropTarget(
      hit && hit.layer.id !== drag.id ? { id: hit.layer.id, position: hit.position } : null
    );
  };

  const endLayerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (!drag.active) return;
    const hit = layerAtPoint(event.clientX, event.clientY);
    setDraggingId(null);
    setDropTarget(null);
    if (!hit || hit.layer.id === drag.id) return;
    const ids = selectedIds.includes(drag.id) ? selectedIds : [drag.id];
    for (const id of ids) {
      if (id !== hit.layer.id) moveLayerTo(id, hit.layer.id, hit.position);
    }
  };

  const renderLayer = (layer: Layer, depth: number): ReactNode => {
    const active = layer.id === doc.activeLayerId;
    const isFolder = layer.kind === 'folder';
    const expanded = !collapsed.includes(layer.id);
    const layerObjectsCollapsed = collapsed.includes(layer.id);
    const drop = dropTarget?.id === layer.id ? dropTarget.position : null;
    return (
      <div key={layer.id} className="layer-branch">
        <div
          data-layer-row
          data-layer-kind={layer.kind}
          data-layer-id={layer.id}
          role="button"
          tabIndex={0}
          title={`${layer.name}\n点击切换当前图层；拖动调整顺序。`}
          className={[
            'layer-row',
            active ? 'is-active' : '',
            layer.visible ? '' : 'is-hidden',
            draggingId === layer.id ? 'is-dragging' : '',
            isFolder ? 'layer-row--folder' : '',
            drop ? `is-drop-${drop}` : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={(event) => {
            setActiveLayer(layer.id);
            if (event.ctrlKey || event.metaKey) {
              setSelectedIds((prev) =>
                prev.includes(layer.id) ? prev.filter((id) => id !== layer.id) : [...prev, layer.id]
              );
            } else {
              setSelectedIds([layer.id]);
            }
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            setRenamingId(layer.id);
            setRenameDraft(layer.name);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') setActiveLayer(layer.id);
          }}
          onPointerDown={(event) => startLayerDrag(event, layer)}
          onPointerMove={moveLayerDrag}
          onPointerUp={endLayerDrag}
          onPointerCancel={endLayerDrag}
        >
          {isFolder ? (
            <button
              type="button"
              className={`layer-row__chevron${expanded ? '' : ' is-collapsed'}`}
              title={expanded ? '折叠文件夹' : '展开文件夹'}
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapsed(layer.id);
              }}
            >
              <Icon name="chevronDown" size={13} />
            </button>
          ) : (
            <button
              type="button"
              className={`layer-row__chevron${layerObjectsCollapsed ? ' is-collapsed' : ''}`}
              title={
                active
                  ? layerObjectsCollapsed
                    ? '展开当前图层对象'
                    : '折叠当前图层对象'
                  : '切换到该图层并展开对象'
              }
              data-testid={`layer-toggle-${layer.id}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!active) {
                  // 点击其他图层箭头时先切换并展开该图层，避免“刚切过去就被折叠”，
                  // 也确保折叠目标始终是点击的图层，而不是下方对象区。
                  setActiveLayer(layer.id);
                  setCollapsed((prev) => prev.filter((id) => id !== layer.id));
                  return;
                }
                toggleCollapsed(layer.id);
              }}
            >
              <Icon name="chevronDown" size={13} />
            </button>
          )}
          <span className={`layer-row__thumb layer-row__thumb--${layer.kind}`}>
            <Icon
              name={isFolder ? 'folder' : layer.kind === 'chemistry' ? 'molecule' : 'layers'}
              size={14}
            />
          </span>
          <span className="layer-row__body">
            {renamingId === layer.id ? (
              <input
                className="layer-rename"
                autoFocus
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => commitRename(layer.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename(layer.id);
                  if (event.key === 'Escape') setRenamingId(null);
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span className="layer-row__name">{layer.name}</span>
            )}
            <span className="layer-row__meta">
              {KIND_LABEL[layer.kind] ?? '图层'} ·{' '}
              {isFolder
                ? `${doc.layers.filter((item) => item.parentId === layer.id).length} 个子图层`
                : `${layer.objects.length} 个对象`}
            </span>
            {layer.id === doc.activeLayerId ? (
              <select
                className="layer-blend"
                data-testid={`layer-blend-${layer.id}`}
                title="图层混合模式"
                value={layer.blendMode ?? 'normal'}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) =>
                  setLayerBlendMode(layer.id, event.target.value as LayerBlendMode)
                }
              >
                <option value="normal">正常</option>
                <option value="multiply">正片叠底</option>
                <option value="screen">滤色</option>
                <option value="overlay">叠加</option>
                <option value="darken">变暗</option>
                <option value="lighten">变亮</option>
              </select>
            ) : null}
          </span>
          <span className="layer-tools">
            <button
              type="button"
              className="layer-row__toggle"
              title={layer.visible ? '隐藏图层' : '显示图层'}
              aria-pressed={layer.visible}
              onClick={(event) => {
                event.stopPropagation();
                toggleLayerVisible(layer.id);
              }}
            >
              <Icon name={layer.visible ? 'eye' : 'eyeOff'} size={15} />
            </button>
            <button
              type="button"
              className={`layer-row__toggle${layer.locked ? ' is-locked' : ''}`}
              title={layer.locked ? '解锁图层' : '锁定图层'}
              aria-pressed={layer.locked}
              onClick={(event) => {
                event.stopPropagation();
                toggleLayerLock(layer.id);
              }}
            >
              <Icon name={layer.locked ? 'lock' : 'unlock'} size={14} />
            </button>
          </span>
        </div>
        {isFolder && expanded
          ? doc.layers
              .filter((item) => item.parentId === layer.id)
              .slice()
              .reverse()
              .map((child) => renderLayer(child, depth + 1))
          : null}
      </div>
    );
  };

  const roots = doc.layers
    .filter((layer) => !layer.parentId)
    .slice()
    .reverse();

  /** 拖动对象行：在同一父级内调整绘制顺序，列表越靠上覆盖越靠下。 */
  const objectDragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const objectDragClickRef = useRef(false);

  const objectRowAtPoint = (
    clientX: number,
    clientY: number
  ): { id: string; placement: 'above' | 'below' } | null => {
    const element = document
      .elementFromPoint(clientX, clientY)
      ?.closest('[data-object-row]') as HTMLElement | null;
    const id = element?.getAttribute('data-object-id');
    if (!element || !id) return null;
    const rect = element.getBoundingClientRect();
    return { id, placement: clientY - rect.top < rect.height / 2 ? 'above' : 'below' };
  };

  const startObjectDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    object: SceneObject
  ) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 对象行的眼睛/锁是 role=button 的 span：必须在这里排除，
    // 否则 pointerdown 会被行拖动捕获，随后的 click 永远落不到图标上。
    if (target.closest('button, input, label, select, .object-row__eye')) return;
    objectDragRef.current = {
      id: object.id,
      startX: event.clientX,
      startY: event.clientY,
      active: false
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 合成事件忽略 */
    }
  };

  const moveObjectDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = objectDragRef.current;
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      drag.active = true;
      setObjectDraggingId(drag.id);
    }
    const hit = objectRowAtPoint(event.clientX, event.clientY);
    setObjectDrop(hit && hit.id !== drag.id ? hit : null);
  };

  const endObjectDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = objectDragRef.current;
    objectDragRef.current = null;
    if (!drag) return;
    if (!drag.active) return;
    objectDragClickRef.current = true;
    setObjectDraggingId(null);
    setObjectDrop(null);
    const hit = objectRowAtPoint(event.clientX, event.clientY);
    if (!hit || hit.id === drag.id) return;
    moveObjectTo(drag.id, hit.id, hit.placement);
  };

  const renderObject = (object: SceneObject, depth = 0, layerName?: string): ReactNode => {
    const children =
      object.type === 'group'
        ? object.childIds
            .map((id) => getObject(doc, id))
            .filter((child): child is SceneObject => Boolean(child))
        : [];
    const objectKey = `obj:${object.id}`;
    const expanded = !collapsed.includes(objectKey);
    return (
      <div key={object.id} className="object-branch">
        <div
          data-object-row
          data-object-id={object.id}
          className={[
            'object-row',
            selection.includes(object.id) ? 'is-active' : '',
            object.parentId ? 'object-row--child' : '',
            objectDraggingId === object.id ? 'is-dragging' : '',
            objectDrop?.id === object.id ? `is-drop-${objectDrop.placement}` : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ paddingLeft: 6 + depth * 13 }}
          role="button"
          tabIndex={0}
          title={`${object.name}\n点击选择；拖动调整层级；右键可复制或删除。`}
          onClick={() => {
            if (objectDragClickRef.current) {
              objectDragClickRef.current = false;
              return;
            }
            setActiveLayer(object.layerId);
            setSelection([object.id]);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setActiveLayer(object.layerId);
            setSelection([object.id]);
            setObjectMenu({ id: object.id, x: event.clientX, y: event.clientY });
          }}
          onPointerDown={(event) => startObjectDrag(event, object)}
          onPointerMove={moveObjectDrag}
          onPointerUp={endObjectDrag}
          onPointerCancel={endObjectDrag}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              setActiveLayer(object.layerId);
              setSelection([object.id]);
            }
          }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              className={`object-row__chevron${expanded ? '' : ' is-collapsed'}`}
              data-testid={`object-toggle-${object.id}`}
              title={expanded ? '折叠对象内容' : '展开对象内容'}
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapsed(objectKey);
              }}
            >
              <Icon name="chevronDown" size={11} />
            </button>
          ) : (
            <span className="object-row__chevron object-row__chevron--empty" />
          )}
          <span className="object-row__icon">
            <Icon name={TYPE_ICON[object.type] ?? 'layers'} size={13} />
          </span>
          <span className="object-row__name">{object.name}</span>
          {layerName ? <span className="object-row__layer">{layerName}</span> : null}
          <span
            className="object-row__eye"
            role="button"
            tabIndex={-1}
            title={object.locked ? '解锁对象' : '锁定对象'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              toggleObjectLocked(object.id);
            }}
          >
            <Icon name={object.locked ? 'lock' : 'unlock'} size={13} />
          </span>
          <span
            className="object-row__eye"
            role="button"
            tabIndex={-1}
            title={object.visible ? '隐藏对象' : '显示对象'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              toggleObjectVisible(object.id);
            }}
          >
            <Icon name={object.visible ? 'eye' : 'eyeOff'} size={13} />
          </span>
        </div>
        {children.length > 0 && expanded
          ? children.map((child) => renderObject(child, depth + 1))
          : null}
      </div>
    );
  };

  return (
    <div className="layers-panel">
      <div className="panel-head">
        <div>
          <h3>图层</h3>
          <span>
            {doc.layers.length} 个图层 · {doc.layers.filter((layer) => layer.kind === 'folder').length} 个文件夹
          </span>
        </div>
        <div className="panel-head__actions" data-layer-menu>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title="新建图层"
            data-testid="layer-add"
            onClick={addLayer}
          >
            <Icon name="plus" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title="更多图层操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid="layer-more"
            onClick={() => setMenuOpen((value) => !value)}
          >
            <span className="props-inline__more" aria-hidden="true">⋯</span>
          </button>
          {menuOpen ? (
            <div className="panel-head__menu" role="menu">
              <button
                type="button"
                role="menuitem"
                data-testid="layer-add-folder"
                onClick={() => {
                  addLayerFolder();
                  setMenuOpen(false);
                }}
              >
                <Icon name="folder" size={14} />
                新建文件夹
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="layer-duplicate"
                onClick={() => {
                  duplicateLayer(doc.activeLayerId);
                  setMenuOpen(false);
                }}
              >
                <Icon name="copy" size={14} />
                复制当前图层
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="layer-merge"
                onClick={() => {
                  mergeLayerDown(doc.activeLayerId);
                  setMenuOpen(false);
                }}
              >
                <Icon name="merge" size={14} />
                向下合并
              </button>
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                data-testid="layer-delete"
                disabled={doc.layers.length <= 1}
                onClick={() => {
                  deleteLayer(doc.activeLayerId);
                  setMenuOpen(false);
                }}
              >
                <Icon name="trash" size={14} />
                删除当前图层
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div
        className="layer-list"
        title="图层列表\n点击切换当前图层；拖动调整顺序，列表越靠上覆盖越靠下。"
      >
        {roots.map((layer) => renderLayer(layer, 0))}
      </div>

      <div
        className={`layer-row layer-row--background${
          doc.page.backgroundVisible === false ? ' is-hidden' : ''
        }`}
        data-testid="background-layer"
        title="背景图层\n页面背景，不参与对象选择；点击眼睛显示/隐藏，点击色块修改颜色。"
      >
        <span className="layer-row__chevron layer-row__chevron--empty" />
        <span
          className="layer-row__thumb layer-row__thumb--background"
          style={{ background: doc.page.background }}
          aria-hidden="true"
        />
        <span className="layer-row__body">
          <span className="layer-row__name">背景</span>
        </span>
        <span className="layer-tools">
          <button
            type="button"
            className="layer-row__toggle"
            data-testid="background-eye"
            aria-label={doc.page.backgroundVisible === false ? '显示背景' : '隐藏背景'}
            title={`背景图层\n${doc.page.backgroundVisible === false ? '点击显示页面背景' : '点击隐藏页面背景'}`}
            onClick={() =>
              setPageBackgroundVisible(doc.page.backgroundVisible === false)
            }
          >
            <Icon
              name={doc.page.backgroundVisible === false ? 'eyeOff' : 'eye'}
              size={15}
            />
          </button>
          <label className="layer-bg-color" title="背景颜色\n点击色块修改页面背景色">
            <span style={{ background: doc.page.background }} />
            <input
              type="color"
              value={doc.page.background}
              onChange={(event) => setPageBackground(event.target.value.toUpperCase())}
            />
          </label>
        </span>
      </div>

      <div className="panel-subhead panel-subhead--objects">
        <span>对象 · {objectScope === 'all' ? '所有图层' : activeLayer?.name ?? ''}</span>
        <span className="panel-subhead__right">
          <div
            className="object-scope-filter"
            role="group"
            aria-label="对象筛选范围"
            title="对象筛选\n切换查看当前图层或所有图层中的对象"
          >
            {(
              [
                ['current', '当前图层'],
                ['all', '所有图层']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={objectScope === value ? 'is-active' : ''}
                data-testid={`object-scope-${value}`}
                aria-pressed={objectScope === value}
                onClick={() => setObjectScope(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {objectScope === 'current' && activeLayer?.kind === 'folder'
            ? `${folderChildren} 个子图层`
            : objectScope === 'current'
              ? currentObjects.length
              : `${allObjects.length} 个`}
          {objectScope === 'current' ? (
            <button
              type="button"
              className={`object-collapse${objectsCollapsed ? ' is-collapsed' : ''}`}
              data-testid="objects-collapse"
              title={objectsCollapsed ? '展开对象列表' : '折叠对象列表'}
              onClick={() => activeLayer && toggleCollapsed(activeLayer.id)}
            >
              <Icon name="chevronDown" size={12} />
            </button>
          ) : null}
        </span>
      </div>

      {objectsCollapsed ? (
        <div className="objects-empty objects-empty--collapsed" data-testid="objects-collapsed">
          <span className="objects-empty__icon">
            <Icon name="layers" size={18} />
          </span>
          <p>对象列表已折叠</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => activeLayer && toggleCollapsed(activeLayer.id)}
          >
            展开对象
          </button>
        </div>
      ) : objectScope === 'current' && activeLayer?.kind === 'folder' ? (
        <div className="objects-empty" title="文件夹是一个容器\n把其他图层拖到这里即可归类；绘制时会使用其中的子图层">
          <span className="objects-empty__icon">
            <Icon name="folder" size={18} />
          </span>
          <p>空文件夹</p>
        </div>
      ) : objects.length === 0 ? (
        <div className="objects-empty" title="对象列表\n当前筛选条件下没有对象">
          <span className="objects-empty__icon">
            <Icon name="molecule" size={18} />
          </span>
          <p>没有对象</p>
        </div>
      ) : (
        <div
          className="object-list"
          title="对象列表\n拖动对象可调整层级；列表越靠上覆盖越靠下。右键对象可复制或删除。"
        >
          {objectScope === 'current'
            ? currentObjects
                .filter((object) => !object.parentId)
                .slice()
                .reverse()
                .map((object) => renderObject(object))
            : allObjects.map(({ object, layerName }) => renderObject(object, 0, layerName))}
        </div>
      )}

      <div className="panel-section panel-section--tight">
        <div className="info-rows">
          <div>
            <span>页面</span>
            <strong>{template?.name ?? '自定义'}</strong>
          </div>
          <div>
            <span>尺寸</span>
            <strong>
              {doc.page.width} × {doc.page.height} px
            </strong>
          </div>
          <div>
            <span>网格</span>
            <strong>
              {doc.grid.size}px · {showGrid ? '显示' : '隐藏'}
            </strong>
          </div>
          <div>
            <span>吸附</span>
            <strong>{snapEnabled ? '开启' : '关闭'}</strong>
          </div>
        </div>
      </div>

      {objectMenu ? (
        <div
          className="object-context-menu"
          data-object-menu
          role="menu"
          data-testid="object-context-menu"
          style={{
            left: Math.min(objectMenu.x, window.innerWidth - 176),
            top: Math.min(objectMenu.y, window.innerHeight - 108)
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="object-menu-duplicate"
            onClick={() => {
              duplicateObject(objectMenu.id);
              setObjectMenu(null);
            }}
          >
            <Icon name="copy" size={14} />
            复制对象
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            data-testid="object-menu-delete"
            onClick={() => {
              deleteObject(objectMenu.id);
              setObjectMenu(null);
            }}
          >
            <Icon name="trash" size={14} />
            删除对象
          </button>
        </div>
      ) : null}
    </div>
  );
}
