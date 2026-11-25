import type {
  EditorSnapshot,
  Layer,
  Paint,
  SceneObject,
  Style,
  VDrawDocument
} from '../../types/document';
import { TEMPLATE_MAP, createCustomDocument, createLayer, drawLayer } from '../document';
import { createId } from '../id';
import { createImageObject } from '../factory';
import { addObjectsToLayer, translateDocumentObjects } from '../scene';
import { baseName, parseDocumentFile, SCHEMA_VERSION } from './serialize';
import { parseSvgToObjects } from './svgImport';
import { ImportError, MAX_IMPORT_BYTES } from './importError';
import { imageObjectName, imagePlacement, type ImportedImageSource } from './imageImport';

export {
  ImportError,
  MAX_IMPORT_BYTES,
  MAX_RASTER_BYTES,
  formatFileSize,
  importErrorInfo
} from './importError';
export type { ImportErrorCode, ImportErrorInfo } from './importError';
export { validateRasterImport } from './imageImport';
export type { ImportedImageSource } from './imageImport';

/** 页面尺寸上限：与导出/打印管线的 20000px 限制一致。 */
export const MAX_PAGE_SIZE = 20000;
/** 网页端 <input type="file"> 与桌面对话框共用的扩展名白名单。 */
export const IMPORT_ACCEPT = '.vdraw,.json,.svg,.png,.jpg,.jpeg,.webp,.gif,.bmp';
/** 单次批量导入的文件数上限：避免一次解码几十张大图把渲染进程拖死。 */
export const MAX_IMPORT_FILES = 50;

export type ImportFormat = 'vdraw' | 'json' | 'svg';

export type ImportMode = 'replace' | 'new' | 'append' | 'layer';

export interface ImportFormatGuide {
  id: 'vdraw' | 'json' | 'svg' | 'bitmap' | 'pdf';
  extension: string;
  label: string;
  detail: string;
  supported: boolean;
}

/** 对话框里的能力说明：支持什么、从哪来、哪些导出格式不能反向导入。 */
export const IMPORT_FORMAT_GUIDE: ImportFormatGuide[] = [
  {
    id: 'vdraw',
    extension: '.vdraw',
    label: 'VDraw 工程',
    detail: '图层、对象、样式、页面与对称/辅助线完整还原',
    supported: true
  },
  {
    id: 'json',
    extension: '.json',
    label: 'VDraw JSON',
    detail: '旧版保存或裸文档 JSON，完整还原图形数据',
    supported: true
  },
  {
    id: 'svg',
    extension: '.svg',
    label: 'SVG 矢量图',
    detail: '路径、形状、文本与基础样式（含 VDraw 导出的 SVG）',
    supported: true
  },
  {
    id: 'bitmap',
    extension: '.png / .jpg…',
    label: '位图图片',
    detail: 'PNG / JPEG / WebP / GIF / BMP，作为可移动、缩放、旋转的位图对象导入',
    supported: true
  },
  {
    id: 'pdf',
    extension: '.pdf',
    label: 'PDF 文档',
    detail: '打印格式不携带可编辑的图形结构',
    supported: false
  }
];

export interface ImportedDocumentStats {
  version: number;
  app: string | null;
  savedAt: string | null;
  templateName: string;
  pageWidth: number;
  pageHeight: number;
  /** 图层总数（含文件夹）。 */
  layers: number;
  objects: number;
}

export interface ImportedDocumentSource {
  kind: 'document';
  format: 'vdraw' | 'json';
  fileName: string;
  suggestedName: string;
  doc: VDrawDocument;
  editor: EditorSnapshot | null;
  warnings: string[];
  stats: ImportedDocumentStats;
}

export interface ImportedSvgStats {
  width: number;
  height: number;
  elements: number;
  skipped: number;
}

export interface ImportedSvgSource {
  kind: 'svg';
  format: 'svg';
  fileName: string;
  suggestedName: string;
  text: string;
  warnings: string[];
  stats: ImportedSvgStats;
}

export type ImportedSource = ImportedDocumentSource | ImportedSvgSource | ImportedImageSource;

const KNOWN_OBJECT_TYPES = new Set<string>([
  'rect',
  'ellipse',
  'line',
  'polygon',
  'path',
  'text',
  'group',
  'bond',
  'atom',
  'ring',
  'arrow',
  'annotation',
  'image'
]);

const LAYER_KINDS: Layer['kind'][] = ['vector', 'chemistry', 'annotation', 'folder'];

const BITMAP_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

