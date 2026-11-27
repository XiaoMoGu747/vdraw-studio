import { useEffect, useState } from 'react';
import { ATOM_PRESETS, BOND_PRESETS } from '../../core/chemistry/presets';
import { applyBenzeneStyle, isBenzeneGroup } from '../../core/chemistry/benzene';
import { validateBondUpgrade } from '../../core/chemistry/chain';
import { ATOM_FONT_SIZE } from '../../core/chemistry/labels';
import {
  allObjects,
  expandSelection,
  getLayerOfObject,
  getObject,
  replaceObject,
  rotateDocumentObjects,
  frameLocalToWorld,
  scaleDocumentObjectsInFrame,
  selectionFrame,
  translateDocumentObjects
} from '../../core/scene';
import type {
  AtomLabelData,
  SceneObject,
  StrokeCap,
  StrokeDashPreset,
  StrokeJoin,
  TextObject
} from '../../types/document';
import { dashArrayFor, useAppStore } from '../../store/useAppStore';
import { patchTextObject } from '../../core/textLayout';
import { Icon } from '../ui/Icon';
import { Section } from '../ui/Section';
import { NumberField, Stepper, TextDraft } from './PropertyFields';

const ALIGN_ACTIONS = [
  { mode: 'left', icon: 'alignLeft', label: '左对齐' },
  { mode: 'center-h', icon: 'alignCenterH', label: '水平居中' },
  { mode: 'right', icon: 'alignRight', label: '右对齐' },
  { mode: 'top', icon: 'alignTop', label: '顶对齐' },
  { mode: 'center-v', icon: 'alignCenterV', label: '垂直居中' },
  { mode: 'bottom', icon: 'alignBottom', label: '底对齐' }
] as const;

