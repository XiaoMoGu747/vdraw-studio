import type { BrushBlendMode, BrushPresetId, ToolId } from '../types/document';
import type { IconName } from '../types/ui';

export interface ToolDef {
  id: ToolId;
  label: string;
  shortcut?: string;
  icon: IconName;
  hint: string;
  chemistry?: boolean;
}

export interface ToolGroup {
  id: string;
  label: string;
  tools: ToolDef[];
}

/** 字体候选：横栏与文字合成器共用同一份清单。 */
export const FONT_CHOICES: { label: string; value: string }[] = [
  { label: '系统默认', value: 'Segoe UI, Microsoft YaHei, sans-serif' },
  { label: '微软雅黑', value: 'Microsoft YaHei, sans-serif' },
  { label: '黑体', value: 'SimHei, sans-serif' },
  { label: '等线', value: 'DengXian, sans-serif' },
  { label: '宋体', value: 'SimSun, serif' },
  { label: '楷体', value: 'KaiTi, serif' },
  { label: '仿宋', value: 'FangSong, serif' },
  { label: '思源黑体', value: '"Source Han Sans SC", sans-serif' },
  { label: 'Cambria（衬线）', value: 'Cambria, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, sans-serif' },
  { label: '等宽（Consolas）', value: 'Consolas, monospace' }
];

export const DEFAULT_FONT_FAMILY = FONT_CHOICES[0].value;

/** 形状子工具（由左侧“形状”按钮统一承载）。 */
export const SHAPE_TOOL_IDS: ToolId[] = [
  'rect',
  'square',
  'ellipse',
  'circle',
  'polygon',
  'line',
  'curve'
];

/** 化学子工具（由“化学工具”子竖栏承载）。 */
export const CHEM_TOOL_IDS: ToolId[] = ['bond', 'atom', 'ring', 'arrow', 'eraser'];

export const TEXT_TOOL: ToolDef = {
  id: 'text',
  label: '文本',
  shortcut: 'T',
  icon: 'text',
  hint: '点击画布输入文本，双击已有文本可编辑'
};