/** 只接受随文档内嵌的常见位图 data URL，避免外部引用在离线/导出时丢失。 */
function isImageDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/i.test(value)
  );
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function extensionOf(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function looksLikeSvg(text: string): boolean {
  const head = text.slice(0, 4096);
  return /<svg[\s>]/i.test(head);
}

function looksLikeJson(text: string): boolean {
  return /^\s*[{[]/.test(text);
}

/** 文本里混入大量替换符或 NUL，说明原文件是二进制（PNG/PDF 等）。 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 512);
  if (sample.includes('\u0000')) return true;
  let broken = 0;
  for (const char of sample) {
    if (char === '\ufffd') broken += 1;
  }
  return broken > 0 && broken / Math.max(1, sample.length) > 0.05;
}

/**
 * 判断文件该走哪条解析链路。
 * 先看扩展名（用户预期），再用内容特征兜底，避免"改错扩展名"导致误导性报错。
 */
export function detectImportFormat(fileName: string, content: string): ImportFormat {
  const text = stripBom(content);
  const extension = extensionOf(fileName);

  if (BITMAP_EXTENSIONS.has(extension)) {
    throw new ImportError(
      'unsupported-type',
      `扩展名是 .${extension}，但内容不是可识别的位图`,
      '如果文件实际是 SVG / VDraw 工程，请改正扩展名后重试；PNG / JPEG / WebP / GIF / BMP 会按二进制读取为位图对象。'
    );
  }
  if (extension === 'pdf') {
    throw new ImportError(
      'unsupported-type',
      '不支持导入 PDF 文件',
      'PDF 是打印格式，无法还原图层与可编辑图形；PDF 仅用于导出。'
    );
  }
  if (looksBinary(text)) {
    throw new ImportError(
      'binary-content',
      '文件是二进制内容，无法作为 VDraw 工程或 SVG 读取',
      'PNG / JPEG / WebP / GIF / BMP 请通过「导入文件」作为位图导入；PDF 暂不支持反向导入。'
    );
  }

  if (extension === 'vdraw' || extension === 'json') {
    if (looksLikeSvg(text)) {
      throw new ImportError(
        'unsupported-type',
        `文件的扩展名是 .${extension}，但内容是 SVG`,
        '请把文件扩展名改为 .svg 后重试，或重新导出 SVG。'
      );
    }
    return extension === 'vdraw' ? 'vdraw' : 'json';
  }

  if (extension === 'svg') {
    if (!looksLikeSvg(text)) {
      throw new ImportError(
        'invalid-svg',
        '文件扩展名是 .svg，但内容不是 SVG 文档',
        'SVG 的根元素必须是 <svg>；请确认文件未被截断或改写过。'
      );
    }
    return 'svg';
  }

  // 未知扩展名：按内容嗅探，能识别就继续，否则给出明确提示。
  if (looksLikeSvg(text)) return 'svg';
  if (looksLikeJson(text)) return 'json';
  throw new ImportError(
    'unsupported-type',
    extension ? `不支持的文件类型：.${extension}` : '无法识别的文件类型',
    '支持 .vdraw / .json / .svg 与 PNG / JPEG / WebP / GIF / BMP 位图。'
  );
}

function readSchemaVersion(payload: Record<string, unknown>): number {
  const raw = payload.schemaVersion;
  if (raw === undefined) return 1;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    throw new ImportError(
      'unsupported-version',
      `文件版本号无效：${String(raw)}`,
      `当前支持 schemaVersion 1–${SCHEMA_VERSION}。`
    );
  }
  if (raw > SCHEMA_VERSION) {
    throw new ImportError(
      'unsupported-version',
      `文件版本 ${raw} 高于当前支持的 ${SCHEMA_VERSION}`,
      '请升级 VDraw Studio 后再导入；旧版本无法保证正确还原新字段。'
    );
  }
  return raw;
}

interface DocumentStructure {
  layerCount: number;
  objectCount: number;
  pageWidth: number;
  pageHeight: number;
}

function assertObjectShape(object: Record<string, unknown>, label: string): void {
  const type = object.type;
  if (typeof type !== 'string' || !KNOWN_OBJECT_TYPES.has(type)) {
    throw new ImportError(
      'invalid-document',
      `${label}的图形类型无效：${String(type)}`,
      '文件可能来自更高版本的 VDraw，或被外部工具改写过。'
    );
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!isFiniteNumber(object[key])) {
      throw new ImportError('invalid-layers', `${label}缺少有效的 ${key} 坐标/尺寸`);
    }
  }
  if (type === 'path') {
    if (!Array.isArray(object.nodes) || object.nodes.length === 0) {
      throw new ImportError('invalid-layers', `${label}的路径节点数据为空`);
    }
    const broken = object.nodes.some(
      (node) => !isRecord(node) || !isFiniteNumber(node.x) || !isFiniteNumber(node.y)
    );
    if (broken) {
      throw new ImportError('invalid-layers', `${label}的路径节点缺少有效坐标`);
    }
  }
  if (type === 'polygon') {
    if (
      !Array.isArray(object.points) ||
      object.points.length < 2 ||
      object.points.some((point) => !isPoint(point))
    ) {
      throw new ImportError('invalid-layers', `${label}的多边形顶点数据无效`);
    }
  }
  if ((type === 'line' || type === 'bond' || type === 'arrow') && (!isPoint(object.start) || !isPoint(object.end))) {
    throw new ImportError('invalid-layers', `${label}的起止点数据无效`);
  }
  if (
    type === 'group' &&
    (!Array.isArray(object.childIds) || object.childIds.some((id) => typeof id !== 'string'))
  ) {
    throw new ImportError('invalid-layers', `${label}的编组子对象列表无效`);
  }
  if (type === 'text' && typeof object.text !== 'string') {
    throw new ImportError('invalid-layers', `${label}的文本内容无效`);
  }
  if (type === 'annotation' && typeof object.text !== 'string') {
    throw new ImportError('invalid-layers', `${label}的标注内容无效`);
  }
  if (
    type === 'atom' &&
    (!isPoint(object.position) ||
      !isRecord(object.label) ||
      typeof object.label.element !== 'string')
  ) {
    throw new ImportError('invalid-layers', `${label}的原子标签数据无效`);
  }
  if (type === 'ring' && typeof object.templateId !== 'string') {
    throw new ImportError('invalid-layers', `${label}的环系模板数据无效`);
  }
  if (type === 'image' && !isImageDataUrl(object.src)) {
    throw new ImportError(
      'invalid-layers',
      `${label}的内嵌位图数据无效`,
      '仅支持随工程内嵌的 PNG / JPEG / WebP / GIF / BMP data URL，不接受外部图片链接。'
    );
  }
}

/** 深度结构校验：宁可拒绝并说明原因，也不让损坏对象进入文档渲染管线。 */
function inspectDocumentStructure(doc: Record<string, unknown>): DocumentStructure {
  const page = doc.page;
  if (!isRecord(page)) {
    throw new ImportError(
      'invalid-document',
      '缺少页面数据（page）',
      '这不是 VDraw 工程文件；请选择由 VDraw 保存的 .vdraw 文件，或改用「导入文件」选择 .svg 矢量图。'
    );
  }
  const pageWidth = page.width;
  const pageHeight = page.height;
  if (!isFiniteNumber(pageWidth) || !isFiniteNumber(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
    throw new ImportError('invalid-page', '页面尺寸无效', 'page.width / page.height 必须是大于 0 的数字。');
  }
  if (pageWidth > MAX_PAGE_SIZE || pageHeight > MAX_PAGE_SIZE) {
    throw new ImportError(
      'invalid-page',
      `页面尺寸 ${Math.round(pageWidth)} × ${Math.round(pageHeight)} 超出支持范围`,
      `单边最大 ${MAX_PAGE_SIZE}px。`
    );
  }

  const rawLayers = doc.layers;
  if (!Array.isArray(rawLayers)) {
    throw new ImportError('invalid-layers', '文档图层数据无效（layers 必须是数组）');
  }

  const layerIds = new Set<string>();
  const objectIds = new Set<string>();
  let objectCount = 0;

  rawLayers.forEach((layer, layerIndex) => {
    if (!isRecord(layer)) {
      throw new ImportError('invalid-layers', `第 ${layerIndex + 1} 个图层的数据已损坏`);
    }
    if (typeof layer.id !== 'string' || !layer.id) {
      throw new ImportError('invalid-layers', `第 ${layerIndex + 1} 个图层缺少 id`);
    }
    if (layerIds.has(layer.id)) {
      throw new ImportError(
        'duplicate-ids',
        `发现重复的图层 ID：${layer.id}`,
        '文件可能被手工拼接或重复导出，请重新保存后再导入。'
      );
    }
    layerIds.add(layer.id);
    const layerName =
      typeof layer.name === 'string' && layer.name.trim() ? layer.name : `第 ${layerIndex + 1} 个图层`;
    if (!Array.isArray(layer.objects)) {
      throw new ImportError('invalid-layers', `图层「${layerName}」的对象列表无效`);
    }
    layer.objects.forEach((object, objectIndex) => {
      if (!isRecord(object)) {
        throw new ImportError('invalid-layers', `图层「${layerName}」第 ${objectIndex + 1} 个对象已损坏`);
      }
      if (typeof object.id !== 'string' || !object.id) {
        throw new ImportError('invalid-layers', `图层「${layerName}」第 ${objectIndex + 1} 个对象缺少 id`);
      }
      if (objectIds.has(object.id)) {
        throw new ImportError(
          'duplicate-ids',
          `发现重复的对象 ID：${object.id}`,
          '重复 ID 会让选择、撤销与编辑指向错误对象，请重新保存文档。'
        );
      }
      objectIds.add(object.id);
      assertObjectShape(object, `图层「${layerName}」第 ${objectIndex + 1} 个对象`);
      objectCount += 1;
    });
  });

  return { layerCount: rawLayers.length, objectCount, pageWidth, pageHeight };
}

function styleLooksValid(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.opacity)) return false;
  const fill = value.fill;
  if (!isRecord(fill) || (fill.type !== 'none' && fill.type !== 'solid')) return false;
  if (fill.type === 'solid' && typeof fill.color !== 'string') return false;
  const stroke = value.stroke;
  if (!isRecord(stroke) || !isFiniteNumber(stroke.width)) return false;
  const paint = stroke.paint;
  if (!isRecord(paint) || (paint.type !== 'none' && paint.type !== 'solid')) return false;
  if (paint.type === 'solid' && typeof paint.color !== 'string') return false;
  return true;
}

