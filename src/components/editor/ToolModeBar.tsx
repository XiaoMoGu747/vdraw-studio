import { useEffect, useRef, useState } from 'react';
import type { WheelEvent as ReactWheelEvent } from 'react';
import { ARROW_PRESETS, ATOM_PRESETS, BOND_PRESETS } from '../../core/chemistry/presets';
import { RING_TEMPLATES } from '../../core/chemistry/rings';
import { DEFAULT_FONT_FAMILY, FONT_CHOICES, SHAPE_TOOL_IDS, TOOL_MAP } from '../../core/tools';
import {
  ERASER_TARGET_OPTIONS,
  createEraserTargets,
  isEraserAllTargets,
  isEraserEmptyTargets
} from '../../core/eraser';
import {
  allObjects,
  expandSelection,
  getLayerOfObject,
  getObject,
  replaceObject
} from '../../core/scene';
import { patchTextObject } from '../../core/textLayout';
import { warpSelection } from '../../core/perspectiveWarp';
import {
  CHEM_ATOM_SIZE_DEFAULT,
  CHEM_ATOM_SIZE_RANGE,
  CHEM_BOND_LENGTH_DEFAULT,
  CHEM_BOND_LENGTH_RANGE,
  CHEM_BOND_SPACING_DEFAULT,
  CHEM_BOND_SPACING_RANGE,
  CHEM_BOND_WIDTH_DEFAULT,
  CHEM_BOND_WIDTH_RANGE,
  useAppStore
} from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { RingGlyph } from '../chemistry/RingGlyph';

