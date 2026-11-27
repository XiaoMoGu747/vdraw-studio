import { create } from 'zustand';
import type {
  BondType,
  BrushBlendMode,
  BrushPresetId,
  ChemToolState,
  CustomBrushPreset,
  EditorSnapshot,
  ExportFormat,
  ExportRegion,
  ExportScope,
  GuideMode,
  GuideSettings,
  Layer,
  LayerBlendMode,
  PanelTab,
  SceneObject,
  StrokeCap,
  StrokeDashPreset,
  StrokeJoin,
  Style,
  SymmetryAxis,
  SymmetryMode,
  ToolId,
  Vec,
  VDrawDocument,
  Viewport
} from '../types/document';
import {
  DEFAULT_STYLE,
  DEFAULT_TEMPLATE_ID,
  TEMPLATE_MAP,
  createCustomDocument,
  createDocument,
  createLayer,
  drawLayer,
  type NewDocumentOptions,
  type TemplateId
} from '../core/document';
import { MAX_ZOOM, MIN_ZOOM, clamp, fitViewport, zoomAround } from '../core/geometry';
import type { CationPlacement } from '../core/chemistry/salts';
import {
  addObjectsToLayer,
  allObjects,
  expandSelection,
  getObject,
  getObjectBounds,
  getLayerOfObject,
  insertObjectsIntoLayer,
  rotateDocumentObjects,
  scaleDocumentObjectsInFrame,
  selectionBounds,
  selectionFrame,
  translateDocumentObjects,
  unionRects
} from '../core/scene';
import { regenerateMirrors } from '../core/symmetry';
import { canClip } from '../core/clipShapes';
import { createGroupObject } from '../core/factory';
import {
  createEraserTargets,
  eraseObjects,
  normalizeEraserTargets,
  toggleEraserTarget as toggleTarget,
  type EraserTarget,
  type EraserTargets
} from '../core/eraser';
import { convertSelectionToPaths } from '../core/convertPath';
import { DEFAULT_RAIL_ORDER } from '../core/rail';
import { CHEM_TOOL_IDS, brushPresetOf } from '../core/tools';
import { createId } from '../core/id';
import { clearAutosave } from '../core/io/autosave';
import { mergeBrushPresets } from '../core/io/brushLibrary';
import {
  clampRegion,
  defaultExportRegion,
  pageRegionBounds,
  selectionExportRegion
} from '../core/io/region';

/** 新图层名按现有图层名称末尾编号的最大值递增，而不是按图层数量。 */
function nextLayerName(layers: Layer[]): string {
  let max = 0;
  for (const layer of layers) {
    if (layer.kind === 'folder') continue;
    const match = layer.name.trim().match(/(\d+)\s*$/);
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  return `图层 ${max + 1}`;
}
import type { ChemIssue } from '../core/chemistry/valence';

export type LayerDropPosition = 'before' | 'after' | 'inside';

/** 未保存修改的确认。桌面端使用原生确认框，浏览器开发模式同样可用。 */
function confirmDiscard(action: string): boolean {
  if (typeof window === 'undefined') return true;
  // 冒烟测试禁用原生确认框，避免自动化流程被阻塞。
  if (window.vdraw?.isSmoke) return true;
  return window.confirm(`当前文档有未保存的修改，${action}后这些修改会丢失。是否继续？`);
}

/** 复制图层时重建对象 id，并同步组内父子引用。 */
function cloneLayerObjects(objects: SceneObject[], layerId: string): SceneObject[] {
  const idMap = new Map<string, string>();
  for (const obj of objects) idMap.set(obj.id, createId(obj.type));
  return objects.map((obj) => {
    const cloned = JSON.parse(JSON.stringify(obj)) as SceneObject;
    cloned.id = idMap.get(obj.id) ?? cloned.id;
    cloned.layerId = layerId;
    cloned.parentId = obj.parentId ? idMap.get(obj.parentId) ?? null : null;
    if (cloned.type === 'group' && obj.type === 'group') {
      cloned.childIds = obj.childIds.map((id) => idMap.get(id) ?? id);
    }
    return cloned;
  });
}

function clipboardObjects(doc: VDrawDocument, selection: string[]): SceneObject[] {
  if (selection.length === 0) return [];
  const ids = new Set(expandSelection(doc, selection));
  return allObjects(doc)
    .filter((obj) => ids.has(obj.id))
    .map((obj) => JSON.parse(JSON.stringify(obj)) as SceneObject);
}

/** 选中范围内被对象锁或图层锁保护的对象；锁定后属性编辑、删除、排序都应拒绝。 */
function lockedObjectsIn(doc: VDrawDocument, ids: string[]): SceneObject[] {
  const selected = new Set(expandSelection(doc, ids));
  return allObjects(doc).filter(
    (obj) => selected.has(obj.id) && (obj.locked || Boolean(getLayerOfObject(doc, obj.id)?.locked))
  );
}

/** 删除集合：编组展开 + 删除原子时连带相连的键，避免留下悬空键线。 */
function deletionSet(doc: VDrawDocument, ids: string[]): Set<string> {
  const selected = new Set(expandSelection(doc, ids));
  const removedAtoms = allObjects(doc).filter(
    (obj) => obj.type === 'atom' && selected.has(obj.id)
  );
  if (removedAtoms.length === 0) return selected;
  for (const obj of allObjects(doc)) {
    if (obj.type !== 'bond' || selected.has(obj.id)) continue;
    for (const atom of removedAtoms) {
      if (atom.type !== 'atom') continue;
      if (
        Math.hypot(obj.start.x - atom.position.x, obj.start.y - atom.position.y) < 1.2 ||
        Math.hypot(obj.end.x - atom.position.x, obj.end.y - atom.position.y) < 1.2
      ) {
        selected.add(obj.id);
        break;
      }
    }
  }
  return selected;
}

export type ToastTone = 'info' | 'success' | 'warn';

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
}

export interface RecentEntry {
  id: string;
  name: string;
  path?: string;
  templateId: string;
  templateName: string;
  sizeLabel: string;
  openedAt: string;
}

export interface ChemReport {
  title: string;
  issues: ChemIssue[];
  emptyMessage: string;
}

export type { CustomBrushPreset } from '../types/document';

export interface TextSettings {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing: number;
  direction: 'horizontal' | 'vertical';
  lineHeight: number;
  /** 文本框宽度（页面像素），0 = 不自动换行。 */
  maxWidth: number;
  color: string;
}

/** 用户自定义的快捷画布模板（启动页「新建画布 → 快捷模板」里一键套用）。 */
export interface CanvasPreset {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** 自定义模板数量上限：再多就会把启动页模板区撑爆。 */
export const MAX_CANVAS_PRESETS = 12;

interface Prefs {
  customTemplates: CanvasPreset[];
  showGrid: boolean;
  showRulers: boolean;
  snapEnabled: boolean;
  autoOpenProperties: boolean;
  hoverHighlight: boolean;
  cornerRadius: number;
  brushSmoothing: number;
  uiDensity: UiDensity;
  reduceMotion: boolean;
  gridSize: number;
  autoSaveSeconds: number;
  toolShortcuts: Record<string, string>;
  chemBondType: BondType;
  /** 固定化学键：开启后新键只改变方向与摆放，三项参数保持当前值。 */
  chemBondFixed: boolean;
  /** 键长 / 键宽 / 键距等比联动。 */
  chemBondUniform: boolean;
  /** 化学键键长（页面 px），同时决定环系缩放基准。 */
  chemBondLength: number;
  /** 化学键键宽。 */
  chemBondWidth: number;
  /** 单独双键/三键的平行线键距（页面 px）。 */
  chemBondSpacing: number;
  /** 苯环/环上双键的内线键距（页面 px），与单独双键/三键独立。 */
  chemRingBondSpacing: number;
  /** 成盐时金属阳离子的摆放：键轴延长线或垂直于键轴的侧向。 */
  chemCationPlacement: CationPlacement;
  /** 成盐金属与酸根的最小距离（页面 px）；0 表示按键长自动计算。 */
  chemSaltDistance: number;
  /** 隐藏原子标签上的正负电荷上标。 */
  chemHideCharges: boolean;
  /** 新建原子/元素标签的默认字号（px）。 */
  chemAtomSize: number;
  chemBenzeneStyle: 'pauling' | 'kekule';
  showToolLabels: boolean;
  theme: ThemeMode;
  /** 画笔参数持久化：重启后保持上次使用的笔刷与手感 */
  brushPreset: BrushPresetId;
  brushSize: number;
  brushOpacity: number;
  brushHardness: number;
  brushSpacing: number;
  brushTexture: number;
  /** 每 dab 墨量 0–1。 */
  brushFlow: number;
  /** dab 混合模式。 */
  brushBlendMode: BrushBlendMode;
  /** 自定义笔刷：从当前参数保存，可反复套用。 */
  customBrushes: CustomBrushPreset[];
  /** 压感与渐隐是预设的"手感"参数，自定义预设需要独立保存。 */
  brushPressure: boolean;
  brushTaper: number;
  /** 压感曲线 gamma：<1 轻压更粗，>1 更依赖实际压力。 */
  brushPressureCurve: number;
  eraserSize: number;
  /** 橡皮只作用当前图层（默认开，Alt 临时全图层）。 */
  eraserCurrentLayer: boolean;
  /** 油漆桶参数：区域填充的断线闭合与扩展量（页面像素）。 */
  bucketMode: 'fill' | 'stroke' | 'both';
  bucketGap: number;
  bucketExpand: number;
  /** 文本工具默认样式，重启后保持。 */
  textSettings: TextSettings;
  /** 辅助线射线密度（每个消失点）。 */
  guideDensity: number;
  /** 等大参考网格的间距（页面像素）。 */
  guideSpacing: number;
  /** 常驻工具栏顺序（含用户从扩展面板添加的化学子工具）。 */
  railOrder: string[];
  /** 多边形边数 3–24。 */
  polygonSides: number;
  /** 星形内径比例 0–0.95；0 表示正多边形。 */
  polygonStar: number;
  /** 按中心绘制形状（Alt 留给"临时关闭吸附"）。 */
  shapeFromCenter: boolean;
  /** 新图形描边虚线预设。 */
  strokeDash: StrokeDashPreset;
  strokeCap: StrokeCap;
  strokeJoin: StrokeJoin;
  /** 新直线默认带末端箭头。 */
  lineArrowEnd: boolean;
  /** 橡皮擦除目标（线条 / 填充 / 描边 / 化学键，可多选并存）。 */
  eraserTargets: EraserTargets;
  /** 画布内联显示超价原子提示。 */
  inlineValence: boolean;
}

/** system = 跟随操作系统的 prefers-color-scheme，切换由 App 监听。 */
export type ThemeMode = 'light' | 'dark' | 'system';

export type UiDensity = 'compact' | 'standard' | 'comfortable';

/** 化学键默认值：设置里的「恢复默认」与首次使用时的初值。 */
export const CHEM_BOND_LENGTH_DEFAULT = 40;
export const CHEM_BOND_WIDTH_DEFAULT = 2.2;
export const CHEM_BOND_SPACING_DEFAULT = 4.2;
/** 环上双键内线默认键距；与单独双键/三键分开控制。 */
export const CHEM_RING_BOND_SPACING_DEFAULT = 4.2;
/** 成盐金属与酸根的默认距离：0 = 按键长与标签宽度自动计算。 */
export const CHEM_SALT_DISTANCE_DEFAULT = 0;
export const CHEM_SALT_DISTANCE_RANGE = { min: 0, max: 600 } as const;
export const CHEM_ATOM_SIZE_DEFAULT = 16;
/** 兼容旧命名：推荐值即默认值。 */
export const CHEM_BOND_LENGTH_RECOMMENDED = CHEM_BOND_LENGTH_DEFAULT;
export const CHEM_BOND_WIDTH_RECOMMENDED = CHEM_BOND_WIDTH_DEFAULT;
export const CHEM_BOND_SPACING_RECOMMENDED = CHEM_BOND_SPACING_DEFAULT;
export const CHEM_RING_BOND_SPACING_RECOMMENDED = CHEM_RING_BOND_SPACING_DEFAULT;
/** 参数范围：按结构式绘图需要大幅放宽，设置面板与顶栏共用。 */
export const CHEM_BOND_LENGTH_RANGE = { min: 8, max: 400 } as const;
export const CHEM_BOND_WIDTH_RANGE = { min: 0.2, max: 40 } as const;
export const CHEM_BOND_SPACING_RANGE = { min: 0.2, max: 100 } as const;
export const CHEM_ATOM_SIZE_RANGE = { min: 6, max: 120 } as const;

const DEFAULT_PREFS: Prefs = {
  customTemplates: [],
  showGrid: true,
  showRulers: true,
  snapEnabled: true,
  autoOpenProperties: true,
  hoverHighlight: true,
  cornerRadius: 0,
  // 默认只做极轻的平滑：新用户第一笔必须"跟手"，需要更强平滑时由用户主动调高。
  brushSmoothing: 12,
  uiDensity: 'standard',
  reduceMotion: false,
  gridSize: 10,
  autoSaveSeconds: 15,
  toolShortcuts: {},
  chemBondType: 'single',
  chemBondFixed: false,
  chemBondUniform: false,
  chemBondLength: CHEM_BOND_LENGTH_DEFAULT,
  chemBondWidth: CHEM_BOND_WIDTH_DEFAULT,
  chemBondSpacing: CHEM_BOND_SPACING_DEFAULT,
  chemRingBondSpacing: CHEM_RING_BOND_SPACING_DEFAULT,
  chemCationPlacement: 'axial',
  chemSaltDistance: CHEM_SALT_DISTANCE_DEFAULT,
  chemHideCharges: false,
  chemAtomSize: CHEM_ATOM_SIZE_DEFAULT,
  chemBenzeneStyle: 'kekule',
  showToolLabels: false,
  theme: 'light',
  brushPreset: 'pen',
  brushSize: 3,
  brushOpacity: 1,
  brushHardness: 0.9,
  brushSpacing: 0.5,
  brushTexture: 0,
  brushFlow: 1,
  brushBlendMode: 'normal',
  customBrushes: [],
  brushPressure: true,
  brushTaper: 0.3,
  brushPressureCurve: 1,
  eraserSize: 12,
  eraserCurrentLayer: true,
  bucketMode: 'fill',
  bucketGap: 2,
  bucketExpand: 0,
  textSettings: {
    fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
    fontSize: 20,
    fontWeight: 400,
    italic: false,
    align: 'left',
    letterSpacing: 0,
    direction: 'horizontal',
    lineHeight: 1.32,
    maxWidth: 0,
    color: '#1b1b1b'
  },
  guideDensity: 24,
  guideSpacing: 120,
  railOrder: DEFAULT_RAIL_ORDER,
  polygonSides: 6,
  polygonStar: 0,
  shapeFromCenter: false,
  strokeDash: 'solid',
  strokeCap: 'round',
  strokeJoin: 'round',
  lineArrowEnd: false,
  eraserTargets: createEraserTargets(true),
  inlineValence: true
};

const DEFAULT_GUIDE_SETTINGS: GuideSettings = {
  horizon: 0.42,
  vpX: 0.5,
  vpLeft: -0.18,
  vpRight: 1.18,
  vpBottom: 1.75
};

export type AlignMode = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';
export type DistributeAxis = 'h' | 'v';
export type ReorderMode = 'front' | 'back' | 'forward' | 'backward';

/** 虚线预设 → SVG dash 数组；线宽参与换算，粗线不会看起来像实线。 */
export function dashArrayFor(preset: StrokeDashPreset, width: number): number[] {
  const unit = Math.max(1, width);
  switch (preset) {
    case 'dashed':
      return [unit * 4, unit * 3];
    case 'dotted':
      return [unit, unit * 2];
    case 'dashdot':
      return [unit * 4, unit * 2, unit, unit * 2];
    default:
      return [];
  }
}

/**
 * 拖拽期视觉预览：只存受影响对象 id 与页面坐标系下的 SVG transform。
 * 不进文档、不进历史，抬手时才由 CanvasStage 一次性提交。
 */
export interface DragPreview {
  ids: string[];
  /** move / rotate：页面坐标系下的 SVG transform（刚体变换，可精确预览）。 */
  transform?: string;
  /**
   * resize：精确的预览文档。缩放提交会分别改变包围盒、字号、笔迹节点宽度，
   * 不是单一仿射，因此用「同一份文档」做预览，抬手直接提交它，保证零跳变。
   */
  doc?: VDrawDocument;
}

interface AppState {
  route: 'start' | 'editor';
  doc: VDrawDocument;
  activeTool: ToolId;
  /** 已打开但尚未选择具体子工具的工具组 */
  toolPanel: 'chem' | 'shape' | null;
  /** 每次点击工具自增，用于重新展开被手动收起的工具横栏 */
  toolEpoch: number;
  leftTab: PanelTab;
  selection: string[];
  clipboard: SceneObject[] | null;
  viewport: Viewport;
  viewportSize: { width: number; height: number };
  /** 左侧调色板浮层覆盖画布时，可见画布区域左侧需要让出的宽度。 */
  canvasLeftInset: number;
  cursor: Vec | null;
  /** 拖拽期只改视觉 transform 的轻量状态；null 表示无预览。 */
  dragPreview: DragPreview | null;
  showGrid: boolean;
  showRulers: boolean;
  snapEnabled: boolean;
  autoOpenProperties: boolean;
  hoverHighlight: boolean;
  cornerRadius: number;
  brushSmoothing: number;
  uiDensity: UiDensity;
  reduceMotion: boolean;
  gridSize: number;
  autoSaveSeconds: number;
  toolShortcuts: Record<string, string>;
  settingsOpen: boolean;
  defaultStyle: Style;
  chem: ChemToolState;
  /** 新建化学键的默认键长（页面 px），环系按同一比例缩放。 */
  chemBondLength: number;
  /** 新建化学键的默认线宽。 */
  chemBondWidth: number;
  /** 新建双键/三键的平行线间距。 */
  chemBondSpacing: number;
  /** 新建苯环/环上双键的内线间距。 */
  chemRingBondSpacing: number;
  /** 成盐时金属阳离子的摆放方式。 */
  chemCationPlacement: CationPlacement;
  /** 成盐金属与酸根的最小距离；0 = 自动。 */
  chemSaltDistance: number;
  /** 是否隐藏原子标签上的电荷上标。 */
  chemHideCharges: boolean;
  /** 新建原子标签的默认字号（px）。 */
  chemAtomSize: number;
  recent: RecentEntry[];
  /** 启动页「快捷模板」中的自定义尺寸。 */
  customTemplates: CanvasPreset[];
  toasts: Toast[];
  past: VDrawDocument[];
  future: VDrawDocument[];
  pendingSnapshot: VDrawDocument | null;
  isDirty: boolean;
  fitToken: number;
  chemReport: ChemReport | null;
  exportTransparent: boolean;
  /** 导出面板：格式 / 范围（整页或框选区域）/ 选区矩形 */
  exportPanelOpen: boolean;
  /** 导入对话框：本地文件校验、覆盖/新建/合并选择。 */
  importPanelOpen: boolean;
  exportFormat: ExportFormat;
  exportScope: ExportScope;
  exportRegion: ExportRegion | null;
  /** JPG 质量（0.5–1），对 PNG / SVG / PDF 无影响。 */
  exportQuality: number;
  propertiesOpen: boolean;
  sidebarTab: 'layers' | 'properties';
  /** 打开的浮层数量：>0 时全局快捷键让位给最上层浮层。 */
  overlayDepth: number;
  leftDockOpen: boolean;
  rightDockOpen: boolean;
  focusCanvas: boolean;
  showToolLabels: boolean;
  theme: ThemeMode;
  railOrder: string[];
  brushPreset: BrushPresetId;
  brushSize: number;
  brushOpacity: number;
  brushHardness: number;
  brushSpacing: number;
  brushTexture: number;
  brushFlow: number;
  brushBlendMode: BrushBlendMode;
  customBrushes: CustomBrushPreset[];
  brushPressure: boolean;
  brushTaper: number;
  brushPressureCurve: number;
  eraserSize: number;
  eraserCurrentLayer: boolean;
  bucketMode: 'fill' | 'stroke' | 'both';
  bucketGap: number;
  bucketExpand: number;
  textSettings: TextSettings;
  textComposerOpen: boolean;
  guideDensity: number;
  guideSpacing: number;
  symmetry: SymmetryMode;
  symmetryAxis: SymmetryAxis;
  guideMode: GuideMode;
  guideSettings: GuideSettings;
  guideAssist: boolean;
  /** 选区内绘制：新对象裁剪到当前选中的图形轮廓。 */
  clipToSelection: boolean;
  /** alpha 锁：新对象只在当前图层已有墨迹范围内可见。 */
  alphaLock: boolean;
  polygonSides: number;
  polygonStar: number;
  shapeFromCenter: boolean;
  strokeDash: StrokeDashPreset;
  strokeCap: StrokeCap;
  strokeJoin: StrokeJoin;
  lineArrowEnd: boolean;
  eraserTargets: EraserTargets;
  inlineValence: boolean;