/** 把任意损坏的样式下沉为可渲染的最小样式，避免缺字段进入渲染/导出管线。 */
function normalizeImportedStyle(value: unknown): Style {
  const raw = isRecord(value) ? value : {};
  const rawFill = isRecord(raw.fill) ? raw.fill : {};
  const fill: Paint =
    rawFill.type === 'solid' && typeof rawFill.color === 'string'
      ? { type: 'solid', color: rawFill.color }
      : { type: 'none' };
  const rawStroke = isRecord(raw.stroke) ? raw.stroke : {};
  const rawPaint = isRecord(rawStroke.paint) ? rawStroke.paint : {};
  const paint: Paint =
    rawPaint.type === 'solid' && typeof rawPaint.color === 'string'
      ? { type: 'solid', color: rawPaint.color }
      : { type: 'none' };
  const cap = rawStroke.cap === 'butt' || rawStroke.cap === 'square' ? rawStroke.cap : 'round';
  const join = rawStroke.join === 'miter' || rawStroke.join === 'bevel' ? rawStroke.join : 'round';
  const dash = Array.isArray(rawStroke.dash) ? rawStroke.dash.filter(isFiniteNumber) : [];
  return {
    fill,
    stroke: {
      paint,
      width: isFiniteNumber(rawStroke.width) && rawStroke.width >= 0 ? rawStroke.width : 1.5,
      cap,
      join,
      dash
    },
    opacity: isFiniteNumber(raw.opacity) ? Math.min(1, Math.max(0.05, raw.opacity)) : 1
  };
}

/**
 * 归一化后再修引用：悬空 parentId / 编组子项 / 镜像 / 裁剪引用会让编辑操作抛错，
 * 这里统一清理并在对话框里如实列出修复项。
 */
