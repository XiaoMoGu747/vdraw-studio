import type { PathNode, Vec } from '../types/document';
import { makeNode } from './factory';

/**
 * 画笔几何管线。
 *
 * 输入是原始指针采样（含压感），输出是"中心线 + 每节点宽度"的贝塞尔路径。
 * 关键约束：
 * 1. 平滑必须是时间归一化的（One Euro），否则同一参数在 60Hz 鼠标与 240Hz 笔下手感不同。
 * 2. 采样/抽稀都在页面坐标中完成，不随视口缩放变化，保证同一条手势输出同一几何。
 * 3. 只有存在宽度差时才写 node.width，纯等宽笔迹仍走普通 stroke，保持向后兼容。
 */

export interface BrushSample {
  x: number;
  y: number;
  /** 归一化压感 0–1。鼠标/触摸恒为 1。 */
  pressure: number;
  /** 事件时间戳（毫秒）。 */
  t: number;
  /** 手写笔倾斜角（度），鼠标/触摸为 0。 */
  tiltX?: number;
  tiltY?: number;
}

export interface BrushProjection {
  /** 抖动修正 0–100 */
  smoothing: number;
  /** 是否启用压感变宽 */
  pressure: boolean;
  /** 起收笔渐隐比例 0–1（相对笔迹长度的两端各占比例，且有像素上限） */
  taper: number;
  /** 基础线宽（页面像素） */
  width: number;
  /** 压感最细比例，默认 0.35 */
  minRatio?: number;
  /** 压感曲线 gamma：<1 轻压更粗，>1 需要更用力；默认 1 */
  pressureCurve?: number;
}

/**
 * 把归一化压感映射为宽度比例。
 * gamma < 1 提升轻压响应，gamma > 1 让笔迹更依赖实际压力。
 */
export function pressureScale(
  pressure: number,
  curve = 1,
  minRatio = 0.35
): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(pressure) ? pressure : 0));
  const gamma = Math.min(4, Math.max(0.1, Number.isFinite(curve) ? curve : 1));
  const curved = Math.pow(p, gamma);
  return minRatio + (1 - minRatio) * curved;
}

/** 采样间距（页面像素）：与视口无关，保证几何可复现。 */
const SAMPLE_SPACING = 0.5;
/** 抽稀阈值（页面像素）。 */
const SIMPLIFY_EPSILON = 0.32;
/** 单条笔迹节点上限，超出则加大抽稀阈值。 */
const MAX_NODES = 1200;
/** 宽度差小于该比例时视为等宽笔迹。 */
const UNIFORM_RATIO = 0.02;
/**
 * 收笔渐隐的绝对上限（页面像素）。
 * 渐隐若按整条笔迹长度的固定比例计算，长笔画会出现"半条线都在变细"，
 * 松手时视觉上像整条线缩水；这里把比例渐隐限制在末端一小段，
 * 既保留笔锋，又让实时层与成品的差异局限于最后几十像素。
 */
const TAPER_MAX_PX = 36;

/** 单端渐隐长度：比例与绝对上限取较小值，且不超过半条笔迹。 */
export function taperLengthFor(total: number, taperRatio: number): number {
  const ratio = Math.max(0, Math.min(1, taperRatio));
  if (ratio <= 0 || total <= 1) return 0;
  return Math.min(total / 2, Math.min(ratio * total, TAPER_MAX_PX));
}

class LowPass {
  private value: number | null = null;

  next(input: number, alpha: number): number {
    this.value = this.value === null ? input : alpha * input + (1 - alpha) * this.value;
    return this.value;
  }

  get current(): number | null {
    return this.value;
  }
}

function smoothingAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(0.05, cutoff));
  return 1 / (1 + tau / Math.max(0.001, dt));
}

/**
 * One Euro 滤波：低速时强平滑，高速时自动放松，避免快划拖尾。
 * 截止频率由平滑滑杆映射，最小 0.5Hz（最强）/ 200Hz（几乎不滤波）。
 */