interface ObjectPropertiesPanelProps {
  /** 属性区局部收起：只隐藏属性字段，表头保留展开入口，面板宽度不变。 */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function ObjectPropertiesPanel({
  collapsed,
  onToggleCollapsed
}: ObjectPropertiesPanelProps) {
  const doc = useAppStore((state) => state.doc);
  const selection = useAppStore((state) => state.selection);
  const updateDoc = useAppStore((state) => state.updateDoc);
  const alignSelection = useAppStore((state) => state.alignSelection);
  const distributeSelection = useAppStore((state) => state.distributeSelection);
  const groupSelection = useAppStore((state) => state.groupSelection);
  const ungroupSelection = useAppStore((state) => state.ungroupSelection);
  const deleteSelection = useAppStore((state) => state.deleteSelection);
  const reorderSelection = useAppStore((state) => state.reorderSelection);
  const notify = useAppStore((state) => state.notify);
  const rotateSelectionBy = useAppStore((state) => state.rotateSelectionBy);
  const flipSelection = useAppStore((state) => state.flipSelection);
  const toggleObjectLock = useAppStore((state) => state.toggleObjectLock);
  const convertSelectionToPath = useAppStore((state) => state.convertSelectionToPath);
  const strokeDash = useAppStore((state) => state.strokeDash);
  const setStrokeDash = useAppStore((state) => state.setStrokeDash);
  const strokeCap = useAppStore((state) => state.strokeCap);
  const setStrokeCap = useAppStore((state) => state.setStrokeCap);
  const strokeJoin = useAppStore((state) => state.strokeJoin);
  const setStrokeJoin = useAppStore((state) => state.setStrokeJoin);
  const beginTransaction = useAppStore((state) => state.beginTransaction);
  const endTransaction = useAppStore((state) => state.endTransaction);

  const selectedObjects = selection
    .map((id) => getObject(doc, id))
    .filter((obj): obj is SceneObject => Boolean(obj));
  const primary = selectedObjects[0] ?? null;
  const allSelectedLocked =
    selectedObjects.length > 0 && selectedObjects.every((obj) => obj.locked);
  const mixedObjectTypes =
    selectedObjects.length > 1 &&
    new Set(selectedObjects.map((obj) => obj.type)).size > 1;
  const objectTypeLabel = primary
    ? mixedObjectTypes
      ? '多个对象'
      : primary.type === 'group'
        ? isBenzeneGroup(primary)
          ? '苯环'
          : '编组'
        : primary.name
    : '未选择对象';
  // 锁定是保护而不是装饰：属性面板的所有写操作都先经过这道闸，避免“锁了还能改”。
  const affectedIds = new Set(expandSelection(doc, selection));
  const lockedSelectedCount = allObjects(doc).filter(
    (obj) => affectedIds.has(obj.id) && (obj.locked || Boolean(getLayerOfObject(doc, obj.id)?.locked))
  ).length;
  const guardUnlocked = () => {
    if (lockedSelectedCount === 0) return true;
    notify(
      `选中对象中有 ${lockedSelectedCount} 个已锁定（或所在图层已锁定），请先在图层列表解锁再编辑`,
      'warn'
    );
    return false;
  };
  const runUnlocked = (action: () => void) => {
    if (guardUnlocked()) action();
  };
  // 变换区与画布选框必须用同一个局部盒：单对象取“未旋转盒 + 旋转角”，多选取轴对齐包围盒。
  // 用 selectionBounds（旋转后的包围盒）会让旋转 30° 的矩形在面板里显示成 404×360，
  // 而改宽高又按本地盒缩放，读数与结果对不上。
  const transformFrame = selectionFrame(doc, selection);
  const bounds = transformFrame?.bounds ?? null;
  const selectedTexts = selectedObjects.filter(
    (obj): obj is TextObject => obj.type === 'text'
  );
  /** 多选时只在所有值一致时返回该值，用于显示混合值。 */
  const shared = <T,>(values: T[]): T | undefined =>
    values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
  const textFontSize = shared(selectedTexts.map((item) => item.fontSize));
  const textAlign = shared(selectedTexts.map((item) => item.align));
  const textItalic = shared(selectedTexts.map((item) => Boolean(item.italic)));
  const textDirection = shared(selectedTexts.map((item) => item.direction ?? 'horizontal'));
  const textWeight = shared(selectedTexts.map((item) => item.fontWeight));
  const bondTypeShared = shared(
    selectedObjects.filter((obj) => obj.type === 'bond').map((obj) => (obj.type === 'bond' ? obj.bondType : ''))
  );
  const arrowKindShared = shared(
    selectedObjects.filter((obj) => obj.type === 'arrow').map((obj) => (obj.type === 'arrow' ? obj.arrowKind : ''))
  );

  /** 所有文本改动都走同一个排版函数，保证包围盒与渲染一致。 */
  const applyTextPatch = (patch: Parameters<typeof patchTextObject>[1]) => {
    const state = useAppStore.getState();
    const ids = new Set(expandSelection(state.doc, state.selection));
    let next = state.doc;
    let blocked = false;
    for (const obj of allObjects(state.doc)) {
      if (obj.type !== 'text' || !ids.has(obj.id)) continue;
      if (obj.locked || getLayerOfObject(state.doc, obj.id)?.locked) {
        blocked = true;
        continue;
      }
      next = replaceObject(next, obj.id, (item) =>
        item.type === 'text' ? patchTextObject(item, patch) : item
      );
    }
    if (next !== state.doc) updateDoc(next, true);
    if (blocked) notify('部分文本所在图层已锁定，未修改', 'warn');
  };

  /** 描边样式：有选中对象时改选中，否则只改默认样式（影响后续新图形）。 */
  const applyStrokePattern = (preset: StrokeDashPreset) => {
    setStrokeDash(preset);
    if (selection.length > 0) {
      // 虚线密度跟随每个对象自己的线宽，粗线不会看起来像实线。
      mutateSelection((obj) => ({
        ...obj,
        style: {
          ...obj.style,
          stroke: { ...obj.style.stroke, dash: dashArrayFor(preset, obj.style.stroke.width) }
        }
      }));
    }
  };
  const applyStrokeCap = (cap: StrokeCap) => {
    setStrokeCap(cap);
    if (selection.length > 0) {
      mutateSelection((obj) => ({
        ...obj,
        style: { ...obj.style, stroke: { ...obj.style.stroke, cap } }
      }));
    }
  };
  const applyStrokeJoin = (join: StrokeJoin) => {
    setStrokeJoin(join);
    if (selection.length > 0) {
      mutateSelection((obj) => ({
        ...obj,
        style: { ...obj.style, stroke: { ...obj.style.stroke, join } }
      }));
    }
  };

  /** 从对象实际 dash 反推预设，避免面板显示"实线"而对象是虚线。 */
  const dashPresetOf = (dash: number[], width: number): StrokeDashPreset => {
    if (dash.length === 0) return 'solid';
    if (dash.length >= 4) return 'dashdot';
    if (dash[0] <= Math.max(1, width) * 1.6) return 'dotted';
    return 'dashed';
  };
  const styleSourceObject = selectedObjects.find((obj) => obj.type !== 'atom' && obj.type !== 'bond');
  const currentDash = styleSourceObject
    ? dashPresetOf(
        styleSourceObject.style.stroke.dash,
        styleSourceObject.style.stroke.width
      )
    : strokeDash;
  const currentCap = styleSourceObject?.style.stroke.cap ?? strokeCap;
  const currentJoin = styleSourceObject?.style.stroke.join ?? strokeJoin;
  const hasVectorStyleTarget = selectedObjects.some(
    (obj) =>
      obj.type === 'rect' ||
      obj.type === 'ellipse' ||
      obj.type === 'line' ||
      obj.type === 'polygon' ||
      obj.type === 'path' ||
      obj.type === 'text' ||
      obj.type === 'group' ||
      obj.type === 'arrow'
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [scaleUniform, setScaleUniform] = useState(true);

  useEffect(() => {
    setMenuOpen(false);
  }, [primary?.id, selection.length]);

  // 原子元素 / 同位素是逐字符写入并包在事务里；切换选择或卸载时必须收尾，避免 pendingSnapshot 泄漏。
  useEffect(
    () => () => {
      endTransaction();
    },
    [primary?.id, collapsed, endTransaction]
  );

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-props-menu]')) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  const collapseButton = (
    <button
      type="button"
      className={`icon-btn icon-btn--sm props-inline__collapse${collapsed ? ' is-collapsed' : ''}`}
      data-testid="properties-section-collapse"
      title={
        collapsed
          ? '局部展开属性区（恢复全部属性字段）'
          : '局部收起属性区（只隐藏属性字段，面板宽度不变）'
      }
      aria-label={collapsed ? '局部展开属性区' : '局部收起属性区'}
      aria-expanded={!collapsed}
      onClick={() => {
        setMenuOpen(false);
        onToggleCollapsed();
      }}
    >
      <Icon name="chevronDown" size={14} className={collapsed ? 'rotate-180' : undefined} />
    </button>
  );