export const TOOLS: ToolDef[] = [
  { id: 'select', label: '选择', shortcut: 'V', icon: 'select', hint: '点击选择，拖拽移动；Shift 多选，空白处框选；Alt 拖拽原位复制；缩放时 Shift 等比、Alt 从中心' },
  { id: 'node', label: '节点', shortcut: 'A', icon: 'node', hint: '拖动节点/控制柄；Shift 多选；双击节点切换尖角/平滑、双击路径加点；Delete 删点' },
  { id: 'pen', label: '钢笔', shortcut: 'P', icon: 'pen', hint: '点击添加节点，拖拽生成曲线；点击首节点闭合，Enter 结束' },
  { id: 'brush', label: '画笔', shortcut: 'N', icon: 'brush', hint: '按住拖拽自由绘制；在左侧扩展栏切换硬笔、铅笔、硬圆或马克笔刷' },
  { id: 'bucket', label: '油漆桶', shortcut: 'K', icon: 'bucket', hint: '点图形填整块，点空白按区域填充；Alt 临时取色' },
  { id: 'rect', label: '矩形', shortcut: 'R', icon: 'rect', hint: '拖拽绘制矩形，默认无填充；Shift 正方形、Alt 关闭吸附' },
  { id: 'square', label: '正方形', shortcut: 'S', icon: 'square', hint: '拖拽绘制正方形，默认无填充' },
  { id: 'ellipse', label: '椭圆', shortcut: 'O', icon: 'ellipse', hint: '拖拽绘制椭圆，默认无填充；Shift 正圆、Alt 关闭吸附' },
  { id: 'circle', label: '圆形', shortcut: 'C', icon: 'circle', hint: '拖拽绘制圆形，默认无填充' },
  { id: 'polygon', label: '多边形', shortcut: 'G', icon: 'polygon', hint: '拖拽绘制多边形；边数/星形在形状横栏设置，Alt 关闭吸附' },
  { id: 'line', label: '直线', shortcut: 'L', icon: 'line', hint: '拖拽绘制直线，Shift 约束角度；端点自动吸附已有对象，可开启末端箭头' },
  { id: 'curve', label: '曲线', shortcut: 'U', icon: 'curve', hint: '拖拽画线，Shift 画弧；单击线身加点（Alt 尖角），右键删点；端点吸附已有对象' },
  TEXT_TOOL,
  { id: 'bond', label: '化学键', shortcut: 'B', icon: 'bond', hint: '拖拽绘制任意长度；单击按标准键长落笔，自动吸附原子与键端点', chemistry: true },
  { id: 'atom', label: '原子标签', icon: 'atom', hint: '点击放置元素或官能团标签；点击环碳会作为取代基挂接', chemistry: true },
  { id: 'ring', label: '环系模板', icon: 'ring', hint: '点击画布插入所选环系模板', chemistry: true },
  { id: 'arrow', label: '反应箭头', icon: 'arrow', hint: '拖拽绘制反应箭头或机理箭头', chemistry: true },
  { id: 'hand', label: '平移', shortcut: 'H', icon: 'hand', hint: '拖拽平移画布，空格键可临时启用' },
  { id: 'eraser', label: '化学橡皮', shortcut: 'X', icon: 'eraser', hint: '只擦化学键、原子标签与环骨架', chemistry: true },
  { id: 'eraser-live', label: '橡皮擦', shortcut: 'E', icon: 'eraser', hint: '擦除笔刷经过的线条/描边、填充与化学键；画布下方横栏可多选擦除对象，Alt 临时全图层' },
  { id: 'symmetry', label: '对称', shortcut: 'Y', icon: 'symmetry', hint: '开启左右/上下对称，可拖动对称轴；Shift+Y 循环模式' },
  { id: 'guides', label: '辅助线', icon: 'perspective', hint: '一点/两点/三点透视、网格与等大辅助；可拖动透视点，并开启绘画辅助' },
  { id: 'zoom', label: '缩放', shortcut: 'Z', icon: 'zoom', hint: '点击放大，Alt 点击缩小；滚轮可直接缩放' },
  { id: 'eyedropper', label: '取色', shortcut: 'I', icon: 'eyedropper', hint: '点击拾取填充色，Shift 拾取描边色；取完自动回到原工具' }
];

export const TOOL_MAP: Record<ToolId, ToolDef> = Object.fromEntries(
  TOOLS.map((tool) => [tool.id, tool])
) as Record<ToolId, ToolDef>;

export const TOOL_SHORTCUTS: Record<string, ToolId> = TOOLS.reduce<Record<string, ToolId>>(
  (acc, tool) => {
    if (tool.shortcut) acc[tool.shortcut.toLowerCase()] = tool.id;
    return acc;
  },
  {}
);

/** 左侧主竖栏的条目：普通工具，或聚合多个子工具的组合工具。 */
export interface RailItem {
  id: string;
  label: string;
  icon: IconName;
  /** 点击后激活的默认工具 */
  tool: ToolId;
  /** 组合工具包含的子工具 */
  tools?: ToolId[];
  chemistry?: boolean;
}

export interface RailGroup {
  id: string;
  label: string;
  items: RailItem[];
}