export function filterSamples(samples: BrushSample[], smoothing: number): BrushSample[] {
  const s = Math.max(0, Math.min(100, smoothing)) / 100;
  const minCutoff = 0.5 + 200 * Math.pow(1 - s, 4);
  const beta = 6 + 18 * s;
  const dCutoff = 1;
  const x = new LowPass();
  const y = new LowPass();
  const dx = new LowPass();
  const dy = new LowPass();
  const output: BrushSample[] = [];
  let prev: BrushSample | null = null;

  for (const sample of samples) {
    if (!prev) {
      x.next(sample.x, 1);
      y.next(sample.y, 1);
      prev = sample;
      output.push({ ...sample });
      continue;
    }
    const dtRaw = (sample.t - prev.t) / 1000;
    const dt = Math.min(0.05, Math.max(0.002, dtRaw || 0.016));
    const derivativeX = (sample.x - prev.x) / dt;
    const derivativeY = (sample.y - prev.y) / dt;
    const edx = dx.next(derivativeX, smoothingAlpha(dCutoff, dt));
    const edy = dy.next(derivativeY, smoothingAlpha(dCutoff, dt));
    const cutoffX = minCutoff + beta * Math.abs(edx);
    const cutoffY = minCutoff + beta * Math.abs(edy);
    const filteredX = x.next(sample.x, smoothingAlpha(cutoffX, dt));
    const filteredY = y.next(sample.y, smoothingAlpha(cutoffY, dt));
    output.push({ x: filteredX, y: filteredY, pressure: sample.pressure, t: sample.t });
    prev = sample;
  }
  return output;
}

/** 按固定距离重采样（页面坐标），消除"事件密度决定节点密度"的问题。 */
export function resampleByDistance(samples: BrushSample[], spacing = SAMPLE_SPACING): BrushSample[] {
  if (samples.length < 2) return samples.map((sample) => ({ ...sample }));
  const output: BrushSample[] = [{ ...samples[0] }];
  let carry = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1];
    const end = samples[index];
    const segment = Math.hypot(end.x - start.x, end.y - start.y);
    if (segment <= 1e-6) {
      const last = output[output.length - 1];
      last.pressure = (last.pressure + end.pressure) / 2;
      continue;
    }
    let travelled = spacing - carry;
    while (travelled <= segment) {
      const ratio = travelled / segment;
      output.push({
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
        pressure: start.pressure + (end.pressure - start.pressure) * ratio,
        t: start.t + (end.t - start.t) * ratio
      });
      travelled += spacing;
    }
    carry = segment - (travelled - spacing);
  }
  const tail = samples[samples.length - 1];
  const last = output[output.length - 1];
  if (Math.hypot(tail.x - last.x, tail.y - last.y) > 1e-3) output.push({ ...tail });
  return output;
}

function perpendicularDistance(point: Vec, start: Vec, end: Vec): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return Math.hypot(point.x - start.x, point.y - start.y);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length;
}