  // 常驻 Inspector：不拦截 Esc，Esc 始终交还给画布（取消操作 / 清空选择 / 退出工具）。
  if (!primary) {
    return (
      <section
        className={`props-inline props-inline--empty${collapsed ? ' is-collapsed' : ''}`}
        data-testid="object-properties-empty"
        data-collapsed={collapsed ? 'true' : 'false'}
      >
        <header className="props-inline__head">
          <span className="props-inline__type">未选择对象</span>
          <div className="props-inline__actions">{collapseButton}</div>
        </header>
        {!collapsed ? (
          <div className="props-inline__body props-inline__body--empty">
            <div className="props-empty">
              <Icon name="properties" size={20} />
              <p>未选择对象</p>
              <span>在画布或图层列表中选择对象后，这里会显示几何、文本与化学属性。</span>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  const mutateSelection = (updater: (obj: SceneObject) => SceneObject) => {
    if (!guardUnlocked()) return;
    const state = useAppStore.getState();
    const ids = new Set(expandSelection(state.doc, state.selection));
    let next = state.doc;
    for (const obj of allObjects(state.doc)) {
      if (!ids.has(obj.id)) continue;
      next = replaceObject(next, obj.id, updater);
    }
    updateDoc(next, true);
  };

  const transform = (fn: (state: ReturnType<typeof useAppStore.getState>) => void) => fn(useAppStore.getState());

  const setX = (value: number) => {
    if (!bounds || !guardUnlocked()) return;
    transform((state) =>
      updateDoc(
        translateDocumentObjects(state.doc, state.selection, value - Math.round(bounds.x * 10) / 10, 0),
        true
      )
    );
  };

  const setY = (value: number) => {
    if (!bounds || !guardUnlocked()) return;
    transform((state) =>
      updateDoc(
        translateDocumentObjects(state.doc, state.selection, 0, value - Math.round(bounds.y * 10) / 10),
        true
      )
    );
  };

  const setW = (value: number) => {
    if (!guardUnlocked()) return;
    const state = useAppStore.getState();
    const frame = selectionFrame(state.doc, state.selection);
    if (!frame || frame.bounds.width < 0.01) return;
    const next = Math.max(1, value);
    updateDoc(
      scaleDocumentObjectsInFrame(
        state.doc,
        state.selection,
        frame,
        frameLocalToWorld(frame, { x: frame.bounds.x, y: frame.bounds.y }),
        next / frame.bounds.width,
        1
      ),
      true
    );
  };

  const setH = (value: number) => {
    if (!guardUnlocked()) return;
    const state = useAppStore.getState();
    const frame = selectionFrame(state.doc, state.selection);
    if (!frame || frame.bounds.height < 0.01) return;
    const next = Math.max(1, value);
    updateDoc(
      scaleDocumentObjectsInFrame(
        state.doc,
        state.selection,
        frame,
        frameLocalToWorld(frame, { x: frame.bounds.x, y: frame.bounds.y }),
        1,
        next / frame.bounds.height
      ),
      true
    );
  };

  /** 缩放基准：位图用原始像素，其余对象用首次进入缩放面板时的显示尺寸。 */
  const scaleBaseOf = (object: SceneObject, frameWidth: number, frameHeight: number) => {
    if (object.type === 'image') {
      return {
        width: Math.max(1, object.naturalWidth || frameWidth),
        height: Math.max(1, object.naturalHeight || frameHeight)
      };
    }
    return {
      width:
        typeof object.baseWidth === 'number' && Number.isFinite(object.baseWidth) && object.baseWidth > 0
          ? object.baseWidth
          : Math.max(1, frameWidth),
      height:
        typeof object.baseHeight === 'number' &&
        Number.isFinite(object.baseHeight) &&
        object.baseHeight > 0
          ? object.baseHeight
          : Math.max(1, frameHeight)
    };
  };

  const scaleFrame = selection.length === 1 ? transformFrame : null;
  const scaleBase =
    primary && scaleFrame
      ? scaleBaseOf(primary, scaleFrame.bounds.width, scaleFrame.bounds.height)
      : null;
  const scaleX =
    scaleFrame && scaleBase
      ? (scaleFrame.bounds.width / scaleBase.width) * 100
      : 100;
  const scaleY =
    scaleFrame && scaleBase
      ? (scaleFrame.bounds.height / scaleBase.height) * 100
      : 100;

  /** 参照 Godot 的节点 scale：按百分比换算成选框缩放，并保留首次的基准尺寸。 */
  const applyScaleTargets = (targetXPercent: number, targetYPercent: number) => {
    if (!guardUnlocked()) return;
    const state = useAppStore.getState();
    if (state.selection.length !== 1) return;
    const frame = selectionFrame(state.doc, state.selection);
    const object = getObject(state.doc, state.selection[0]);
    if (!frame || !object || frame.bounds.width < 0.01 || frame.bounds.height < 0.01) return;
    const base = scaleBaseOf(object, frame.bounds.width, frame.bounds.height);
    const percentX = Math.min(1000, Math.max(1, targetXPercent));
    const percentY = Math.min(1000, Math.max(1, targetYPercent));
    const sx = (base.width * (percentX / 100)) / frame.bounds.width;
    const sy = (base.height * (percentY / 100)) / frame.bounds.height;
    if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6) return;
    let next = scaleDocumentObjectsInFrame(
      state.doc,
      state.selection,
      frame,
      frame.center,
      sx,
      sy
    );
    next = replaceObject(next, object.id, (item) => ({
      ...item,
      baseWidth: base.width,
      baseHeight: base.height
    }));
    state.updateDoc(next, true);
  };

  const commitScaleX = (value: number) => {
    if (!Number.isFinite(value)) return;
    if (scaleUniform && scaleX > 0.01) {
      const factor = value / scaleX;
      applyScaleTargets(value, scaleY * factor);
    } else {
      applyScaleTargets(value, scaleY);
    }
  };

  const commitScaleY = (value: number) => {
    if (!Number.isFinite(value)) return;
    if (scaleUniform && scaleY > 0.01) {
      const factor = value / scaleY;
      applyScaleTargets(scaleX * factor, value);
    } else {
      applyScaleTargets(scaleX, value);
    }
  };

  const resetScale = () => applyScaleTargets(100, 100);

  // 只有自带 rotation 字段的单个图形能显示绝对角度；编组/多选的实际旋转发生在子对象上，
  // 若仍用 primary.rotation 作基准，重复输入会不断累加。
  const absoluteRotation =
    selection.length === 1 &&
    (primary.type === 'rect' ||
      primary.type === 'ellipse' ||
      primary.type === 'text' ||
      primary.type === 'image');
  const primaryRotation = absoluteRotation ? primary.rotation ?? 0 : 0;
  const rotateSelection = (value: number) => {
    if (!guardUnlocked()) return;
    const state = useAppStore.getState();
    const frame = selectionFrame(state.doc, state.selection);
    if (!frame) return;
    updateDoc(
      rotateDocumentObjects(state.doc, state.selection, frame.center, value - primaryRotation),
      true
    );
  };

  const updateAtom = (
    patch: Partial<AtomLabelData>,
    atomPatch?: { explicitH?: number | null }
  ) => {
    mutateSelection((obj) =>
      obj.type === 'atom'
        ? { ...obj, ...atomPatch, label: { ...obj.label, ...patch } }
        : obj
    );
  };

  const setText = (value: string) => {
    if (primary.type !== 'text') return;
    applyTextPatch({ text: value });
  };

  return (
    <section
      className={`props-inline${collapsed ? ' is-collapsed' : ''}`}
      data-testid="object-properties"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <header className="props-inline__head">
        <span className="props-inline__type" title={objectTypeLabel}>
          {objectTypeLabel}
          {selection.length > 1 ? <em>共 {selection.length} 个</em> : null}
        </span>
        <div className="props-inline__actions">
          <div className="props-inline__menu-anchor" data-props-menu>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              title="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid="properties-menu"
              onClick={() => setMenuOpen((value) => !value)}
            >
              <span className="props-inline__more" aria-hidden="true">
                ⋯
              </span>
            </button>
            {menuOpen ? (
              <div className="props-inline__menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (!guardUnlocked()) return;
                    setMenuOpen(false);
                    deleteSelection();
                  }}
                >
                  <Icon name="trash" size={13} />
                  删除对象
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    useAppStore.getState().clearSelection();
                  }}
                >
                  <Icon name="close" size={13} />
                  取消选择
                </button>
              </div>
            ) : null}
          </div>
          {collapseButton}
        </div>
      </header>
      {!collapsed && lockedSelectedCount > 0 ? (
        <div className="props-lock-note" data-testid="properties-locked-note">
          <Icon name="lock" size={13} />
          <span>选中对象已锁定（或所在图层已锁定），解锁后才能修改属性。</span>
        </div>
      ) : null}
      {!collapsed ? (
      <div className="props-inline__body">
        <div className="object-props">
        <Section title="对齐与分布">
          <div
            className="align-grid"
            title="单个对象对齐到页面，多个对象对齐到选择区域"
            aria-label="单个对象对齐到页面，多个对象对齐到选择区域"
          >
            {ALIGN_ACTIONS.map((action) => (
              <button
                key={action.mode}
                type="button"
                className="icon-btn"
                title={action.label}
                disabled={selection.length === 0}
                onClick={() => runUnlocked(() => alignSelection(action.mode))}
              >
                <Icon name={action.icon} size={17} />
              </button>
            ))}
            <button
              type="button"
              className="icon-btn"
              title="水平分布"
              disabled={selection.length < 3}
              onClick={() => runUnlocked(() => distributeSelection('h'))}
            >
              <Icon name="distributeH" size={17} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="垂直分布"
              disabled={selection.length < 3}
              onClick={() => runUnlocked(() => distributeSelection('v'))}
            >
              <Icon name="distributeV" size={17} />
            </button>
          </div>
        </Section>

        <Section title="变换">
          <div className="field-grid field-grid--transform" data-prop-focus="transform">
            <NumberField label="X" value={bounds ? bounds.x : null} onCommit={setX} />
            <NumberField label="Y" value={bounds ? bounds.y : null} onCommit={setY} />
            <NumberField label="宽" value={bounds ? bounds.width : null} onCommit={setW} />
            <NumberField label="高" value={bounds ? bounds.height : null} onCommit={setH} />
            {absoluteRotation ? (
              <NumberField label="旋转" value={primaryRotation} suffix="°" onCommit={rotateSelection} />
            ) : (
              <NumberField
                label="旋转 +"
                value={null}
                suffix="°"
                placeholder="增量"
                commitWhenEmpty
                onCommit={rotateSelectionBy}
              />
            )}
            {primary.type === 'rect' ? (
              <NumberField
                label="圆角"
                value={primary.cornerRadius ?? 0}
                suffix="px"
                onCommit={(value) =>
                  mutateSelection((obj) =>
                    obj.type === 'rect'
                      ? {
                          ...obj,
                          cornerRadius: Math.max(
                            0,
                            Math.min(value, obj.width / 2, obj.height / 2)
                          )
                        }
                      : obj
                  )
                }
              />
            ) : null}
          </div>
          {scaleFrame && scaleBase ? (
            <div className="scale-panel" data-testid="scale-panel">
              <div className="scale-panel__head">
                <span className="scale-panel__title">缩放</span>
                <button
                  type="button"
                  className={`scale-link${scaleUniform ? ' is-active' : ''}`}
                  data-testid="scale-link"
                  aria-pressed={scaleUniform}
                  title={
                    scaleUniform
                      ? '等比缩放：修改 X / Y 任一轴会按同一倍率同步另一轴'
                      : '独立缩放：X / Y 分别调整'
                  }
                  onClick={() => setScaleUniform((value) => !value)}
                >
                  <Icon name={scaleUniform ? 'link' : 'unlink'} size={14} />
                </button>
                <em>{scaleUniform ? '等比' : '独立'}</em>
                <button
                  type="button"
                  className="ghost-action scale-reset"
                  disabled={
                    Math.abs(scaleX - 100) < 0.05 && Math.abs(scaleY - 100) < 0.05
                  }
                  onClick={resetScale}
                >
                  重置
                </button>
              </div>
              <div className="field-grid">
                <NumberField label="X" value={scaleX} suffix="%" onCommit={commitScaleX} />
                <NumberField label="Y" value={scaleY} suffix="%" onCommit={commitScaleY} />
              </div>
            </div>
          ) : null}
          <div className="prop-actions prop-actions--wrap">
            <button type="button" className="ghost-action" disabled={selection.length < 2} onClick={() => runUnlocked(groupSelection)}>
              编组
            </button>
            <button type="button" className="ghost-action" disabled={!selectedObjects.some((obj) => obj.type === 'group')} onClick={() => runUnlocked(ungroupSelection)}>
              解组
            </button>
            <button type="button" className="ghost-action" onClick={() => runUnlocked(() => reorderSelection('front'))}>
              置顶
            </button>
            <button type="button" className="ghost-action" onClick={() => runUnlocked(() => reorderSelection('forward'))}>
              上移一层
            </button>
            <button type="button" className="ghost-action" onClick={() => runUnlocked(() => reorderSelection('backward'))}>
              下移一层
            </button>
            <button type="button" className="ghost-action" onClick={() => runUnlocked(() => reorderSelection('back'))}>
              置底
            </button>
          </div>
          <div className="prop-actions prop-actions--wrap">
            <button type="button" className="ghost-action" title="顺时针旋转 90°" onClick={() => runUnlocked(() => rotateSelectionBy(90))}>
              旋转 +90°
            </button>
            <button type="button" className="ghost-action" title="逆时针旋转 90°" onClick={() => runUnlocked(() => rotateSelectionBy(-90))}>
              旋转 −90°
            </button>
            <button type="button" className="ghost-action" onClick={() => runUnlocked(() => flipSelection('horizontal'))}>
              水平翻转
            </button>
            <button type="button" className="ghost-action" onClick={() => runUnlocked(() => flipSelection('vertical'))}>
              垂直翻转
            </button>
            <button
              type="button"
              className="ghost-action"
              title="把选中的矩形/椭圆/多边形/直线转换为可编辑路径"
              disabled={!selectedObjects.some((obj) => ['rect', 'ellipse', 'polygon', 'line'].includes(obj.type))}
              onClick={() => runUnlocked(convertSelectionToPath)}
            >
              转换为路径
            </button>
            <button type="button" className="ghost-action" onClick={toggleObjectLock}>
              {allSelectedLocked ? '解锁对象' : '锁定对象'}
            </button>
          </div>
        </Section>

        {primary.type === 'image' ? (
          <Section title="位图">
            <div className="field-grid field-grid--prop">
              <div className="field-row">
                <span className="field-row__label">原始尺寸</span>
                <span>
                  {primary.naturalWidth} × {primary.naturalHeight} px
                </span>
              </div>
              <div className="field-row">
                <span className="field-row__label">格式</span>
                <span>{primary.imageFormat ? primary.imageFormat.toUpperCase() : '位图'}</span>
              </div>
              <div className="field-row">
                <span className="field-row__label">显示尺寸</span>
                <span>
                  {Math.round(primary.width)} × {Math.round(primary.height)} px
                </span>
              </div>
            </div>
          </Section>
        ) : null}

        {hasVectorStyleTarget ? (
          <Section title="描边样式">
            <div className="field-grid field-grid--prop">
              <div className="field-row">
                <span className="field-row__label">线型</span>
                <select
                  className="select"
                  data-testid="stroke-dash"
                  value={currentDash}
                  onChange={(event) => applyStrokePattern(event.target.value as StrokeDashPreset)}
                >
                  <option value="solid">实线</option>
                  <option value="dashed">虚线</option>
                  <option value="dotted">点线</option>
                  <option value="dashdot">点划线</option>
                </select>
              </div>
              <div className="field-row">
                <span className="field-row__label">端点</span>
                <select
                  className="select"
                  data-testid="stroke-cap"
                  value={currentCap}
                  onChange={(event) => applyStrokeCap(event.target.value as StrokeCap)}
                >
                  <option value="round">圆头</option>
                  <option value="butt">平头</option>
                  <option value="square">方头</option>
                </select>
              </div>
              <div className="field-row">
                <span className="field-row__label">拐角</span>
                <select
                  className="select"
                  data-testid="stroke-join"
                  value={currentJoin}
                  onChange={(event) => applyStrokeJoin(event.target.value as StrokeJoin)}
                >
                  <option value="round">圆角</option>
                  <option value="miter">尖角</option>
                  <option value="bevel">斜切</option>
                </select>
              </div>
            </div>
          </Section>
        ) : null}

        {primary.type === 'group' && primary.ringStyle ? (
          <Section title="当前所选环的式样">
            <div className="benzene-style-options">
              <button
                type="button"
                className={`benzene-style-option${primary.ringStyle === 'pauling' ? ' is-active' : ''}`}
                onClick={() => updateDoc(applyBenzeneStyle(doc, primary.id, 'pauling'), true)}
              >
                鲍林式
                <em>圆圈</em>
              </button>
              <button
                type="button"
                className={`benzene-style-option${primary.ringStyle === 'kekule' ? ' is-active' : ''}`}
                onClick={() => updateDoc(applyBenzeneStyle(doc, primary.id, 'kekule'), true)}
              >
                凯库勒式
                <em>交替双键</em>
              </button>
            </div>
          </Section>
        ) : null}

        {selectedTexts.length > 0 ? (
          <Section
            title="文本"
            hint={`${selectedTexts.length} 个文本对象${textFontSize === undefined ? ' · 字号不一致' : ''}`}
          >
            {primary.type === 'text' ? (
              <TextDraft value={primary.text} multiline placeholder="输入文本内容" onCommit={setText} />
            ) : null}
            <div className="field-row">
              <span className="field-row__label">字号</span>
              <div className="input-unit input-unit--compact">
                <input
                  className="input"
                  type="number"
                  min={6}
                  max={240}
                  defaultValue={textFontSize === undefined ? '' : Math.round(textFontSize)}
                  placeholder={textFontSize === undefined ? '混合' : undefined}
                  key={`${primary.id}-${textFontSize ?? 'mixed'}`}
                  onBlur={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isFinite(next)) return;
                    applyTextPatch({ fontSize: Math.min(240, Math.max(6, next)) });
                  }}
                />
                <em>px</em>
              </div>
            </div>
            <div className="field-row">
              <span className="field-row__label">对齐</span>
              <select
                className="select"
                value={textAlign ?? ''}
                onChange={(event) =>
                  applyTextPatch({ align: event.target.value as TextObject['align'] })
                }
              >
                {textAlign === undefined ? <option value="">混合</option> : null}
                <option value="left">左对齐</option>
                <option value="center">居中</option>
                <option value="right">右对齐</option>
              </select>
            </div>
            <div className="field-row">
              <span className="field-row__label">字重</span>
              <select
                className="select"
                value={textWeight ?? ''}
                onChange={(event) => applyTextPatch({ fontWeight: Number(event.target.value) })}
              >
                {textWeight === undefined ? <option value="">混合</option> : null}
                <option value={400}>常规</option>
                <option value={600}>半粗</option>
                <option value={700}>粗体</option>
              </select>
            </div>
            <div className="field-row">
              <span className="field-row__label">字形</span>
              <button
                type="button"
                className={`option-tile${textItalic ? ' is-active' : ''}`}
                data-testid="text-italic"
                title="斜体"
                onClick={() => applyTextPatch({ italic: !textItalic })}
              >
                斜体
              </button>
            </div>
            <div className="field-row">
              <span className="field-row__label">字距</span>
              <div className="input-unit input-unit--compact">
                <input
                  className="input"
                  type="number"
                  min={-5}
                  max={50}
                  step={0.5}
                  defaultValue={selectedTexts[0]?.letterSpacing ?? 0}
                  key={`spacing-${primary.id}`}
                  onBlur={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) {
                      applyTextPatch({ letterSpacing: Math.min(50, Math.max(-5, next)) });
                    }
                  }}
                />
                <em>px</em>
              </div>
            </div>
            <div className="field-row">
              <span className="field-row__label">行高</span>
              <input
                className="input input--mini"
                type="number"
                min={0.8}
                max={2.4}
                step={0.05}
                defaultValue={selectedTexts[0]?.lineHeight ?? 1.32}
                key={`line-${primary.id}`}
                onBlur={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) {
                    applyTextPatch({ lineHeight: Math.min(2.4, Math.max(0.8, next)) });
                  }
                }}
              />
            </div>
            <div className="field-row">
              <span className="field-row__label">方向</span>
              <div className="mode-segment">
                {(
                  [
                    ['horizontal', '横排'],
                    ['vertical', '竖排']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={textDirection === value ? 'is-active' : ''}
                    onClick={() => applyTextPatch({ direction: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field-row">
              <span className="field-row__label">颜色</span>
              <input
                type="color"
                className="input-color"
                value={
                  primary.style.fill.type === 'solid' ? primary.style.fill.color : '#1B1B1B'
                }
                onChange={(event) => applyTextPatch({ color: event.target.value.toUpperCase() })}
              />
            </div>
          </Section>
        ) : null}

        {primary.type === 'bond' ? (
          <Section title="化学键">
            <div className="type-chip-grid">
              {BOND_PRESETS.map((preset) => (
                <button
                  key={preset.type}
                  type="button"
                  className={`type-chip${bondTypeShared === preset.type ? ' is-active' : ''}`}
                  onClick={() => {
                    if (primary.type !== 'bond') return;
                    const validation = validateBondUpgrade(doc, primary, preset.type);
                    if (!validation.ok) {
                      notify(validation.reason ?? '该键不能切换为多重键', 'warn');
                      return;
                    }
                    mutateSelection((obj) =>
                      obj.type === 'bond' ? { ...obj, bondType: preset.type } : obj
                    );
                  }}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </Section>
        ) : null}

        {primary.type === 'atom' ? (
          <Section title="原子标签">
            <div className="field-row">
              <span className="field-row__label">元素</span>
              <input
                className="input input--mini"
                data-prop-focus="atom-element"
                value={primary.label.element}
                onFocus={beginTransaction}
                onBlur={endTransaction}
                onChange={(event) => {
                  const value = event.target.value.slice(0, 2);
                  updateAtom({ element: value ? value[0].toUpperCase() + value.slice(1) : 'C' });
                }}
              />
            </div>
            <div className="field-row">
              <span className="field-row__label">基团标签</span>
              <TextDraft
                value={primary.label.group ?? ''}
                placeholder={ATOM_PRESETS.find((item) => item.element === primary.label.element)?.display ?? '无'}
                onCommit={(value) => updateAtom({ group: value.trim() || null })}
              />
            </div>
            <div className="field-row">
              <span className="field-row__label">元素大小</span>
              <div className="input-unit input-unit--compact">
                <input
                  className="input"
                  type="number"
                  min={6}
                  max={120}
                  step={1}
                  data-testid="atom-size"
                  defaultValue={Math.round(primary.label.fontSize ?? ATOM_FONT_SIZE)}
                  key={`atom-size-${primary.id}`}
                  onBlur={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) {
                      updateAtom({ fontSize: Math.max(6, Math.min(120, next)) });
                    }
                  }}
                />
                <em>px</em>
              </div>
            </div>
            <div className="field-row">
              <span className="field-row__label">形式电荷</span>
              <Stepper value={primary.label.charge} min={-3} max={3} onChange={(value) => updateAtom({ charge: value })} />
            </div>
            <div className="field-row">
              <span className="field-row__label">孤对电子</span>
              <Stepper value={primary.label.lonePairs} min={0} max={3} onChange={(value) => updateAtom({ lonePairs: value })} />
            </div>
            <div className="field-row">
              <span className="field-row__label">氢原子数</span>
              <Stepper
                value={primary.label.hydrogens ?? 0}
                min={0}
                max={4}
                onChange={(value) =>
                  // 手填氢数视为"显式固定"，后续结构变更不再自动覆盖；清 0 则恢复自动推导。
                  updateAtom(
                    { hydrogens: value > 0 ? value : null },
                    { explicitH: value > 0 ? value : null }
                  )
                }
              />
            </div>
            <div className="field-row">
              <span className="field-row__label">自由基</span>
              <select
                className="select"
                value={primary.label.radical}
                onChange={(event) => updateAtom({ radical: event.target.value as AtomLabelData['radical'] })}
              >
                <option value="none">无</option>
                <option value="singlet">单线态</option>
                <option value="doublet">双重态</option>
                <option value="triplet">三重态</option>
              </select>
            </div>
            <div className="field-row">
              <span className="field-row__label">同位素</span>
              <div className="input-unit input-unit--compact">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={300}
                  placeholder="质量数"
                  value={primary.label.isotope ?? ''}
                  onFocus={beginTransaction}
                  onBlur={endTransaction}
                  onChange={(event) => {
                    const raw = event.target.value;
                    updateAtom({
                      isotope: raw ? Math.min(300, Math.max(1, Number.parseInt(raw, 10) || 1)) : null
                    });
                  }}
                />
                <em>u</em>
              </div>
            </div>
          </Section>
        ) : null}

        {primary.type === 'arrow' ? (
          <Section title="反应箭头">
            <div className="field-row">
              <span className="field-row__label">类型</span>
              <select
                className="select"
                value={arrowKindShared ?? ''}
                onChange={(event) =>
                  mutateSelection((obj) =>
                    obj.type === 'arrow'
                      ? { ...obj, arrowKind: event.target.value as typeof primary.arrowKind }
                      : obj
                  )
                }
              >
                {arrowKindShared === undefined ? <option value="">混合</option> : null}
                <option value="reaction">反应箭头</option>
                <option value="equilibrium">平衡箭头</option>
                <option value="mechanism">机理箭头</option>
                <option value="retro">逆合成箭头</option>
              </select>
            </div>
            <div className="field-row" data-prop-focus="arrow-label">
              <span className="field-row__label">文字</span>
              <TextDraft
                multiline
                value={primary.label}
                placeholder="如：H₂SO₄, Δ（回车可写第二行条件）"
                onCommit={(value) =>
                  mutateSelection((obj) =>
                    obj.type === 'arrow' ? { ...obj, label: value } : obj
                  )
                }
              />
            </div>
          </Section>
        ) : null}

        </div>
      </div>
      ) : null}
    </section>
  );
}