  startDocument: (templateId?: TemplateId) => void;
  startDocumentWith: (options: NewDocumentOptions) => void;
  /** 保存一个自定义快捷模板（同名会覆盖尺寸）。 */
  addCanvasPreset: (name: string, width: number, height: number) => void;
  removeCanvasPreset: (id: string) => void;
  setRailOrder: (order: string[]) => void;
  toggleRailItem: (key: string) => void;
  setBrushPreset: (preset: BrushPresetId) => void;
  setBrushSize: (size: number) => void;
  setBrushOpacity: (opacity: number) => void;
  setBrushHardness: (hardness: number) => void;
  setBrushSpacing: (spacing: number) => void;
  setBrushTexture: (texture: number) => void;
  setBrushFlow: (flow: number) => void;
  setBrushBlendMode: (mode: BrushBlendMode) => void;
  setBrushPressureCurve: (curve: number) => void;
  /** 导入笔刷库：追加并返回实际新增数量。 */
  importBrushLibrary: (brushes: CustomBrushPreset[]) => number;
  saveCustomBrush: (name?: string) => string;
  applyCustomBrush: (id: string) => boolean;
  deleteCustomBrush: (id: string) => void;
  setEraserSize: (size: number) => void;
  setEraserCurrentLayer: (enabled: boolean) => void;
  setEraserTargets: (targets: EraserTargets) => void;
  toggleEraserTarget: (target: EraserTarget) => void;
  setPolygonSides: (sides: number) => void;
  setPolygonStar: (ratio: number) => void;
  toggleShapeFromCenter: () => void;
  setStrokeDash: (dash: StrokeDashPreset) => void;
  setStrokeCap: (cap: StrokeCap) => void;
  setStrokeJoin: (join: StrokeJoin) => void;
  setLineArrowEnd: (enabled: boolean) => void;
  toggleInlineValence: () => void;
  /** 隐式氢：隐藏原子标签上的 H 计数（写入文档）。 */
  toggleImplicitHydrogens: () => void;
  /** 以选中框中心旋转（度，正数为顺时针）。 */
  rotateSelectionBy: (degrees: number) => void;
  /** 水平/垂直翻转选中对象。 */
  flipSelection: (axis: 'horizontal' | 'vertical') => void;
  /** 锁定/解锁选中对象（图层锁之外的细粒度锁）。 */
  toggleObjectLock: () => void;
  /** 把选中的参数化形状转换为可编辑路径。 */
  convertSelectionToPath: () => void;
  setBucketMode: (mode: 'fill' | 'stroke' | 'both') => void;
  setBucketGap: (gap: number) => void;
  setBucketExpand: (expand: number) => void;
  setGuideDensity: (density: number) => void;
  setGuideSpacing: (spacing: number) => void;
  setTextSettings: (settings: Partial<AppState['textSettings']>) => void;
  setTextComposerOpen: (open: boolean) => void;
  setSymmetry: (mode: SymmetryMode) => void;
  setSymmetryAxis: (axis: SymmetryAxis) => void;
  cycleSymmetry: () => void;
  setGuideMode: (mode: GuideMode) => void;
  setGuideSettings: (settings: Partial<GuideSettings>) => void;
  toggleGuideAssist: () => void;
  /** 打开文档时恢复随文档保存的编辑器环境。 */
  applyEditorSnapshot: (snapshot: EditorSnapshot) => void;
  toggleClipToSelection: () => void;
  toggleAlphaLock: () => void;
  loadDocument: (doc: VDrawDocument, path: string, dirty?: boolean) => void;
  /** force=true 时跳过未保存确认（由调用方先展示统一确认框）。 */
  goToStart: (force?: boolean) => void;
  setTool: (tool: ToolId) => void;
  /** 取色完成后回到取色前的工具。 */
  restoreToolAfterEyedropper: () => void;
  setToolPanel: (panel: 'chem' | 'shape' | null) => void;
  setLeftTab: (tab: PanelTab) => void;
  setViewport: (viewport: Viewport) => void;
  setViewportSize: (size: { width: number; height: number }) => void;
  setCanvasLeftInset: (inset: number) => void;
  panBy: (dx: number, dy: number) => void;
  zoomAt: (factor: number, anchor?: Vec) => void;
  setZoom: (zoom: number, anchor?: Vec) => void;
  fitToCanvas: (size?: { width: number; height: number }, padding?: number) => void;
  /** 缩放到选中对象（无选中时等同适应窗口）。 */
  zoomToSelection: () => void;
  toggleGrid: () => void;
  toggleRulers: () => void;
  toggleSnap: () => void;
  toggleAutoOpenProperties: () => void;
  toggleHoverHighlight: () => void;
  setCornerRadius: (radius: number) => void;
  setBrushSmoothing: (amount: number) => void;
  setUiDensity: (density: UiDensity) => void;
  setReduceMotion: (reduce: boolean) => void;
  setGridSize: (size: number) => void;
  setAutoSaveSeconds: (seconds: number) => void;
  setToolShortcut: (toolId: string, key: string) => void;
  resetToolShortcuts: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  setDefaultFill: (color: string | null) => void;
  setDefaultStroke: (color: string) => void;
  setStrokeWidth: (width: number) => void;
  setDefaultOpacity: (opacity: number) => void;
  setCursor: (point: Vec | null) => void;
  setDragPreview: (preview: DragPreview | null) => void;
  notify: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: string) => void;
  setChem: (patch: Partial<ChemToolState>) => void;
  setChemDefaults: (patch: Partial<ChemToolState>) => void;
  /** 修改单个化学参数；等比联动开启时键长/键宽/键距/元素大小按同一倍率调整。 */
  setChemBondMetric: (
    key: 'length' | 'width' | 'spacing' | 'atomSize',
    value: number
  ) => void;
  /** 恢复化学参数默认值（40 / 2.2 / 4.2 / 4.2 / 16）。 */
  resetChemBondMetrics: () => void;
  /** 只改某一项，不影响另外两项（用于单项“默认”按钮/兼容旧入口）。 */
  setChemBondLength: (length: number) => void;
  setChemBondWidth: (width: number) => void;
  setChemBondSpacing: (spacing: number) => void;
  /** 只改环上双键的内线间距，不影响单独双键/三键。 */
  setChemRingBondSpacing: (spacing: number) => void;
  /** 设置成盐金属阳离子的摆放方式。 */
  setChemCationPlacement: (placement: CationPlacement) => void;
  /** 设置成盐金属与酸根的最小距离；0 = 自动。 */
  setChemSaltDistance: (distance: number) => void;
  /** 显示/隐藏原子标签上的正负电荷。 */
  setChemHideCharges: (hide: boolean) => void;
  setChemAtomSize: (size: number) => void;
  /** 在对象列表内复制单个对象（含编组子对象），并选中新副本。 */
  duplicateObject: (id: string) => void;
  /** 删除单个对象；原子被删时连带清理相连的键。 */
  deleteObject: (id: string) => void;
  /** 拖动对象行调整前后层级：above = 覆盖目标，below = 被目标覆盖。 */
  moveObjectTo: (dragId: string, targetId: string, placement: 'above' | 'below') => void;
  updateDoc: (next: VDrawDocument, record?: boolean) => void;
  beginTransaction: () => void;
  endTransaction: () => void;
  undo: () => void;
  redo: () => void;
  setSelection: (ids: string[], additive?: boolean) => void;
  copySelection: () => void;
  pasteClipboard: () => void;
  duplicateSelection: () => void;
  selectAll: () => void;
  clearSelection: () => void;
  addObjects: (objects: SceneObject[], layerId?: string) => boolean;
  deleteSelection: () => void;
  groupSelection: () => void;
  ungroupSelection: () => void;
  alignSelection: (mode: AlignMode) => void;
  distributeSelection: (axis: DistributeAxis) => void;
  reorderSelection: (mode: ReorderMode) => void;
  addLayer: () => void;
  addLayerFolder: () => void;
  duplicateLayer: (layerId: string) => void;
  mergeLayerDown: (layerId: string) => void;
  moveLayerTo: (layerId: string, targetId: string, position: LayerDropPosition) => void;
  deleteLayer: (layerId: string) => void;
  renameLayer: (layerId: string, name: string) => void;
  moveLayer: (layerId: string, direction: -1 | 1) => void;
  setPageBackground: (color: string) => void;
  setPageBackgroundVisible: (visible: boolean) => void;
  setActiveLayer: (layerId: string) => void;
  toggleLayerVisible: (layerId: string) => void;
  toggleLayerLock: (layerId: string) => void;
  setLayerBlendMode: (layerId: string, mode: LayerBlendMode) => void;
  markSaved: (path: string, name?: string) => void;
  /** 重命名当前文档标题（写入文档名并标记未保存）。 */
  renameDocument: (name: string) => void;
  addRecent: (entry: RecentEntry) => void;
  /** 只重命名启动页最近文件记录，不改动磁盘上的文件名。 */
  renameRecent: (id: string, name: string) => void;
  removeRecent: (id: string) => void;
  clearRecent: () => void;
  setChemReport: (report: ChemReport | null) => void;
  toggleExportTransparent: () => void;
  openExportPanel: (format?: ExportFormat, scope?: ExportScope) => void;
  closeExportPanel: () => void;
  openImportPanel: () => void;
  closeImportPanel: () => void;
  setExportFormat: (format: ExportFormat) => void;
  setExportScope: (scope: ExportScope) => void;
  setExportRegion: (region: ExportRegion) => void;
  setExportQuality: (quality: number) => void;
  openProperties: () => void;
  closeProperties: () => void;
  setSidebarTab: (tab: 'layers' | 'properties') => void;
  pushOverlay: () => void;
  popOverlay: () => void;
  toggleLeftDock: () => void;
  toggleRightDock: () => void;
  toggleFocusCanvas: () => void;
  setLeftDockOpen: (open: boolean) => void;
  setRightDockOpen: (open: boolean) => void;
  toggleToolLabels: () => void;
  setShowToolLabels: (show: boolean) => void;
  setTheme: (theme: ThemeMode) => void;
}

