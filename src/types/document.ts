export type Vec = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

export type ID = string;

export type ToolId =
  | 'select'
  | 'node'
  | 'pen'
  | 'brush'
  | 'bucket'
  | 'curve'
  | 'rect'
  | 'square'
  | 'ellipse'
  | 'circle'
  | 'polygon'
  | 'line'
  | 'text'
  | 'bond'
  | 'atom'
  | 'ring'
  | 'arrow'
  | 'hand'
  | 'eraser'
  | 'eraser-live'
  | 'symmetry'
  | 'guides'
  | 'zoom'
  | 'eyedropper';

/** 画笔笔刷预设。 */
export type BrushPresetId = 'pen' | 'pencil' | 'round' | 'marker';

/** 对称线模式。 */
export type SymmetryMode = 'none' | 'vertical' | 'horizontal' | 'both';

/** 辅助线模式。 */
export type GuideMode = 'none' | 'one-point' | 'two-point' | 'three-point' | 'grid' | 'equal';

/** 对称轴位置与透视辅助线控制点（均为相对画布的 0~1 比例）。 */
export interface SymmetryAxis {
  x: number;
  y: number;
}

export interface GuideSettings {
  horizon: number;
  vpX: number;
  vpLeft: number;
  vpRight: number;
  vpBottom: number;
}

/** 随文档保存的编辑器工作环境（不属于页面内容，但影响重开后的手感）。 */
export interface EditorSnapshot {
  symmetry: SymmetryMode;
  symmetryAxis: SymmetryAxis;
  guideMode: GuideMode;
  guideSettings: GuideSettings;
  guideAssist: boolean;
  guideDensity: number;
  guideSpacing: number;
  /** 随文档携带的自定义笔刷；旧文件缺省，不覆盖本机已有笔刷。 */
  customBrushes?: CustomBrushPreset[];
}

export type PanelTab = 'layers' | 'chemistry';

export type Paint =
  | { type: 'none' }
  | { type: 'solid'; color: string };

export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';
/** 描边虚线预设：映射到具体的 dash 数组。 */
export type StrokeDashPreset = 'solid' | 'dashed' | 'dotted' | 'dashdot';

export interface StrokeStyle {
  paint: Paint;
  width: number;
  cap: StrokeCap;
  join: StrokeJoin;
  dash: number[];
}

export interface Style {
  fill: Paint;
  stroke: StrokeStyle;
  opacity: number;
}

export type ObjectType =
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'polygon'
  | 'path'
  | 'text'
  | 'group'
  | 'bond'
  | 'atom'
  | 'ring'
  | 'arrow'
  | 'annotation'
  | 'image';

export interface PathNode {
  id: ID;
  x: number;
  y: number;
  /** 入控制柄，相对节点坐标 */
  handleIn: Vec | null;
  /** 出控制柄，相对节点坐标 */
  handleOut: Vec | null;
  type: 'corner' | 'smooth';
  /**
   * 该节点的绝对线宽（页面像素）。仅画笔笔迹可能带此字段：
   * 存在时按"中心线 + 宽度包络"渲染为填充轮廓，不存在时按普通 stroke 渲染。
   */
  width?: number;
  /**
   * 椭圆笔尖参数（仅画笔笔迹）：长轴方向与短/长轴比。
   * 存在时轮廓按"椭圆支撑宽度"生成，倾斜笔迹落笔后仍保持扁笔效果。
   */
  nibAngle?: number;
  nibAspect?: number;
  /** 手工调过控制柄：曲线工具的自动平滑不再覆盖该节点。 */
  handleLocked?: boolean;
}

export interface SceneObjectBase {
  id: ID;
  type: ObjectType;
  name: string;
  layerId: ID;
  parentId: ID | null;
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  style: Style;
  /** 由对称工具生成的镜像：记录源对象与镜像类型，供"同步镜像"重新生成。 */
  mirrorOf?: ID;
  mirrorKind?: 'x' | 'y' | 'xy';
  /** 绘制范围裁剪：引用作为剪影的对象 id（选区内绘制 / alpha 锁）。 */
  clipIds?: ID[];
  /**
   * 线条/描边擦除轨迹：作为独立 mask 只裁掉 stroke/ink，
   * 不改变几何、不影响 fill。与 PathObject.eraseStrokes（填充擦除）分开。
   */
  strokeEraseStrokes?: EraseStroke[];
}

