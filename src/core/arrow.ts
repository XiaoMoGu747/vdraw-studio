import type { ArrowKind, Vec } from '../types/document';
import { normalize, perpendicular, sub } from './geometry';

export interface ArrowGeometry {
  lines: { x1: number; y1: number; x2: number; y2: number }[];
  polygons: Vec[][];
  curve: string | null;
}

function head(tip: Vec, direction: Vec, size = 11, width = 8): Vec[] {
  const back = { x: tip.x - direction.x * size, y: tip.y - direction.y * size };
  const normal = perpendicular(direction);
  return [
    tip,
    { x: back.x + normal.x * width, y: back.y + normal.y * width },
    { x: back.x - normal.x * width, y: back.y - normal.y * width }
  ];
}

export function buildArrowGeometry(
  kind: ArrowKind,
  start: Vec,
  end: Vec
): ArrowGeometry {
  const direction = normalize(sub(end, start));
  const normal = perpendicular(direction);
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < 2) return { lines: [], polygons: [], curve: null };

  switch (kind) {
    case 'equilibrium': {
      const offset = 4;
      const a1 = { x: start.x + normal.x * offset, y: start.y + normal.y * offset };
      const b1 = { x: end.x + normal.x * offset, y: end.y + normal.y * offset };
      const a2 = { x: end.x - normal.x * offset, y: end.y - normal.y * offset };
      const b2 = { x: start.x - normal.x * offset, y: start.y - normal.y * offset };
      return {
        lines: [
          { x1: a1.x, y1: a1.y, x2: b1.x, y2: b1.y },
          { x1: a2.x, y1: a2.y, x2: b2.x, y2: b2.y }
        ],
        polygons: [head(b1, direction, 9, 6), head(b2, { x: -direction.x, y: -direction.y }, 9, 6)],
        curve: null
      };
    }

    case 'retro': {
      const slashOffset = Math.min(40, distance * 0.28);
      const base = { x: end.x - direction.x * slashOffset, y: end.y - direction.y * slashOffset };
      return {
        lines: [
          { x1: start.x, y1: start.y, x2: end.x, y2: end.y },
          {
            x1: base.x - normal.x * 8 + direction.x * 6,
            y1: base.y - normal.y * 8 + direction.y * 6,
            x2: base.x + normal.x * 8 - direction.x * 6,
            y2: base.y + normal.y * 8 - direction.y * 6
          },
          {
            x1: base.x - normal.x * 8 + direction.x * 13,
            y1: base.y - normal.y * 8 + direction.y * 13,
            x2: base.x + normal.x * 8 - direction.x * 13,
            y2: base.y + normal.y * 8 - direction.y * 13
          }
        ],
        polygons: [head(end, direction)],
        curve: null
      };
    }

    case 'mechanism': {
      const control = {
        x: (start.x + end.x) / 2 + normal.x * Math.min(90, distance * 0.32),
        y: (start.y + end.y) / 2 + normal.y * Math.min(90, distance * 0.32)
      };
      const tangent = normalize(sub(end, control));
      return {
        lines: [],
        polygons: [head(end, tangent, 11, 7)],
        curve: `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} Q ${control.x.toFixed(2)} ${control.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
      };
    }

    case 'reaction':
    default:
      return {
        lines: [{ x1: start.x, y1: start.y, x2: end.x, y2: end.y }],
        polygons: [head(end, direction)],
        curve: null
      };
  }
}