function repairDocument(
  doc: VDrawDocument,
  rawDoc: Record<string, unknown>
): { doc: VDrawDocument; warnings: string[] } {
  const warnings: string[] = [];
  const rawLayers = Array.isArray(rawDoc.layers) ? rawDoc.layers : [];
  if (typeof rawDoc.name !== 'string' || !rawDoc.name.trim()) {
    warnings.push('文档名为空，已使用「未命名」');
  }
  if (rawLayers.length === 0) {
    warnings.push('文件没有图层，已创建空白图层');
  }

  const layerIds = new Set(doc.layers.map((layer) => layer.id));
  const allObjectIds = new Set<string>();
  for (const layer of doc.layers) {
    for (const object of layer.objects) allObjectIds.add(object.id);
  }

  const rawStyles = new Map<string, unknown>();
  for (const rawLayer of rawLayers) {
    if (!isRecord(rawLayer) || !Array.isArray(rawLayer.objects)) continue;
    for (const rawObject of rawLayer.objects) {
      if (isRecord(rawObject) && typeof rawObject.id === 'string') {
        rawStyles.set(rawObject.id, rawObject.style);
      }
    }
  }

  let fixedLayerNames = 0;
  let fixedLayerKinds = 0;
  let fixedLayerParents = 0;
  let fixedObjectLayers = 0;
  let fixedObjectParents = 0;
  let fixedGroups = 0;
  let fixedMirrors = 0;
  let fixedClips = 0;
  let fixedStyles = 0;
  let fixedImageMeta = 0;

  const layers: Layer[] = doc.layers.map((layer, index) => {
    let name = typeof layer.name === 'string' ? layer.name.trim() : '';
    if (!name) {
      name = `图层 ${index + 1}`;
      fixedLayerNames += 1;
    }
    const kind = LAYER_KINDS.includes(layer.kind) ? layer.kind : 'vector';
    if (kind !== layer.kind) fixedLayerKinds += 1;
    const parentId =
      layer.parentId && layerIds.has(layer.parentId) && layer.parentId !== layer.id
        ? layer.parentId
        : null;
    if (parentId !== (layer.parentId ?? null)) fixedLayerParents += 1;

    const layerObjectIds = new Set(layer.objects.map((object) => object.id));
    const objects: SceneObject[] = layer.objects.map((object) => {
      let next = object;
      if (object.layerId !== layer.id) {
        next = { ...next, layerId: layer.id };
        fixedObjectLayers += 1;
      }
      if (next.parentId && !layerObjectIds.has(next.parentId)) {
        next = { ...next, parentId: null };
        fixedObjectParents += 1;
      }
      if (next.type === 'group') {
        const children = next.childIds.filter((id) => layerObjectIds.has(id));
        if (children.length !== next.childIds.length) {
          next = { ...next, childIds: children };
          fixedGroups += 1;
        }
      }
      if (next.mirrorOf && !allObjectIds.has(next.mirrorOf)) {
        next = { ...next };
        delete next.mirrorOf;
        delete next.mirrorKind;
        fixedMirrors += 1;
      }
      if (next.clipIds) {
        const clips = next.clipIds.filter((id) => allObjectIds.has(id));
        if (clips.length !== next.clipIds.length) {
          if (clips.length > 0) {
            next = { ...next, clipIds: clips };
          } else {
            next = { ...next };
            delete next.clipIds;
          }
          fixedClips += 1;
        }
      }
      if (next.type === 'image') {
        const naturalWidth =
          isFiniteNumber(next.naturalWidth) && next.naturalWidth > 0
            ? next.naturalWidth
            : Math.max(1, next.width);
        const naturalHeight =
          isFiniteNumber(next.naturalHeight) && next.naturalHeight > 0
            ? next.naturalHeight
            : Math.max(1, next.height);
        if (naturalWidth !== next.naturalWidth || naturalHeight !== next.naturalHeight) {
          next = { ...next, naturalWidth, naturalHeight };
          fixedImageMeta += 1;
        }
        if (
          next.imageFormat !== undefined &&
          !['png', 'jpeg', 'webp', 'gif', 'bmp'].includes(String(next.imageFormat))
        ) {
          next = { ...next };
          delete next.imageFormat;
          fixedImageMeta += 1;
        }
      }
      if (!styleLooksValid(rawStyles.get(object.id))) {
        next = { ...next, style: normalizeImportedStyle(next.style) };
        fixedStyles += 1;
      }
      return next;
    });

    return { ...layer, name, kind, parentId, objects };
  });

  // 网格 / 纸张背景缺失时渲染会读到 undefined：统一下沉为安全默认值。
  const rawGrid = rawDoc.grid;
  const gridValues = isRecord(rawGrid) ? rawGrid : {};
  const grid = {
    visible: gridValues.visible !== false,
    size: isFiniteNumber(gridValues.size) && gridValues.size > 0 ? gridValues.size : 10,
    subdivisions:
      isFiniteNumber(gridValues.subdivisions) && gridValues.subdivisions > 0
        ? gridValues.subdivisions
        : 5,
    snap: gridValues.snap !== false,
    snapStep:
      isFiniteNumber(gridValues.snapStep) && gridValues.snapStep > 0 ? gridValues.snapStep : 10
  };
  const gridBroken =
    !isRecord(rawGrid) ||
    !isFiniteNumber(rawGrid.size) ||
    !isFiniteNumber(rawGrid.subdivisions) ||
    !isFiniteNumber(rawGrid.snapStep);
  if (gridBroken) warnings.push('已补齐缺失的网格设置');

  const background =
    typeof doc.page.background === 'string' &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(doc.page.background)
      ? doc.page.background
      : '#ffffff';
  if (background !== doc.page.background) warnings.push('已修正无效的纸张背景色');

  if (fixedLayerNames > 0) warnings.push(`已补齐 ${fixedLayerNames} 个图层名称`);
  if (fixedLayerKinds > 0) warnings.push(`已修正 ${fixedLayerKinds} 个图层的类型`);
  if (fixedLayerParents > 0) warnings.push(`已清理 ${fixedLayerParents} 个失效的图层文件夹引用`);
  if (fixedObjectLayers > 0) warnings.push(`已修正 ${fixedObjectLayers} 个对象的图层归属`);
  if (fixedObjectParents > 0) warnings.push(`已清理 ${fixedObjectParents} 个悬空的编组父级引用`);
  if (fixedGroups > 0) warnings.push(`已丢弃 ${fixedGroups} 组失效的编组子对象引用`);
  if (fixedMirrors > 0) warnings.push(`已移除 ${fixedMirrors} 个找不到源对象的镜像标记`);
  if (fixedClips > 0) warnings.push(`已清理 ${fixedClips} 个失效的裁剪范围引用`);
  if (fixedImageMeta > 0) warnings.push(`已为 ${fixedImageMeta} 个位图对象补齐原始尺寸`);
  if (fixedStyles > 0) warnings.push(`已为 ${fixedStyles} 个缺失样式的对象补齐默认样式`);

  return {
    doc: { ...doc, grid, page: { ...doc.page, background }, layers },
    warnings
  };
}

