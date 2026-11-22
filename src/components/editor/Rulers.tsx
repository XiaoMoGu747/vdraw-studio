import { useMemo } from 'react';
import type { Viewport } from '../../types/document';

interface RulersProps {
  width: number;
  height: number;
  viewport: Viewport;
  pageWidth: number;
  pageHeight: number;
}

const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

function pickStep(zoom: number): number {
  return STEPS.find((step) => step * zoom >= 64) ?? 5000;
}

export function Rulers({ width, height, viewport, pageWidth, pageHeight }: RulersProps) {
  const step = pickStep(viewport.zoom);

  const ticks = useMemo(() => {
    const startPage = -viewport.pan.x / viewport.zoom;
    const endPage = (width - viewport.pan.x) / viewport.zoom;
    const first = Math.floor(startPage / step) * step;
    const result: number[] = [];
    for (let value = first; value <= endPage; value += step) {
      result.push(value);
    }
    return result;
  }, [viewport, width, step]);

  const verticalTicks = useMemo(() => {
    const startPage = -viewport.pan.y / viewport.zoom;
    const endPage = (height - viewport.pan.y) / viewport.zoom;
    const first = Math.floor(startPage / step) * step;
    const result: number[] = [];
    for (let value = first; value <= endPage; value += step) {
      result.push(value);
    }
    return result;
  }, [viewport, height, step]);

  const labelEvery = Math.max(1, Math.ceil(38 / (step * viewport.zoom)));
  const pageStartX = viewport.pan.x;
  const pageEndX = viewport.pan.x + pageWidth * viewport.zoom;
  const pageStartY = viewport.pan.y;
  const pageEndY = viewport.pan.y + pageHeight * viewport.zoom;

  return (
    <>
      <div className="ruler-corner">px</div>

      <div className="ruler ruler--top">
        <svg width="100%" height="22" preserveAspectRatio="none">
          <rect
            x={pageStartX}
            y={0}
            width={Math.max(0, pageEndX - pageStartX)}
            height={22}
            fill="rgba(63, 109, 240, 0.035)"
          />
          {ticks.map((value, index) => {
            const x = value * viewport.zoom + viewport.pan.x;
            const major = value % (step * 5) === 0;
            return (
              <g key={`t-${value}`}>
                <line
                  x1={x}
                  y1={major ? 6 : 14}
                  x2={x}
                  y2={22}
                  stroke={major ? '#9aa3b3' : '#c2c8d4'}
                  strokeWidth={1}
                />
                {index % labelEvery === 0 ? (
                  <text x={x + 3} y={major ? 11 : 13} className="ruler__label">
                    {value}
                  </text>
                ) : null}
              </g>
            );
          })}
          <line x1={pageStartX} y1={0} x2={pageStartX} y2={22} stroke="#3f6df0" strokeWidth={1} opacity={0.45} />
          <line x1={pageEndX} y1={0} x2={pageEndX} y2={22} stroke="#3f6df0" strokeWidth={1} opacity={0.45} />
        </svg>
      </div>

      <div className="ruler ruler--left">
        <svg width="22" height="100%" preserveAspectRatio="none">
          <rect
            x={0}
            y={pageStartY}
            width={22}
            height={Math.max(0, pageEndY - pageStartY)}
            fill="rgba(63, 109, 240, 0.035)"
          />
          {verticalTicks.map((value, index) => {
            const y = value * viewport.zoom + viewport.pan.y;
            const major = value % (step * 5) === 0;
            return (
              <g key={`v-${value}`}>
                <line
                  x1={major ? 6 : 14}
                  y1={y}
                  x2={22}
                  y2={y}
                  stroke={major ? '#9aa3b3' : '#c2c8d4'}
                  strokeWidth={1}
                />
                {index % labelEvery === 0 ? (
                  <text x={major ? 3 : 4} y={y - 3} className="ruler__label">
                    {value}
                  </text>
                ) : null}
              </g>
            );
          })}
          <line x1={0} y1={pageStartY} x2={22} y2={pageStartY} stroke="#3f6df0" strokeWidth={1} opacity={0.45} />
          <line x1={0} y1={pageEndY} x2={22} y2={pageEndY} stroke="#3f6df0" strokeWidth={1} opacity={0.45} />
        </svg>
      </div>
    </>
  );
}
