import type { BondType, Vec } from '../../types/document';
import { distance, normalize, perpendicular, sub } from '../geometry';

export interface BondSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BondGeometry {
  segments: BondSegment[];
  polygons: Vec[][];
  wavyPath: string | null;
}

export interface BondGeometryOptions {
  /** 双键 / 三键 / 芳香键的线间距 */
  spacing?: number;
  /** 芳香键内侧线所在方向：1 或 -1 */
  aromaticSide?: 1 | -1;
  /** 环内双键（凯库勒式）第二条线的方向：指向环心，且两端内缩 */
  innerSide?: 1 | -1;
  /** 两端元素标签的避让半径；用于逐条平行线裁切，防止压住元素符号 */
  startClearance?: number;
  endClearance?: number;
}

const EMPTY: BondGeometry = { segments: [], polygons: [], wavyPath: null };

/**
 * 依据键型生成可复用的几何数据（纯函数）。
 *
 * 双键/三键的平行线按“到两端标签圆的距离”逐条裁切：
 * - 单独双键：两条线对称分布在键轴两侧、长度相等；
 * - 单独三键：三条线等距分布、长度相等；
 * - 环内双键：保留“完整外线 + 朝环心内缩线”的凯库勒画法；
 * - 平行线偏移超过标签半径时，至少留 3px 侧向余量，避免线段贴着文字穿过。
 */
export function buildBondGeometry(
  type: BondType,
  start: Vec,
  end: Vec,
  options: BondGeometryOptions = {}
): BondGeometry {
  const total = distance(start, end);
  if (total < 0.5) return EMPTY;

  const spacing = Math.max(0.2, options.spacing ?? 5);
  const side = options.aromaticSide ?? 1;
  const startClearance = Math.max(0, options.startClearance ?? 0);
  const endClearance = Math.max(0, options.endClearance ?? 0);
  const dir = normalize(sub(end, start));
  const normal = perpendicular(dir);

  const pointAt = (travel: number, offset = 0): Vec => ({
    x: start.x + dir.x * travel + normal.x * offset,
    y: start.y + dir.y * travel + normal.y * offset
  });

  const segment = (from: number, to: number, offset = 0): BondSegment => {
    const a = pointAt(from, offset);
    const b = pointAt(to, offset);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  };

  /**
   * 平行线在某一端需要让出的轴向距离。
   * 标签按圆近似：|offset| < R 时交于圆周；否则让到圆外 3px。
   */
  const clearanceAt = (clearance: number, offset: number): number => {
    if (clearance <= 0.001) return 0;
    const lateral = Math.abs(offset);
    if (lateral < clearance - 0.001) {
      return Math.sqrt(Math.max(0, clearance * clearance - lateral * lateral));
    }
    const expanded = lateral + 3;
    return Math.sqrt(Math.max(0, expanded * expanded - lateral * lateral));
  };

  /** 单条平行线；inset 为两端额外内缩量（用于环内双键）。 */
  const line = (offset: number, inset = 0): BondSegment | null => {
    const from = clearanceAt(startClearance, offset) + inset;
    const to = total - clearanceAt(endClearance, offset) - inset;
    return to - from > 0.2 ? segment(from, to, offset) : null;
  };

  const axisFrom = clearanceAt(startClearance, 0);
  const axisTo = total - clearanceAt(endClearance, 0);
  const axisLength = Math.max(0, axisTo - axisFrom);

  const collect = (segments: Array<BondSegment | null>): BondSegment[] =>
    segments.filter((item): item is BondSegment => item !== null);

  switch (type) {
    case 'single':
      return { ...EMPTY, segments: collect([line(0)]) };

    case 'double': {
      if (options.innerSide) {
        // 环内双键：外线保持完整边线，内线朝环心偏移并两端内缩。
        const offset = spacing * options.innerSide;
        const from = clearanceAt(startClearance, offset);
        const to = total - clearanceAt(endClearance, offset);
        const visible = Math.max(0, to - from);
        const inset = Math.min(visible * 0.16, spacing * 1.7);
        const inner = visible > 0.2 ? segment(from + inset, to - inset, offset) : null;
        return { ...EMPTY, segments: collect([line(0), inner]) };
      }
      // 单独双键：两条等长平行线对称分布在键轴两侧。
      const half = spacing / 2;
      return { ...EMPTY, segments: collect([line(-half), line(half)]) };
    }

    case 'triple':
      // 单独三键：三条等长平行线，中间一条落在键轴上。
      return { ...EMPTY, segments: collect([line(-spacing), line(0), line(spacing)]) };

    case 'aromatic': {
      // 芳香键沿用环内线画法：外线完整，内线朝芳香侧偏移并内缩。
      const offset = spacing * side;
      const from = clearanceAt(startClearance, offset);
      const to = total - clearanceAt(endClearance, offset);
      const visible = Math.max(0, to - from);
      const inset = Math.min(visible * 0.16, spacing * 1.6);
      const inner = visible > 0.2 ? segment(from + inset, to - inset, offset) : null;
      return { ...EMPTY, segments: collect([line(0), inner]) };
    }

    case 'wedge': {
      const halfStart = 0.45;
      const halfEnd = Math.min(2.8, Math.max(1.6, axisLength * 0.055));
      return {
        ...EMPTY,
        polygons: [
          [
            pointAt(axisFrom, halfStart),
            pointAt(axisTo, halfEnd),
            pointAt(axisTo, -halfEnd),
            pointAt(axisFrom, -halfStart)
          ]
        ]
      };
    }

    case 'hashed': {
      const bars = 7;
      const segments: BondSegment[] = [];
      for (let i = 0; i < bars; i += 1) {
        const t = 0.12 + (i / (bars - 1)) * 0.84;
        const travel = axisFrom + axisLength * t;
        const half = 0.5 + (i / (bars - 1)) * 2.2;
        const a = pointAt(travel, -half);
        const b = pointAt(travel, half);
        segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      return { ...EMPTY, segments };
    }

    case 'wavy': {
      const amplitude = Math.min(2.6, Math.max(1.2, axisLength * 0.06));
      const waves = 3.5;
      const samples = 56;
      const points: string[] = [];
      for (let i = 0; i <= samples; i += 1) {
        const t = i / samples;
        const offset = Math.sin(t * Math.PI * 2 * waves) * amplitude;
        const point = pointAt(axisFrom + axisLength * t, offset);
        points.push(`${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
      }
      return { ...EMPTY, wavyPath: points.join(' ') };
    }

    case 'dative': {
      const arrowLength = Math.min(8, Math.max(0.5, axisLength * 0.32));
      const tip = pointAt(axisTo, 0);
      const base = pointAt(axisTo - arrowLength, 0);
      const halfWidth = Math.min(3.1, arrowLength * 0.45);
      return {
        ...EMPTY,
        segments: [segment(axisFrom, axisTo - arrowLength, 0)],
        polygons: [
          [
            tip,
            { x: base.x + normal.x * halfWidth, y: base.y + normal.y * halfWidth },
            { x: base.x - normal.x * halfWidth, y: base.y - normal.y * halfWidth }
          ]
        ]
      };
    }

    default:
      return EMPTY;
  }
}