function inspectDocumentSource(
  fileName: string,
  text: string,
  format: 'vdraw' | 'json'
): ImportedDocumentSource {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    throw new ImportError(
      'invalid-json',
      '文件不是有效的 JSON',
      detail ? `解析错误：${detail}` : '请确认文件是 VDraw 保存的 .vdraw 工程，或改用 SVG 导入。'
    );
  }
  if (!isRecord(payload)) {
    throw new ImportError('invalid-document', '文件内容不是 VDraw 文档对象');
  }

  const version = readSchemaVersion(payload);
  const hasEnvelope = 'document' in payload;
  if (hasEnvelope && !isRecord(payload.document)) {
    throw new ImportError('invalid-document', '文件缺少有效的 document 文档数据');
  }
  const rawDoc = (hasEnvelope ? payload.document : payload) as Record<string, unknown>;
  inspectDocumentStructure(rawDoc);

  const damagedEditor = payload.editor !== undefined && !isRecord(payload.editor);
  if (damagedEditor) {
    // editor 只是工作环境（对称/辅助线），损坏时丢弃即可，不影响图形数据。
    delete payload.editor;
  }

  let parsed: { doc: VDrawDocument; editor: EditorSnapshot | null };
  try {
    parsed = parseDocumentFile(text);
  } catch (error) {
    throw new ImportError(
      'invalid-document',
      `文档解析失败：${error instanceof Error ? error.message : '未知错误'}`,
      '文件结构可能已损坏，请尝试从自动恢复点或备份重新保存。'
    );
  }

  const repaired = repairDocument(parsed.doc, rawDoc);
  const doc = repaired.doc;
  const warnings = repaired.warnings;
  if (damagedEditor) warnings.push('编辑器环境数据（对称/辅助线）已忽略');

  const layers = doc.layers.length;
  const objects = doc.layers.reduce((total, layer) => total + layer.objects.length, 0);
  const template = TEMPLATE_MAP[doc.templateId];
  const source: ImportedDocumentSource = {
    kind: 'document',
    format,
    fileName,
    suggestedName: baseName(fileName) || doc.name || '导入画布',
    doc,
    editor: parsed.editor,
    warnings,
    stats: {
      version,
      app: typeof payload.app === 'string' ? payload.app : null,
      savedAt: typeof payload.savedAt === 'string' ? payload.savedAt : null,
      templateName: template?.name ?? '自定义画布',
      pageWidth: doc.page.width,
      pageHeight: doc.page.height,
      layers,
      objects
    }
  };
  return source;
}

const SVG_SKIP_TAGS = new Set(['defs', 'style', 'title', 'metadata', 'desc']);
const SVG_CONTAINER_TAGS = new Set(['g', 'svg', 'symbol', 'a']);
const SVG_DRAWABLE_TAGS = new Set([
  'rect',
  'circle',
  'ellipse',
  'line',
  'polygon',
  'polyline',
  'path',
  'text'
]);

function svgLength(element: Element, name: string, fallback: number): number {
  const raw = (element.getAttribute(name) ?? '').trim();
  if (!raw || raw.endsWith('%')) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

interface SvgInspection {
  width: number;
  height: number;
  elements: number;
  skipped: number;
}

function inspectSvgStructure(root: Element): SvgInspection {
  const viewBox = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value));
  const width =
    hasViewBox && viewBox[2] > 0 ? viewBox[2] : svgLength(root, 'width', 800);
  const height =
    hasViewBox && viewBox[3] > 0 ? viewBox[3] : svgLength(root, 'height', 600);

  let elements = 0;
  let skipped = 0;
  const walk = (element: Element) => {
    for (const child of Array.from(element.children)) {
      const tag = child.nodeName.toLowerCase();
      if (SVG_SKIP_TAGS.has(tag)) continue;
      if (SVG_CONTAINER_TAGS.has(tag)) {
        walk(child);
        continue;
      }
      if (SVG_DRAWABLE_TAGS.has(tag)) {
        elements += 1;
        continue;
      }
      skipped += 1;
    }
  };
  walk(root);
  return { width, height, elements, skipped };
}

function inspectSvgSource(fileName: string, text: string): ImportedSvgSource {
  if (typeof DOMParser === 'undefined') {
    throw new ImportError('invalid-svg', '当前环境不支持 SVG 解析', '请使用桌面应用或现代浏览器打开 VDraw。');
  }
  const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
  const errorNode = xml.querySelector('parsererror');
  if (errorNode) {
    throw new ImportError(
      'invalid-svg',
      'SVG 解析失败：XML 结构不完整',
      '请确认文件没有被截断；动画、脚本或外部引用不会被执行。'
    );
  }
  const root = xml.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') {
    throw new ImportError('invalid-svg', '不是有效的 SVG 文件', 'SVG 的根元素必须是 <svg>。');
  }

  const inspection = inspectSvgStructure(root);
  if (inspection.elements === 0) {
    throw new ImportError(
      'empty-svg',
      'SVG 中没有可导入的图元',
      '支持 path / rect / circle / ellipse / line / polyline / polygon / text 及其分组。'
    );
  }

  const warnings: string[] = [];
  if (inspection.skipped > 0) {
    warnings.push(`将跳过 ${inspection.skipped} 个暂不支持的元素（如渐变、滤镜、位图或裁剪）`);
  }

  return {
    kind: 'svg',
    format: 'svg',
    fileName,
    suggestedName: baseName(fileName) || '导入 SVG',
    text,
    warnings,
    stats: {
      width: inspection.width,
      height: inspection.height,
      elements: inspection.elements,
      skipped: inspection.skipped
    }
  };
}

export interface ImportValidationInput {
  fileName: string;
  content: string;
}

