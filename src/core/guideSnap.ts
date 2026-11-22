import type { Vec } from '../types/document';

/**
 * 与 CanvasGuides.radialLines 一致的射线方向集合：
 * 可见射线按 2π/count 均分，方向是无向的，取半圆 count 个即可。
 * 吸附方向量化到这些角度，笔迹就能贴合画布上真实存在的射线。
 */
export function guideRayDirections(density: number): Vec[] {
  const count = Math.max(8, Math.min(48, Math.round(density)));
  return Array.from({ length: count }, (_, index) => {
    const angle = (index * Math.PI) / count;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
}

/** 等大参考网格：从页面中线向两侧按固定间距排线，带数量上限。 */
export function equalGridOffsets(size: number, spacing: number, cap = 60): number[] {
  const step = Math.max(8, spacing);
  const center = size / 2;
  const offsets: number[] = [];
  for (let distance = step; distance < size; distance += step) {
    if (offsets.length >= cap) break;
    for (const value of [center + distance, center - distance]) {
      if (value > 0 && value < size) offsets.push(value);
    }
  }
  return offsets.sort((a, b) => a - b);
}
