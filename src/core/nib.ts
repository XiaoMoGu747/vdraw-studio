export interface NibShape {
  /** 椭圆笔尖的旋转角（弧度），沿倾斜方向。 */
  angle: number;
  /** 短轴/长轴，1 = 圆笔尖，越小越扁。 */
  aspect: number;
}

/**
 * 倾斜角 → 椭圆笔尖：
 * - tiltX/tiltY 为 PointerEvent 的角度值（度）；
 * - 倾角越大，接触面越扁，aspect 最小 0.35，避免退化成一条线；
 * - 倾斜方向决定椭圆长轴方向。
 */
export function nibFromTilt(tiltX = 0, tiltY = 0): NibShape {
  const magnitude = Math.min(75, Math.hypot(tiltX, tiltY));
  const aspect = Math.max(0.35, Math.cos((magnitude * Math.PI) / 180));
  return {
    angle: magnitude < 1 ? 0 : Math.atan2(tiltY, tiltX),
    aspect
  };
}

/**
 * 连续 stamp 覆盖时的单枚透明度：
 * 目标不透明度为 target，重叠次数为 overlap；
 * 用 1-(1-target)^(1/n) 让叠加后的视觉效果接近目标值。
 */
export function stampAlpha(target: number, overlap: number): number {
  const clamped = Math.min(1, Math.max(0.01, target));
  if (clamped >= 0.999) return 1;
  const coverage = Math.max(1, overlap);
  return 1 - Math.pow(1 - clamped, 1 / coverage);
}
