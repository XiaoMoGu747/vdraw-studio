import { useMemo } from 'react';
import type { BondType, Vec } from '../../types/document';
import { benzeneBondTypes, type BenzeneStyle } from '../../core/chemistry/benzene';
import { buildBondGeometry } from '../../core/chemistry/bonds';
import { ringBounds, type RingTemplate } from '../../core/chemistry/rings';

interface RingGlyphProps {
  template: RingTemplate;
  width?: number;
  height?: number;
  benzeneStyle?: BenzeneStyle;
}

export function RingGlyph({
  template,
  width = 72,
  height = 56,
  benzeneStyle
}: RingGlyphProps) {
  const points = useMemo<Vec[]>(() => {
    const bounds = ringBounds(template.atoms);
    const padding = 10;
    const scale = Math.min(
      (width - padding * 2) / Math.max(bounds.width, 0.3),
      (height - padding * 2) / Math.max(bounds.height, 0.3)
    );
    const contentWidth = bounds.width * scale;
    const contentHeight = bounds.height * scale;
    const offsetX = (width - contentWidth) / 2 - bounds.x * scale;
    const offsetY = (height - contentHeight) / 2 - bounds.y * scale;
    return template.atoms.map((atom) => ({
      x: atom.x * scale + offsetX,
      y: atom.y * scale + offsetY
    }));
  }, [template, width, height]);

  const bonds = useMemo(() => {
    const center = points.reduce(
      (acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }),
      { x: 0, y: 0 }
    );
    const overrideTypes: BondType[] | null =
      template.id === 'benzene' && benzeneStyle ? benzeneBondTypes(benzeneStyle) : null;
    return template.bonds.map((bond, index) => {
      const start = points[bond.a];
      const end = points[bond.b];
      const normal = { x: -(end.y - start.y), y: end.x - start.x };
      const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const side = normal.x * (center.x - midpoint.x) + normal.y * (center.y - midpoint.y) >= 0 ? 1 : -1;
      const type = overrideTypes?.[index] ?? bond.type;
      return buildBondGeometry(type, start, end, {
        spacing: 2.8,
        aromaticSide: side,
        innerSide: type === 'double' ? side : undefined
      });
    });
  }, [template, points, benzeneStyle]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
    >
      {bonds.map((geometry, bondIndex) => (
        <g key={`bond-${bondIndex}`}>
          {geometry.segments.map((segment, index) => (
            <line
              key={`seg-${index}`}
              x1={segment.x1}
              y1={segment.y1}
              x2={segment.x2}
              y2={segment.y2}
              stroke="currentColor"
              strokeWidth={1.2}
              strokeLinecap="round"
            />
          ))}
          {geometry.polygons.map((polygon, index) => (
            <polygon
              key={`poly-${index}`}
              points={polygon.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')}
              fill="currentColor"
            />
          ))}
        </g>
      ))}
      {template.id === 'benzene' && benzeneStyle === 'pauling' ? (
        (() => {
          const center = points.reduce(
            (acc, point) => ({
              x: acc.x + point.x / points.length,
              y: acc.y + point.y / points.length
            }),
            { x: 0, y: 0 }
          );
          const radius =
            points.reduce(
              (sum, point) => sum + Math.hypot(point.x - center.x, point.y - center.y),
              0
            ) / points.length;
          return (
            <circle
              cx={center.x}
              cy={center.y}
              r={radius * 0.55}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.2}
            />
          );
        })()
      ) : null}
      {template.atoms.map((atom, index) =>
        atom.label ? (
          <text
            key={`label-${index}`}
            x={points[index].x}
            y={points[index].y + 0.5}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={9.5}
            fontWeight={600}
            fontFamily="inherit"
            fill="currentColor"
            stroke="var(--ring-label-bg, #ffffff)"
            strokeWidth={3}
            paintOrder="stroke"
          >
            {atom.label}
          </text>
        ) : null
      )}
    </svg>
  );
}
