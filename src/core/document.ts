import type { GridSettings, ID, Layer, Style, VDrawDocument } from '../types/document';
import { createId } from './id';

export type TemplateId = 'blank-landscape' | 'a4-portrait' | 'square' | 'chem-sheet';

export interface DocTemplate {
  id: TemplateId;
  name: string;
  description: string;
  sizeLabel: string;
  width: number;
  height: number;
  orientation: 'landscape' | 'portrait' | 'square';
  accent: string;
  chemistryLayers: boolean;
  grid: GridSettings;
}

const baseGrid: GridSettings = {
  visible: true,
  size: 10,
  subdivisions: 5,
  snap: true,
  snapStep: 10
};

export const TEMPLATES: DocTemplate[] = [
  {
    id: 'blank-landscape',
    name: '空白文档',
    description: '通用矢量绘图，横向 A4 画布',
    sizeLabel: 'A4 横版 · 1123 × 794',
    width: 1123,
    height: 794,
    orientation: 'landscape',
    accent: '#4c7df0',
    chemistryLayers: false,
    grid: baseGrid
  },
  {
    id: 'a4-portrait',
    name: 'A4 竖版',
    description: '海报、插图与版式草稿',
    sizeLabel: 'A4 竖版 · 794 × 1123',
    width: 794,
    height: 1123,
    orientation: 'portrait',
    accent: '#8b5cf6',
    chemistryLayers: false,
    grid: baseGrid
  },
  {
    id: 'square',
    name: '方形画布',
    description: '图标、构图与素材绘制',
    sizeLabel: '正方形 · 1000 × 1000',
    width: 1000,
    height: 1000,
    orientation: 'square',
    accent: '#0f9d8f',
    chemistryLayers: false,
    grid: { ...baseGrid, size: 20, subdivisions: 5, snapStep: 20 }
  },
  {
    id: 'chem-sheet',
    name: '化学结构稿',
    description: '预置化学图层，适合反应式与机理图',
    sizeLabel: 'A4 横版 · 1123 × 794',
    width: 1123,
    height: 794,
    orientation: 'landscape',
    accent: '#d97706',
    chemistryLayers: true,
    grid: baseGrid
  }
];

export const DEFAULT_TEMPLATE_ID: TemplateId = 'blank-landscape';

export const TEMPLATE_MAP: Record<string, DocTemplate> = Object.fromEntries(
  TEMPLATES.map((template) => [template.id, template])
);

/** 新图形默认无填充，仅描边；需要时在左侧外观面板设置填充。 */
export const DEFAULT_STYLE: Style = {
  fill: { type: 'none' },
  stroke: {
    paint: { type: 'solid', color: '#1c2430' },
    width: 1.5,
    cap: 'round',
    join: 'round',
    dash: []
  },
  opacity: 1
};

export function createLayer(name: string, kind: Layer['kind'] = 'vector'): Layer {
  return {
    id: createId('layer'),
    name,
    visible: true,
    locked: false,
    kind,
    objects: []
  };
}

export function createDocument(templateId: TemplateId, name: string): VDrawDocument {
  const template = TEMPLATE_MAP[templateId] ?? TEMPLATES[0];
  const layers: Layer[] = template.chemistryLayers
    ? [createLayer('化学结构', 'chemistry'), createLayer('标注与说明', 'annotation')]
    : [createLayer('图层 1', 'vector')];

  const now = new Date().toISOString();
  return {
    id: createId('doc'),
    name,
    page: {
      width: template.width,
      height: template.height,
      background: '#ffffff',
      unit: 'px'
    },
    grid: { ...template.grid },
    layers,
    activeLayerId: layers[0].id,
    templateId: template.id,
    createdAt: now,
    updatedAt: now,
    filePath: null
  };
}

export interface NewDocumentOptions {
  name?: string;
  width?: number;
  height?: number;
  templateId?: TemplateId;
  infinite?: boolean;
  /** 用途模板可预置网格步长（不改变键长 40 与默认纸张尺寸）。 */
  gridSize?: number;
  showGrid?: boolean;
}

/**
 * 按启动页配置创建文档：支持自定义名称、尺寸与无限画布。
 * 无限画布使用较大的虚拟纸面，并标记 page.infinite 以隐藏固定边界。
 */
export function createCustomDocument(options: NewDocumentOptions, fallbackName: string): VDrawDocument {
  const templateId = options.templateId ?? DEFAULT_TEMPLATE_ID;
  const base = createDocument(templateId, options.name?.trim() || fallbackName);
  const infinite = Boolean(options.infinite);
  const width = infinite ? 4000 : Math.max(1, Math.round(options.width ?? base.page.width));
  const height = infinite ? 4000 : Math.max(1, Math.round(options.height ?? base.page.height));
  return {
    ...base,
    page: {
      ...base.page,
      width,
      height,
      infinite
    }
  };
}

export function countObjects(doc: VDrawDocument): number {
  return doc.layers.reduce((total, layer) => total + layer.objects.length, 0);
}

export function activeLayer(doc: VDrawDocument): Layer | null {
  return doc.layers.find((layer) => layer.id === doc.activeLayerId) ?? doc.layers[0] ?? null;
}

export function findLayer(doc: VDrawDocument, layerId: ID): Layer | null {
  return doc.layers.find((layer) => layer.id === layerId) ?? null;
}

/**
 * 绘制目标图层：文件夹只是容器，绘制时下钻到其中第一个可绘制图层，
 * 若文件夹为空则退回到文档中第一个普通图层。
 */
export function drawLayer(doc: VDrawDocument): Layer | null {
  let layer: Layer | null = doc.layers.find((item) => item.id === doc.activeLayerId) ?? null;
  const guard = new Set<string>();
  while (layer && layer.kind === 'folder') {
    if (guard.has(layer.id)) break;
    guard.add(layer.id);
    layer = doc.layers.find((item) => item.parentId === layer!.id && item.kind !== 'folder') ?? null;
  }
  return layer ?? doc.layers.find((item) => item.kind !== 'folder') ?? null;
}
