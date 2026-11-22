import type {
  CustomBrushPreset,
  EditorSnapshot,
  GuideMode,
  GuideSettings,
  Style,
  SymmetryMode,
  VDrawDocument
} from '../../types/document';
import { DEFAULT_STYLE, DEFAULT_TEMPLATE_ID, createLayer } from '../document';
import { normalizeBrushEntries } from './brushLibrary';

export const SCHEMA_VERSION = 1;

export interface VDrawFilePayload {
  schemaVersion: number;
  app: string;
  savedAt: string;
  document: VDrawDocument;
  /** 编辑器工作环境：对称/辅助线等，旧文件没有该字段。 */
  editor?: EditorSnapshot;
}

export function serializeDocument(doc: VDrawDocument, editor?: EditorSnapshot): string {
  const payload: VDrawFilePayload = {
    schemaVersion: SCHEMA_VERSION,
    app: 'VDraw Studio',
    savedAt: new Date().toISOString(),
    document: doc,
    ...(editor ? { editor } : {})
  };
  return JSON.stringify(payload, null, 2);
}

function normalizeStyle(style: Partial<Style> | undefined): Style {
  return {
    fill: style?.fill ?? { ...DEFAULT_STYLE.fill },
    stroke: style?.stroke ?? JSON.parse(JSON.stringify(DEFAULT_STYLE.stroke)),
    opacity: typeof style?.opacity === 'number' ? style.opacity : 1
  };
}

const SYMMETRY_MODES: SymmetryMode[] = ['none', 'vertical', 'horizontal', 'both'];
const GUIDE_MODES: GuideMode[] = ['none', 'one-point', 'two-point', 'three-point', 'grid', 'equal'];

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** 旧文件没有 editor 字段；损坏/越界的值回落到安全默认值。 */
function normalizeEditor(value: unknown): EditorSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<EditorSnapshot>;
  const axis = raw.symmetryAxis ?? { x: 0.5, y: 0.5 };
  const settings: Partial<GuideSettings> = raw.guideSettings ?? {};
  return {
    symmetry: SYMMETRY_MODES.includes(raw.symmetry as SymmetryMode)
      ? (raw.symmetry as SymmetryMode)
      : 'none',
    symmetryAxis: {
      x: clampNumber(axis.x, 0.5, 0, 1),
      y: clampNumber(axis.y, 0.5, 0, 1)
    },
    guideMode: GUIDE_MODES.includes(raw.guideMode as GuideMode)
      ? (raw.guideMode as GuideMode)
      : 'none',
    guideSettings: {
      horizon: clampNumber(settings.horizon, 0.42, 0, 1),
      vpX: clampNumber(settings.vpX, 0.5, -1, 2),
      vpLeft: clampNumber(settings.vpLeft, -0.18, -1, 2),
      vpRight: clampNumber(settings.vpRight, 1.18, -1, 2),
      vpBottom: clampNumber(settings.vpBottom, 1.75, -1, 3)
    },
    guideAssist: raw.guideAssist === true,
    guideDensity: clampNumber(raw.guideDensity, 24, 8, 48),
    guideSpacing: clampNumber(raw.guideSpacing, 120, 20, 600),
    // 文档携带的笔刷：逐项夹取/去无名，最多 200；旧文件没有该字段时为空。
    customBrushes: normalizeBrushEntries(raw.customBrushes, 'doc-brush').brushes as CustomBrushPreset[]
  };
}

export function parseDocumentFile(raw: string): {
  doc: VDrawDocument;
  editor: EditorSnapshot | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('文件内容为空');

  const payload = parsed as Partial<VDrawFilePayload> & { document?: VDrawDocument };
  // 无版本号的旧文件按 1 处理；未来版本不猜测字段语义，直接拒绝以免静默损坏。
  const version = typeof payload.schemaVersion === 'number' ? payload.schemaVersion : 1;
  if (!Number.isFinite(version) || version < 1 || version > SCHEMA_VERSION) {
    throw new Error(`文件版本 ${version} 不受支持（当前支持 ${SCHEMA_VERSION}）`);
  }
  const doc = payload.document ?? (parsed as VDrawDocument);
  if (!doc || typeof doc !== 'object') throw new Error('缺少文档数据');

  if (!doc.page || typeof doc.page.width !== 'number' || typeof doc.page.height !== 'number') {
    throw new Error('文档页面数据无效');
  }
  if (!Array.isArray(doc.layers)) throw new Error('文档图层数据无效');

  const layers = doc.layers.length > 0 ? doc.layers : [createLayer('图层 1')];
  const normalizedLayers = layers.map((layer) => ({
    ...layer,
    visible: layer.visible !== false,
    locked: layer.locked === true,
    objects: Array.isArray(layer.objects)
      ? layer.objects.map((obj) => ({
          ...obj,
          visible: obj.visible !== false,
          locked: obj.locked === true,
          rotation: typeof obj.rotation === 'number' ? obj.rotation : 0,
          style: normalizeStyle(obj.style),
          parentId: obj.parentId ?? null
        }))
      : []
  }));

  const activeLayerId = normalizedLayers.some((layer) => layer.id === doc.activeLayerId)
    ? doc.activeLayerId
    : normalizedLayers[0].id;

  const normalizedDoc: VDrawDocument = {
    ...doc,
    name: doc.name || '未命名',
    page: {
      width: doc.page.width,
      height: doc.page.height,
      background: doc.page.background || '#ffffff',
      backgroundVisible: doc.page.backgroundVisible !== false,
      unit: 'px',
      infinite: doc.page.infinite === true
    },
    grid: { ...doc.grid },
    layers: normalizedLayers,
    activeLayerId,
    templateId: doc.templateId || DEFAULT_TEMPLATE_ID,
    filePath: doc.filePath ?? null,
    createdAt: doc.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  return { doc: normalizedDoc, editor: normalizeEditor(payload.editor) };
}

export function deserializeDocument(raw: string): VDrawDocument {
  return parseDocumentFile(raw).doc;
}

export function baseName(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  return name.replace(/\.[^.]+$/, '') || '未命名';
}
