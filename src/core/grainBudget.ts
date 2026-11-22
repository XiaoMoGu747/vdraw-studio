import type { VDrawDocument } from '../types/document';
import { GRAIN_PATH_BUDGET, brushMaterialLayers } from './brushMaterial';

/**
 * 为整份文档分配「逐 dab 混合」预算：
 * - 按文档顺序累加 multiply 笔迹的 grain 元素数；
 * - 放得下预算的笔迹保留逐 dab；超出的笔迹由调用方传 forceBuckets，退化为 3 个分桶；
 * - SVG 选中导出用 allowed 限定只统计实际导出的对象。
 *
 * 该函数会调用 brushMaterialLayers 做一次计数，随后渲染/导出再次调用时命中同一几何缓存。
 */
export function grainBudgetIds(
  doc: VDrawDocument,
  allowed?: Set<string> | null
): Set<string> {
  const perDab = new Set<string>();
  let used = 0;
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (const object of layer.objects) {
      if (!object.visible) continue;
      if (object.type !== 'path' || !object.brushMaterial) continue;
      if (object.brushMaterial.blendMode !== 'multiply') continue;
      if (allowed && !allowed.has(object.id)) continue;
      const layers = brushMaterialLayers(
        object.nodes,
        object.brushMaterial,
        object.style.stroke.width || 2
      );
      const cost = layers.grain.length;
      if (used + cost <= GRAIN_PATH_BUDGET) {
        perDab.add(object.id);
        used += cost;
      }
    }
  }
  return perDab;
}