export const RAIL_GROUPS: RailGroup[] = [
  {
    id: 'draw',
    label: '绘制',
    items: [
      { id: 'select', label: '选择', icon: 'select', tool: 'select' },
      { id: 'node', label: '节点', icon: 'node', tool: 'node' },
      { id: 'pen', label: '钢笔', icon: 'pen', tool: 'pen' },
      { id: 'curve', label: '曲线', icon: 'curve', tool: 'curve' },
      { id: 'brush', label: '画笔', icon: 'brush', tool: 'brush' },
      { id: 'bucket', label: '油漆桶', icon: 'bucket', tool: 'bucket' },
      { id: 'text', label: '文本', icon: 'text', tool: 'text' },
      { id: 'eraser-live', label: '橡皮擦', icon: 'eraser', tool: 'eraser-live' }
    ]
  },
  {
    id: 'shape',
    label: '形状',
    items: [
      { id: 'shape', label: '形状', icon: 'square', tool: 'rect', tools: SHAPE_TOOL_IDS }
    ]
  },
  {
    id: 'chem',
    label: '化学',
    items: [
      {
        id: 'chemistry',
        label: '化学工具',
        icon: 'chemistry',
        tool: 'bond',
        tools: CHEM_TOOL_IDS,
        chemistry: true
      }
    ]
  },
  {
    id: 'view',
    label: '视图',
    items: [
      { id: 'symmetry', label: '对称', icon: 'symmetry', tool: 'symmetry' },
      { id: 'guides', label: '辅助线', icon: 'perspective', tool: 'guides' },
      { id: 'hand', label: '平移', icon: 'hand', tool: 'hand' },
      { id: 'zoom', label: '缩放', icon: 'zoom', tool: 'zoom' },
      { id: 'eyedropper', label: '取色', icon: 'eyedropper', tool: 'eyedropper' }
    ]
  }
];

export interface BrushPreset {
  id: BrushPresetId;
  name: string;
  width: number;
  opacity: number;
  /** 是否使用压感变宽（仅手写笔生效，鼠标/触摸自动忽略） */
  pressure: boolean;
  /** 起收笔渐隐比例 0–1，0 表示平头 */
  taper: number;
  /** 软边硬度 0–1：1 接近实心边，0 更柔 */
  hardness: number;
  /** 纹理点间距系数（相对笔宽），越大纹理越疏 */
  spacing: number;
  /** 纹理强度 0–1，0 表示无纹理 */
  texture: number;
  /** 每 dab 墨量 0–1（纹理/墨点层）。 */
  flow: number;
  /** dab 混合模式。 */
  blendMode: BrushBlendMode;
  /** 预设自带的抖动修正（0–100）：切换笔刷时一并恢复，硬圆默认不做平滑。 */
  smoothing: number;
  hint: string;
}

export const BRUSH_PRESETS: BrushPreset[] = [
  {
    id: 'pen',
    name: '硬笔',
    width: 3,
    opacity: 1,
    pressure: true,
    taper: 0.3,
    hardness: 0.9,
    spacing: 0.5,
    texture: 0,
    flow: 1,
    blendMode: 'normal',
    smoothing: 8,
    hint: '均匀线条 + 轻微收锋，适合勾线与标注'
  },
  {
    id: 'pencil',
    name: '铅笔',
    width: 2.4,
    opacity: 0.82,
    pressure: true,
    taper: 0.5,
    hardness: 0.35,
    spacing: 0.8,
    texture: 0.6,
    flow: 0.7,
    blendMode: 'multiply',
    smoothing: 12,
    hint: '轻质笔触，压感变宽、两端渐隐，适合草稿'
  },
  {
    id: 'round',
    name: '硬圆',
    width: 8,
    opacity: 1,
    pressure: false,
    taper: 0,
    hardness: 0.85,
    spacing: 0.5,
    texture: 0.04,
    flow: 1,
    blendMode: 'normal',
    smoothing: 0,
    hint: '等宽圆头粗笔刷，适合涂色与描边；默认不做抖动修正'
  },
  {
    id: 'marker',
    name: '马克',
    width: 14,
    opacity: 0.45,
    pressure: false,
    taper: 0,
    hardness: 0.55,
    spacing: 0.6,
    texture: 0.12,
    flow: 0.7,
    blendMode: 'normal',
    smoothing: 6,
    hint: '平头半透明，叠加出加深效果，适合铺色与高亮'
  }
];

export function brushPresetOf(id: BrushPresetId): BrushPreset {
  return BRUSH_PRESETS.find((preset) => preset.id === id) ?? BRUSH_PRESETS[0];
}

/** 这些工具的左侧扩展栏有子选项。 */
export function hasToolOptions(tool: ToolId): boolean {
  return (
    SHAPE_TOOL_IDS.includes(tool) ||
    tool === 'brush' ||
    tool === 'bucket' ||
    tool === 'symmetry' ||
    tool === 'guides' ||
    TOOL_MAP[tool].chemistry === true
  );
}
