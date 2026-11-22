import type { BrushBlendMode, CustomBrushPreset } from '../../types/document';

/** 笔刷库中的单支笔刷（与自定义预设同构，flow/blendMode 必填）。 */
export interface BrushLibraryEntry {
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
  flow: number;
  blendMode: BrushBlendMode;
}

export interface BrushLibraryFile {
  schemaVersion: 1;
  app: 'VDraw Studio';
  kind: 'brush-library';
  exportedAt: string;
  brushes: BrushLibraryEntry[];
}

const MAX_BRUSHES = 200;
const BLEND_MODES: BrushBlendMode[] = ['normal', 'multiply'];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function serializeBrushLibrary(brushes: BrushLibraryEntry[]): string {
  const payload: BrushLibraryFile = {
    schemaVersion: 1,
    app: 'VDraw Studio',
    kind: 'brush-library',
    exportedAt: new Date().toISOString(),
    brushes: brushes.slice(0, MAX_BRUSHES).map((brush) => ({
      ...brush,
      flow: brush.flow ?? 1,
      blendMode: brush.blendMode === 'multiply' ? 'multiply' : 'normal'
    }))
  };
  return JSON.stringify(payload, null, 2);
}

/** 把任意数组归一化为合法的笔刷条目；文档 editor 与 .vbrush 共用。 */
export function normalizeBrushEntries(
  value: unknown,
  idPrefix = 'imported'
): { brushes: BrushLibraryEntry[]; skipped: number } {
  if (!Array.isArray(value)) return { brushes: [], skipped: 0 };
  const brushes: BrushLibraryEntry[] = [];
  let skipped = 0;
  for (const item of value.slice(0, MAX_BRUSHES)) {
    if (!item || typeof item !== 'object') {
      skipped += 1;
      continue;
    }
    const source = item as Partial<BrushLibraryEntry>;
    const name = typeof source.name === 'string' ? source.name.trim() : '';
    if (!name) {
      skipped += 1;
      continue;
    }
    brushes.push({
      id: `${idPrefix}-${brushes.length}`,
      name: name.slice(0, 32),
      width: clamp(finite(source.width, 6), 1, 80),
      opacity: clamp(finite(source.opacity, 1), 0.05, 1),
      hardness: clamp(finite(source.hardness, 0.9), 0, 1),
      spacing: clamp(finite(source.spacing, 0.5), 0.05, 2),
      texture: clamp(finite(source.texture, 0), 0, 1),
      pressure: source.pressure === true,
      taper: clamp(finite(source.taper, 0.3), 0, 1),
      smoothing: clamp(finite(source.smoothing, 12), 0, 100),
      flow: clamp(finite(source.flow, 1), 0.05, 1),
      blendMode: BLEND_MODES.includes(source.blendMode as BrushBlendMode)
        ? (source.blendMode as BrushBlendMode)
        : 'normal'
    });
  }
  return {
    brushes,
    skipped: skipped + Math.max(0, value.length - MAX_BRUSHES)
  };
}

const brushSignature = (brush: CustomBrushPreset): string =>
  [
    brush.name,
    brush.width,
    brush.opacity,
    brush.hardness,
    brush.spacing,
    brush.texture,
    brush.pressure ? 1 : 0,
    brush.taper,
    brush.smoothing,
    brush.flow ?? 1,
    brush.blendMode === 'multiply' ? 'multiply' : 'normal'
  ].join('|');

/**
 * 把文档携带的笔刷并入本机库：
 * - 以「名称 + 全部参数」去重，本地已有同款不重复添加；
 * - 新条目重新生成 id，避免跨文档冲突；
 * - 仍遵守 200 支上限。
 */
export function mergeBrushPresets(
  existing: CustomBrushPreset[],
  incoming: CustomBrushPreset[],
  options: { limit?: number; idPrefix?: string } = {}
): { brushes: CustomBrushPreset[]; added: number } {
  const limit = options.limit ?? MAX_BRUSHES;
  const base = options.idPrefix ?? `merged-${Date.now().toString(36)}`;
  const brushes = [...existing];
  const seen = new Set(brushes.map(brushSignature));
  let added = 0;
  for (const brush of incoming) {
    if (brushes.length >= limit) break;
    const signature = brushSignature(brush);
    if (seen.has(signature)) continue;
    seen.add(signature);
    brushes.push({
      ...brush,
      id: `${base}-${brushes.length}`,
      flow: brush.flow ?? 1,
      blendMode: brush.blendMode === 'multiply' ? 'multiply' : 'normal'
    });
    added += 1;
  }
  return { brushes, added };
}

/**
 * 解析并归一化笔刷库：
 * - 拒绝非 JSON / 非 VDraw 笔刷库；
 * - 逐项夹取数值、丢弃无名条目；
 * - 最多保留 200 支，返回跳过数量供 UI 提示。
 */
export function parseBrushLibrary(raw: string): {
  brushes: BrushLibraryEntry[];
  skipped: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('笔刷库格式不正确');
  }
  const file = parsed as Partial<BrushLibraryFile>;
  if (file.kind !== 'brush-library' || !Array.isArray(file.brushes)) {
    throw new Error('不是 VDraw 笔刷库文件');
  }
  if (file.app !== undefined && file.app !== 'VDraw Studio') {
    throw new Error('笔刷库来源不是 VDraw Studio');
  }
  if (file.schemaVersion !== undefined && file.schemaVersion !== 1) {
    throw new Error('笔刷库版本不受支持');
  }

  const { brushes, skipped } = normalizeBrushEntries(file.brushes, 'imported');
  if (brushes.length === 0) throw new Error('笔刷库中没有可用的笔刷');
  return { brushes, skipped };
}