/** 统一的导入入口：格式识别 → 结构校验 → 归一化，失败时抛出带提示的 ImportError。 */
export function validateImportContent(input: ImportValidationInput): ImportedSource {
  const text = stripBom(input.content);
  if (!text.trim()) {
    throw new ImportError(
      'empty-file',
      '文件是空的，没有可导入的内容',
      '请选择保存过内容的 .vdraw 工程文件或导出的 SVG。'
    );
  }
  if (text.length > MAX_IMPORT_BYTES) {
    throw new ImportError(
      'file-too-large',
      `文件内容超过 ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB 上限`,
      '请在 VDraw 中拆分文档后重新保存。'
    );
  }
  const format = detectImportFormat(input.fileName, text);
  return format === 'svg'
    ? inspectSvgSource(input.fileName, text)
    : inspectDocumentSource(input.fileName, text, format);
}

function cloneDocument(doc: VDrawDocument): VDrawDocument {
  return JSON.parse(JSON.stringify(doc)) as VDrawDocument;
}

function remapObjects(
  layer: Layer,
  targetLayerId: string,
  objectIds: Map<string, string>
): SceneObject[] {
  return layer.objects.map((object) => {
    const next = JSON.parse(JSON.stringify(object)) as SceneObject;
    next.id = objectIds.get(object.id) ?? createId(object.type);
    next.layerId = targetLayerId;
    next.parentId = object.parentId ? objectIds.get(object.parentId) ?? null : null;
    if (next.type === 'group') {
      next.childIds = next.childIds
        .map((id) => objectIds.get(id))
        .filter((id): id is string => Boolean(id));
    }
    if (next.mirrorOf) {
      const mirror = objectIds.get(next.mirrorOf);
      if (mirror) next.mirrorOf = mirror;
      else {
        delete next.mirrorOf;
        delete next.mirrorKind;
      }
    }
    if (next.clipIds) {
      const clips = next.clipIds
        .map((id) => objectIds.get(id))
        .filter((id): id is string => Boolean(id));
      if (clips.length > 0) next.clipIds = clips;
      else delete next.clipIds;
    }
    return next;
  });
}

/** 新建画布：沿用导入文档的页面与图层，但使用新文档身份，避免覆盖当前文件。 */
export function documentImportToNewDocument(
  source: ImportedDocumentSource,
  fallbackName: string
): VDrawDocument {
  const now = new Date().toISOString();
  const doc = cloneDocument(source.doc);
  return {
    ...doc,
    id: createId('doc'),
    name: source.suggestedName || fallbackName || doc.name || '导入画布',
    filePath: null,
    createdAt: now,
    updatedAt: now
  };
}

/** 覆盖当前画布：保留当前文档的身份/文件名/保存路径，只替换页面与图形内容。 */
export function documentImportToReplacement(
  current: VDrawDocument,
  source: ImportedDocumentSource
): VDrawDocument {
  const imported = cloneDocument(source.doc);
  return {
    ...current,
    page: imported.page,
    grid: imported.grid,
    layers: imported.layers,
    activeLayerId: imported.activeLayerId,
    templateId: imported.templateId,
    implicitHydrogens: imported.implicitHydrogens,
    updatedAt: new Date().toISOString()
  };
}

export interface DocumentAppendResult {
  doc: VDrawDocument;
  layersAdded: number;
  objectsAdded: number;
}

/** 合并到当前画布：逐层重映射 id，避免与当前文档的图层/对象/编组引用冲突。 */
export function documentImportToAppend(
  current: VDrawDocument,
  source: ImportedDocumentSource
): DocumentAppendResult {
  const imported = cloneDocument(source.doc);
  const layerIds = new Map<string, string>();
  const objectIds = new Map<string, string>();
  for (const layer of imported.layers) {
    layerIds.set(layer.id, createId('layer'));
    for (const object of layer.objects) objectIds.set(object.id, createId(object.type));
  }

  const usedNames = new Set(current.layers.map((layer) => layer.name));
  const appended: Layer[] = imported.layers.map((layer) => {
    const id = layerIds.get(layer.id) as string;
    let name = layer.name?.trim() || '导入图层';
    if (usedNames.has(name)) {
      let index = 2;
      while (usedNames.has(`${name} ${index}`)) index += 1;
      name = `${name} ${index}`;
    }
    usedNames.add(name);
    return {
      ...layer,
      id,
      name,
      parentId: layer.parentId ? layerIds.get(layer.parentId) ?? null : null,
      objects: remapObjects(layer, id, objectIds)
    };
  });

  return {
    doc: {
      ...current,
      layers: [...current.layers, ...appended],
      updatedAt: new Date().toISOString()
    },
    layersAdded: appended.length,
    objectsAdded: appended.reduce((total, layer) => total + layer.objects.length, 0)
  };
}

function svgObjects(
  source: ImportedSvgSource,
  layerId: string,
  pageWidth: number,
  pageHeight: number,
  fit: 'contain' | 'none',
  offset: { x: number; y: number } = { x: 0, y: 0 }
): SceneObject[] {
  return parseSvgToObjects(source.text, layerId, pageWidth, pageHeight, { fit, offset }).objects;
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(32, Math.min(MAX_PAGE_SIZE, Math.ceil(value)));
}

/** SVG 新建画布：页面尺寸取 SVG 自带尺寸，图形按原始用户单位放置。 */
export function svgImportToNewDocument(
  source: ImportedSvgSource,
  fallbackName: string
): { doc: VDrawDocument; objects: SceneObject[] } {
  const width = clampPageSize(source.stats.width);
  const height = clampPageSize(source.stats.height);
  const name = source.suggestedName || fallbackName || '导入画布';
  const doc = createCustomDocument({ name, width, height }, name);
  const layer = doc.layers[0];
  const objects = svgObjects(source, layer.id, width, height, 'none');
  return { doc: addObjectsToLayer(doc, layer.id, objects), objects };
}

export interface SvgImportResultBuild {
  doc: VDrawDocument;
  objects: SceneObject[];
  layerId: string;
}