const RECENT_KEY = 'vdraw.recent.v1';
const PREFS_KEY = 'vdraw.prefs.v1';
const HISTORY_LIMIT = 60;
/** 直接编辑派生镜像时只提示一次，避免每次拖动都弹 toast。 */
let mirrorEditWarned = false;

/** 每个预设记住自己的尺寸/透明度，避免来回切换时互相覆盖。 */
const brushPresetMemory = new Map<BrushPresetId, { size: number; opacity: number }>();

/** 取色前使用的工具：取色完成后回落，避免打断当前工作流。 */
let toolBeforeEyedropper: ToolId = 'select';

/** 滑杆拖动会高频触发，偏好写入做 200ms 合并，避免同步 localStorage 拖慢绘制。 */
let brushPrefsTimer: number | null = null;
/** 合并窗口内的多个补丁：连点两个「推荐」时不能互相覆盖。 */
let pendingPrefsPatch: Partial<Prefs> = {};

function scheduleBrushPrefs(patch: Partial<Prefs>): void {
  if (typeof window === 'undefined') return;
  pendingPrefsPatch = { ...pendingPrefsPatch, ...patch };
  if (brushPrefsTimer !== null) window.clearTimeout(brushPrefsTimer);
  brushPrefsTimer = window.setTimeout(() => {
    brushPrefsTimer = null;
    const merged = pendingPrefsPatch;
    pendingPrefsPatch = {};
    writePrefs({ ...readPrefs(), ...merged });
  }, 200);
}

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      toolShortcuts:
        parsed.toolShortcuts && typeof parsed.toolShortcuts === 'object'
          ? { ...parsed.toolShortcuts }
          : {},
      // 文本样式是嵌套对象：必须与默认值合并，否则旧偏好会丢 lineHeight 等新字段。
      textSettings: {
        ...DEFAULT_PREFS.textSettings,
        ...(parsed.textSettings ?? {})
      },
      // 自定义模板：脏数据直接丢弃，尺寸收敛到可绘制范围。
      customTemplates: Array.isArray(parsed.customTemplates)
        ? parsed.customTemplates
            .filter(
              (item) =>
                Boolean(item) &&
                typeof item.id === 'string' &&
                typeof item.name === 'string' &&
                Number.isFinite(item.width) &&
                Number.isFinite(item.height)
            )
            .slice(0, MAX_CANVAS_PRESETS)
            .map((item) => ({
              id: item.id,
              name: item.name,
              width: Math.round(clamp(item.width, 1, 20000)),
              height: Math.round(clamp(item.height, 1, 20000))
            }))
        : [],
      brushFlow:
        typeof parsed.brushFlow === 'number' && Number.isFinite(parsed.brushFlow)
          ? clamp(parsed.brushFlow, 0, 1)
          : DEFAULT_PREFS.brushFlow,
      brushBlendMode: parsed.brushBlendMode === 'multiply' ? 'multiply' : 'normal',
      brushPressureCurve:
        typeof parsed.brushPressureCurve === 'number' &&
        Number.isFinite(parsed.brushPressureCurve)
          ? clamp(parsed.brushPressureCurve, 0.4, 2)
          : DEFAULT_PREFS.brushPressureCurve,
      // 自定义笔刷是数组：旧偏好或损坏数据要回落到空列表。
      customBrushes: Array.isArray(parsed.customBrushes) ? parsed.customBrushes : [],
      // 工具栏顺序：至少保留一个可点击项，脏数据回落到默认顺序。
      railOrder:
        Array.isArray(parsed.railOrder) && parsed.railOrder.every((key) => typeof key === 'string') && parsed.railOrder.length > 0
          ? [...new Set(parsed.railOrder)]
          : DEFAULT_PREFS.railOrder,
      polygonSides:
        typeof parsed.polygonSides === 'number' && Number.isFinite(parsed.polygonSides)
          ? Math.min(24, Math.max(3, Math.round(parsed.polygonSides)))
          : DEFAULT_PREFS.polygonSides,
      polygonStar:
        typeof parsed.polygonStar === 'number' && Number.isFinite(parsed.polygonStar)
          ? clamp(parsed.polygonStar, 0, 0.95)
          : DEFAULT_PREFS.polygonStar,
      shapeFromCenter: Boolean(parsed.shapeFromCenter),
      strokeDash:
        parsed.strokeDash === 'dashed' ||
        parsed.strokeDash === 'dotted' ||
        parsed.strokeDash === 'dashdot'
          ? parsed.strokeDash
          : 'solid',
      strokeCap:
        parsed.strokeCap === 'butt' || parsed.strokeCap === 'square' ? parsed.strokeCap : 'round',
      strokeJoin:
        parsed.strokeJoin === 'miter' || parsed.strokeJoin === 'bevel' ? parsed.strokeJoin : 'round',
      lineArrowEnd: Boolean(parsed.lineArrowEnd),
      chemBondFixed:
        typeof parsed.chemBondFixed === 'boolean'
          ? parsed.chemBondFixed
          : DEFAULT_PREFS.chemBondFixed,
      chemBondUniform:
        typeof parsed.chemBondUniform === 'boolean'
          ? parsed.chemBondUniform
          : DEFAULT_PREFS.chemBondUniform,
      chemBondLength:
        typeof parsed.chemBondLength === 'number' && Number.isFinite(parsed.chemBondLength)
          ? clamp(parsed.chemBondLength, CHEM_BOND_LENGTH_RANGE.min, CHEM_BOND_LENGTH_RANGE.max)
          : DEFAULT_PREFS.chemBondLength,
      chemBondWidth:
        typeof parsed.chemBondWidth === 'number' && Number.isFinite(parsed.chemBondWidth)
          ? clamp(parsed.chemBondWidth, CHEM_BOND_WIDTH_RANGE.min, CHEM_BOND_WIDTH_RANGE.max)
          : DEFAULT_PREFS.chemBondWidth,
      chemBondSpacing:
        typeof parsed.chemBondSpacing === 'number' && Number.isFinite(parsed.chemBondSpacing)
          ? clamp(parsed.chemBondSpacing, CHEM_BOND_SPACING_RANGE.min, CHEM_BOND_SPACING_RANGE.max)
          : DEFAULT_PREFS.chemBondSpacing,
      chemRingBondSpacing:
        typeof parsed.chemRingBondSpacing === 'number' &&
        Number.isFinite(parsed.chemRingBondSpacing)
          ? clamp(
              parsed.chemRingBondSpacing,
              CHEM_BOND_SPACING_RANGE.min,
              CHEM_BOND_SPACING_RANGE.max
            )
          : DEFAULT_PREFS.chemRingBondSpacing,
      chemCationPlacement:
        parsed.chemCationPlacement === 'right' || parsed.chemCationPlacement === 'axial'
          ? parsed.chemCationPlacement
          : DEFAULT_PREFS.chemCationPlacement,
      chemSaltDistance:
        typeof parsed.chemSaltDistance === 'number' && Number.isFinite(parsed.chemSaltDistance)
          ? clamp(
              parsed.chemSaltDistance,
              CHEM_SALT_DISTANCE_RANGE.min,
              CHEM_SALT_DISTANCE_RANGE.max
            )
          : DEFAULT_PREFS.chemSaltDistance,
      chemHideCharges:
        typeof parsed.chemHideCharges === 'boolean'
          ? parsed.chemHideCharges
          : DEFAULT_PREFS.chemHideCharges,
      chemAtomSize:
        typeof parsed.chemAtomSize === 'number' && Number.isFinite(parsed.chemAtomSize)
          ? clamp(parsed.chemAtomSize, CHEM_ATOM_SIZE_RANGE.min, CHEM_ATOM_SIZE_RANGE.max)
          : DEFAULT_PREFS.chemAtomSize,
      // 旧偏好只有 eraserScope（全部/仅图形/仅化学），迁移到四项目标；
      // 新偏好缺字段时按"全部选中"，避免升级后橡皮静默失效。
      eraserTargets: normalizeEraserTargets(
        parsed.eraserTargets,
        (parsed as { eraserScope?: unknown }).eraserScope
      ),
      inlineValence: parsed.inlineValence !== false
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function readRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function writeRecent(entries: RecentEntry[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, 6)));
  } catch {
    /* 本地存储不可用时忽略 */
  }
}

function writePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 本地存储不可用时忽略 */
  }
}

const prefs = readPrefs();
let untitledCounter = 0;

function nextDocumentName(): string {
  untitledCounter += 1;
  return `未命名-${untitledCounter}`;
}

const initialDoc = createDocument(DEFAULT_TEMPLATE_ID, '未命名-1');

