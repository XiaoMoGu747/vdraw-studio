import type { VDrawDocument, Vec } from '../../types/document';
import { findBondAnchor, type BondAnchor } from './chain';
import { idealBondAngle, type Hybridization } from './electronic';

/**
 * 落点解算器：把散落在画布各处的"吸附容差"收敛成一条规则。
 *
 * 基准来自 KingDraw 的实测：命中半径 0.15 文档单位，默认键长 0.78，
 * 即半径 ≈ 键长的 19%（docs/kingdraw-rea-analysis.md §12.1）。
 * 这里取 0.19 并把结果钳在 4–14 屏幕像素，再按缩放换算回文档坐标，
 * 保证不同缩放下"视觉吸附范围"稳定。
 */

export const CHEM_HIT_RATIO = 0.19;
export const CHEM_HIT_MIN_PX = 4;
export const CHEM_HIT_MAX_PX = 14;
/** 切换到另一个候选所需的额外距离（屏幕像素），避免两个候选之间抖动。 */
export const CHEM_HIT_HYSTERESIS_PX = 2;

export function snapRadius(bondLength: number, zoom = 1): number {
  const base = Math.max(1, bondLength) * CHEM_HIT_RATIO;
  const screen = Math.min(CHEM_HIT_MAX_PX, Math.max(CHEM_HIT_MIN_PX, base));
  return screen / Math.max(0.05, zoom);
}

interface HysteresisEntry {
  point: Vec;
  anchor: BondAnchor;
}

const hysteresis = new Map<string, HysteresisEntry>();

/** 结束一次拖动/切换工具时清掉迟滞状态。 */
export function resetSnapHysteresis(key?: string): void {
  if (key) hysteresis.delete(key);
  else hysteresis.clear();
}

export interface SnapOptions {
  bondLength: number;
  zoom: number;
  /** 迟滞键：同一支笔/同一次拖动用同一个 key。 */
  key?: string;
  /** 关闭迟滞（例如单击落点，需要严格取最近）。 */
  noHysteresis?: boolean;
}

/**
 * 统一落点解算：原子（P1）> 键端点（P2）> 环锚点由调用方补 > 网格由调用方补。
 * 优先级在 findBondAnchor 内部实现（原子两段式扫描），这里只负责半径与迟滞。
 */
export function resolveSnapAnchor(
  doc: VDrawDocument,
  point: Vec,
  options: SnapOptions
): BondAnchor | null {
  const radius = snapRadius(options.bondLength, options.zoom);
  const next = findBondAnchor(doc, point, radius);
  const key = options.key ?? 'default';

  if (!next) {
    hysteresis.delete(key);
    return null;
  }
  if (options.noHysteresis) {
    hysteresis.set(key, { point: next.point, anchor: next });
    return next;
  }

  const previous = hysteresis.get(key);
  if (previous && (previous.point.x !== next.point.x || previous.point.y !== next.point.y)) {
    const nextDistance = Math.hypot(next.point.x - point.x, next.point.y - point.y);
    const previousDistance = Math.hypot(
      previous.point.x - point.x,
      previous.point.y - point.y
    );
    if (nextDistance > previousDistance - CHEM_HIT_HYSTERESIS_PX / Math.max(0.05, options.zoom)) {
      return previous.anchor;
    }
  }
  hysteresis.set(key, { point: next.point, anchor: next });
  return next;
}

/**
 * 角度模板集合（度）。
 *
 * 刻意不包含 15°：KingDraw 全库不存在 15.0 与 π/12 常量，
 * 实际使用的是 30/45/60/90/120 这套离散模板（§12.2）。
 */
const BASE_TEMPLATES = [60, 90, 120, 180];

export function angleTemplatesFor(hybridization?: Hybridization | null): number[] {
  const templates = new Set<number>(BASE_TEMPLATES);
  if (hybridization) templates.add(Number(idealBondAngle(hybridization).toFixed(2)));
  return [...templates];
}

/** 角度吸附容差（度）：偏离模板不超过该值才吸附。 */
export const ANGLE_SNAP_TOLERANCE_DEG = 6;

export interface DirectionSnap {
  vector: Vec;
  /** 吸附后的角度（度），未吸附时为原始角度 */
  angle: number;
  snapped: boolean;
}

/** 把方向向量吸附到最近的模板角；未超过容差则原样返回。 */
export function snapVector(
  vector: Vec,
  templates: number[],
  toleranceDeg = ANGLE_SNAP_TOLERANCE_DEG
): DirectionSnap {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.001) return { vector, angle: 0, snapped: false };
  const angle = (Math.atan2(vector.y, vector.x) * 180) / Math.PI;
  let best = angle;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const template of templates) {
    // 同时考虑模板在四个象限的等价方向。
    for (const candidate of [template, 180 - template, 180 + template, 360 - template]) {
      const wrapped = ((candidate % 360) + 360) % 360;
      let delta = Math.abs(((angle - wrapped) % 360 + 360) % 360);
      if (delta > 180) delta = 360 - delta;
      if (delta < bestDelta) {
        bestDelta = delta;
        best = wrapped;
      }
    }
  }
  if (bestDelta > toleranceDeg) return { vector, angle, snapped: false };
  const rad = (best * Math.PI) / 180;
  return {
    vector: { x: Math.cos(rad) * length, y: Math.sin(rad) * length },
    angle: best,
    snapped: true
  };
}