/** SVG 覆盖当前画布：清空所有图层的对象，把图元放进当前绘图层（保留图层结构）。 */
export function svgImportToReplacement(
  current: VDrawDocument,
  source: ImportedSvgSource
): SvgImportResultBuild {
  const layer = drawLayer(current);
  if (!layer) {
    throw new ImportError(
      'no-draw-layer',
      '当前文档没有可用的绘图层',
      '请先新建一个普通图层，或把当前选中的文件夹展开后再导入。'
    );
  }
  if (layer.locked) {
    throw new ImportError(
      'locked-layer',
      `绘图层「${layer.name}」已锁定`,
      '请在右侧图层面板解锁该图层后重试。'
    );
  }
  // 保持 SVG 原始尺寸：超出页面时也不缩放/裁剪，用户可自行拖动或缩放。
  const objects = svgObjects(source, layer.id, current.page.width, current.page.height, 'none');
  return {
    doc: {
      ...current,
      layers: current.layers.map((item) =>
        item.id === layer.id ? { ...item, objects } : { ...item, objects: [] }
      ),
      updatedAt: new Date().toISOString()
    },
    objects,
    layerId: layer.id
  };
}

/** SVG 合并到当前画布：追加进当前绘图层，不改动已有对象。 */
export function svgImportToAppend(
  current: VDrawDocument,
  source: ImportedSvgSource
): SvgImportResultBuild {
  const layer = drawLayer(current);
  if (!layer) {
    throw new ImportError(
      'no-draw-layer',
      '当前文档没有可用的绘图层',
      '请先新建一个普通图层，或把当前选中的文件夹展开后再导入。'
    );
  }
  if (layer.locked) {
    throw new ImportError(
      'locked-layer',
      `绘图层「${layer.name}」已锁定`,
      '请在右侧图层面板解锁该图层后重试。'
    );
  }
  const objects = svgObjects(source, layer.id, current.page.width, current.page.height, 'none');
  return { doc: addObjectsToLayer(current, layer.id, objects), objects, layerId: layer.id };
}

export interface ImageImportBuild {
  doc: VDrawDocument;
  objects: SceneObject[];
  layerId: string;
  warnings: string[];
}

function buildImageObject(
  source: ImportedImageSource,
  layerId: string,
  pageWidth: number,
  pageHeight: number,
  offset: { x: number; y: number } = { x: 0, y: 0 }
): { object: SceneObject; warnings: string[] } {
  const placement = imagePlacement(
    source.stats.width,
    source.stats.height,
    pageWidth,
    pageHeight,
    offset
  );
  const warnings: string[] = [];
  if (placement.exceedsPage) {
    warnings.push('图片大于页面，已保持原始尺寸；可拖动或缩放调整，画布不会自动裁剪');
  }
  return {
    object: createImageObject(
      layerId,
      source.dataUrl,
      source.stats.width,
      source.stats.height,
      placement,
      imageObjectName(source),
      source.format
    ),
    warnings
  };
}

/** 位图新建画布：页面尺寸取图片像素尺寸，图片铺满页面。 */
export function imageImportToNewDocument(
  source: ImportedImageSource,
  fallbackName: string
): ImageImportBuild {
  const width = clampPageSize(source.stats.width);
  const height = clampPageSize(source.stats.height);
  const name = source.suggestedName || fallbackName || '导入图片';
  const doc = createCustomDocument({ name, width, height }, name);
  const layer = doc.layers[0];
  const built = buildImageObject(source, layer.id, width, height);
  return {
    doc: addObjectsToLayer(doc, layer.id, [built.object]),
    objects: [built.object],
    layerId: layer.id,
    warnings: built.warnings
  };
}

/** 位图覆盖当前画布：清空所有图层对象，把图片放进当前绘图层。 */
export function imageImportToReplacement(
  current: VDrawDocument,
  source: ImportedImageSource
): ImageImportBuild {
  const layer = drawLayer(current);
  if (!layer) {
    throw new ImportError(
      'no-draw-layer',
      '当前文档没有可用的绘图层',
      '请先新建一个普通图层，或把当前选中的文件夹展开后再导入。'
    );
  }
  if (layer.locked) {
    throw new ImportError(
      'locked-layer',
      `绘图层「${layer.name}」已锁定`,
      '请在右侧图层面板解锁该图层后重试。'
    );
  }
  const built = buildImageObject(source, layer.id, current.page.width, current.page.height);
  return {
    doc: {
      ...current,
      layers: current.layers.map((item) =>
        item.id === layer.id ? { ...item, objects: [built.object] } : { ...item, objects: [] }
      ),
      updatedAt: new Date().toISOString()
    },
    objects: [built.object],
    layerId: layer.id,
    warnings: built.warnings
  };
}

/** 位图合并到当前画布：追加进当前绘图层，不改动已有对象。 */
export function imageImportToAppend(
  current: VDrawDocument,
  source: ImportedImageSource
): ImageImportBuild {
  const layer = drawLayer(current);
  if (!layer) {
    throw new ImportError(
      'no-draw-layer',
      '当前文档没有可用的绘图层',
      '请先新建一个普通图层，或把当前选中的文件夹展开后再导入。'
    );
  }
  if (layer.locked) {
    throw new ImportError(
      'locked-layer',
      `绘图层「${layer.name}」已锁定`,
      '请在右侧图层面板解锁该图层后重试。'
    );
  }
  const built = buildImageObject(source, layer.id, current.page.width, current.page.height);
  return {
    doc: addObjectsToLayer(current, layer.id, [built.object]),
    objects: [built.object],
    layerId: layer.id,
    warnings: built.warnings
  };
}

/* ------------------------------------------------------------------ *
 * 批量导入：把多个已校验文件一次性写入「当前图层」或「新建图层」。
 * 两个落点共用一次 updateDoc，整批导入只产生一个撤销快照。
 * ------------------------------------------------------------------ */

export type LayerImportMode = 'append' | 'layer';