export const useAppStore = create<AppState>((set, get) => {
  const pushHistory = (snapshot: VDrawDocument) => {
    const { past } = get();
    set({
      past: [...past, snapshot].slice(-HISTORY_LIMIT),
      future: [],
      pendingSnapshot: null,
      isDirty: true
    });
  };

  return {
    route: 'start',
    doc: initialDoc,
    activeTool: 'select',
    toolPanel: null,
    toolEpoch: 0,
    leftTab: 'layers',
    selection: [],
    clipboard: null,
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    viewportSize: { width: 0, height: 0 },
    canvasLeftInset: 0,
    cursor: null,
    dragPreview: null,
    showGrid: prefs.showGrid,
    showRulers: prefs.showRulers,
    snapEnabled: prefs.snapEnabled,
    autoOpenProperties: prefs.autoOpenProperties,
    hoverHighlight: prefs.hoverHighlight,
    cornerRadius: prefs.cornerRadius,
    brushSmoothing: prefs.brushSmoothing,
    uiDensity: prefs.uiDensity,
    reduceMotion: prefs.reduceMotion,
    gridSize: prefs.gridSize,
    autoSaveSeconds: prefs.autoSaveSeconds,
    toolShortcuts: prefs.toolShortcuts,
    settingsOpen: false,
    defaultStyle: {
      ...(JSON.parse(JSON.stringify(DEFAULT_STYLE)) as Style),
      stroke: {
        ...(JSON.parse(JSON.stringify(DEFAULT_STYLE)) as Style).stroke,
        cap: prefs.strokeCap,
        join: prefs.strokeJoin,
        dash: dashArrayFor(prefs.strokeDash, DEFAULT_STYLE.stroke.width)
      }
    },
    chem: {
      bondType: prefs.chemBondType,
      bondFixed: prefs.chemBondFixed,
      bondUniform: prefs.chemBondUniform,
      element: 'C',
      atomPresetId: 'C',
      atomCategory: 'element',
      ringTemplateId: 'benzene',
      ringScale: 1,
      benzeneStyle: prefs.chemBenzeneStyle,
      arrowKind: 'reaction',
      charge: 0,
      isotope: null,
      radical: 'none',
      lonePairs: 0
    },
    chemBondLength: prefs.chemBondLength,
    chemBondWidth: prefs.chemBondWidth,
    chemBondSpacing: prefs.chemBondSpacing,
    chemRingBondSpacing: prefs.chemRingBondSpacing,
    chemCationPlacement: prefs.chemCationPlacement,
    chemSaltDistance: prefs.chemSaltDistance,
    chemHideCharges: prefs.chemHideCharges,
    chemAtomSize: prefs.chemAtomSize,
    recent: readRecent(),
    customTemplates: prefs.customTemplates,
    toasts: [],
    past: [],
    future: [],
    pendingSnapshot: null,
    isDirty: false,
    fitToken: 0,
    chemReport: null,
    exportTransparent: false,
    exportPanelOpen: false,
    importPanelOpen: false,
    exportFormat: 'png',
    exportScope: 'page',
    exportRegion: null,
    exportQuality: 0.92,
    propertiesOpen: false,
    sidebarTab: 'layers',
    overlayDepth: 0,
    leftDockOpen: true,
    rightDockOpen: true,
    focusCanvas: false,
    showToolLabels: prefs.showToolLabels,
    theme: prefs.theme,
    railOrder: prefs.railOrder,
    brushPreset: prefs.brushPreset,
    brushSize: prefs.brushSize,
    brushOpacity: prefs.brushOpacity,
    brushHardness: prefs.brushHardness,
    brushSpacing: prefs.brushSpacing,
    brushTexture: prefs.brushTexture,
    brushFlow: prefs.brushFlow,
    brushBlendMode: prefs.brushBlendMode,
    customBrushes: prefs.customBrushes,
    brushPressure: prefs.brushPressure,
    brushTaper: prefs.brushTaper,
    brushPressureCurve: prefs.brushPressureCurve,
    eraserSize: prefs.eraserSize,
    eraserCurrentLayer: prefs.eraserCurrentLayer,
    bucketMode: prefs.bucketMode,
    bucketGap: prefs.bucketGap,
    bucketExpand: prefs.bucketExpand,
    textSettings: { ...prefs.textSettings },
    textComposerOpen: false,
    guideDensity: prefs.guideDensity,
    guideSpacing: prefs.guideSpacing,
    symmetry: 'none',
    symmetryAxis: { x: 0.5, y: 0.5 },
    guideMode: 'none',
    guideSettings: { ...DEFAULT_GUIDE_SETTINGS },
    guideAssist: false,
    clipToSelection: false,
    alphaLock: false,
    polygonSides: prefs.polygonSides,
    polygonStar: prefs.polygonStar,
    shapeFromCenter: prefs.shapeFromCenter,
    strokeDash: prefs.strokeDash,
    strokeCap: prefs.strokeCap,
    strokeJoin: prefs.strokeJoin,
    lineArrowEnd: prefs.lineArrowEnd,
    eraserTargets: prefs.eraserTargets,
    inlineValence: prefs.inlineValence,

    startDocumentWith: (options) => {
      if (get().route === 'editor' && get().isDirty && !confirmDiscard('新建文档')) return;
      clearAutosave();
      const doc = createCustomDocument(options, nextDocumentName());
      const gridSize = options.gridSize ?? get().gridSize;
      doc.grid = { ...doc.grid, size: gridSize, snapStep: gridSize };
      set({
        route: 'editor',
        doc,
        selection: [],
        activeTool: 'select',
        viewport: { zoom: 1, pan: { x: 0, y: 0 } },
        cursor: null,
        dragPreview: null,
        past: [],
        future: [],
        pendingSnapshot: null,
        isDirty: false,
        fitToken: get().fitToken + 1,
        chemReport: null,
        propertiesOpen: false,
        exportPanelOpen: false,
        showGrid: options.showGrid ?? get().showGrid
      });
    },

    addCanvasPreset: (name, width, height) => {
      const w = Math.round(clamp(width, 1, 20000));
      const h = Math.round(clamp(height, 1, 20000));
      const label = name.trim() || `${w} × ${h}`;
      const current = get().customTemplates;
      // 同名视为修改尺寸，不再堆一个重复模板。
      const existing = current.find((item) => item.name === label);
      const next = existing
        ? current.map((item) => (item === existing ? { ...item, width: w, height: h } : item))
        : [
            ...current,
            { id: `preset-${Date.now().toString(36)}-${current.length}`, name: label, width: w, height: h }
          ];
      if (!existing && next.length > MAX_CANVAS_PRESETS) {
        get().notify(`自定义模板最多 ${MAX_CANVAS_PRESETS} 个，请先删除旧的`, 'warn');
        return;
      }
      set({ customTemplates: next });
      writePrefs({ ...readPrefs(), customTemplates: next });
      get().notify(existing ? '已更新自定义模板' : '已保存自定义模板', 'success');
    },

    removeCanvasPreset: (id) => {
      const next = get().customTemplates.filter((item) => item.id !== id);
      set({ customTemplates: next });
      writePrefs({ ...readPrefs(), customTemplates: next });
    },

    setRailOrder: (order) => {
      const unique = [...new Set(order)];
      const railOrder = unique.length > 0 ? unique : ['select'];
      set({ railOrder });
      scheduleBrushPrefs({ railOrder });
    },

    toggleRailItem: (key) => {
      const order = get().railOrder;
      if (order.includes(key)) {
        if (order.length <= 1) {
          get().notify('常驻栏至少保留一个工具', 'warn');
          return;
        }
        const railOrder = order.filter((item) => item !== key);
        set({ railOrder });
        scheduleBrushPrefs({ railOrder });
        return;
      }
      const railOrder = [...order, key];
      set({ railOrder });
      scheduleBrushPrefs({ railOrder });
    },

    setBrushPreset: (preset) => {
      const current = get();
      const fallback = brushPresetOf(preset);
      // 点同一个预设 = 恢复该预设的默认值；切到其他预设时先记住当前的，
      // 再恢复目标预设上次用过的尺寸/透明度（不丢用户调好的参数）。
      const memory =
        current.brushPreset === preset ? null : brushPresetMemory.get(preset);
      if (current.brushPreset !== preset) {
        brushPresetMemory.set(current.brushPreset, {
          size: current.brushSize,
          opacity: current.brushOpacity
        });
      }
      const brushSize = memory?.size ?? fallback.width;
      const brushOpacity = memory?.opacity ?? fallback.opacity;
      // 预设同时决定软边/纹理/流量/混合/压感/渐隐：切换笔刷时手感要跟着变。
      const {
        hardness: brushHardness,
        spacing: brushSpacing,
        texture: brushTexture,
        flow: brushFlow,
        blendMode: brushBlendMode
      } = fallback;
      const brushPressure = fallback.pressure;
      const brushTaper = fallback.taper;
      // 平滑是"手感"的一部分：硬圆预设不做抖动修正，否则线条会被明显掰直。
      const brushSmoothing = fallback.smoothing;
      set({
        brushPreset: preset,
        brushSize,
        brushOpacity,
        brushHardness,
        brushSpacing,
        brushTexture,
        brushFlow,
        brushBlendMode,
        brushPressure,
        brushTaper,
        brushSmoothing
      });
      writePrefs({
        ...readPrefs(),
        brushPreset: preset,
        brushSize,
        brushOpacity,
        brushHardness,
        brushSpacing,
        brushTexture,
        brushFlow,
        brushBlendMode,
        brushPressure,
        brushTaper,
        brushSmoothing
      });
    },

    setBrushSize: (size) => {
      const brushSize = Math.min(60, Math.max(0.5, size));
      set({ brushSize });
      scheduleBrushPrefs({ brushSize });
    },

    setBrushOpacity: (opacity) => {
      const brushOpacity = Math.min(1, Math.max(0.05, opacity));
      set({ brushOpacity });
      scheduleBrushPrefs({ brushOpacity });
    },

    setBrushHardness: (hardness) => {
      const brushHardness = Math.min(1, Math.max(0, hardness));
      set({ brushHardness });
      scheduleBrushPrefs({ brushHardness });
    },

    setBrushSpacing: (spacing) => {
      const brushSpacing = Math.min(1.2, Math.max(0.05, spacing));
      set({ brushSpacing });
      scheduleBrushPrefs({ brushSpacing });
    },

    setBrushTexture: (texture) => {
      const brushTexture = Math.min(1, Math.max(0, texture));
      set({ brushTexture });
      scheduleBrushPrefs({ brushTexture });
    },

    setBrushFlow: (flow) => {
      const brushFlow = Math.min(1, Math.max(0, flow));
      set({ brushFlow });
      scheduleBrushPrefs({ brushFlow });
    },

    setBrushBlendMode: (mode) => {
      const brushBlendMode: BrushBlendMode = mode === 'multiply' ? 'multiply' : 'normal';
      set({ brushBlendMode });
      scheduleBrushPrefs({ brushBlendMode });
    },

    setBrushPressureCurve: (curve) => {
      const brushPressureCurve = Math.min(2, Math.max(0.4, curve));
      set({ brushPressureCurve });
      scheduleBrushPrefs({ brushPressureCurve });
    },

    importBrushLibrary: (brushes) => {
      const existing = get().customBrushes;
      const room = Math.max(0, 200 - existing.length);
      if (room === 0 || brushes.length === 0) return 0;
      const base = Date.now().toString(36);
      const incoming: CustomBrushPreset[] = brushes.slice(0, room).map((brush, index) => ({
        ...brush,
        id: `custom-${base}-${index}`,
        flow: brush.flow ?? 1,
        blendMode: brush.blendMode === 'multiply' ? 'multiply' : 'normal'
      }));
      const customBrushes = [...existing, ...incoming].slice(-200);
      set({ customBrushes });
      scheduleBrushPrefs({ customBrushes });
      return incoming.length;
    },

    saveCustomBrush: (name) => {
      const state = get();
      if (state.customBrushes.length >= 200) {
        get().notify('自定义笔刷已达上限 200', 'warn');
        return '';
      }
      const brush: CustomBrushPreset = {
        id: `custom-${Date.now().toString(36)}`,
        name: name?.trim() || `自定义 ${state.customBrushes.length + 1}`,
        width: state.brushSize,
        opacity: state.brushOpacity,
        hardness: state.brushHardness,
        spacing: state.brushSpacing,
        texture: state.brushTexture,
        pressure: state.brushPressure,
        taper: state.brushTaper,
        smoothing: state.brushSmoothing,
        flow: state.brushFlow,
        blendMode: state.brushBlendMode
      };
      const customBrushes = [...state.customBrushes, brush];
      set({ customBrushes });
      scheduleBrushPrefs({ customBrushes });
      return brush.name;
    },

    applyCustomBrush: (id) => {
      const state = get();
      const brush = state.customBrushes.find((item) => item.id === id);
      if (!brush) return false;
      set({
        brushSize: brush.width,
        brushOpacity: brush.opacity,
        brushHardness: brush.hardness,
        brushSpacing: brush.spacing,
        brushTexture: brush.texture,
        brushFlow: brush.flow ?? 1,
        brushBlendMode: brush.blendMode === 'multiply' ? 'multiply' : 'normal',
        brushPressure: brush.pressure,
        brushTaper: brush.taper,
        brushSmoothing: brush.smoothing
      });
      scheduleBrushPrefs({
        brushSize: brush.width,
        brushOpacity: brush.opacity,
        brushHardness: brush.hardness,
        brushSpacing: brush.spacing,
        brushTexture: brush.texture,
        brushFlow: brush.flow ?? 1,
        brushBlendMode: brush.blendMode === 'multiply' ? 'multiply' : 'normal',
        brushPressure: brush.pressure,
        brushTaper: brush.taper,
        brushSmoothing: brush.smoothing
      });
      return true;
    },

    deleteCustomBrush: (id) => {
      const customBrushes = get().customBrushes.filter((item) => item.id !== id);
      set({ customBrushes });
      scheduleBrushPrefs({ customBrushes });
    },

    setEraserSize: (size) => {
      const eraserSize = Math.min(80, Math.max(2, size));
      set({ eraserSize });
      scheduleBrushPrefs({ eraserSize });
    },

    setEraserCurrentLayer: (enabled) => {
      set({ eraserCurrentLayer: enabled });
      scheduleBrushPrefs({ eraserCurrentLayer: enabled });
    },

    setEraserTargets: (targets) => {
      set({ eraserTargets: targets });
      scheduleBrushPrefs({ eraserTargets: targets });
    },

    toggleEraserTarget: (target) => {
      const eraserTargets = toggleTarget(get().eraserTargets, target);
      set({ eraserTargets });
      scheduleBrushPrefs({ eraserTargets });
    },

    setPolygonSides: (sides) => {
      const polygonSides = Math.min(24, Math.max(3, Math.round(sides)));
      set({ polygonSides });
      scheduleBrushPrefs({ polygonSides });
    },

    setPolygonStar: (ratio) => {
      const polygonStar = Math.min(0.95, Math.max(0, ratio));
      set({ polygonStar });
      scheduleBrushPrefs({ polygonStar });
    },

    toggleShapeFromCenter: () => {
      const shapeFromCenter = !get().shapeFromCenter;
      set({ shapeFromCenter });
      scheduleBrushPrefs({ shapeFromCenter });
    },

    setStrokeDash: (dash) => {
      const defaultStyle = get().defaultStyle;
      set({
        strokeDash: dash,
        defaultStyle: {
          ...defaultStyle,
          stroke: { ...defaultStyle.stroke, dash: dashArrayFor(dash, defaultStyle.stroke.width) }
        }
      });
      scheduleBrushPrefs({ strokeDash: dash });
    },

    setStrokeCap: (cap) => {
      const defaultStyle = get().defaultStyle;
      set({
        strokeCap: cap,
        defaultStyle: { ...defaultStyle, stroke: { ...defaultStyle.stroke, cap } }
      });
      scheduleBrushPrefs({ strokeCap: cap });
    },

    setStrokeJoin: (join) => {
      const defaultStyle = get().defaultStyle;
      set({
        strokeJoin: join,
        defaultStyle: { ...defaultStyle, stroke: { ...defaultStyle.stroke, join } }
      });
      scheduleBrushPrefs({ strokeJoin: join });
    },

    setLineArrowEnd: (enabled) => {
      set({ lineArrowEnd: enabled });
      scheduleBrushPrefs({ lineArrowEnd: enabled });
    },

    toggleInlineValence: () => {
      const inlineValence = !get().inlineValence;
      set({ inlineValence });
      scheduleBrushPrefs({ inlineValence });
    },

    toggleImplicitHydrogens: () => {
      const doc = get().doc;
      get().updateDoc({ ...doc, implicitHydrogens: !doc.implicitHydrogens }, true);
    },

    rotateSelectionBy: (degrees) => {
      const { doc, selection } = get();
      if (selection.length === 0 || !degrees) return;
      if (lockedObjectsIn(doc, selection).length > 0) {
        get().notify('选中对象已锁定（或所在图层已锁定），请先解锁再旋转', 'warn');
        return;
      }
      const frame = selectionFrame(doc, selection);
      if (!frame) return;
      get().updateDoc(rotateDocumentObjects(doc, selection, frame.center, degrees), true);
    },

    flipSelection: (axis) => {
      const { doc, selection } = get();
      if (selection.length === 0) return;
      if (lockedObjectsIn(doc, selection).length > 0) {
        get().notify('选中对象已锁定（或所在图层已锁定），请先解锁再翻转', 'warn');
        return;
      }
      const frame = selectionFrame(doc, selection);
      if (!frame) return;
      if (axis === 'horizontal') {
        get().updateDoc(
          scaleDocumentObjectsInFrame(
            doc,
            selection,
            frame,
            { x: frame.center.x, y: frame.center.y },
            -1,
            1
          ),
          true
        );
      } else {
        get().updateDoc(
          scaleDocumentObjectsInFrame(
            doc,
            selection,
            frame,
            { x: frame.center.x, y: frame.center.y },
            1,
            -1
          ),
          true
        );
      }
    },

    toggleObjectLock: () => {
      const { doc, selection } = get();
      if (selection.length === 0) return;
      // 编组锁定时子对象一并锁定，否则仍可被直接命中选中。
      const ids = new Set(expandSelection(doc, selection));
      const targets = allObjects(doc).filter((obj) => ids.has(obj.id));
      if (targets.length === 0) return;
      // 混合选择时以“是否全部已锁”为准：只要有未锁对象就统一上锁，全部已锁才解锁。
      const nextLocked = !targets.every((obj) => obj.locked);
      get().updateDoc(
        {
          ...doc,
          layers: doc.layers.map((layer) => ({
            ...layer,
            objects: layer.objects.map((obj) =>
              ids.has(obj.id) ? { ...obj, locked: nextLocked } : obj
            )
          }))
        },
        true
      );
      get().notify(
        nextLocked ? '已锁定选中对象（可在图层列表解锁）' : '已解锁选中对象',
        'success'
      );
    },

    convertSelectionToPath: () => {
      const { doc, selection } = get();
      if (selection.length === 0) return;
      if (lockedObjectsIn(doc, selection).length > 0) {
        get().notify('选中对象已锁定（或所在图层已锁定），请先解锁再转换', 'warn');
        return;
      }
      // 只转换直接选中的形状；编组内的子对象不单独转，避免破坏编组结构。
      const ids = new Set(selection);
      const targets = allObjects(doc).filter((obj) => ids.has(obj.id));
      const { converted, skipped } = convertSelectionToPaths(targets);
      if (converted.size === 0) {
        get().notify('选中的对象不支持转换为路径', 'warn');
        return;
      }
      get().updateDoc(
        {
          ...doc,
          layers: doc.layers.map((layer) => ({
            ...layer,
            objects: layer.objects.map((obj) => converted.get(obj.id) ?? obj)
          }))
        },
        true
      );
      get().notify(
        `已转换 ${converted.size} 个对象为路径${skipped > 0 ? `，跳过 ${skipped} 个` : ''}`,
        'success'
      );
    },

    setBucketMode: (mode) => {
      set({ bucketMode: mode });
      scheduleBrushPrefs({ bucketMode: mode });
    },

    setBucketGap: (gap) => {
      const bucketGap = Math.min(12, Math.max(0, gap));
      set({ bucketGap });
      scheduleBrushPrefs({ bucketGap });
    },

    setBucketExpand: (expand) => {
      const bucketExpand = Math.min(4, Math.max(-2, expand));
      set({ bucketExpand });
      scheduleBrushPrefs({ bucketExpand });
    },

    setGuideDensity: (density) => {
      const guideDensity = Math.min(48, Math.max(8, Math.round(density)));
      set({ guideDensity });
      scheduleBrushPrefs({ guideDensity });
    },

    setGuideSpacing: (spacing) => {
      const guideSpacing = Math.min(600, Math.max(20, Math.round(spacing)));
      set({ guideSpacing });
      scheduleBrushPrefs({ guideSpacing });
    },

    setTextSettings: (settings) => {
      const textSettings = { ...get().textSettings, ...settings };
      set({ textSettings });
      scheduleBrushPrefs({ textSettings });
    },

    setTextComposerOpen: (open) => {
      if (get().textComposerOpen === open) return;
      set({ textComposerOpen: open });
    },

    setSymmetry: (mode) => set({ symmetry: mode }),

    setSymmetryAxis: (axis) => set({ symmetryAxis: axis }),

    cycleSymmetry: () => {
      const order: SymmetryMode[] = ['none', 'vertical', 'horizontal', 'both'];
      const index = order.indexOf(get().symmetry);
      set({ symmetry: order[(index + 1) % order.length] });
    },

    setGuideMode: (mode) =>
      // 只切换参考线；绘画辅助仍需用户显式开启，避免"一选模式笔迹就被拉直"。
      set({ guideMode: mode, guideAssist: mode === 'none' ? false : get().guideAssist }),

    setGuideSettings: (settings) =>
      set({ guideSettings: { ...get().guideSettings, ...settings } }),

    toggleGuideAssist: () => set({ guideAssist: !get().guideAssist }),

    applyEditorSnapshot: (snapshot) => {
      const current = get();
      // 文档笔刷并入本机库：按名称+参数去重，不覆盖本地已有笔刷。
      const merged = mergeBrushPresets(current.customBrushes, snapshot.customBrushes ?? [], {
        idPrefix: `doc-${Date.now().toString(36)}`
      });
      set({
        symmetry: snapshot.symmetry,
        symmetryAxis: { ...snapshot.symmetryAxis },
        guideMode: snapshot.guideMode,
        guideSettings: { ...snapshot.guideSettings },
        guideAssist: snapshot.guideAssist,
        guideDensity: snapshot.guideDensity,
        guideSpacing: snapshot.guideSpacing,
        ...(merged.added > 0 ? { customBrushes: merged.brushes } : {})
      });
      if (merged.added > 0) {
        scheduleBrushPrefs({ customBrushes: merged.brushes });
        get().notify(`已从文档载入 ${merged.added} 支自定义笔刷`, 'info');
      }
    },

    toggleClipToSelection: () => {
      const enabled = !get().clipToSelection;
      set({ clipToSelection: enabled, ...(enabled ? { alphaLock: false } : {}) });
      if (enabled && get().selection.length !== 1) {
        get().notify('请选中一个图形作为绘制范围', 'info');
      }
    },

    toggleAlphaLock: () => {
      const enabled = !get().alphaLock;
      set({ alphaLock: enabled, ...(enabled ? { clipToSelection: false } : {}) });
      if (enabled) get().notify('alpha 锁：新笔迹只显示在已有墨迹范围内', 'info');
    },

    startDocument: (templateId = DEFAULT_TEMPLATE_ID) => {
      if (get().route === 'editor' && get().isDirty && !confirmDiscard('新建文档')) return;
      clearAutosave();
      const template = TEMPLATE_MAP[templateId] ?? TEMPLATE_MAP[DEFAULT_TEMPLATE_ID];
      const doc = createDocument(template.id as TemplateId, nextDocumentName());
      const gridSize = get().gridSize;
      doc.grid = { ...doc.grid, size: gridSize, snapStep: gridSize };
      set({
        route: 'editor',
        doc,
        selection: [],
        activeTool: 'select',
        // 新文档从干净的工作环境开始，避免沿用上一篇文档的对称/透视设置。
        symmetry: 'none',
        symmetryAxis: { x: 0.5, y: 0.5 },
        guideMode: 'none',
        guideSettings: { ...DEFAULT_GUIDE_SETTINGS },
        guideAssist: false,
        leftTab: 'layers',
        viewport: { zoom: 1, pan: { x: 0, y: 0 } },
        cursor: null,
        dragPreview: null,
        past: [],
        future: [],
        pendingSnapshot: null,
        isDirty: false,
        fitToken: get().fitToken + 1,
        chemReport: null,
        propertiesOpen: false,
        exportPanelOpen: false
      });
    },

    loadDocument: (doc, path, dirty = false) => {
      clearAutosave();
      const template = TEMPLATE_MAP[doc.templateId];
      const entry: RecentEntry = {
        id: doc.id,
        name: doc.name,
        path,
        templateId: doc.templateId,
        templateName: template?.name ?? '自定义',
        sizeLabel: template?.sizeLabel ?? `${doc.page.width} × ${doc.page.height}`,
        openedAt: new Date().toISOString()
      };
      if (path) get().addRecent(entry);
      set({
        route: 'editor',
        doc: { ...doc, filePath: path },
        selection: [],
        activeTool: 'select',
        // 先清空编辑器环境；文件里带 editor 时由 applyEditorSnapshot 覆盖。
        symmetry: 'none',
        symmetryAxis: { x: 0.5, y: 0.5 },
        guideMode: 'none',
        guideSettings: { ...DEFAULT_GUIDE_SETTINGS },
        guideAssist: false,
        viewport: { zoom: 1, pan: { x: 0, y: 0 } },
        dragPreview: null,
        past: [],
        future: [],
        pendingSnapshot: null,
        isDirty: dirty,
        fitToken: get().fitToken + 1,
        chemReport: null,
        propertiesOpen: false,
        exportPanelOpen: false
      });
    },

    goToStart: (force = false) => {
      if (!force && get().route === 'editor' && get().isDirty && !confirmDiscard('返回启动页')) return;
      clearAutosave();
      set({
        route: 'start',
        activeTool: 'select',
        cursor: null,
        dragPreview: null,
        selection: [],
        propertiesOpen: false,
        exportPanelOpen: false,
        // 已离开编辑文档；启动页不再持有未保存状态，关闭窗口时不会重复确认。
        isDirty: false
      });
    },

    setTool: (tool) => {
      // 选文本/油漆桶/对称/辅助线时收起化学/形状组面板，否则底部会被旧横栏霸占，
      // 新工具的横栏无法出现；画笔等无独占横栏的工具保持现状（形状面板可继续开着）。
      // 化学面板例外：只要切到非化学工具就收起，避免"按 G 画多边形却看到化学横栏"。
      const clearsPanel =
        tool === 'text' ||
        tool === 'bucket' ||
        tool === 'symmetry' ||
        tool === 'guides' ||
        // 选择工具例外：允许先选中/移动对象，化学横栏继续保留，方便随后接着画。
        (get().toolPanel === 'chem' && !CHEM_TOOL_IDS.includes(tool) && tool !== 'select');
      if (tool === 'eyedropper' && get().activeTool !== 'eyedropper') {
        toolBeforeEyedropper = get().activeTool;
      }
      set({
        activeTool: tool,
        toolEpoch: get().toolEpoch + 1,
        // 中途换工具不能残留上一条手势的视觉 transform。
        dragPreview: null,
        ...(clearsPanel ? { toolPanel: null } : {})
      });
    },

    restoreToolAfterEyedropper: () => {
      const target = toolBeforeEyedropper === 'eyedropper' ? 'select' : toolBeforeEyedropper;
      get().setTool(target);
    },

    setToolPanel: (panel) => set({ toolPanel: panel }),

    setLeftTab: (tab) => set({ leftTab: tab }),

    setViewport: (viewport) => set({ viewport }),

    setViewportSize: (size) => set({ viewportSize: size }),

    setCanvasLeftInset: (inset) => set({ canvasLeftInset: Math.max(0, Math.round(inset)) }),

    panBy: (dx, dy) => {
      const { viewport } = get();
      set({ viewport: { ...viewport, pan: { x: viewport.pan.x + dx, y: viewport.pan.y + dy } } });
    },

    zoomAt: (factor, anchor) => {
      const { viewport } = get();
      const next = clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      set({ viewport: anchor ? zoomAround(viewport, next, anchor) : { ...viewport, zoom: next } });
    },

    setZoom: (zoom, anchor) => {
      const { viewport } = get();
      const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
      set({ viewport: anchor ? zoomAround(viewport, next, anchor) : { ...viewport, zoom: next } });
    },

    fitToCanvas: (size, padding = 56) => {
      const { doc, viewportSize, canvasLeftInset } = get();
      const target = size ?? viewportSize;
      if (target.width < 40 || target.height < 40) return;
      // 左侧调色板浮层覆盖画布：页面只在露出的区域里居中，避免被面板压住。
      const inset = Math.min(canvasLeftInset, Math.max(0, target.width - 80));
      const fit = fitViewport(
        target.width - inset,
        target.height,
        doc.page.width,
        doc.page.height,
        padding
      );
      set({ viewport: { zoom: fit.zoom, pan: { x: fit.pan.x + inset, y: fit.pan.y } } });
    },

    zoomToSelection: () => {
      const { doc, selection, viewportSize, canvasLeftInset } = get();
      const bounds = selection.length > 0 ? selectionBounds(doc, selection) : null;
      if (!bounds || viewportSize.width < 40 || viewportSize.height < 40) {
        get().fitToCanvas();
        return;
      }
      const inset = Math.min(canvasLeftInset, Math.max(0, viewportSize.width - 80));
      const availableW = Math.max(80, viewportSize.width - inset);
      const padding = 64;
      const zoom = clamp(
        Math.min(
          (availableW - padding * 2) / Math.max(1, bounds.width),
          (viewportSize.height - padding * 2) / Math.max(1, bounds.height)
        ),
        MIN_ZOOM,
        MAX_ZOOM
      );
      set({
        viewport: {
          zoom,
          pan: {
            x: inset + availableW / 2 - (bounds.x + bounds.width / 2) * zoom,
            y: viewportSize.height / 2 - (bounds.y + bounds.height / 2) * zoom
          }
        }
      });
    },

    toggleGrid: () => {
      const showGrid = !get().showGrid;
      set({ showGrid });
      writePrefs({ ...readPrefs(), showGrid });
    },

    toggleRulers: () => {
      const showRulers = !get().showRulers;
      set({ showRulers });
      writePrefs({ ...readPrefs(), showRulers });
    },

    toggleSnap: () => {
      const snapEnabled = !get().snapEnabled;
      set({ snapEnabled });
      writePrefs({ ...readPrefs(), snapEnabled });
    },

    toggleAutoOpenProperties: () => {
      const autoOpenProperties = !get().autoOpenProperties;
      set({ autoOpenProperties });
      writePrefs({ ...readPrefs(), autoOpenProperties });
    },

    toggleHoverHighlight: () => {
      const hoverHighlight = !get().hoverHighlight;
      set({ hoverHighlight });
      writePrefs({ ...readPrefs(), hoverHighlight });
    },

    setCornerRadius: (radius) => {
      const cornerRadius = clamp(Math.round(radius), 0, 400);
      set({ cornerRadius });
      writePrefs({ ...readPrefs(), cornerRadius });
    },

    setBrushSmoothing: (amount) => {
      const brushSmoothing = clamp(Math.round(amount), 0, 100);
      set({ brushSmoothing });
      writePrefs({ ...readPrefs(), brushSmoothing });
    },

    setUiDensity: (uiDensity) => {
      set({ uiDensity });
      writePrefs({ ...readPrefs(), uiDensity });
    },

    setReduceMotion: (reduceMotion) => {
      set({ reduceMotion });
      writePrefs({ ...readPrefs(), reduceMotion });
    },

    setGridSize: (size) => {
      const gridSize = clamp(Math.round(size), 2, 100);
      const doc = get().doc;
      set({ gridSize });
      writePrefs({ ...readPrefs(), gridSize });
      if (doc.grid.size !== gridSize || doc.grid.snapStep !== gridSize) {
        get().updateDoc(
          {
            ...doc,
            grid: { ...doc.grid, size: gridSize, snapStep: gridSize }
          },
          true
        );
      }
    },

    setAutoSaveSeconds: (seconds) => {
      const allowed = [0, 15, 30, 60];
      const autoSaveSeconds = allowed.includes(Math.round(seconds)) ? Math.round(seconds) : 15;
      set({ autoSaveSeconds });
      writePrefs({ ...readPrefs(), autoSaveSeconds });
    },

    setToolShortcut: (toolId, key) => {
      const normalized = key.trim().toLowerCase().slice(0, 1);
      const next: Record<string, string> = {};
      for (const [id, value] of Object.entries(get().toolShortcuts)) {
        if (id !== toolId && value !== normalized) next[id] = value;
      }
      if (normalized) {
        if (!/^[a-z0-9]$/.test(normalized)) return;
        next[toolId] = normalized;
      }
      set({ toolShortcuts: next });
      writePrefs({ ...readPrefs(), toolShortcuts: next });
    },

    resetToolShortcuts: () => {
      set({ toolShortcuts: {} });
      writePrefs({ ...readPrefs(), toolShortcuts: {} });
    },

    openSettings: () => set({ settingsOpen: true }),
    closeSettings: () => set({ settingsOpen: false }),

    setDefaultFill: (color) => {
      const style = get().defaultStyle;
      set({ defaultStyle: { ...style, fill: color ? { type: 'solid', color } : { type: 'none' } } });
    },

    setDefaultStroke: (color) => {
      const style = get().defaultStyle;
      set({
        defaultStyle: { ...style, stroke: { ...style.stroke, paint: { type: 'solid', color } } }
      });
    },

    setStrokeWidth: (width) => {
      const style = get().defaultStyle;
      set({ defaultStyle: { ...style, stroke: { ...style.stroke, width: clamp(width, 0, 40) } } });
    },

    setDefaultOpacity: (opacity) => {
      const style = get().defaultStyle;
      set({ defaultStyle: { ...style, opacity: clamp(opacity, 0.05, 1) } });
    },

    setCursor: (point) => set({ cursor: point }),

    setDragPreview: (dragPreview) => set({ dragPreview }),

    notify: (message, tone = 'info') => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      set({ toasts: [...get().toasts.slice(-2), { id, message, tone }] });
      window.setTimeout(() => get().dismissToast(id), 2800);
    },

    dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),

    setChem: (patch) => set({ chem: { ...get().chem, ...patch } }),

    setChemDefaults: (patch) => {
      const chem = { ...get().chem, ...patch };
      set({ chem });
      writePrefs({
        ...readPrefs(),
        chemBondType: chem.bondType,
        chemBondFixed: chem.bondFixed,
        chemBondUniform: chem.bondUniform,
        chemBenzeneStyle: chem.benzeneStyle
      });
    },

    setChemBondMetric: (key, value) => {
      const normalize = (metric: 'length' | 'width' | 'spacing' | 'atomSize', raw: number) => {
        const range =
          metric === 'length'
            ? CHEM_BOND_LENGTH_RANGE
            : metric === 'width'
              ? CHEM_BOND_WIDTH_RANGE
              : metric === 'spacing'
                ? CHEM_BOND_SPACING_RANGE
                : CHEM_ATOM_SIZE_RANGE;
        const clamped = clamp(raw, range.min, range.max);
        return metric === 'atomSize'
          ? Math.round(clamped)
          : Math.round(clamped * 10) / 10;
      };
      const state = get();
      const normalized = normalize(key, value);
      const current = {
        length: state.chemBondLength,
        width: state.chemBondWidth,
        spacing: state.chemBondSpacing,
        atomSize: state.chemAtomSize
      };
      if (!state.chem.bondUniform) {
        const next = { ...current, [key]: normalized };
        set({
          chemBondLength: next.length,
          chemBondWidth: next.width,
          chemBondSpacing: next.spacing,
          chemAtomSize: next.atomSize
        });
        scheduleBrushPrefs({
          chemBondLength: next.length,
          chemBondWidth: next.width,
          chemBondSpacing: next.spacing,
          chemAtomSize: next.atomSize
        });
        return;
      }
      const factor = normalized / Math.max(0.0001, current[key]);
      const next = {
        length: normalize('length', current.length * factor),
        width: normalize('width', current.width * factor),
        spacing: normalize('spacing', current.spacing * factor),
        atomSize: normalize('atomSize', current.atomSize * factor)
      };
      // 被直接编辑的那一项以用户输入为准，避免浮点/取整导致输入值回跳。
      next[key] = normalized;
      set({
        chemBondLength: next.length,
        chemBondWidth: next.width,
        chemBondSpacing: next.spacing,
        chemAtomSize: next.atomSize
      });
      scheduleBrushPrefs({
        chemBondLength: next.length,
        chemBondWidth: next.width,
        chemBondSpacing: next.spacing,
        chemAtomSize: next.atomSize
      });
    },

    resetChemBondMetrics: () => {
      set({
        chemBondLength: CHEM_BOND_LENGTH_DEFAULT,
        chemBondWidth: CHEM_BOND_WIDTH_DEFAULT,
        chemBondSpacing: CHEM_BOND_SPACING_DEFAULT,
        chemRingBondSpacing: CHEM_RING_BOND_SPACING_DEFAULT,
        chemAtomSize: CHEM_ATOM_SIZE_DEFAULT
      });
      scheduleBrushPrefs({
        chemBondLength: CHEM_BOND_LENGTH_DEFAULT,
        chemBondWidth: CHEM_BOND_WIDTH_DEFAULT,
        chemBondSpacing: CHEM_BOND_SPACING_DEFAULT,
        chemRingBondSpacing: CHEM_RING_BOND_SPACING_DEFAULT,
        chemAtomSize: CHEM_ATOM_SIZE_DEFAULT
      });
    },

    setChemBondLength: (length) => {
      const value = clamp(Math.round(length * 10) / 10, CHEM_BOND_LENGTH_RANGE.min, CHEM_BOND_LENGTH_RANGE.max);
      set({ chemBondLength: value });
      scheduleBrushPrefs({ chemBondLength: value });
    },

    setChemBondWidth: (width) => {
      const value = clamp(Math.round(width * 10) / 10, CHEM_BOND_WIDTH_RANGE.min, CHEM_BOND_WIDTH_RANGE.max);
      set({ chemBondWidth: value });
      scheduleBrushPrefs({ chemBondWidth: value });
    },

    setChemBondSpacing: (spacing) => {
      const value = clamp(
        Math.round(spacing * 10) / 10,
        CHEM_BOND_SPACING_RANGE.min,
        CHEM_BOND_SPACING_RANGE.max
      );
      set({ chemBondSpacing: value });
      scheduleBrushPrefs({ chemBondSpacing: value });
    },

    setChemRingBondSpacing: (spacing) => {
      const value = clamp(
        Math.round(spacing * 10) / 10,
        CHEM_BOND_SPACING_RANGE.min,
        CHEM_BOND_SPACING_RANGE.max
      );
      set({ chemRingBondSpacing: value });
      scheduleBrushPrefs({ chemRingBondSpacing: value });
    },

    setChemCationPlacement: (placement) => {
      set({ chemCationPlacement: placement });
      scheduleBrushPrefs({ chemCationPlacement: placement });
    },

    setChemSaltDistance: (distance) => {
      const value = clamp(
        Math.round(distance),
        CHEM_SALT_DISTANCE_RANGE.min,
        CHEM_SALT_DISTANCE_RANGE.max
      );
      set({ chemSaltDistance: value });
      scheduleBrushPrefs({ chemSaltDistance: value });
    },

    setChemHideCharges: (hide) => {
      set({ chemHideCharges: hide });
      scheduleBrushPrefs({ chemHideCharges: hide });
    },

    setChemAtomSize: (size) => {
      const value = clamp(
        Math.round(size),
        CHEM_ATOM_SIZE_RANGE.min,
        CHEM_ATOM_SIZE_RANGE.max
      );
      set({ chemAtomSize: value });
      scheduleBrushPrefs({ chemAtomSize: value });
    },

    updateDoc: (next, record = true) => {
      const { doc, past, pendingSnapshot, symmetry, symmetryAxis } = get();
      if (next === doc) return;

      // 对称联动：镜像对象是派生数据，源对象一改就按当前轴/模式同步。
      // 直接拖镜像会被"拉回"到源对象的镜像位置，这是派生对象的预期语义。
      let resolved = next;
      const hasMirrors = next.layers.some((layer) =>
        layer.objects.some((object) => Boolean(object.mirrorOf))
      );
      // 事务（拖拽）期间先不同步，避免每一帧都重建镜像；抬手时在 endTransaction 统一同步。
      if (symmetry !== 'none' && hasMirrors && !pendingSnapshot) {
        let touchedMirror = false;
        for (const layer of next.layers) {
          for (const object of layer.objects) {
            if (!object.mirrorOf) continue;
            const before = getObject(doc, object.id);
            if (before && before !== object) touchedMirror = true;
          }
        }
        const synced = regenerateMirrors(
          next,
          symmetryAxis,
          symmetry,
          next.page.width,
          next.page.height
        );
        if (synced.changed > 0 || synced.removed > 0) resolved = synced.doc;
        if (touchedMirror && !mirrorEditWarned) {
          mirrorEditWarned = true;
          get().notify('镜像为派生对象，已按源对象自动同步；请编辑源对象', 'info');
        }
      }

      if (resolved === doc) return;
      if (record && !pendingSnapshot) {
        set({
          doc: resolved,
          past: [...past, doc].slice(-HISTORY_LIMIT),
          future: [],
          isDirty: true
        });
      } else {
        set({ doc: resolved, isDirty: true });
      }
    },

    beginTransaction: () => {
      if (get().pendingSnapshot) return;
      set({ pendingSnapshot: get().doc });
    },

    endTransaction: () => {
      const { pendingSnapshot, doc, symmetry, symmetryAxis } = get();
      if (!pendingSnapshot) return;
      // 拖拽结束后统一同步镜像，保证移动/缩放/擦除/节点编辑都能带动对侧。
      let resolved = doc;
      if (symmetry !== 'none') {
        const hasMirrors = doc.layers.some((layer) =>
          layer.objects.some((object) => Boolean(object.mirrorOf))
        );
        if (hasMirrors) {
          const synced = regenerateMirrors(
            doc,
            symmetryAxis,
            symmetry,
            doc.page.width,
            doc.page.height
          );
          if (synced.changed > 0 || synced.removed > 0) resolved = synced.doc;
        }
      }
      if (pendingSnapshot !== resolved) pushHistory(pendingSnapshot);
      else set({ pendingSnapshot: null });
      if (resolved !== doc) set({ doc: resolved, isDirty: true });
    },

    undo: () => {
      const { past, future, doc, selection } = get();
      if (past.length === 0) return;
      const previous = past[past.length - 1];
      set({
        doc: previous,
        past: past.slice(0, -1),
        future: [doc, ...future].slice(0, HISTORY_LIMIT),
        selection: selection.filter((id) => Boolean(getObject(previous, id))),
        pendingSnapshot: null,
        dragPreview: null,
        isDirty: true
      });
    },

    redo: () => {
      const { past, future, doc, selection } = get();
      if (future.length === 0) return;
      const next = future[0];
      set({
        doc: next,
        past: [...past, doc].slice(-HISTORY_LIMIT),
        future: future.slice(1),
        selection: selection.filter((id) => Boolean(getObject(next, id))),
        pendingSnapshot: null,
        dragPreview: null,
        isDirty: true
      });
    },

    setSelection: (ids, additive = false) => {
      if (!additive) {
        const next = [...new Set(ids)];
        set({
          selection: next,
          dragPreview: null,
          propertiesOpen: next.length > 0 && get().autoOpenProperties ? true : get().propertiesOpen
        });
        return;
      }
      const next = new Set(get().selection);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      const selection = [...next];
      set({
        selection,
        dragPreview: null,
        propertiesOpen: selection.length > 0 && get().autoOpenProperties ? true : get().propertiesOpen
      });
    },

    selectAll: () => {
      const { doc } = get();
      const ids = allObjects(doc)
        .filter((obj) => !obj.parentId)
        .filter((obj) => {
          const layer = getLayerOfObject(doc, obj.id);
          return layer?.visible && !layer.locked && obj.visible && !obj.locked;
        })
        .map((obj) => obj.id);
      const selection = [...new Set(ids)];
      set({
        selection,
        dragPreview: null,
        propertiesOpen: selection.length > 0 && get().autoOpenProperties ? true : get().propertiesOpen
      });
    },

    copySelection: () => {
      const { doc, selection } = get();
      const objects = clipboardObjects(doc, selection);
      if (objects.length === 0) {
        get().notify('没有可复制的对象', 'warn');
        return;
      }
      set({ clipboard: objects });
      get().notify(`已复制 ${selection.length} 个对象`, 'success');
    },

    pasteClipboard: () => {
      const { clipboard, doc } = get();
      if (!clipboard || clipboard.length === 0) {
        get().notify('剪贴板为空', 'warn');
        return;
      }
      const layer = drawLayer(doc);
      if (!layer || layer.locked) {
        get().notify('当前图层已锁定，无法粘贴', 'warn');
        return;
      }
      const cloned = cloneLayerObjects(clipboard, layer.id);
      const topIds = cloned.filter((obj) => !obj.parentId).map((obj) => obj.id);
      const temp: VDrawDocument = {
        ...doc,
        layers: [{ ...layer, objects: cloned }],
        activeLayerId: layer.id
      };
      const shifted = translateDocumentObjects(temp, topIds, 12, 12);
      const shiftedObjects = shifted.layers[0]?.objects ?? [];
      get().addObjects(shiftedObjects, layer.id);
      get().notify(`已粘贴 ${topIds.length} 个对象`, 'success');
    },

    duplicateSelection: () => {
      const { doc, selection } = get();
      const objects = clipboardObjects(doc, selection);
      if (objects.length === 0) {
        get().notify('没有可复制的对象', 'warn');
        return;
      }
      const layer = drawLayer(doc);
      if (!layer || layer.locked) {
        get().notify('当前图层已锁定，无法复制对象', 'warn');
        return;
      }
      const cloned = cloneLayerObjects(objects, layer.id);
      const topIds = cloned.filter((obj) => !obj.parentId).map((obj) => obj.id);
      const temp: VDrawDocument = {
        ...doc,
        layers: [{ ...layer, objects: cloned }],
        activeLayerId: layer.id
      };
      const shifted = translateDocumentObjects(temp, topIds, 12, 12);
      get().addObjects(shifted.layers[0]?.objects ?? [], layer.id);
    },

    clearSelection: () => set({ selection: [] }),

    addObjects: (objects, layerId) => {
      const { doc } = get();
      const targetId = layerId ?? doc.activeLayerId;
      const layer = doc.layers.find((item) => item.id === targetId);
      if (!layer) return false;
      if (layer.locked) {
        get().notify('当前图层已锁定，请先解锁', 'warn');
        return false;
      }
      const state = get();
      let clipIds: string[] | undefined;
      if (state.alphaLock) {
        // alpha 锁：以"添加前"的图层墨迹为剪影集合（上限 200，避免超大文档导出膨胀）。
        clipIds = layer.objects
          .filter((obj) => obj.visible && !obj.clipIds)
          .slice(0, 200)
          .map((obj) => obj.id);
      } else if (state.clipToSelection && state.selection.length === 1) {
        const target = getObject(doc, state.selection[0]);
        if (target && canClip(target)) clipIds = [target.id];
      }
      const prepared = objects.map((obj) => ({
        ...obj,
        layerId: targetId,
        ...(clipIds && clipIds.length > 0 ? { clipIds } : {})
      }));
      const next = addObjectsToLayer(doc, targetId, prepared);
      get().updateDoc(next, true);
      const topLevel = prepared.filter((obj) => !obj.parentId).map((obj) => obj.id);
      // 画笔连续作画时不应每笔都被选中：否则画布常驻选择框，Delete/拖拽极易误伤上一笔。
      const selectNewObjects = get().activeTool !== 'brush';
      set({
        selection: selectNewObjects ? topLevel : get().selection,
        propertiesOpen:
          selectNewObjects && topLevel.length > 0 && get().autoOpenProperties
            ? true
            : get().propertiesOpen
      });
      return true;
    },

    deleteSelection: () => {
      const { doc, selection } = get();
      if (selection.length === 0) return;
      const ids = deletionSet(doc, selection);
      const locked = lockedObjectsIn(doc, [...ids]);
      if (locked.length > 0) {
        get().notify(
          `选中的 ${locked.length} 个对象已锁定（或所在图层已锁定），请先解锁再删除`,
          'warn'
        );
        return;
      }
      // 与橡皮共用善后流程：清理空编组、解除已断开的芳香环、重算编组包围盒。
      const next = eraseObjects(doc, [...ids]);
      get().updateDoc(next, true);
      set({ selection: [] });
    },

    duplicateObject: (id) => {
      const { doc } = get();
      const source = getObject(doc, id);
      if (!source) return;
      const layer = doc.layers.find((item) => item.id === source.layerId);
      if (!layer) return;
      if (layer.locked || source.locked) {
        get().notify('图层或对象已锁定，无法复制对象', 'warn');
        return;
      }
      const objects = clipboardObjects(doc, [id]);
      if (objects.length === 0) return;
      const cloned = cloneLayerObjects(objects, layer.id);
      const topIds = cloned.filter((obj) => !obj.parentId).map((obj) => obj.id);
      // 在源对象所在图层内偏移 12px 复制，保持图层归属与编组结构。
      const temp: VDrawDocument = {
        ...doc,
        layers: [{ ...layer, objects: cloned }],
        activeLayerId: layer.id
      };
      const shifted = translateDocumentObjects(temp, topIds, 12, 12);
      const prepared = shifted.layers[0]?.objects ?? [];
      // 复制件紧贴源对象下方：数组更靠前 = 层级更低，列表中正好显示在原对象下一行。
      const sourceIndex = layer.objects.findIndex((obj) => obj.id === id);
      const next = insertObjectsIntoLayer(
        doc,
        layer.id,
        prepared,
        sourceIndex < 0 ? layer.objects.length : sourceIndex
      );
      get().updateDoc(next, true);
      set({ selection: topIds });
      get().notify('已复制对象', 'success');
    },

    deleteObject: (id) => {
      const { doc, selection } = get();
      if (!getObject(doc, id)) return;
      const ids = deletionSet(doc, [id]);
      const locked = lockedObjectsIn(doc, [...ids]);
      if (locked.length > 0) {
        get().notify('对象已锁定（或所在图层已锁定），请先解锁再删除', 'warn');
        return;
      }
      const next = eraseObjects(doc, [...ids]);
      get().updateDoc(next, true);
      set({ selection: selection.filter((item) => !ids.has(item)) });
    },

    moveObjectTo: (dragId, targetId, placement) => {
      const { doc } = get();
      if (dragId === targetId) return;
      const drag = getObject(doc, dragId);
      const target = getObject(doc, targetId);
      if (!drag || !target || drag.layerId !== target.layerId) return;
      if (drag.locked || getLayerOfObject(doc, dragId)?.locked) {
        get().notify('对象已锁定（或所在图层已锁定），请先解锁再调整层级', 'warn');
        return;
      }
      // 只在同一父级内排序：编组子对象不能拖到编组外，避免结构散架。
      if ((drag.parentId ?? null) !== (target.parentId ?? null)) {
        get().notify('只能在同一编组内调整对象层级', 'info');
        return;
      }
      // 数组顺序即绘制顺序：越靠后越在上层。
      let changed = false;
      const next = {
        ...doc,
        layers: doc.layers.map((layer) => {
          if (layer.id !== drag.layerId) return layer;
          const objects = [...layer.objects];
          const from = objects.findIndex((obj) => obj.id === dragId);
          if (from < 0) return layer;
          const [moved] = objects.splice(from, 1);
          const to = objects.findIndex((obj) => obj.id === targetId);
          if (to < 0) return layer;
          objects.splice(placement === 'above' ? to + 1 : to, 0, moved);
          changed = true;
          return { ...layer, objects };
        })
      };
      if (changed) get().updateDoc(next, true);
    },

    groupSelection: () => {
      const { doc, selection } = get();
      const ids = selection.filter((id) => Boolean(getObject(doc, id)));
      if (ids.length < 2) {
        get().notify('请选择至少两个对象后再编组', 'warn');
        return;
      }
      if (lockedObjectsIn(doc, ids).length > 0) {
        get().notify('选中对象已锁定（或所在图层已锁定），请先解锁再编组', 'warn');
        return;
      }
      const objects = ids.map((id) => getObject(doc, id)).filter(Boolean) as SceneObject[];
      const layers = new Set(objects.map((obj) => obj.layerId));
      if (layers.size > 1) {
        get().notify('请在同一图层内选择对象后编组', 'warn');
        return;
      }
      const layer = doc.layers.find((item) => item.id === objects[0].layerId);
      if (!layer || layer.locked) {
        get().notify('图层已锁定，无法编组', 'warn');
        return;
      }
      const bounds = unionRects(objects.map((obj) => getObjectBounds(obj, doc)));
      const group = createGroupObject(layer.id, `编组 ${objects.length}`, bounds, ids);
      const next = {
        ...doc,
        layers: doc.layers.map((item) => {
          if (item.id !== layer.id) return item;
          return {
            ...item,
            objects: [
              ...item.objects.map((obj) => (ids.includes(obj.id) ? { ...obj, parentId: group.id } : obj)),
              group
            ]
          };
        })
      };
      get().updateDoc(next, true);
      set({ selection: [group.id] });
    },

    ungroupSelection: () => {
      const { doc, selection } = get();
      const groups = selection
        .map((id) => getObject(doc, id))
        .filter((obj): obj is SceneObject => Boolean(obj && obj.type === 'group'));
      if (groups.length === 0) return;
      if (lockedObjectsIn(doc, groups.map((group) => group.id)).length > 0) {
        get().notify('编组或所在图层已锁定，请先解锁再解组', 'warn');
        return;
      }
      const groupIds = new Set(groups.map((group) => group.id));
      const childIds: string[] = [];
      const next = {
        ...doc,
        layers: doc.layers.map((layer) => ({
          ...layer,
          objects: layer.objects
            .filter((obj) => !groupIds.has(obj.id))
            .map((obj) => {
              if (obj.parentId && groupIds.has(obj.parentId)) {
                childIds.push(obj.id);
                return { ...obj, parentId: null };
              }
              return obj;
            })
        }))
      };
      get().updateDoc(next, true);
      set({ selection: childIds });
    },

    alignSelection: (mode) => {
      const { doc, selection } = get();
      if (selection.length === 0) return;
      if (lockedObjectsIn(doc, selection).length > 0) {
        get().notify('选中对象已锁定（或所在图层已锁定），请先解锁再对齐', 'warn');
        return;
      }
      const pageBounds = { x: 0, y: 0, width: doc.page.width, height: doc.page.height };
      const reference =
        selection.length >= 2 ? selectionBounds(doc, selection) ?? pageBounds : pageBounds;
      let next = doc;
      for (const id of selection) {
        const obj = getObject(next, id);
        if (!obj) continue;
        const bounds = getObjectBounds(obj, next);
        let dx = 0;
        let dy = 0;
        if (mode === 'left') dx = reference.x - bounds.x;
        if (mode === 'center-h') dx = reference.x + reference.width / 2 - (bounds.x + bounds.width / 2);
        if (mode === 'right') dx = reference.x + reference.width - (bounds.x + bounds.width);
        if (mode === 'top') dy = reference.y - bounds.y;
        if (mode === 'center-v') dy = reference.y + reference.height / 2 - (bounds.y + bounds.height / 2);
        if (mode === 'bottom') dy = reference.y + reference.height - (bounds.y + bounds.height);
        next = translateDocumentObjects(next, [id], dx, dy);
      }
      get().updateDoc(next, true);
    },

    distributeSelection: (axis) => {
      const { doc, selection } = get();
      if (selection.length < 3) {
        get().notify('分布对象需要至少三个对象', 'warn');
        return;
      }
      if (lockedObjectsIn(doc, selection).length > 0) {
        get().notify('选中对象已锁定（或所在图层已锁定），请先解锁再分布', 'warn');
        return;
      }
      const items = selection
        .map((id) => {
          const obj = getObject(doc, id);
          return obj ? { id, bounds: getObjectBounds(obj, doc) } : null;
        })
        .filter(Boolean) as { id: string; bounds: ReturnType<typeof getObjectBounds> }[];
      items.sort((a, b) =>
        axis === 'h'
          ? a.bounds.x - b.bounds.x
          : a.bounds.y - b.bounds.y
      );
      const first = items[0];
      const last = items[items.length - 1];
      const span =
        axis === 'h'
          ? last.bounds.x + last.bounds.width - first.bounds.x
          : last.bounds.y + last.bounds.height - first.bounds.y;
      const totalSize = items.reduce(
        (sum, item) => sum + (axis === 'h' ? item.bounds.width : item.bounds.height),
        0
      );
      const gap = (span - totalSize) / (items.length - 1);
      let cursor = axis === 'h' ? first.bounds.x : first.bounds.y;
      let next = doc;
      for (const item of items) {
        const bounds = item.bounds;
        const currentStart = axis === 'h' ? bounds.x : bounds.y;
        const delta = cursor - currentStart;
        next = translateDocumentObjects(next, [item.id], axis === 'h' ? delta : 0, axis === 'v' ? delta : 0);
        cursor += (axis === 'h' ? bounds.width : bounds.height) + gap;
      }
      get().updateDoc(next, true);
    },

    reorderSelection: (mode) => {
      const { doc, selection } = get();
      if (selection.length === 0) return;
      if (lockedObjectsIn(doc, selection).length > 0) {
        get().notify('选中对象已锁定（或所在图层已锁定），请先解锁再调整层级', 'warn');
        return;
      }
      const ids = new Set(expandSelection(doc, selection));
      const next = {
        ...doc,
        layers: doc.layers.map((layer) => {
          const affected = layer.objects.filter((obj) => ids.has(obj.id));
          if (affected.length === 0) return layer;
          const rest = layer.objects.filter((obj) => !ids.has(obj.id));
          let objects = layer.objects;
          if (mode === 'front') objects = [...rest, ...affected];
          else if (mode === 'back') objects = [...affected, ...rest];
          else if (mode === 'forward') {
            objects = [...layer.objects];
            // 从后往前扫，选中的对象各自向上一层，避免一次跨越多个对象。
            for (let index = objects.length - 2; index >= 0; index -= 1) {
              if (ids.has(objects[index].id) && !ids.has(objects[index + 1].id)) {
                [objects[index], objects[index + 1]] = [objects[index + 1], objects[index]];
              }
            }
          } else {
            objects = [...layer.objects];
            for (let index = 1; index < objects.length; index += 1) {
              if (ids.has(objects[index].id) && !ids.has(objects[index - 1].id)) {
                [objects[index], objects[index - 1]] = [objects[index - 1], objects[index]];
              }
            }
          }
          return { ...layer, objects };
        })
      };
      get().updateDoc(next, true);
    },

    addLayer: () => {
      const { doc } = get();
      const layer = createLayer(nextLayerName(doc.layers), 'vector');
      get().updateDoc(
        { ...doc, layers: [...doc.layers, layer], activeLayerId: layer.id },
        true
      );
    },

    addLayerFolder: () => {
      const { doc } = get();
      const count = doc.layers.filter((layer) => layer.kind === 'folder').length;
      const folder: Layer = {
        ...createLayer(`文件夹 ${count + 1}`, 'folder'),
        parentId: null
      };
      get().updateDoc(
        { ...doc, layers: [...doc.layers, folder], activeLayerId: folder.id },
        true
      );
    },

    duplicateLayer: (layerId) => {
      const { doc } = get();
      const index = doc.layers.findIndex((layer) => layer.id === layerId);
      const layer = doc.layers[index];
      if (!layer) return;
      if (layer.kind === 'folder') {
        get().notify('文件夹暂不支持复制，请复制其中的图层', 'warn');
        return;
      }
      const copyId = createId('layer');
      const copy: Layer = {
        ...layer,
        id: copyId,
        name: nextLayerName(doc.layers),
        objects: cloneLayerObjects(layer.objects, copyId)
      };
      const layers = [...doc.layers];
      layers.splice(index + 1, 0, copy);
      get().updateDoc({ ...doc, layers, activeLayerId: copy.id }, true);
      set({ selection: copy.objects.filter((obj) => !obj.parentId).map((obj) => obj.id) });
    },

    mergeLayerDown: (layerId) => {
      const { doc } = get();
      const index = doc.layers.findIndex((layer) => layer.id === layerId);
      const source = doc.layers[index];
      if (!source) return;
      if (source.kind === 'folder') {
        get().notify('文件夹无法合并，请选择具体图层', 'warn');
        return;
      }
      if (source.locked) {
        get().notify('当前图层已锁定，请先解锁再向下合并', 'warn');
        return;
      }
      let targetIndex = -1;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = doc.layers[cursor];
        if ((candidate.parentId ?? null) !== (source.parentId ?? null)) continue;
        if (candidate.kind === 'folder' || candidate.locked) continue;
        targetIndex = cursor;
        break;
      }
      if (targetIndex < 0) {
        get().notify('下方没有可合并的图层', 'warn');
        return;
      }
      const target = doc.layers[targetIndex];
      const moved = source.objects.map((obj) => ({ ...obj, layerId: target.id }));
      const layers = doc.layers
        .map((layer) =>
          layer.id === target.id ? { ...layer, objects: [...layer.objects, ...moved] } : layer
        )
        .filter((layer) => layer.id !== source.id);
      get().updateDoc({ ...doc, layers, activeLayerId: target.id }, true);
      set({ selection: [] });
      get().notify(`已将「${source.name}」合并到「${target.name}」`, 'success');
    },

    moveLayerTo: (layerId, targetId, position) => {
      const { doc } = get();
      if (layerId === targetId) return;
      const moving = doc.layers.find((layer) => layer.id === layerId);
      const target = doc.layers.find((layer) => layer.id === targetId);
      if (!moving || !target) return;
      // 防止把文件夹拖进自己的子孙层级
      let ancestor: string | null = target.parentId ?? null;
      const guard = new Set<string>();
      while (ancestor) {
        if (ancestor === layerId) {
          get().notify('不能将文件夹移动到自身内部', 'warn');
          return;
        }
        if (guard.has(ancestor)) break;
        guard.add(ancestor);
        ancestor = doc.layers.find((layer) => layer.id === ancestor)?.parentId ?? null;
      }
      if (position === 'inside' && target.kind !== 'folder') return;

      const rest = doc.layers.filter((layer) => layer.id !== layerId);
      const targetIndex = rest.findIndex((layer) => layer.id === targetId);
      if (targetIndex < 0) return;
      const next: Layer = { ...moving };
      if (position === 'inside') {
        next.parentId = target.id;
        rest.splice(targetIndex + 1, 0, next);
      } else {
        next.parentId = target.parentId ?? null;
        // 图层面板按数组倒序渲染：视觉上的“上方”对应数组更大的索引。
        rest.splice(position === 'before' ? targetIndex + 1 : targetIndex, 0, next);
      }
      get().updateDoc({ ...doc, layers: rest }, true);
    },

    deleteLayer: (layerId) => {
      const { doc } = get();
      if (doc.layers.length <= 1) {
        get().notify('至少需要保留一个图层', 'warn');
        return;
      }
      const removed = doc.layers.find((layer) => layer.id === layerId);
      if (!removed) return;
      const subtree = doc.layers.filter(
        (layer) => layer.id === layerId || layer.parentId === layerId
      );
      if (subtree.some((layer) => layer.locked)) {
        get().notify('图层或子图层已锁定，请先解锁再删除', 'warn');
        return;
      }
      const removedIndex = doc.layers.findIndex((layer) => layer.id === layerId);
      const childIds = doc.layers
        .filter((layer) => layer.parentId === layerId)
        .map((layer) => layer.id);
      let layers = doc.layers
        .filter((layer) => layer.id !== layerId)
        .map((layer) =>
          layer.parentId === layerId ? { ...layer, parentId: removed.parentId ?? null } : layer
        );
      let activeLayerId = doc.activeLayerId === layerId ? null : doc.activeLayerId;

      // 文件夹只是容器：删除时把直接持有的对象迁移到子图层，避免静默丢内容。
      if (removed.kind === 'folder' && removed.objects.length > 0) {
        let host =
          layers.find((layer) => childIds.includes(layer.id) && layer.kind !== 'folder') ??
          layers.find((layer) => layer.kind !== 'folder');
        if (!host) {
          host = createLayer('图层 1');
          host.parentId = removed.parentId ?? null;
          layers = [...layers];
          layers.splice(Math.min(removedIndex, layers.length), 0, host);
        }
        const migrated = removed.objects.map((obj) => ({ ...obj, layerId: host!.id }));
        host.objects = [...host.objects, ...migrated];
        activeLayerId = activeLayerId ?? host.id;
      }

      if (!activeLayerId) {
        activeLayerId =
          layers.find((layer) => layer.kind !== 'folder')?.id ?? layers[0]?.id ?? doc.activeLayerId;
      }
      get().updateDoc({ ...doc, layers, activeLayerId }, true);
      set({ selection: get().selection.filter((id) => Boolean(getObject({ ...doc, layers }, id))) });
    },

    renameLayer: (layerId, name) => {
      const { doc } = get();
      const trimmed = name.trim();
      if (!trimmed) return;
      get().updateDoc(
        {
          ...doc,
          layers: doc.layers.map((layer) =>
            layer.id === layerId ? { ...layer, name: trimmed } : layer
          )
        },
        true
      );
    },

    moveLayer: (layerId, direction) => {
      const { doc } = get();
      const index = doc.layers.findIndex((layer) => layer.id === layerId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= doc.layers.length) return;
      const layers = [...doc.layers];
      const [layer] = layers.splice(index, 1);
      layers.splice(target, 0, layer);
      get().updateDoc({ ...doc, layers }, true);
    },

    setActiveLayer: (layerId) => {
      const { doc } = get();
      if (!doc.layers.some((layer) => layer.id === layerId)) return;
      set({ doc: { ...doc, activeLayerId: layerId } });
    },

    toggleLayerVisible: (layerId) => {
      const { doc } = get();
      get().updateDoc(
        {
          ...doc,
          layers: doc.layers.map((layer) =>
            layer.id === layerId ? { ...layer, visible: !layer.visible } : layer
          )
        },
        true
      );
    },

    toggleLayerLock: (layerId) => {
      const { doc } = get();
      get().updateDoc(
        {
          ...doc,
          layers: doc.layers.map((layer) =>
            layer.id === layerId ? { ...layer, locked: !layer.locked } : layer
          )
        },
        true
      );
    },

    setLayerBlendMode: (layerId, mode) => {
      const { doc } = get();
      get().updateDoc(
        {
          ...doc,
          layers: doc.layers.map((layer) =>
            layer.id === layerId ? { ...layer, blendMode: mode } : layer
          )
        },
        true
      );
    },

    setPageBackground: (color) => {
      const { doc } = get();
      if (doc.page.background === color) return;
      get().updateDoc({ ...doc, page: { ...doc.page, background: color } }, true);
    },

    setPageBackgroundVisible: (visible) => {
      const { doc } = get();
      if ((doc.page.backgroundVisible !== false) === visible) return;
      get().updateDoc({ ...doc, page: { ...doc.page, backgroundVisible: visible } }, true);
    },

    markSaved: (path, name) => {
      clearAutosave();
      const { doc } = get();
      set({
        doc: { ...doc, filePath: path, name: name ?? doc.name, updatedAt: new Date().toISOString() },
        isDirty: false
      });
    },

    renameDocument: (name) => {
      const clean = name.trim().replace(/\s+/g, ' ').slice(0, 80);
      const doc = get().doc;
      if (!clean || clean === doc.name) return;
      const recent = get().recent.map((item) =>
        item.id === doc.id || (doc.filePath && item.path === doc.filePath)
          ? { ...item, name: clean }
          : item
      );
      writeRecent(recent);
      set({
        doc: { ...doc, name: clean, updatedAt: new Date().toISOString() },
        isDirty: true,
        recent
      });
    },

    addRecent: (entry) => {
      const recent = [
        entry,
        ...get().recent.filter((item) => item.path !== entry.path || !entry.path)
      ]
        .filter((item, index, array) => array.findIndex((other) => other.id === item.id) === index)
        .slice(0, 6);
      writeRecent(recent);
      set({ recent });
    },

    renameRecent: (id, name) => {
      const clean = name.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!clean) return;
      const target = get().recent.find((item) => item.id === id);
      const recent = get().recent.map((item) =>
        item.id === id ? { ...item, name: clean } : item
      );
      writeRecent(recent);
      // 若当前内存中的文档正好是这条记录，标题也立即同步，返回画布时不再显示旧名。
      const doc = get().doc;
      const sameDocument = Boolean(
        target && (doc.id === target.id || (target.path && doc.filePath === target.path))
      );
      set({
        recent,
        ...(sameDocument && doc.name !== clean
          ? { doc: { ...doc, name: clean, updatedAt: new Date().toISOString() } }
          : {})
      });
    },

    removeRecent: (id) => {
      const recent = get().recent.filter((item) => item.id !== id);
      writeRecent(recent);
      set({ recent });
    },

    clearRecent: () => {
      writeRecent([]);
      set({ recent: [] });
    },

    setChemReport: (report) => set({ chemReport: report }),

    toggleExportTransparent: () =>
      set({ exportTransparent: !get().exportTransparent }),

    openExportPanel: (format, scope) => {
      const { doc, selection, exportRegion } = get();
      const bounds = pageRegionBounds(doc.page);
      // 有选中对象时默认导出「选中对象」，同时把选区包围盒记为框选范围的起点，
      // 用户从「选中对象」切到「框选区域」时不用重新框一遍。
      const suggested =
        selectionExportRegion(doc, selection) ?? exportRegion ?? defaultExportRegion(bounds);
      set({
        exportPanelOpen: true,
        exportFormat: format ?? get().exportFormat,
        exportScope: scope ?? (selection.length > 0 ? 'selection' : 'page'),
        exportRegion: clampRegion(suggested, bounds)
      });
    },

    closeExportPanel: () => set({ exportPanelOpen: false }),

    // 导入与导出互斥：同时打开会叠两层浮层，关闭按钮也会互相遮挡。
    openImportPanel: () => set({ importPanelOpen: true, exportPanelOpen: false }),

    closeImportPanel: () => set({ importPanelOpen: false }),

    setExportFormat: (format) => set({ exportFormat: format }),

    setExportScope: (scope) => {
      const { doc, exportRegion } = get();
      const bounds = pageRegionBounds(doc.page);
      set({
        exportScope: scope,
        exportRegion:
          scope === 'region'
            ? clampRegion(exportRegion ?? defaultExportRegion(bounds), bounds)
            : exportRegion
      });
    },

    setExportRegion: (region) => {
      const { doc } = get();
      set({ exportRegion: clampRegion(region, pageRegionBounds(doc.page)), exportScope: 'region' });
    },

    setExportQuality: (quality) =>
      set({ exportQuality: Math.min(1, Math.max(0.5, Number.isFinite(quality) ? quality : 0.92)) }),

    openProperties: () => {
      if (get().selection.length === 0) return;
      // 只有显式“打开属性”（右键菜单 / 双击）才切页签；单纯选中不抢图层页。
      set({ propertiesOpen: true, sidebarTab: 'properties' });
    },

    closeProperties: () => set({ propertiesOpen: false }),

    setSidebarTab: (sidebarTab) => set({ sidebarTab }),

    pushOverlay: () => set({ overlayDepth: get().overlayDepth + 1 }),

    popOverlay: () => set({ overlayDepth: Math.max(0, get().overlayDepth - 1) }),

    toggleLeftDock: () => set({ leftDockOpen: !get().leftDockOpen, focusCanvas: false }),

    toggleRightDock: () => set({ rightDockOpen: !get().rightDockOpen, focusCanvas: false }),

    toggleFocusCanvas: () => {
      const focusCanvas = !get().focusCanvas;
      set({ focusCanvas });
    },

    setLeftDockOpen: (open) => set({ leftDockOpen: open }),

    setRightDockOpen: (open) => set({ rightDockOpen: open }),

    toggleToolLabels: () => {
      const showToolLabels = !get().showToolLabels;
      set({ showToolLabels });
      writePrefs({ ...readPrefs(), showToolLabels });
    },

    setShowToolLabels: (showToolLabels) => {
      set({ showToolLabels });
      writePrefs({ ...readPrefs(), showToolLabels });
    },

    setTheme: (theme) => {
      set({ theme });
      writePrefs({ ...readPrefs(), theme });
    }
  };
});