/** Ramer–Douglas–Peucker 抽稀，保留首尾点。 */
function simplifySamples(samples: BrushSample[], epsilon: number): BrushSample[] {
  if (samples.length <= 2) return samples;
  const keep = new Uint8Array(samples.length);
  keep[0] = 1;
  keep[samples.length - 1] = 1;
  const stack: [number, number][] = [[0, samples.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const distance = perpendicularDistance(samples[i], samples[first], samples[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (index !== -1 && maxDistance > epsilon) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return samples.filter((_, index) => keep[index] === 1);
}

function cumulativeLengths(samples: BrushSample[]): number[] {
  const lengths: number[] = [0];
  for (let i = 1; i < samples.length; i += 1) {
    lengths.push(
      lengths[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y)
    );
  }
  return lengths;
}

function insertAtDistance(samples: BrushSample[], distance: number): BrushSample[] {
  const lengths = cumulativeLengths(samples);
  const total = lengths[lengths.length - 1] ?? 0;
  if (distance <= 0 || distance >= total) return samples;
  for (let index = 1; index < samples.length; index += 1) {
    if (lengths[index] < distance) continue;
    const span = lengths[index] - lengths[index - 1];
    const ratio = span > 1e-9 ? (distance - lengths[index - 1]) / span : 0;
    const start = samples[index - 1];
    const end = samples[index];
    const inserted: BrushSample = {
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
      pressure: start.pressure + (end.pressure - start.pressure) * ratio,
      t: start.t + (end.t - start.t) * ratio
    };
    return [...samples.slice(0, index), inserted, ...samples.slice(index)];
  }
  return samples;
}

/**
 * 起收笔渐隐需要沿笔迹长度分布的节点，否则抽稀会把一条直线压成两个端点，
 * 渐隐信息全部丢失（整条线变成等宽）。这里补齐渐隐区与满宽区的分界节点。
 */
function withTaperAnchors(samples: BrushSample[], taper: number): BrushSample[] {
  const total = cumulativeLengths(samples).pop() ?? 0;
  if (total < 2) return samples;
  const ramp = taperLengthFor(total, taper);
  if (ramp < 1) return samples;
  return insertAtDistance(insertAtDistance(samples, ramp), total - ramp);
}

/** 计算每个采样点的绝对线宽（页面像素）。 */
export function strokeWidths(samples: BrushSample[], projection: BrushProjection): number[] {
  const base = Math.max(0.1, projection.width);
  const minRatio = Math.max(0.05, Math.min(1, projection.minRatio ?? 0.35));
  const lengths = cumulativeLengths(samples);
  const total = lengths[lengths.length - 1] ?? 0;
  const taperLength = taperLengthFor(total, projection.taper);
  const curve = projection.pressureCurve ?? 1;
  return samples.map((sample, index) => {
    const scale = projection.pressure
      ? pressureScale(sample.pressure, curve, minRatio)
      : 1;
    let taperScale = 1;
    if (taperLength > 0.5) {
      const distance = lengths[index];
      const fromStart = Math.min(1, distance / taperLength);
      const fromEnd = Math.min(1, (total - distance) / taperLength);
      const ramp = Math.min(fromStart, fromEnd);
      // 平方根让收笔更自然，末端仍有可见墨量
      taperScale = 0.18 + 0.82 * Math.sqrt(ramp);
    }
    return Math.max(0.1, base * scale * taperScale);
  });
}

function isUniform(widths: number[]): boolean {
  if (widths.length === 0) return true;
  let min = Infinity;
  let max = -Infinity;
  for (const width of widths) {
    if (width < min) min = width;
    if (width > max) max = width;
  }
  return max - min <= Math.max(0.05, max * UNIFORM_RATIO);
}

/**
 * 把采样点拟合为可编辑的贝塞尔节点。
 * 使用向心 Catmull-Rom 的切线估计，节点保留在中心线上，宽度写入 node.width。
 */
export function samplesToNodes(
  samples: BrushSample[],
  projection: BrushProjection
): { nodes: PathNode[]; uniform: boolean } {
  const widths = strokeWidths(samples, projection);
  const tension = 0.34;
  const nodes: PathNode[] = samples.map((sample, index) => {
    const prev = samples[Math.max(0, index - 1)];
    const next = samples[Math.min(samples.length - 1, index + 1)];
    const tangent = { x: (next.x - prev.x) * tension, y: (next.y - prev.y) * tension };
    const handleOut = index === samples.length - 1 ? null : { x: tangent.x, y: tangent.y };
    const handleIn = index === 0 ? null : { x: -tangent.x, y: -tangent.y };
    const node = makeNode(sample.x, sample.y, handleIn, handleOut);
    node.type = handleIn || handleOut ? 'smooth' : 'corner';
    return node;
  });
  const uniform = isUniform(widths) && !projection.pressure;
  if (!uniform) {
    nodes.forEach((node, index) => {
      node.width = Math.round(widths[index] * 100) / 100;
    });
  }
  return { nodes, uniform };
}

/** 完整管线：滤波 → 定距重采样 → 抽稀（含节点上限）→ 贝塞尔拟合。 */
export function buildBrushNodes(
  samples: BrushSample[],
  projection: BrushProjection
): { nodes: PathNode[]; uniform: boolean } {
  if (samples.length === 0) return { nodes: [], uniform: true };
  const filtered = filterSamples(samples, projection.smoothing);
  const resampled = resampleByDistance(filtered);
  let simplified = simplifySamples(resampled, SIMPLIFY_EPSILON);
  let epsilon = SIMPLIFY_EPSILON;
  let guard = 0;
  while (simplified.length > MAX_NODES && guard < 4) {
    epsilon *= 1.7;
    simplified = simplifySamples(resampled, epsilon);
    guard += 1;
  }
  if (simplified.length === 1) {
    const only = simplified[0];
    simplified = [only, { ...only, x: only.x + 0.01 }];
  }
  if (projection.taper > 0) {
    simplified = withTaperAnchors(simplified, projection.taper);
  }
  return samplesToNodes(simplified, projection);
}

/** 贝塞尔扁平化：用于宽度包络、矢量橡皮与命中判定。 */
export function flattenNodes(
  nodes: PathNode[],
  closed = false,
  step = 0.75,
  fallbackWidth = 2,
  nibAware = false
): { x: number; y: number; width: number; nibAngle?: number; nibAspect?: number }[] {
  if (nodes.length === 0) return [];
  const points: {
    x: number;
    y: number;
    width: number;
    nibAngle?: number;
    nibAspect?: number;
  }[] = [];
  const push = (x: number, y: number, width: number, source?: PathNode) => {
    const last = points[points.length - 1];
    if (!last || Math.hypot(last.x - x, last.y - y) > 0.01) {
      points.push({
        x,
        y,
        width,
        nibAngle: source?.nibAngle,
        nibAspect: source?.nibAspect
      });
    } else {
      last.width = Math.max(last.width, width);
    }
  };
  push(nodes[0].x, nodes[0].y, nodes[0].width ?? fallbackWidth, nodes[0]);

  const segment = (from: PathNode, to: PathNode) => {
    const c1 = from.handleOut
      ? { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y }
      : { x: from.x, y: from.y };
    const c2 = to.handleIn
      ? { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y }
      : { x: to.x, y: to.y };
    const curveLength =
      Math.hypot(c1.x - from.x, c1.y - from.y) +
      Math.hypot(c2.x - c1.x, c2.y - c1.y) +
      Math.hypot(to.x - c2.x, to.y - c2.y);
    const steps = Math.max(1, Math.min(96, Math.ceil(curveLength / step)));
    const fromWidth = from.width ?? fallbackWidth;
    const toWidth = to.width ?? fallbackWidth;
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      const mt = 1 - t;
      const x =
        mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x;
      const y =
        mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y;
      push(x, y, fromWidth + (toWidth - fromWidth) * t, to);
    }
  };

  for (let index = 1; index < nodes.length; index += 1) segment(nodes[index - 1], nodes[index]);
  if (closed && nodes.length > 1) segment(nodes[nodes.length - 1], nodes[0]);

  if (nibAware) {
    // 扁笔尖的墨迹边界不是等宽圆：按该点处路径法线与长轴的夹角求椭圆支撑宽度，
    // 命中/擦除才与落笔后的填充轮廓同源。
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (
        typeof point.nibAngle !== 'number' ||
        typeof point.nibAspect !== 'number' ||
        point.nibAspect <= 0.3 ||
        point.nibAspect >= 0.995
      ) {
        continue;
      }
      const prev = points[index === 0 ? (closed ? points.length - 1 : 0) : index - 1];
      const next =
        points[index === points.length - 1 ? (closed ? 0 : points.length - 1) : index + 1];
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;
      const normalAngle = Math.atan2(dx / length, -dy / length);
      const half = Math.max(0.05, point.width / 2);
      const major = half / Math.sqrt(point.nibAspect);
      const minor = half * Math.sqrt(point.nibAspect);
      const delta = normalAngle - point.nibAngle;
      const cos = Math.cos(delta);
      const sin = Math.sin(delta);
      point.width = 2 * Math.sqrt((major * cos) ** 2 + (minor * sin) ** 2);
    }
  }

  return points;
}

function normalAt(points: { x: number; y: number }[], index: number): Vec {
  const prev = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { x: 0, y: 1 };
  return { x: -dy / length, y: dx / length };
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * 由"中心线 + 宽度"生成闭合外轮廓的 d 字符串。
 * 返回 null 表示该路径没有宽度信息，应继续按普通 stroke 渲染。
 */
export function brushOutlineData(
  nodes: PathNode[],
  options: { expand?: number } = {}
): string | null {
  if (nodes.length < 2) return null;
  if (!nodes.some((node) => typeof node.width === 'number')) return null;
  // 直接按节点求法线，不再按 0.9px 扁平化：节点本身来自抽稀后的贝塞尔拟合，
  // 密度足够支撑 1px 级轮廓精度，可把路径点数从数千压到数十。
  const points: {
    x: number;
    y: number;
    width: number;
    nibAngle?: number;
    nibAspect?: number;
  }[] = [];
  for (const node of nodes) {
    const width = node.width ?? 2;
    const last = points[points.length - 1];
    if (last && Math.hypot(last.x - node.x, last.y - node.y) < 0.05) {
      last.width = Math.max(last.width, width);
      continue;
    }
    points.push({
      x: node.x,
      y: node.y,
      width,
      nibAngle: node.nibAngle,
      nibAspect: node.nibAspect
    });
  }
  if (points.length < 2) return null;
  const left: Vec[] = [];
  const right: Vec[] = [];
  const expand = Math.max(0, Math.min(3, options.expand ?? 0));
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const normal = normalAt(points, index);
    const half = Math.max(0.05, point.width / 2);
    let offset = half;
    // 椭圆笔尖：沿法线方向的支撑半宽由长短轴投影决定。
    // 长轴方向画得细、垂直长轴方向画得粗，落笔后仍是扁笔触感。
    if (
      typeof point.nibAspect === 'number' &&
      point.nibAspect > 0.3 &&
      point.nibAspect < 0.995 &&
      typeof point.nibAngle === 'number'
    ) {
      const major = half / Math.sqrt(point.nibAspect);
      const minor = half * Math.sqrt(point.nibAspect);
      const delta = Math.atan2(normal.y, normal.x) - point.nibAngle;
      const cos = Math.cos(delta);
      const sin = Math.sin(delta);
      offset = Math.sqrt((major * cos) ** 2 + (minor * sin) ** 2);
    }
    // 材质软边：按半宽比例向外扩张，生成更宽更淡的底层轮廓。
    offset *= 1 + expand;
    left.push({ x: point.x + normal.x * offset, y: point.y + normal.y * offset });
    right.push({ x: point.x - normal.x * offset, y: point.y - normal.y * offset });
  }
  const startRadius = Math.max(0.05, points[0].width / 2);
  const endRadius = Math.max(0.05, points[points.length - 1].width / 2);
  const parts: string[] = [`M ${round(left[0].x)} ${round(left[0].y)}`];
  for (let index = 1; index < left.length; index += 1) {
    parts.push(`L ${round(left[index].x)} ${round(left[index].y)}`);
  }
  const last = points[points.length - 1];
  const lastRight = right[right.length - 1];
  if (Math.hypot(last.x - lastRight.x, last.y - lastRight.y) > 0.1) {
    parts.push(
      `A ${round(endRadius)} ${round(endRadius)} 0 0 1 ${round(lastRight.x)} ${round(lastRight.y)}`
    );
  }
  for (let index = right.length - 2; index >= 0; index -= 1) {
    parts.push(`L ${round(right[index].x)} ${round(right[index].y)}`);
  }
  const first = points[0];
  if (Math.hypot(first.x - right[0].x, first.y - right[0].y) > 0.1) {
    parts.push(`A ${round(startRadius)} ${round(startRadius)} 0 0 1 ${round(left[0].x)} ${round(left[0].y)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

/** 笔迹的最大墨迹宽度（扁笔尖按短轴支撑放大），用于命中判定与包围盒。 */
export function maxNodeWidth(nodes: PathNode[]): number {
  let max = 0;
  for (const node of nodes) {
    const width = node.width ?? 0;
    const aspect = node.nibAspect;
    const inkWidth =
      typeof aspect === 'number' && aspect > 0.3 && aspect < 0.995
        ? width / Math.sqrt(aspect)
        : width;
    max = Math.max(max, inkWidth);
  }
  return max;
}
