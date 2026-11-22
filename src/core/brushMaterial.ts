import type { BrushBlendMode, BrushMaterial, PathNode } from '../types/document';
import { brushOutlineData } from './brush';
import { DAB_BUCKET_ALPHAS, dabBucket, dabPath, generateStampDabs } from './stamp';

export interface MaterialLayer {
  d: string;
  /** 相对基础不透明度的系数（0–1）。 */
  opacity: number;
  /** 混合模式：multiply 需要渲染/导出为逐 dab 元素。 */
  blendMode?: BrushBlendMode;
}

export interface BrushMaterialLayers {
  /** 软边底层：从宽到窄、从淡到浓，先画。 */
  edges: MaterialLayer[];
  /** dab 墨点：主笔迹之后画，按墨量分桶。 */
  grain: MaterialLayer[];
  /** 主体/软边的整体墨量（flow）；grain 已单独乘过，不重复。 */
  bodyOpacity: number;
  /** 整笔混合模式：主体/软边按此与背景混合，grain 逐 dab 各自混合。 */
  blendMode: BrushBlendMode;
  /** 本笔生成的 dab 数量（实时层用于调试/冒烟计数，不参与渲染）。 */
  dabCount: number;
}

/**
 * 材质是否值得入库/绘制：落笔、实时层、缓存共用同一阈值。
 * 普通勾线（硬边、无纹理）不生成派生层，避免无意义节点；
 * 但用户显式调低流量或选择混合模式时，即使硬边也要入库，否则参数会静默失效。
 */
export function hasBrushMaterial(material: {
  hardness: number;
  texture: number;
  flow?: number;
  blendMode?: BrushBlendMode;
}): boolean {
  return (
    material.texture > 0.08 ||
    material.hardness < 0.7 ||
    (typeof material.flow === 'number' && material.flow < 0.99) ||
    material.blendMode === 'multiply'
  );
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const CACHE_LIMIT = 256;
/** 单笔逐 dab 混合最多输出的元素数；超长笔迹退化为分桶 multiply，控制 SVG/DOM 体积。 */
const MAX_PER_DAB_LAYERS = 240;
/** 整份文档允许的逐 dab 元素总预算；超出后其余 multiply 笔迹退化为 3 个分桶。 */
export const GRAIN_PATH_BUDGET = 1200;
const materialLayerCache = new Map<string, BrushMaterialLayers>();
let cacheHits = 0;
let cacheMisses = 0;

function mixHash(hash: number, value: number): number {
  const quantized = Math.round((Number.isFinite(value) ? value : 0) * 1000);
  let next = (hash ^ quantized) >>> 0;
  next = Math.imul(next ^ (next >>> 16), 0x45d9f3b) >>> 0;
  return next;
}

/** 几何签名：节点、手柄、宽度、笔尖、材质或基宽任一变化都会使缓存失效。 */
function materialSignature(
  nodes: PathNode[],
  material: BrushMaterial,
  baseWidth: number,
  forceBuckets: boolean
): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const mix = (value: number) => {
    first = mixHash(first, value);
    second = mixHash(second ^ (first >>> 7), value + 0.618);
  };
  mix(nodes.length);
  mix(baseWidth);
  mix(material.hardness);
  mix(material.spacing);
  mix(material.texture);
  mix(material.seed);
  mix(material.flow ?? 1);
  mix(material.blendMode === 'multiply' ? 1 : 0);
  mix(forceBuckets ? 1 : 0);
  for (const node of nodes) {
    mix(node.x);
    mix(node.y);
    mix(node.width ?? -1);
    mix(node.handleIn?.x ?? -1);
    mix(node.handleIn?.y ?? -1);
    mix(node.handleOut?.x ?? -1);
    mix(node.handleOut?.y ?? -1);
    mix(node.nibAngle ?? -1);
    mix(node.nibAspect ?? -1);
    mix(node.type === 'smooth' ? 1 : 0);
    mix(node.handleLocked ? 1 : 0);
  }
  return `${first.toString(36)}-${second.toString(36)}-${nodes.length}`;
}