export interface ImportSourcesBuild {
  doc: VDrawDocument;
  /** 本批实际写入的对象（含编组子对象）。 */
  objects: SceneObject[];
  /** 顶层对象 ID，用于导入后直接选中并拖动/缩放。 */
  selection: string[];
  /** 写入的目标图层：append 为当前绘图层，layer 为各新建图层。 */
  layerIds: string[];
  layersAdded: number;
  objectsAdded: number;
  warnings: string[];
}

function uniqueLayerName(base: string, used: Set<string>): string {
  const clean = base.trim() || '导入图层';
  if (!used.has(clean)) {
    used.add(clean);
    return clean;
  }
  let index = 2;
  while (used.has(`${clean} ${index}`)) index += 1;
  const name = `${clean} ${index}`;
  used.add(name);
  return name;
}

/** 工程文件按对象写入单一图层：保留编组/镜像/裁剪引用，但不再保留原图层结构。 */
function flattenDocumentObjects(source: ImportedDocumentSource, layerId: string): SceneObject[] {
  const objectIds = new Map<string, string>();
  for (const layer of source.doc.layers) {
    for (const object of layer.objects) objectIds.set(object.id, createId(object.type));
  }
  return source.doc.layers.flatMap((layer) => remapObjects(layer, layerId, objectIds));
}

/** 批量导入时给后续文件一个 28px 级联偏移，避免多张图完全叠在同一位置。 */
function offsetImportedObjects(
  current: VDrawDocument,
  layerId: string,
  objects: SceneObject[],
  dx: number,
  dy: number
): SceneObject[] {
  if ((!dx && !dy) || objects.length === 0) return objects;
  const temp: VDrawDocument = {
    ...current,
    layers: [{ ...createLayer('批量导入临时层'), id: layerId, objects }]
  };
  const topIds = objects.filter((object) => !object.parentId).map((object) => object.id);
  return translateDocumentObjects(temp, topIds, dx, dy).layers[0].objects;
}

/**
 * 批量落点：
 * - append：所有文件写入当前绘图层（工程文件会摊平图层，对象 ID 全部重映射）。
 * - layer：每个文件新建一个图层，图层名取文件名；同样重映射 ID。
 * 位图/SVG 保持原始尺寸；超出页面时不缩放、不裁剪，只给出提示。
 */
export function importSourcesToDocument(
  current: VDrawDocument,
  sources: ImportedSource[],
  mode: LayerImportMode
): ImportSourcesBuild {
  if (sources.length === 0) {
    throw new ImportError('empty-file', '没有可导入的文件');
  }

  let layers: Layer[] = [...current.layers];
  const usedNames = new Set(layers.map((layer) => layer.name));
  const warnings: string[] = [];
  const imported: SceneObject[] = [];
  const createdLayerIds: string[] = [];

  let targetLayerId: string | null = null;
  if (mode === 'append') {
    const target = drawLayer(current);
    if (!target) {
      throw new ImportError(
        'no-draw-layer',
        '当前文档没有可用的绘图层',
        '请先新建一个普通图层，或把当前选中的文件夹展开后再导入。'
      );
    }
    if (target.locked) {
      throw new ImportError(
        'locked-layer',
        `绘图层「${target.name}」已锁定`,
        '请在右侧图层面板解锁该图层后重试。'
      );
    }
    targetLayerId = target.id;
  }

  const cascade = sources.length > 1;
  sources.forEach((source, index) => {
    const offset = {
      x: cascade ? index * 28 : 0,
      y: cascade ? index * 28 : 0
    };
    let layerId = targetLayerId;
    let createdLayer: Layer | null = null;
    if (mode === 'layer') {
      createdLayer = createLayer(
        uniqueLayerName(source.suggestedName || '导入图层', usedNames),
        'vector'
      );
      layerId = createdLayer.id;
    }
    if (!layerId) return;

    let objects: SceneObject[] = [];
    if (source.kind === 'document') {
      objects = flattenDocumentObjects(source, layerId);
      objects = offsetImportedObjects(current, layerId, objects, offset.x, offset.y);
    } else if (source.kind === 'image') {
      const built = buildImageObject(
        source,
        layerId,
        current.page.width,
        current.page.height,
        offset
      );
      objects = [built.object];
      warnings.push(...built.warnings.map((warning) => `「${source.fileName}」${warning}`));
    } else {
      objects = svgObjects(
        source,
        layerId,
        current.page.width,
        current.page.height,
        'none',
        offset
      );
      if (source.stats.width > current.page.width || source.stats.height > current.page.height) {
        warnings.push(
          `「${source.fileName}」画布尺寸大于页面，已保持原始尺寸；可拖动或缩放调整`
        );
      }
    }

    if (objects.length === 0) {
      warnings.push(`「${source.fileName}」没有可导入的对象`);
      return;
    }

    if (createdLayer) {
      layers = [...layers, { ...createdLayer, objects }];
      createdLayerIds.push(createdLayer.id);
    } else {
      layers = layers.map((layer) =>
        layer.id === layerId ? { ...layer, objects: [...layer.objects, ...objects] } : layer
      );
    }
    imported.push(...objects);
  });

  if (imported.length === 0) {
    throw new ImportError(
      'empty-file',
      '选中的文件没有可导入的对象',
      '请选择包含图形或位图的文件；空工程可以改用「新建画布」。'
    );
  }

  const activeLayerId =
    mode === 'append'
      ? targetLayerId ?? current.activeLayerId
      : createdLayerIds[createdLayerIds.length - 1] ?? current.activeLayerId;

  return {
    doc: {
      ...current,
      layers,
      activeLayerId,
      updatedAt: new Date().toISOString()
    },
    objects: imported,
    selection: imported.filter((object) => !object.parentId).map((object) => object.id),
    layerIds: mode === 'append' ? (targetLayerId ? [targetLayerId] : []) : createdLayerIds,
    layersAdded: createdLayerIds.length,
    objectsAdded: imported.length,
    warnings
  };
}