export interface RectObject extends SceneObjectBase {
  type: 'rect';
  cornerRadius: number;
}

export interface EllipseObject extends SceneObjectBase {
  type: 'ellipse';
}

export interface LineObject extends SceneObjectBase {
  type: 'line';
  start: Vec;
  end: Vec;
  /** 末端箭头：普通示意图用，不参与化学语义。 */
  arrowEnd?: boolean;
}

export interface PolygonObject extends SceneObjectBase {
  type: 'polygon';
  points: Vec[];
}

/** dab 混合模式：normal 合并分桶；multiply 逐 dab 与背景相乘。 */
export type BrushBlendMode = 'normal' | 'multiply';

/** 用户从当前参数保存的自定义笔刷（本机偏好与文档 editor 共用）。 */
export interface CustomBrushPreset {
  id: string;
  name: string;
  width: number;
  opacity: number;
  hardness: number;
  spacing: number;
  texture: number;
  pressure: boolean;
  taper: number;
  smoothing: number;
  /** 每 dab 墨量；旧偏好/旧笔刷库/旧文档缺省按 1。 */
  flow?: number;
  /** dab 混合模式；旧偏好/旧笔刷库/旧文档缺省按 normal。 */
  blendMode?: BrushBlendMode;
}

/** 画笔材质：落笔后仍要参与渲染/导出的参数（不存位图）。 */
export interface BrushMaterial {
  /** 软边硬度 0–1；1 接近实心边。 */
  hardness: number;
  /** 纹理颗粒间距系数（相对笔宽）。 */
  spacing: number;
  /** 纹理强度 0–1。 */
  texture: number;
  /** 每笔固定种子：同一笔重绘/导出时颗粒位置稳定。 */
  seed: number;
  /** 每 dab 墨量系数 0–1；默认 1（旧文件缺省按 1 处理）。 */
  flow?: number;
  /** dab 混合模式；默认 normal（旧文件缺省）。 */
  blendMode?: BrushBlendMode;
}

export interface EraseStroke {
  /** 橡皮中心线；只有一个点表示一次点按。 */
  points: Vec[];
  /** 橡皮半径（页面像素）。 */
  radius: number;
}

export interface PathObject extends SceneObjectBase {
  type: 'path';
  nodes: PathNode[];
  closed: boolean;
  /** 旧版填充擦除孔洞；保留用于读旧文件，新擦除改用 eraseStrokes。 */
  holes?: Vec[][];
  /** 填充擦除轨迹：mask 用黑色描边表示，重叠天然合并。 */
  eraseStrokes?: EraseStroke[];
  /** 画笔材质；普通路径/导入路径没有该字段。 */
  brushMaterial?: BrushMaterial;
  /** 区域擦除从形状轮廓切出的描边片段：描边/线条目标都能继续切它。 */
  strokeFragment?: boolean;
}

export interface TextObject extends SceneObjectBase {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  /** 斜体：渲染、导出与度量共用。 */
  italic?: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing?: number;
  direction?: 'horizontal' | 'vertical';
  /** 行高倍率（相对字号），默认 1.32。 */
  lineHeight?: number;
  /** 文本框宽度（页面像素），0/未设置表示不自动换行。 */
  maxWidth?: number;
}

export interface GroupObject extends SceneObjectBase {
  type: 'group';
  childIds: ID[];
  /** 苯环结构式：鲍林式（内圆圈）或凯库勒式（交替双键） */
  ringStyle?: 'pauling' | 'kekule';
  /** 任意闭合环骨架标记：用于环内部命中，不参与芳香性/价态推导 */
  ringFrame?: boolean;
  /**
   * 鲍林式稠环的内圈圆心。简单苯环继续用 ringStyle 绘制；
   * 稠环外层用多个圆心表示每个苯环，避免为每个环再嵌套一层编组。
   */
  ringCenters?: Vec[];
  /** 稠环内圈样式；与 ringStyle 分开，避免外层被误判成单个苯环。 */
  ringCircleStyle?: 'pauling';
}

export type BondType =
  | 'single'
  | 'double'
  | 'triple'
  | 'aromatic'
  | 'wedge'
  | 'hashed'
  | 'wavy'
  | 'dative';

export interface BondObject extends SceneObjectBase {
  type: 'bond';
  bondType: BondType;
  start: Vec;
  end: Vec;
  /** 芳香键内侧线方向，由所在环的质心决定 */
  aromaticSide?: 1 | -1;
  /** 环内双键的第二条线方向（凯库勒式苯环），指向环心 */
  ringInnerSide?: 1 | -1;
}