/** 反应箭头的小型图标。 */
function ArrowGlyph({ kind }: { kind: string }) {
  return (
    <svg className="arrow-mini" width={18} height={12} viewBox="0 0 18 12" aria-hidden="true">
      {kind === 'equilibrium' ? (
        <>
          <path d="M2 4h12M10 1.5L14 4l-4 2.5" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
          <path d="M16 8H4M8 5.5L4 8l4 2.5" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
        </>
      ) : kind === 'retro' ? (
        <>
          <path d="M3 6h9" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
          <path d="M9 3.5L12 6l-3 2.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
          <path d="M15 2.5v7" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
        </>
      ) : kind === 'mechanism' ? (
        <path
          d="M2 9c4.5 0 4-6 8-6h4M11 0.5L14.5 3 11 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
        />
      ) : (
        <>
          <path d="M2 6h12" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
          <path d="M10 2.8L15 6l-5 3.2" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** 二级键型面板使用的小型键型图标。 */
function BondGlyph({ type }: { type: string }) {
  const strokeProps = {
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const
  };
  return (
    <svg className="bond-mini" width={18} height={12} viewBox="0 0 18 12" aria-hidden="true">
      {type === 'single' ? <line x1={2} y1={6} x2={16} y2={6} {...strokeProps} /> : null}
      {type === 'double' ? (
        <>
          <line x1={2} y1={4} x2={16} y2={4} {...strokeProps} />
          <line x1={4} y1={8} x2={14} y2={8} {...strokeProps} />
        </>
      ) : null}
      {type === 'triple' ? (
        <>
          <line x1={2} y1={3} x2={16} y2={3} {...strokeProps} />
          <line x1={2} y1={6} x2={16} y2={6} {...strokeProps} />
          <line x1={2} y1={9} x2={16} y2={9} {...strokeProps} />
        </>
      ) : null}
      {type === 'aromatic' ? (
        <>
          <line x1={2} y1={6} x2={16} y2={6} {...strokeProps} />
          <circle cx={9} cy={6} r={3} fill="none" {...strokeProps} />
        </>
      ) : null}
      {type === 'wedge' ? (
        <polygon points="2,3 16,5 16,7 2,9" fill="currentColor" />
      ) : null}
      {type === 'hashed' ? (
        <>
          <line x1={3} y1={4.5} x2={3} y2={7.5} {...strokeProps} />
          <line x1={6} y1={3.6} x2={6} y2={8.4} {...strokeProps} />
          <line x1={9} y1={2.7} x2={9} y2={9.3} {...strokeProps} />
          <line x1={12} y1={1.8} x2={12} y2={10.2} {...strokeProps} />
          <line x1={15} y1={1} x2={15} y2={11} {...strokeProps} />
        </>
      ) : null}
      {type === 'wavy' ? (
        <path d="M2 8 Q 4 2 6.5 8 T 11 8 T 16 8" fill="none" {...strokeProps} />
      ) : null}
      {type === 'dative' ? (
        <>
          <line x1={2} y1={6} x2={12} y2={6} {...strokeProps} />
          <polyline points="10,3 15,6 10,9" fill="none" {...strokeProps} />
        </>
      ) : null}
    </svg>
  );
}

const GUIDE_MODES = [
  ['none', '无'],
  ['one-point', '一点透视'],
  ['two-point', '两点透视'],
  ['three-point', '三点透视'],
  ['grid', '网格'],
  ['equal', '等大']
] as const;

const CHEM_TOOLS = ['bond', 'atom', 'ring', 'arrow', 'eraser'] as const;
const CHEM_CATEGORIES = [
  ['bond', '化学键', 'bond'],
  ['element', '元素', 'atom'],
  ['group', '官能团', 'molecule'],
  ['ring', '苯环', 'ring'],
  ['arrow', '箭头', 'arrow'],
  ['eraser', '化学橡皮', 'eraser']
] as const;

const CHEM_CATEGORY_HINTS: Record<string, string> = {
  bond: '化学键\n拖拽从原子/键端点延伸，空白处单击或拖拽绘制；可切换键型与固定化学键。',
  element: '元素\n选择元素后点击画布放置原子标签；点击已有原子可重贴标签。',
  group: '官能团\n选择官能团后点击画布放置，可作为取代基挂接到环或碳链。',
  ring: '苯环 / 环系\n选择环模板后点击画布插入；点击已有环碳可挂接新环。',
  arrow: '箭头\n拖拽绘制反应箭头、平衡箭头或机理箭头，文字可在右侧属性编辑。',
  eraser: '化学橡皮\n只擦除化学键、原子标签和环骨架；擦断环键后芳香内圈自动解除。'
};

type FeatureKey = 'symmetry' | 'guides' | 'chem' | 'bucket' | 'shape' | 'text' | 'eraser';

function formatMetric(value: number, decimals: number): string {
  return decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
}

/**
 * 化学参数输入：聚焦即全选，允许清空后重新输入；回车提交并失焦。
 * type=number 仍保留步进箭头，但内部用字符串 draft 承接空值，避免一删就被重置。
 */
function ChemMetricInput({
  testId,
  label,
  title,
  value,
  decimals,
  min,
  max,
  step,
  onCommit
}: {
  testId: string;
  label: string;
  title: string;
  value: number;
  decimals: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(() => formatMetric(value, decimals));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(formatMetric(value, decimals));
  }, [value, decimals]);
  const commit = () => {
    focused.current = false;
    const next = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(next)) {
      setDraft(formatMetric(value, decimals));
      return;
    }
    onCommit(next);
  };
  return (
    <label
      className="mode-field mode-field--num chem-param-field"
      title={title}
    >
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        inputMode="decimal"
        data-testid={testId}
        value={draft}
        onFocus={(event) => {
          focused.current = true;
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        onBlur={commit}
      />
      <em>px</em>
    </label>
  );
}

/** 横栏比可视宽度长时，鼠标滚轮也能横向滑动（不必去拖底部细滚动条）。 */
function scrollDockHorizontally(event: ReactWheelEvent<HTMLDivElement>) {
  // 横栏在画布视口内部：滚轮只用于横向浏览，不能再冒泡成画布缩放。
  event.stopPropagation();
  const el = event.currentTarget;
  if (el.scrollWidth <= el.clientWidth + 1) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  el.scrollLeft += delta;
}

/**
 * 画布内统一操作布局：
 * 右上角“编辑 / 关闭”，画布下方横栏承载具体设置。
 */
export function ToolModeBar() {
  const activeTool = useAppStore((state) => state.activeTool);
  const toolEpoch = useAppStore((state) => state.toolEpoch);
  const toolPanel = useAppStore((state) => state.toolPanel);
  const setTool = useAppStore((state) => state.setTool);
  const setToolPanel = useAppStore((state) => state.setToolPanel);
  const chem = useAppStore((state) => state.chem);
  const setChem = useAppStore((state) => state.setChem);
  const setChemDefaults = useAppStore((state) => state.setChemDefaults);
  // 数值来自「设置 → 化学」，这里只展示，避免二处配置各说各话。
  const bondLength = useAppStore((state) => state.chemBondLength);
  const bondWidth = useAppStore((state) => state.chemBondWidth);
  const bondSpacing = useAppStore((state) => state.chemBondSpacing);
  const atomSize = useAppStore((state) => state.chemAtomSize);
  const setChemBondMetric = useAppStore((state) => state.setChemBondMetric);
  const resetChemBondMetrics = useAppStore((state) => state.resetChemBondMetrics);
  const symmetry = useAppStore((state) => state.symmetry);
  const setSymmetry = useAppStore((state) => state.setSymmetry);
  const setSymmetryAxis = useAppStore((state) => state.setSymmetryAxis);
  const guideMode = useAppStore((state) => state.guideMode);
  const setGuideMode = useAppStore((state) => state.setGuideMode);
  const guideAssist = useAppStore((state) => state.guideAssist);
  const toggleGuideAssist = useAppStore((state) => state.toggleGuideAssist);
  const setGuideSettings = useAppStore((state) => state.setGuideSettings);
  const guideSettings = useAppStore((state) => state.guideSettings);
  const guideDensity = useAppStore((state) => state.guideDensity);
  const setGuideDensity = useAppStore((state) => state.setGuideDensity);
  const guideSpacing = useAppStore((state) => state.guideSpacing);
  const setGuideSpacing = useAppStore((state) => state.setGuideSpacing);
  const bucketMode = useAppStore((state) => state.bucketMode);
  const setBucketMode = useAppStore((state) => state.setBucketMode);
  const bucketGap = useAppStore((state) => state.bucketGap);
  const setBucketGap = useAppStore((state) => state.setBucketGap);
  const bucketExpand = useAppStore((state) => state.bucketExpand);
  const setBucketExpand = useAppStore((state) => state.setBucketExpand);
  const textSettings = useAppStore((state) => state.textSettings);
  const setTextSettings = useAppStore((state) => state.setTextSettings);
  // 文字合成器展开时，格式控件已经在面板里：横栏让位，避免两套控件重复。
  const textComposerOpen = useAppStore((state) => state.textComposerOpen);
  // 选中的单个文本对象：它的格式要直接反映到横栏上，改完立刻回写，
  // 与主流作图软件"选中文本 → 顶部即格式栏"的体验一致。
  const selectedText = useAppStore((state) => {
    if (state.selection.length !== 1) return null;
    const obj = getObject(state.doc, state.selection[0]);
    return obj && obj.type === 'text' ? obj : null;
  });
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const toggleSnap = useAppStore((state) => state.toggleSnap);
  const cornerRadius = useAppStore((state) => state.cornerRadius);
  const setCornerRadius = useAppStore((state) => state.setCornerRadius);
  const polygonSides = useAppStore((state) => state.polygonSides);
  const setPolygonSides = useAppStore((state) => state.setPolygonSides);
  const polygonStar = useAppStore((state) => state.polygonStar);
  const setPolygonStar = useAppStore((state) => state.setPolygonStar);
  const shapeFromCenter = useAppStore((state) => state.shapeFromCenter);
  const toggleShapeFromCenter = useAppStore((state) => state.toggleShapeFromCenter);
  const lineArrowEnd = useAppStore((state) => state.lineArrowEnd);
  const setLineArrowEnd = useAppStore((state) => state.setLineArrowEnd);
  const eraserTargets = useAppStore((state) => state.eraserTargets);
  const setEraserTargets = useAppStore((state) => state.setEraserTargets);
  const toggleEraserTarget = useAppStore((state) => state.toggleEraserTarget);

  const [editing, setEditing] = useState<Record<FeatureKey, boolean>>({
    symmetry: true,
    guides: true,
    chem: true,
    bucket: true,
    shape: true,
    text: true,
    eraser: true
  });
  const [openChemPanels, setOpenChemPanels] = useState<string[]>([]);
  const [guideMore, setGuideMore] = useState(false);
  // 字体输入框用本地草稿：允许输入任意字体名，不必被固定选项限制。
  const [fontDraft, setFontDraft] = useState(textSettings.fontFamily);

  const isChem = (CHEM_TOOLS as readonly string[]).includes(activeTool);
  const isShape = (SHAPE_TOOL_IDS as readonly string[]).includes(activeTool);
  const isBucket = activeTool === 'bucket';
  const isText = activeTool === 'text';
  const isEraserLive = activeTool === 'eraser-live';
  // 工具组刚展开时 activeTool 仍为选择工具，具体子工具尚未选中
  const chemVisible = toolPanel === 'chem' || isChem;
  const shapeVisible = toolPanel === 'shape' || isShape;

  useEffect(() => {
    // 每次点击工具都重新展开对应的横栏（包括此前用“完成”收起的情况）
    const reopened: Partial<Record<FeatureKey, boolean>> = {};
    if (activeTool === 'symmetry') reopened.symmetry = true;
    if (activeTool === 'guides') reopened.guides = true;
    if (chemVisible) reopened.chem = true;
    if (shapeVisible) reopened.shape = true;
    if (activeTool === 'bucket') reopened.bucket = true;
    if (activeTool === 'text') reopened.text = true;
    if (isEraserLive) reopened.eraser = true;
    if (Object.keys(reopened).length > 0) {
      setEditing((value) => ({ ...value, ...reopened }));
    }
  }, [activeTool, toolEpoch, toolPanel, chemVisible, shapeVisible, isEraserLive]);

  // 选中文本时自动展开格式栏（此前用"完成"收起过也不影响手动再收起一次）。
  const selectedTextId = selectedText?.id ?? null;
  useEffect(() => {
    if (!selectedTextId) return;
    setEditing((value) => (value.text ? value : { ...value, text: true }));
  }, [selectedTextId]);

  // 横栏显示选中文本的真实格式：换选另一个文本时不会沿用上一段文本的字号/颜色。
  useEffect(() => {
    if (!selectedText) return;
    const color =
      selectedText.style.fill.type === 'solid'
        ? selectedText.style.fill.color
        : textSettings.color;
    const next = {
      fontFamily: selectedText.fontFamily,
      fontSize: selectedText.fontSize,
      fontWeight: selectedText.fontWeight,
      italic: Boolean(selectedText.italic),
      align: selectedText.align,
      letterSpacing: selectedText.letterSpacing ?? 0,
      lineHeight: selectedText.lineHeight ?? 1.32,
      direction: selectedText.direction ?? 'horizontal',
      maxWidth: selectedText.maxWidth ?? 0,
      color
    };
    const same = (Object.keys(next) as (keyof typeof next)[]).every(
      (key) => textSettings[key] === next[key]
    );
    if (!same) setTextSettings(next);
    // 依赖具体字段而不是 selectedText 引用：拖动画布时引用会变，但格式没变不该重设。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedText?.id,
    selectedText?.fontSize,
    selectedText?.fontFamily,
    selectedText?.fontWeight,
    selectedText?.italic,
    selectedText?.align,
    selectedText?.letterSpacing,
    selectedText?.lineHeight,
    selectedText?.direction,
    selectedText?.maxWidth,
    selectedText?.style.fill
  ]);

  const showSymmetry = symmetry !== 'none';
  const showGuides = guideMode !== 'none';
  const guideValue: string = guideMode;
  if (
    !showSymmetry &&
    !showGuides &&
    !chemVisible &&
    !shapeVisible &&
    !isBucket &&
    !isText &&
    !isEraserLive &&
    !selectedText
  ) {
    return null;
  }

  const setFeature = (key: FeatureKey, value: boolean) =>
    setEditing((current) => ({ ...current, [key]: value }));

  const closeToSelect = () => setTool('select');

  // 选中单个文本时也显示文本格式栏：格式项就在手边，不必先切回文字工具。
  const textDockWanted = isText || Boolean(selectedText);

  // 同一时间只显示一组上下文选项：工具 > 对称 > 辅助线，避免底部堆叠多条。
  const showChem = chemVisible && editing.chem;
  const showBucket = !showChem && isBucket && editing.bucket;
  const showEraser = !showChem && !showBucket && isEraserLive && editing.eraser;
  const showShape = !showChem && !showBucket && !showEraser && shapeVisible && editing.shape;
  const showText =
    !showChem &&
    !showBucket &&
    !showEraser &&
    !showShape &&
    textDockWanted &&
    editing.text &&
    !textComposerOpen;
  // 对称 / 辅助线互斥显示；当前选中的是哪一个工具，哪一个优先。
  const modeSlotFree = !showChem && !showBucket && !showEraser && !showShape && !showText;
  const guideToolActive = activeTool === 'guides' && showGuides;
  const showSym = modeSlotFree && showSymmetry && editing.symmetry && !guideToolActive;
  const showGuide = modeSlotFree && showGuides && editing.guides && !showSym;
  // “全部擦除”是派生态：三项全选即亮起；点它时全选/全不选一步到位。
  const eraserAllActive = isEraserAllTargets(eraserTargets);
  const eraserNoneActive = isEraserEmptyTargets(eraserTargets);

  // 用"完成"收起横栏后，工具仍然激活：留一个 chip 让人能把它叫回来。
  const collapsedChip: { feature: FeatureKey; label: string } | null = (() => {
    if (chemVisible && !showChem) return { feature: 'chem', label: '化学工具' };
    if (!showChem && isBucket && !showBucket) return { feature: 'bucket', label: '油漆桶' };
    if (!showChem && !isBucket && isEraserLive && !showEraser) {
      return { feature: 'eraser', label: '橡皮擦' };
    }
    if (!showChem && !isBucket && shapeVisible && !showShape) return { feature: 'shape', label: '形状' };
    if (
      !showChem &&
      !isBucket &&
      !isEraserLive &&
      !shapeVisible &&
      textDockWanted &&
      !showText &&
      !textComposerOpen
    ) {
      return { feature: 'text', label: '文本' };
    }
    if (modeSlotFree && showSymmetry && !showSym && !editing.symmetry) {
      return { feature: 'symmetry', label: '对称' };
    }
    if (modeSlotFree && showGuides && !showGuide && !editing.guides) {
      return { feature: 'guides', label: '辅助线' };
    }
    return null;
  })();

  const toggleChemPanel = (id: string) =>
    setOpenChemPanels((panels) =>
      panels.includes(id) ? panels.filter((item) => item !== id) : [...panels, id]
    );

  const activateChemCategory = (id: string) => {
    if (id === 'bond') setTool('bond');
    else if (id === 'element' || id === 'group') {
      setChem({ atomCategory: id });
      setTool('atom');
    } else if (id === 'ring') setTool('ring');
    else if (id === 'arrow') setTool('arrow');
    else setTool('eraser');
    // 化学橡皮无需二级参数：操作说明放在分类按钮的悬停提示里。
    if (id === 'eraser') {
      setOpenChemPanels([]);
      return;
    }
    // 点击分类展开二级面板；同一时间只保留一个，避免面板叠加遮挡画布。
    setOpenChemPanels([id]);
  };

  const applyTextSetting = (patch: Partial<typeof textSettings>) => {
    setTextSettings(patch);
    // 正在输入的文本框要立刻跟着变：把补丁广播给画布上的编辑器，
    // 否则用户在输入过程中调字体/字号看不到任何变化。
    window.dispatchEvent(new CustomEvent('vdraw:text-style', { detail: patch }));
    const state = useAppStore.getState();
    const ids = new Set(expandSelection(state.doc, state.selection));
    if (ids.size === 0) return;
    let next = state.doc;
    let blocked = false;
    for (const obj of allObjects(state.doc)) {
      if (obj.type !== 'text' || !ids.has(obj.id)) continue;
      if (getLayerOfObject(state.doc, obj.id)?.locked) {
        blocked = true;
        continue;
      }
      next = replaceObject(next, obj.id, (item) =>
        item.type === 'text' ? patchTextObject(item, patch) : item
      );
    }
    if (next !== state.doc) state.updateDoc(next, true);
    if (blocked) state.notify('部分文本所在图层已锁定，未修改', 'warn');
  };

  const chemPanel = (id: string) => {
    const close = (
      <button
        type="button"
        className="chem-subpanel__close"
        data-chem-panel-close={id}
        title="关闭"
        onClick={() => toggleChemPanel(id)}
      >
        <Icon name="close" size={13} />
      </button>
    );
    if (id === 'bond') {
      return (
        <>
          <header className="chem-subpanel__head">{close}</header>
          <div className="chem-subpanel__body chem-subpanel__body--4">
            {BOND_PRESETS.map((preset) => (
              <button
                key={preset.type}
                type="button"
                data-bond={preset.type}
                title={preset.hint}
                className={`mode-dock__item${chem.bondType === preset.type ? ' is-active' : ''}`}
                onClick={() => {
                  setChem({ bondType: preset.type });
                  setTool('bond');
                }}
              >
                <BondGlyph type={preset.type} />
                {preset.name}
              </button>
            ))}
            {/* 键长/键宽/键距统一由一级横栏控制；这里只保留“固定化学键”。 */}
            <span
              className="chem-subpanel__foot"
              role="group"
              aria-label="化学键绘制选项"
            >
              <button
                type="button"
                className={`chem-param${chem.bondFixed ? ' is-active' : ''}`}
                data-testid="bond-fixed"
                aria-pressed={chem.bondFixed}
                title={
                  chem.bondFixed
                    ? `已固定：新键严格使用 ${Math.round(bondLength)}px / ${bondWidth.toFixed(1)}px / ${bondSpacing.toFixed(1)}px，仅方向与摆放可调`
                    : '固定化学键：开启后绘制新键只改变方向与摆放，严格使用键长 / 键宽 / 键距'
                }
                onClick={() => {
                  setChemDefaults({ bondFixed: !chem.bondFixed });
                  setTool('bond');
                }}
              >
                <span className="chem-param__lock" aria-hidden="true">
                  <Icon name={chem.bondFixed ? 'lock' : 'unlock'} size={14} />
                </span>
                <span className="chem-param__name">固定化学键</span>
                <span className="chem-param__hint">
                  {chem.bondFixed ? '仅方向 / 摆放可调' : '长度可随拖拽变化'}
                </span>
              </button>
            </span>
          </div>
        </>
      );
    }
    if (id === 'element' || id === 'group') {
      const presets = ATOM_PRESETS.filter((preset) => preset.kind === id);
      return (
        <>
          <header className="chem-subpanel__head">{close}</header>
          {/* 元素 12 项排 6 列 2 行；官能团 21 项排 7 列 3 行。 */}
          <div
            className={`chem-subpanel__body${
              id === 'element' ? ' chem-subpanel__body--6' : ' chem-subpanel__body--7'
            }`}
            data-testid="atom-preset-grid"
          >
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-atom={preset.id}
                title={preset.hint}
                className={`mode-dock__item${chem.atomPresetId === preset.id ? ' is-active' : ''}`}
                onClick={() => {
                  setChem({ element: preset.element, atomPresetId: preset.id, atomCategory: id });
                  setTool('atom');
                }}
              >
                <Icon name={id === 'element' ? 'atom' : 'molecule'} size={14} />
                {preset.display}
              </button>
            ))}
          </div>
        </>
      );
    }
    if (id === 'ring') {
      return (
        <>
          <header className="chem-subpanel__head">{close}</header>
          <div className="chem-subpanel__body chem-subpanel__body--5">
            {RING_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                data-ring={template.id}
                title={`${template.name} ${template.formula}`}
                className={`mode-dock__item${chem.ringTemplateId === template.id ? ' is-active' : ''}`}
                onClick={() => {
                  setChem({ ringTemplateId: template.id });
                  setTool('ring');
                }}
              >
                <RingGlyph template={template} width={28} height={24} />
                {template.name}
              </button>
            ))}
            {/* 与对象属性里的「当前所选环」区分：这里是新环的默认式样。
                环大小 + 两种式样 + 插入入口统一排在底部一行，不参与模板网格。 */}
            <div className="chem-subpanel__foot">
              <label className="mode-field mode-field--num" title="新环键长缩放，1 为标准 40px">
                <span>环大小</span>
                <input
                  type="number"
                  min={50}
                  max={200}
                  step={10}
                  data-testid="ring-scale"
                  value={Math.round((chem.ringScale ?? 1) * 100)}
                  onChange={(event) =>
                    setChem({
                      ringScale: Math.max(
                        0.5,
                        Math.min(2, (Number(event.target.value) || 100) / 100)
                      )
                    })
                  }
                />
                <em>%</em>
              </label>
              <span className="mode-segment" role="group" aria-label="新环默认式样">
                <button
                  type="button"
                  data-benzene-style="pauling"
                  className={chem.benzeneStyle === 'pauling' ? 'is-active' : ''}
                  title="新环默认：之后插入的苯环使用鲍林式；已画的环请在右侧属性中修改"
                  onClick={() => setChem({ benzeneStyle: 'pauling', ringTemplateId: 'benzene' })}
                >
                  鲍林式
                </button>
                <button
                  type="button"
                  data-benzene-style="kekule"
                  className={chem.benzeneStyle === 'kekule' ? 'is-active' : ''}
                  title="新环默认：之后插入的苯环使用凯库勒式；已画的环请在右侧属性中修改"
                  onClick={() => setChem({ benzeneStyle: 'kekule', ringTemplateId: 'benzene' })}
                >
                  凯库勒式
                </button>
              </span>
              <button
                type="button"
                className="mode-dock__item"
                data-testid="benzene-insert"
                title="在画布插入苯环"
                onClick={() => {
                  setChem({ ringTemplateId: 'benzene' });
                  setTool('ring');
                }}
              >
                <Icon name="ring" size={14} />
                插入苯环
              </button>
            </div>
          </div>
        </>
      );
    }
    if (id === 'arrow') {
      return (
        <>
          <header className="chem-subpanel__head">{close}</header>
          <div className="chem-subpanel__body chem-subpanel__body--4">
            {ARROW_PRESETS.map((preset) => (
              <button
                key={preset.kind}
                type="button"
                data-arrow={preset.kind}
                title={preset.hint}
                className={`mode-dock__item${chem.arrowKind === preset.kind ? ' is-active' : ''}`}
                onClick={() => {
                  setChem({ arrowKind: preset.kind });
                  setTool('arrow');
                }}
              >
                <ArrowGlyph kind={preset.kind} />
                {preset.name}
              </button>
            ))}
          </div>
        </>
      );
    }
    return <header className="chem-subpanel__head">{close}</header>;
  };

  return (
    <>
      <div className="mode-docks" data-testid="mode-docks">
        {/* 化学：一级横栏分类 + 互斥的二级扩展 */}
        {showChem ? (
          <div className="chem-stack">
            {openChemPanels.length > 0 ? (
              <div className="chem-subpanels" data-testid="chem-subpanels">
                {openChemPanels.map((id) => (
                  <section
                    key={id}
                    className="chem-subpanel"
                    data-chem-panel={id}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerUp={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.stopPropagation()}
                  >
                    {chemPanel(id)}
                  </section>
                ))}
              </div>
            ) : null}
            <div
              className="mode-dock mode-dock--chem"
              data-testid="chem-dock"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.stopPropagation()}
              onWheel={scrollDockHorizontally}
            >
              {/* 当前键型只在二级面板里以高亮表示：一级横栏保持定宽，
                  避免点击“化学键”时多出一段状态文字把整条横栏推歪。 */}
              {CHEM_CATEGORIES.map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  data-chem-category={id}
                  title={CHEM_CATEGORY_HINTS[id] ?? label}
                  className={`mode-dock__item${
                    (id === 'bond' && activeTool === 'bond') ||
                    ((id === 'element' || id === 'group') &&
                      activeTool === 'atom' &&
                      chem.atomCategory === id) ||
                    (id === 'ring' && activeTool === 'ring') ||
                    (id === 'arrow' && activeTool === 'arrow') ||
                    (id === 'eraser' && activeTool === 'eraser')
                      ? ' is-active'
                      : ''
                  }`}
                  onClick={() => activateChemCategory(id)}
                >
                  <Icon name={icon} size={14} />
                  {label}
                </button>
              ))}
              <span className="mode-dock__divider" />
              <button
                type="button"
                className={`chem-metric-link${chem.bondUniform ? ' is-active' : ''}`}
                data-testid="chem-bond-uniform"
                aria-pressed={chem.bondUniform}
                title={
                  chem.bondUniform
                    ? '等比联动：修改键长 / 键宽 / 键距任一参数，另外两项按同一倍率调整'
                    : '独立参数：键长 / 键宽 / 键距分别调整'
                }
                onClick={() => setChemDefaults({ bondUniform: !chem.bondUniform })}
              >
                <Icon name={chem.bondUniform ? 'link' : 'unlink'} size={14} />
              </button>
              <button
                type="button"
                className="chem-metric-reset"
                data-testid="chem-bond-defaults"
                title={`恢复默认：键长 ${CHEM_BOND_LENGTH_DEFAULT} / 键宽 ${CHEM_BOND_WIDTH_DEFAULT} / 键距 ${CHEM_BOND_SPACING_DEFAULT} / 元素 ${CHEM_ATOM_SIZE_DEFAULT}`}
                onClick={resetChemBondMetrics}
              >
                <Icon name="undo" size={13} />
              </button>
              <ChemMetricInput
                testId="chem-bond-length"
                label="键长"
                title={`后续新建化学键的键长（${CHEM_BOND_LENGTH_RANGE.min}–${CHEM_BOND_LENGTH_RANGE.max}px）`}
                value={bondLength}
                decimals={0}
                min={CHEM_BOND_LENGTH_RANGE.min}
                max={CHEM_BOND_LENGTH_RANGE.max}
                step={1}
                onCommit={(value) => setChemBondMetric('length', value)}
              />
              <ChemMetricInput
                testId="chem-bond-width"
                label="键宽"
                title={`后续新建化学键的键宽（${CHEM_BOND_WIDTH_RANGE.min}–${CHEM_BOND_WIDTH_RANGE.max}px）`}
                value={bondWidth}
                decimals={1}
                min={CHEM_BOND_WIDTH_RANGE.min}
                max={CHEM_BOND_WIDTH_RANGE.max}
                step={0.1}
                onCommit={(value) => setChemBondMetric('width', value)}
              />
              <ChemMetricInput
                testId="chem-bond-spacing"
                label="键距"
                title={`双键 / 三键键距（${CHEM_BOND_SPACING_RANGE.min}–${CHEM_BOND_SPACING_RANGE.max}px）；后续新建结构使用`}
                value={bondSpacing}
                decimals={1}
                min={CHEM_BOND_SPACING_RANGE.min}
                max={CHEM_BOND_SPACING_RANGE.max}
                step={0.1}
                onCommit={(value) => setChemBondMetric('spacing', value)}
              />
              <ChemMetricInput
                testId="chem-atom-size"
                label="元素"
                title={`新增原子/元素标签的字号（${CHEM_ATOM_SIZE_RANGE.min}–${CHEM_ATOM_SIZE_RANGE.max}px）；与键长等参数等比联动`}
                value={atomSize}
                decimals={0}
                min={CHEM_ATOM_SIZE_RANGE.min}
                max={CHEM_ATOM_SIZE_RANGE.max}
                step={1}
                onCommit={(value) => setChemBondMetric('atomSize', value)}
              />
              <span className="mode-dock__divider" />
              <button
                type="button"
                className="mode-dock__icon mode-dock__icon--primary"
                title="退出化学工具（Esc）"
                data-testid="chem-confirm"
                onClick={() => {
                  setFeature('chem', false);
                  setToolPanel(null);
                  closeToSelect();
                }}
              >
                <Icon name="check" size={15} strokeWidth={2.4} />
              </button>
            </div>
          </div>
        ) : null}

        {showBucket ? (
          <div
            className="mode-dock"
            data-testid="bucket-dock"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            {(
              [
                ['fill', '填充'],
                ['stroke', '描边'],
                ['both', '填充+描边']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-bucket-mode={value}
                className={`mode-dock__item${bucketMode === value ? ' is-active' : ''}`}
                onClick={() => setBucketMode(value)}
              >
                {label}
              </button>
            ))}
            <span className="mode-dock__divider" />
            <label className="mode-field mode-field--num">
              <span>断线容差</span>
              <input
                type="number"
                min={0}
                max={12}
                step={1}
                data-testid="bucket-gap"
                value={bucketGap}
                onChange={(event) => setBucketGap(Number(event.target.value) || 0)}
              />
              <em>px</em>
            </label>
            <label className="mode-field mode-field--num">
              <span>扩展</span>
              <input
                type="number"
                min={-2}
                max={4}
                step={1}
                data-testid="bucket-expand"
                value={bucketExpand}
                onChange={(event) => setBucketExpand(Number(event.target.value) || 0)}
              />
              <em>px</em>
            </label>
            <span className="mode-dock__note">点图形填整块；点空白按区域填充</span>
            <button
              type="button"
              className="mode-dock__icon mode-dock__icon--primary"
              title="完成"
              data-testid="bucket-confirm"
              onClick={() => setFeature('bucket', false)}
            >
              <Icon name="check" size={15} strokeWidth={2.4} />
            </button>
          </div>
        ) : null}

        {showEraser ? (
          <div
            className="mode-dock mode-dock--eraser"
            data-testid="eraser-dock"
            title="可多选擦除对象；全部擦除会一次选中或取消其余三项"
            aria-label="橡皮擦擦除对象"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
            onWheel={scrollDockHorizontally}
          >
            {/* 前三项可多选并存：每个目标独立生效，同类对象不会互相吞掉。 */}
            {ERASER_TARGET_OPTIONS.map((option) => {
              const active = eraserTargets[option.key];
              return (
                <button
                  key={option.key}
                  type="button"
                  data-eraser-target={option.key}
                  className={`mode-dock__item${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  title={option.hint}
                  onClick={() => toggleEraserTarget(option.key)}
                >
                  {option.label}
                </button>
              );
            })}
            <span className="mode-dock__divider" />
            <button
              type="button"
              data-eraser-target="all"
              className={`mode-dock__item${eraserAllActive ? ' is-active' : ''}`}
              aria-pressed={eraserAllActive}
              title="选中时其余三项一并选中；取消时其余三项一并取消"
              onClick={() =>
                setEraserTargets(createEraserTargets(eraserAllActive ? false : true))
              }
            >
              <Icon name="eraser" size={14} />
              全部擦除
            </button>
            <span className="mode-dock__divider" />
            <button
              type="button"
              className="mode-dock__icon mode-dock__icon--primary"
              title="完成"
              data-testid="eraser-confirm"
              onClick={() => setFeature('eraser', false)}
            >
              <Icon name="check" size={15} strokeWidth={2.4} />
            </button>
            {/* 未选择任何目标时给一句短提示：橡皮仍可拖动，但不会生效。 */}
            {eraserNoneActive ? (
              <span className="mode-dock__note" data-testid="eraser-hint">
                未选择擦除对象
              </span>
            ) : null}
          </div>
        ) : null}

        {showShape ? (
          <div
            className="mode-dock"
            data-testid="shape-dock"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            {SHAPE_TOOL_IDS.map((shapeId) => {
              const shape = TOOL_MAP[shapeId];
              return (
                <button
                  key={shapeId}
                  type="button"
                  data-shape={shapeId}
                  title={shape.hint}
                  className={`mode-dock__item${activeTool === shapeId ? ' is-active' : ''}`}
                  onClick={() => {
                    useAppStore.getState().setSelection([]);
                    setTool(shapeId);
                  }}
                >
                  <Icon name={shape.icon} size={15} />
                  {shape.label}
                </button>
              );
            })}
            <span className="mode-dock__divider" />
            <div className="mode-radius" data-testid="shape-radius-control">
              <button
                type="button"
                className={`mode-dock__item${cornerRadius > 0 ? ' is-active' : ''}`}
                data-testid="shape-radius-toggle"
                title={cornerRadius > 0 ? '关闭矩形圆角' : '开启矩形圆角'}
                onClick={() => setCornerRadius(cornerRadius > 0 ? 0 : 18)}
              >
                圆角
              </button>
              <input
                type="range"
                min={0}
                max={400}
                step={1}
                value={Math.min(400, cornerRadius)}
                aria-label="矩形圆角半径"
                data-testid="shape-radius"
                onChange={(event) => setCornerRadius(Number(event.target.value))}
              />
              <label className="mode-radius__value">
                <input
                  type="number"
                  min={0}
                  max={400}
                  step={1}
                  value={cornerRadius}
                  aria-label="手动输入矩形圆角半径"
                  data-testid="shape-radius-number"
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setCornerRadius(Number(event.target.value) || 0)}
                />
                <span>px</span>
              </label>
            </div>
            <button
              type="button"
              className={`mode-dock__item${snapEnabled ? ' is-active' : ''}`}
              data-testid="shape-snap-toggle"
              title="绘制形状时吸附到网格（也可按 Alt 临时取消）"
              aria-pressed={snapEnabled}
              onClick={toggleSnap}
            >
              <Icon name="snap" size={15} />
              吸附
            </button>
            {activeTool === 'polygon' ? (
              <>
                <label className="mode-field mode-field--num" title="多边形/星形边数">
                  <span>边数</span>
                  <input
                    type="number"
                    min={3}
                    max={24}
                    step={1}
                    data-testid="polygon-sides"
                    value={polygonSides}
                    onChange={(event) => setPolygonSides(Number(event.target.value) || 6)}
                  />
                </label>
                <label className="mode-field mode-field--num" title="内径比例：0 为正多边形，>0 为星形">
                  <span>星形</span>
                  <input
                    type="number"
                    min={0}
                    max={95}
                    step={5}
                    data-testid="polygon-star"
                    value={Math.round(polygonStar * 100)}
                    onChange={(event) => setPolygonStar((Number(event.target.value) || 0) / 100)}
                  />
                  <em>%</em>
                </label>
              </>
            ) : null}
            {activeTool === 'line' ? (
              <button
                type="button"
                className={`mode-dock__item${lineArrowEnd ? ' is-active' : ''}`}
                data-testid="line-arrow-end"
                title="新直线末端带箭头"
                aria-pressed={lineArrowEnd}
                onClick={() => setLineArrowEnd(!lineArrowEnd)}
              >
                箭头
              </button>
            ) : null}
            <button
              type="button"
              className={`mode-dock__item${shapeFromCenter ? ' is-active' : ''}`}
              data-testid="shape-from-center"
              title="拖拽时以落点为几何中心（Alt 仍是临时关闭吸附）"
              aria-pressed={shapeFromCenter}
              onClick={toggleShapeFromCenter}
            >
              中心
            </button>
            <span className="mode-dock__divider" />
            <button
              type="button"
              className="mode-dock__icon mode-dock__icon--primary"
              title="完成"
              data-testid="shape-confirm"
              onClick={() => {
                setFeature('shape', false);
                if (!isShape) setToolPanel(null);
              }}
            >
              <Icon name="check" size={15} strokeWidth={2.4} />
            </button>
          </div>
        ) : null}

        {showText ? (
          <div
            className="mode-dock mode-dock--text"
            data-testid="text-dock"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
            // 鼠标滚轮横向滑动：横栏比可视宽度长时不再“点不到后面的控件”。
            onWheel={scrollDockHorizontally}
          >
            <label className="mode-field mode-field--font" title="可直接输入字体名，或从下拉建议中选择">
              <span>字体</span>
              <input
                data-testid="text-font"
                list="vdraw-font-families"
                value={fontDraft}
                placeholder="字体名"
                spellCheck={false}
                onFocus={() => useAppStore.getState().beginTransaction()}
                onChange={(event) => {
                  const value = event.target.value;
                  setFontDraft(value);
                  if (!value.trim()) return;
                  applyTextSetting({ fontFamily: value });
                }}
                onBlur={() => {
                  useAppStore.getState().endTransaction();
                  const next = fontDraft.trim() || DEFAULT_FONT_FAMILY;
                  setFontDraft(next);
                  applyTextSetting({ fontFamily: next });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              <datalist id="vdraw-font-families">
                {FONT_CHOICES.map((font) => (
                  <option key={font.value} value={font.value} label={font.label} />
                ))}
              </datalist>
            </label>
            <label className="mode-field mode-field--num">
              <span>字号</span>
              <input
                type="number"
                min={6}
                max={200}
                data-testid="text-size"
                value={textSettings.fontSize}
                onFocus={() => useAppStore.getState().beginTransaction()}
                onBlur={() => useAppStore.getState().endTransaction()}
                onChange={(event) =>
                  applyTextSetting({
                    fontSize: Math.max(6, Number(event.target.value) || 20)
                  })
                }
              />
            </label>
            <label className="mode-field mode-field--num">
              <span>字间距</span>
              <input
                type="number"
                min={-5}
                max={50}
                step={0.5}
                data-testid="text-spacing"
                value={textSettings.letterSpacing}
                onChange={(event) =>
                  applyTextSetting({ letterSpacing: Number(event.target.value) || 0 })
                }
              />
            </label>
            <label className="mode-field mode-field--num">
              <span>框宽</span>
              <input
                type="number"
                min={0}
                max={2000}
                step={10}
                data-testid="text-width"
                value={textSettings.maxWidth}
                onChange={(event) =>
                  applyTextSetting({ maxWidth: Math.max(0, Number(event.target.value) || 0) })
                }
              />
              <em>px</em>
            </label>
            <label className="mode-field mode-field--num">
              <span>字重</span>
              <select
                data-testid="text-weight"
                value={textSettings.fontWeight}
                onChange={(event) =>
                  applyTextSetting({ fontWeight: Number(event.target.value) })
                }
              >
                <option value={400}>常规</option>
                <option value={600}>半粗</option>
                <option value={700}>粗体</option>
              </select>
            </label>
            <div className="mode-field">
              <span>字形</span>
              <div className="mode-segment">
                <button
                  type="button"
                  data-testid="text-italic-toggle"
                  className={textSettings.italic ? 'is-active' : ''}
                  title="斜体（新建与选中文本同时生效）"
                  onClick={() => applyTextSetting({ italic: !textSettings.italic })}
                >
                  斜体
                </button>
                <button
                  type="button"
                  data-testid="text-superscript"
                  title="把选中内容转为上标（输入 ^{2}）"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent('vdraw:insert-text', { detail: '^{}' })
                    )
                  }
                >
                  x²
                </button>
                <button
                  type="button"
                  data-testid="text-subscript"
                  title="把选中内容转为下标（输入 _{2}）"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent('vdraw:insert-text', { detail: '_{}' })
                    )
                  }
                >
                  x₂
                </button>
                <button
                  type="button"
                  data-testid="text-bullet"
                  title="插入项目符号"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent('vdraw:insert-text', { detail: '• ' })
                    )
                  }
                >
                  • 列表
                </button>
              </div>
            </div>
            <label className="mode-field">
              <span>对齐</span>
              <select
                data-testid="text-align"
                value={textSettings.align ?? 'left'}
                onChange={(event) =>
                  applyTextSetting({ align: event.target.value as 'left' | 'center' | 'right' })
                }
              >
                <option value="left">左对齐</option>
                <option value="center">居中</option>
                <option value="right">右对齐</option>
              </select>
            </label>
            <label className="mode-field mode-field--num">
              <span>行高</span>
              <input
                type="number"
                min={0.8}
                max={2.4}
                step={0.05}
                data-testid="text-line-height"
                value={textSettings.lineHeight}
                onFocus={() => useAppStore.getState().beginTransaction()}
                onBlur={() => useAppStore.getState().endTransaction()}
                onChange={(event) =>
                  applyTextSetting({
                    lineHeight: Math.min(2.4, Math.max(0.8, Number(event.target.value) || 1.32))
                  })
                }
              />
            </label>
            <div className="mode-field">
              <span>方向</span>
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
                    data-text-direction={value}
                    className={textSettings.direction === value ? 'is-active' : ''}
                    onClick={() => applyTextSetting({ direction: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="mode-field mode-field--color">
              <span>颜色</span>
              <input
                type="color"
                data-testid="text-color"
                value={textSettings.color}
                onChange={(event) => applyTextSetting({ color: event.target.value.toUpperCase() })}
              />
            </label>
            <span
              className="mode-dock__note"
              title="输入 ^{2} 或 _{2}，落笔时转为上标/下标字符；回车换行，Ctrl+回车或点击画布外完成"
            >
              ^{2} 上标 · _{2} 下标 · Enter 换行
            </span>
            <button
              type="button"
              className="mode-dock__icon mode-dock__icon--primary"
              title="完成"
              data-testid="text-confirm"
              onClick={() => {
                window.dispatchEvent(new Event('vdraw:commit-text'));
                setFeature('text', false);
              }}
            >
              <Icon name="check" size={15} strokeWidth={2.4} />
            </button>
          </div>
        ) : null}

        {/* 对称 / 辅助线横栏保留原有布局 */}
        {showSym ? (
          <div
            className="mode-dock"
            data-testid="mode-dock"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            {(
              [
                ['none', '关闭'],
                ['vertical', '左右'],
                ['horizontal', '上下'],
                ['both', '左右上下']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`mode-dock__item${symmetry === value ? ' is-active' : ''}`}
                data-symmetry={value}
                onClick={() => setSymmetry(value)}
              >
                <Icon name="symmetry" size={14} />
                {label}
              </button>
            ))}
            <span className="mode-dock__divider" />
            <button
              type="button"
              className="mode-dock__icon"
              title="对称轴复位"
              onClick={() => setSymmetryAxis({ x: 0.5, y: 0.5 })}
            >
              <Icon name="undo" size={14} />
            </button>
            <button
              type="button"
              className="mode-dock__icon"
              title="关闭对称"
              data-testid="mode-exit"
              onClick={() => setSymmetry('none')}
            >
              <Icon name="close" size={14} />
            </button>
            <button
              type="button"
              className="mode-dock__icon mode-dock__icon--primary"
              title="完成"
              data-testid="mode-confirm"
              onClick={() => setFeature('symmetry', false)}
            >
              <Icon name="check" size={15} strokeWidth={2.4} />
            </button>
          </div>
        ) : null}

        {showGuide ? (
          <div className="chem-stack">
            {guideMore ? (
              <section
                className="chem-subpanel"
                data-testid="guide-more-panel"
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
              >
                <header className="chem-subpanel__head">
                  <button
                    type="button"
                    className="chem-subpanel__close"
                    title="收起高级设置"
                    onClick={() => setGuideMore(false)}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </header>
                <div className="chem-subpanel__body">
                  <label className="mode-field">
                    <span>线密度</span>
                    <select
                      data-testid="guide-density"
                      value={guideDensity}
                      onChange={(event) => setGuideDensity(Number(event.target.value))}
                    >
                      <option value={12}>12 条</option>
                      <option value={24}>24 条</option>
                      <option value={36}>36 条</option>
                      <option value={48}>48 条</option>
                    </select>
                  </label>
                  <label className="mode-field mode-field--num">
                    <span>参考长度</span>
                    <input
                      type="number"
                      min={20}
                      max={600}
                      step={10}
                      data-testid="guide-spacing"
                      value={guideSpacing}
                      onChange={(event) => setGuideSpacing(Number(event.target.value) || 120)}
                    />
                    <em>px</em>
                  </label>
                  <label className="mode-field mode-field--num">
                    <span>地平线</span>
                    <input
                      type="number"
                      min={-20}
                      max={120}
                      step={1}
                      data-testid="guide-horizon"
                      value={Math.round(guideSettings.horizon * 100)}
                      onChange={(event) =>
                        setGuideSettings({ horizon: Number(event.target.value) / 100 })
                      }
                    />
                    <em>%</em>
                  </label>
                  <button
                    type="button"
                    className="mode-dock__item"
                    data-testid="guide-perspective-apply"
                    title="对选中图形应用透视（单应）变形"
                    onClick={() => {
                      const state = useAppStore.getState();
                      if (state.selection.length === 0) {
                        state.notify('请先选中要透视变形的图形', 'info');
                        return;
                      }
                      const result = warpSelection(
                        state.doc,
                        state.selection,
                        state.guideSettings,
                        state.doc.page
                      );
                      if (result.changed === 0) {
                        state.notify(
                          `没有可变形的对象（${result.unsupported} 个不支持）`,
                          'warn'
                        );
                        return;
                      }
                      state.updateDoc(result.doc, true);
                      state.notify(
                        `已对 ${result.changed} 个对象应用透视变形${result.unsupported ? `，跳过 ${result.unsupported} 个` : ''}`,
                        'success'
                      );
                    }}
                  >
                    透视变形选中对象
                  </button>
                </div>
              </section>
            ) : null}
            <div
              className="mode-dock"
              data-testid="guide-dock"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.stopPropagation()}
            >
              {GUIDE_MODES.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`mode-dock__item${guideValue === value ? ' is-active' : ''}`}
                  data-guide={value}
                  onClick={() => setGuideMode(value)}
                >
                  {label}
                </button>
              ))}
              <span className="mode-dock__divider" />
              <button
                type="button"
                className={`mode-dock__item${guideAssist ? ' is-active' : ''}`}
                data-testid="guide-assist"
                disabled={guideValue === 'none'}
                onClick={toggleGuideAssist}
              >
                绘画辅助
              </button>
              <button
                type="button"
                className={`mode-dock__item${guideMore ? ' is-active' : ''}`}
                data-testid="guide-more"
                title="线密度、参考长度、地平线与透视变形"
                onClick={() => setGuideMore((value) => !value)}
              >
                更多
              </button>
              <button
                type="button"
                className="mode-dock__icon"
                title="辅助线复位"
                onClick={() =>
                  setGuideSettings({
                    horizon: 0.42,
                    vpX: 0.5,
                    vpLeft: -0.18,
                    vpRight: 1.18,
                    vpBottom: 1.75
                  })
                }
              >
                <Icon name="undo" size={14} />
              </button>
              <button
                type="button"
                className="mode-dock__icon"
                title="关闭辅助线"
                data-testid="guide-exit"
                onClick={() => setGuideMode('none')}
              >
                <Icon name="close" size={14} />
              </button>
              <button
                type="button"
                className="mode-dock__icon mode-dock__icon--primary"
                title="完成"
                data-testid="guide-confirm"
                onClick={() => setFeature('guides', false)}
              >
                <Icon name="check" size={15} strokeWidth={2.4} />
              </button>
            </div>
          </div>
        ) : null}

        {collapsedChip ? (
          <button
            type="button"
            className="mode-dock mode-dock--chip"
            data-testid="mode-collapsed"
            title="工具仍在激活，点击重新展开选项"
            onClick={() => setFeature(collapsedChip.feature, true)}
          >
            {collapsedChip.label}选项已收起 · 展开
          </button>
        ) : null}
      </div>
    </>
  );
}
