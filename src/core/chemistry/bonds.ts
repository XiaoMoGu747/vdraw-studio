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
}

const EMPTY: BondGeometry = { segments: [], polygons: [], wavyPath: null };

/**
 * 依据键型生成可复用的几何数据（纯函数）。
 * 画布中的化学键与左侧面板预览共用同一套几何。
 */
export function buildBondGeometry(
  type: BondType,
  start: Vec,
  end: Vec,
  options: BondGeometryOptions = {}
): BondGeometry {
  const total = distance(start, end);
  if (total < 0.5) return EMPTY;

  const spacing = options.spacing ?? 5;
  const side = options.aromaticSide ?? 1;
  const dir = normalize(sub(end, start));
  const normal = perpendicular(dir);

  const at = (t: number, offset = 0): Vec => ({
    x: start.x + (end.x - start.x) * t + normal.x * offset,
    y: start.y + (end.y - start.y) * t + normal.y * offset
  });

  const segment = (t1: number, t2: number, offset: number): BondSegment => {
    const a = at(t1, offset);
    const b = at(t2, offset);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  };

  switch (type) {
    case 'single':
      return { ...EMPTY, segments: [segment(0, 1, 0)] };

    case 'double': {
      if (options.innerSide) {
        // 凯库勒式：外层六元环保持完整边线，第二条线内缩并靠近环心
        const inset = Math.min(total * 0.16, spacing * 1.7);
        const t1 = inset / total;
        const t2 = 1 - inset / total;
        return {
          ...EMPTY,
          segments: [segment(0, 1, 0), segment(t1, t2, spacing * options.innerSide)]
        };
      }
      // 双键：一条完整主线 + 一条内缩平行线，避免两条等长细线显得松散
      const inset = Math.min(total * 0.18, spacing * 1.9);
      return {
        ...EMPTY,
        segments: [segment(0, 1, 0), segment(inset / total, 1 - inset / total, spacing)]
      };
    }

    case 'triple': {
      // 三键：中间完整主线，上下两条略内缩，整体更紧凑
      const inset = Math.min(total * 0.1, spacing * 1.1);
      return {
        ...EMPTY,
        segments: [
          segment(0, 1, 0),
          segment(inset / total, 1 - inset / total, spacing),
          segment(inset / total, 1 - inset / total, -spacing)
        ]
      };
    }

    case 'aromatic': {
      const inset = Math.min(total * 0.16, spacing * 1.6);
      const t1 = inset / total;
      const t2 = 1 - inset / total;
      return {
        ...EMPTY,
        segments: [segment(0, 1, 0), segment(t1, t2, spacing * side)]
      };
    }

    case 'wedge': {
      const halfStart = 0.45;
      const halfEnd = Math.min(2.8, Math.max(1.6, total * 0.055));
      return {
        ...EMPTY,
        polygons: [[at(0, halfStart), at(1, halfEnd), at(1, -halfEnd), at(0, -halfStart)]]
      };
    }

    case 'hashed': {
      const bars = 7;
      const segments: BondSegment[] = [];
      for (let i = 0; i < bars; i += 1) {
        const t = 0.12 + (i / (bars - 1)) * 0.84;
        const half = 0.5 + (i / (bars - 1)) * 2.2;
        const a = at(t, -half);
        const b = at(t, half);
        segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      return { ...EMPTY, segments };
    }

    case 'wavy': {
      const amplitude = Math.min(2.6, Math.max(1.2, total * 0.06));
      const waves = 3.5;
      const samples = 56;
      const points: string[] = [];
      for (let i = 0; i <= samples; i += 1) {
        const t = i / samples;
        const offset = Math.sin(t * Math.PI * 2 * waves) * amplitude;
        const point = at(t, offset);
        points.push(`${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
      }
      return { ...EMPTY, wavyPath: points.join(' ') };
    }

    case 'dative': {
      const arrowLength = Math.min(8, total * 0.32);
      const tip = at(1, 0);
      const base = at(1 - arrowLength / total, 0);
      const halfWidth = Math.min(3.1, arrowLength * 0.45);
      return {
        ...EMPTY,
        segments: [segment(0, 1 - arrowLength / total, 0)],
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