export interface AtomLabelData {
  element: string;
  charge: number;
  isotope: number | null;
  radical: 'none' | 'singlet' | 'doublet' | 'triplet';
  lonePairs: number;
  hydrogens: number | null;
  group: string | null;
  /** 原子标签字号；缺省为 16，缩放选择框时同步更新。 */
  fontSize?: number;
}

export interface AtomObject extends SceneObjectBase {
  type: 'atom';
  position: Vec;
  label: AtomLabelData;
}

export interface RingObject extends SceneObjectBase {
  type: 'ring';
  templateId: string;
  scale: number;
}

export type ArrowKind = 'reaction' | 'equilibrium' | 'mechanism' | 'retro';

export interface ArrowObject extends SceneObjectBase {
  type: 'arrow';
  arrowKind: ArrowKind;
  start: Vec;
  end: Vec;
  label: string;
}

export interface AnnotationObject extends SceneObjectBase {
  type: 'annotation';
  text: string;
  targetId: ID | null;
}

/**
 * 位图对象：图像以 data URL 内嵌在文档里，随 .vdraw 保存/导出，
 * 不依赖外部文件或网络。width/height 是页面显示尺寸，natural* 只作元数据。
 */
export interface ImageObject extends SceneObjectBase {
  type: 'image';
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  /** 原始格式（png/jpeg/webp/gif/bmp），仅用于属性面板提示。 */
  imageFormat?: 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp';
}

export type SceneObject =
  | RectObject
  | EllipseObject
  | LineObject
  | PolygonObject
  | PathObject
  | TextObject
  | GroupObject
  | BondObject
  | AtomObject
  | RingObject
  | ArrowObject
  | AnnotationObject
  | ImageObject;

export type LayerBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten';

export interface Layer {
  id: ID;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 图层混合模式；normal/未设置表示普通叠加。 */
  blendMode?: LayerBlendMode;
  kind: 'vector' | 'chemistry' | 'annotation' | 'folder';
  /** 文件夹图层的父级；为空表示顶层图层 */
  parentId?: ID | null;
  objects: SceneObject[];
}

export interface PageSetup {
  width: number;
  height: number;
  background: string;
  /** 背景伪图层是否可见；关闭后画布显示透明棋盘格 */
  backgroundVisible?: boolean;
  unit: 'px';
  /** 无限画布：不显示固定纸张边界 */
  infinite?: boolean;
}

export interface GridSettings {
  visible: boolean;
  size: number;
  subdivisions: number;
  snap: boolean;
  snapStep: number;
}

export interface VDrawDocument {
  id: ID;
  name: string;
  page: PageSetup;
  grid: GridSettings;
  layers: Layer[];
  activeLayerId: ID;
  templateId: string;
  /** 隐式氢：原子标签省略 H 计数（数据仍保留，导出同样省略）。 */
  implicitHydrogens?: boolean;
  createdAt: string;
  updatedAt: string;
  filePath: string | null;
}

export interface Viewport {
  zoom: number;
  pan: Vec;
}

/** 导出时使用的页面坐标矩形（单位与画布一致：px）。 */
export interface ExportRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ExportFormat = 'svg' | 'png' | 'jpg' | 'pdf';

/** 导出范围：整页 / 画面上框选的区域 / 当前选中的对象。 */
export type ExportScope = 'page' | 'region' | 'selection';

export interface ChemToolState {
  bondType: BondType;
  /** 默认键长：点击与拖拽绘制的化学键一律使用标准键长，不再跟随拖拽距离。 */
  bondLengthLocked: boolean;
  /** 默认粗细锁定：锁定后固定用设置里的粗细，未锁时跟随左侧「大小」滑杆。 */
  bondWidthLocked: boolean;
  element: string;
  atomPresetId: string;
  /** 原子子工具分类：元素 / 官能团 */
  atomCategory: 'element' | 'group';
  ringTemplateId: string;
  /** 新环缩放（0.5–2），1 为标准 40px 键长。 */
  ringScale: number;
  benzeneStyle: 'pauling' | 'kekule';
  arrowKind: ArrowKind;
  charge: number;
  isotope: number | null;
  radical: AtomLabelData['radical'];
  lonePairs: number;
}