/** 清空缓存并重置命中统计（测试或大批量文档切换时使用）。 */
export function clearBrushMaterialCache(): void {
  materialLayerCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

export function brushMaterialCacheStats(): { size: number; hits: number; misses: number } {
  return { size: materialLayerCache.size, hits: cacheHits, misses: cacheMisses };
}

/**
 * 由笔迹中心线 + 材质参数派生可导出的矢量层。
 * - 软边：两条向外扩张、透明度递减的轮廓（不依赖 SVG filter）；
 * - 墨点：矢量 stamp dab（方向场椭圆 + 确定性墨量），按墨量分 3 桶合并为 path。
 * 渲染与导出共用一份按几何签名的缓存：文档重建但几何未变时直接复用。
 */
export function brushMaterialLayers(
  nodes: PathNode[],
  material: BrushMaterial,
  baseWidth: number,
  options: { forceBuckets?: boolean; noCache?: boolean } = {}
): BrushMaterialLayers {
  if (nodes.length < 2) {
    return { edges: [], grain: [], bodyOpacity: 1, blendMode: 'normal', dabCount: 0 };
  }
  const forceBuckets = options.forceBuckets === true;
  if (options.noCache) {
    // 实时层每帧几何都不同：走缓存只会不断写入无效键并淘汰成品层。
    return computeBrushMaterialLayers(nodes, material, baseWidth, forceBuckets);
  }
  const key = materialSignature(nodes, material, baseWidth, forceBuckets);
  const cached = materialLayerCache.get(key);
  if (cached) {
    cacheHits += 1;
    return cached;
  }
  cacheMisses += 1;
  const layers = computeBrushMaterialLayers(nodes, material, baseWidth, forceBuckets);
  materialLayerCache.set(key, layers);
  if (materialLayerCache.size > CACHE_LIMIT) {
    const oldest = materialLayerCache.keys().next().value;
    if (oldest !== undefined) materialLayerCache.delete(oldest);
  }
  return layers;
}

function computeBrushMaterialLayers(
  nodes: PathNode[],
  material: BrushMaterial,
  baseWidth: number,
  forceBuckets: boolean
): BrushMaterialLayers {
  const hardness = clamp01(Number.isFinite(material.hardness) ? material.hardness : 1);
  const texture = clamp01(Number.isFinite(material.texture) ? material.texture : 0);
  const width = Math.max(0.5, baseWidth);
  const hasWidths = nodes.some((node) => typeof node.width === 'number');
  const rawFlow = material.flow;
  const flow =
    typeof rawFlow === 'number' && Number.isFinite(rawFlow) ? clamp01(rawFlow) : 1;
  const blendMode: BrushBlendMode =
    material.blendMode === 'multiply' ? 'multiply' : 'normal';

  const edges: MaterialLayer[] = [];
  const soft = 1 - hardness;
  if (soft > 0.03) {
    const definitions = [
      { expand: soft * 0.55, alpha: soft * 0.16 },
      { expand: soft * 0.28, alpha: soft * 0.28 }
    ];
    for (const definition of definitions) {
      if (hasWidths) {
        const d = brushOutlineData(nodes, { expand: definition.expand });
        if (d) edges.push({ d, opacity: definition.alpha });
      } else {
        // 等宽笔迹没有节点宽度：临时按比例加宽节点再生成轮廓。
        const widened = nodes.map((node) => ({
          ...node,
          width: width * (1 + definition.expand)
        }));
        const d = brushOutlineData(widened);
        if (d) edges.push({ d, opacity: definition.alpha });
      }
    }
  }

  const grain: MaterialLayer[] = [];
  let dabCount = 0;
  if (texture > 0.03) {
    // 矢量 stamp：沿中心线按 spacing 定距铺排旋转椭圆 dab，
    // 墨量由固定 seed 决定；flow 控制每 dab 墨量。
    const dabs = generateStampDabs(nodes, material, width);
    dabCount = dabs.length;
    if (!forceBuckets && blendMode === 'multiply' && dabs.length <= MAX_PER_DAB_LAYERS) {
      // 逐 dab 输出：每个 dab 单独参与 mix-blend-mode，重叠处会继续相乘加深。
      for (const dab of dabs) {
        grain.push({
          d: dabPath(dab),
          opacity: DAB_BUCKET_ALPHAS[dabBucket(dab.ink)] * texture * flow,
          blendMode
        });
      }
    } else {
      // normal，或超长笔迹的体积兜底：按墨量分 3 桶合并。
      const buckets = ['', '', ''];
      for (const dab of dabs) {
        buckets[dabBucket(dab.ink)] += dabPath(dab);
      }
      buckets.forEach((d, bucket) => {
        if (d) {
          grain.push({
            d,
            opacity: DAB_BUCKET_ALPHAS[bucket] * texture * flow,
            blendMode: blendMode === 'multiply' ? 'multiply' : undefined
          });
        }
      });
    }
  }

  return { edges, grain, bodyOpacity: flow, blendMode, dabCount };
}
