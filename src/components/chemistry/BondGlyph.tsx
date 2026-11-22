import { useMemo } from 'react';
import type { BondType } from '../../types/document';
import { buildBondGeometry } from '../../core/chemistry/bonds';

interface BondGlyphProps {
  type: BondType;
  width?: number;
  height?: number;
}

export function BondGlyph({ type, width = 44, height = 26 }: BondGlyphProps) {
  const geometry = useMemo(() => {
    const start = { x: width * 0.16, y: height * 0.76 };
    const end = { x: width * 0.84, y: height * 0.24 };
    return buildBondGeometry(type, start, end, { spacing: 3.2 });
  }, [type, width, height]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
    >
      {geometry.segments.map((segment, index) => (
        <line
          key={`seg-${index}`}
          x1={segment.x1}
          y1={segment.y1}
          x2={segment.x2}
          y2={segment.y2}
          stroke="currentColor"
          strokeWidth={1.45}
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
      {geometry.wavyPath ? (
        <path
          d={geometry.wavyPath}
          stroke="currentColor"
          strokeWidth={1.45}
          strokeLinecap="round"
          fill="none"
        />
      ) : null}
    </svg>
  );
}
