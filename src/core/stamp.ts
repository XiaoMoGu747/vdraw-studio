import type { BrushMaterial, PathNode } from '../types/document';
import { flattenNodes, maxNodeWidth } from './brush';

/**
 * 落笔后的矢量 dab（笔尖印记）。
 *
 * 与「随机散点」不同：dab 沿中心线按 spacing 定距铺排，长轴跟随路径切线
 * （方向场笔尖），墨量由固定 seed 决定，因此同一笔在画布 / SVG / 重新打开后完全一致。
 */
export interface StampDab {
  x: number;
  y: number;
  /** 长半轴，沿方向场（路径切线 + 笔尖角度）。 */
  rx: number;
  /** 短半轴，恒 <= rx，避免 SVG 自动交换长短轴。 */
  ry: number;
  /** 长轴旋转角（度）。 */
  rotation: number;
  /** 墨量 0–1，确定性伪随机。 */
  ink: number;
}

const MAX_DABS = 420;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round = (value: number) => Math.round(value * 100) / 100;

/** 墨量分桶透明度：绘制期实时层与落笔后的 SVG/导出必须共用同一组系数。 */
export const DAB_BUCKET_ALPHAS = [0.18, 0.32, 0.5] as const;

export function dabBucket(ink: number): number {
  return Math.min(2, Math.floor(clamp01(ink) * 3));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把旋转椭圆写进一段 SVG path：两段带 x-axis-rotation 的半椭圆弧。 */
export function dabPath(dab: StampDab): string {
  const radians = (dab.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rx = Math.max(0.2, round(dab.rx));
  const ry = Math.max(0.2, Math.min(rx, round(dab.ry)));
  const x1 = round(dab.x + rx * cos);
  const y1 = round(dab.y + rx * sin);
  const x2 = round(dab.x - rx * cos);
  const y2 = round(dab.y - rx * sin);
  const rotation = round(dab.rotation);
  return (
    `M ${x1} ${y1} A ${rx} ${ry} ${rotation} 1 0 ${x2} ${y2} ` +
    `A ${rx} ${ry} ${rotation} 1 0 ${x1} ${y1} Z `
  );
}

/**
 * 单个 dab 的唯一构造入口：绘制期实时层与落笔后的矢量层共用，
 * 保证方向场、长短轴、墨量与横向抖动完全同源。
 */
export function createStampDab(
  x: number,
  y: number,
  width: number,
  tangent: number,
  nibAngle: number | undefined,
  nibAspect: number | undefined,
  rng: () => number
): StampDab {
  const aspect =
    typeof nibAspect === 'number' && nibAspect > 0.3 && nibAspect < 0.995
      ? nibAspect
      : 0.72 + 0.2 * rng();
  const rx = Math.max(0.2, width * (0.34 + 0.08 * rng()));
  const ry = Math.max(0.2, rx * Math.max(0.3, Math.min(0.98, aspect)));
  const offset = (rng() - 0.5) * width * 0.14;
  const normalX = -Math.sin(tangent);
  const normalY = Math.cos(tangent);
  const rotation =
    (tangent * 180) / Math.PI +
    (typeof nibAngle === 'number' ? (nibAngle * 180) / Math.PI : 0);
  return {
    x: x + normalX * offset,
    y: y + normalY * offset,
    rx,
    ry,
    rotation,
    // 0.15 起跳，让最低墨量桶（alpha 0.18）也能被用到；三档都有实际分布。
    ink: clamp01(0.15 + 0.85 * rng())
  };
}

/**
 * 由笔迹中心线 + 材质参数生成 dab 序列。
 * - `spacing` 真正决定 dab 间距（相对笔宽）；
 * - `texture` 决定墨量变化幅度（此处只影响后续分桶透明度，ink 本身是确定性权重）；
 * - `nibAngle` / `nibAspect` 决定方向场与椭圆长短轴比。
 */
export function generateStampDabs(
  nodes: PathNode[],
  material: BrushMaterial,
  baseWidth: number
): StampDab[] {
  if (nodes.length < 2) return [];
  const width = Math.max(0.5, baseWidth);
  const spacing = Number.isFinite(material.spacing)
    ? Math.max(0.05, Math.min(2, material.spacing))
    : 0.5;
  const points = flattenNodes(nodes, false, 0.8, width);
  if (points.length < 2) return [];

  const lengths: number[] = [0];
  for (let index = 1; index < points.length; index += 1) {
    lengths.push(
      lengths[index - 1] +
        Math.hypot(
          points[index].x - points[index - 1].x,
          points[index].y - points[index - 1].y
        )
    );
  }
  const total = lengths[lengths.length - 1];
  if (total <= 0) return [];

  const base = Math.max(width, maxNodeWidth(nodes));
  let step = Math.max(0.9, base * Math.max(0.08, spacing));
  if (total / step > MAX_DABS) step = total / MAX_DABS;

  const rng = mulberry32(Math.floor(material.seed) || 1);
  const dabs: StampDab[] = [];
  let index = 1;
  for (let distance = step * 0.5; distance < total; distance += step) {
    while (index < lengths.length - 1 && lengths[index] < distance) index += 1;
    const start = points[index - 1];
    const end = points[index] ?? start;
    const span = lengths[index] - lengths[index - 1] || 1;
    const t = Math.min(1, Math.max(0, (distance - lengths[index - 1]) / span));
    const before = points[Math.max(0, index - 2)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const tangent = Math.atan2(after.y - before.y, after.x - before.x);
    const centerWidth = start.width + (end.width - start.width) * t;
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t;
    dabs.push(
      createStampDab(
        x,
        y,
        centerWidth,
        tangent,
        start.nibAngle ?? end.nibAngle,
        start.nibAspect ?? end.nibAspect,
        rng
      )
    );
  }
  return dabs;
}
