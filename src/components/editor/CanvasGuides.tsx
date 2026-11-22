import { memo } from 'react';
import { equalGridOffsets } from '../../core/guideSnap';
import type { GuideMode, GuideSettings, SymmetryAxis, SymmetryMode } from '../../types/document';

interface CanvasGuidesProps {
  pageWidth: number;
  pageHeight: number;
  zoom: number;
  symmetry: SymmetryMode;
  axis: SymmetryAxis;
  guideMode: GuideMode;
  settings: GuideSettings;
  /** 每个消失点发射的参考线数量（与吸附量化口径一致）。 */
  density?: number;
  /** 网格辅助线间距（页面像素），来自文档网格设置。 */
  gridStep?: number;
  /** 等大参考网格的间距（页面像素）。 */
  reference?: number;
}

const stroke = '#3f6df0';
const soft = '#8aa2e8';
const gridColor = '#b6c3d6';

interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Liang-Barsky：把线段裁剪到画布矩形内，辅助线不再溢出页面。 */
function clipSegmentToPage(
  a: { x: number; y: number },
  b: { x: number; y: number },
  w: number,
  h: number
): LineSegment | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x, w - a.x, a.y, h - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index] < 0) return null;
      continue;
    }
    const r = q[index] / p[index];
    if (p[index] < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  const x1 = a.x + dx * t0;
  const y1 = a.y + dy * t0;
  const x2 = a.x + dx * t1;
  const y2 = a.y + dy * t1;
  if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return null;
  return { x1, y1, x2, y2 };
}

/** 从消失点向四周发射，逐条裁剪到画布内。 */
function radialLines(
  origin: { x: number; y: number },
  w: number,
  h: number,
  count = 24
): LineSegment[] {
  const reach = Math.hypot(w, h) * 2.5;
  const lines: LineSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const target = {
      x: origin.x + Math.cos(angle) * reach,
      y: origin.y + Math.sin(angle) * reach
    };
    const clipped = clipSegmentToPage(origin, target, w, h);
    if (clipped) lines.push(clipped);
  }
  return lines;
}

/** 画布叠层：对称轴 + 透视/网格/等大辅助线 + 可拖动的透视点。 */
export const CanvasGuides = memo(function CanvasGuides({
  pageWidth,
  pageHeight,
  zoom,
  symmetry,
  axis,
  guideMode,
  settings,
  density = 24,
  gridStep = 0,
  reference = 120
}: CanvasGuidesProps) {
  const w = pageWidth;
  const h = pageHeight;
  const unit = 1 / zoom;
  const dash = `${7 * unit} ${6 * unit}`;
  const ax = axis.x * w;
  const ay = axis.y * h;
  const horizon = settings.horizon * h;

  const symmetryLines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  // 对称轴严格限制在画布范围内，不溢出页面边界
  if (symmetry === 'vertical' || symmetry === 'both') {
    symmetryLines.push({ x1: ax, y1: 0, x2: ax, y2: h });
  }
  if (symmetry === 'horizontal' || symmetry === 'both') {
    symmetryLines.push({ x1: 0, y1: ay, x2: w, y2: ay });
  }

  const guideLines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const handles: { id: string; x: number; y: number }[] = [];
  const horizonLine = clipSegmentToPage({ x: 0, y: horizon }, { x: w, y: horizon }, w, h);

  if (guideMode === 'one-point') {
    const vp = { x: settings.vpX * w, y: horizon };
    handles.push({ id: 'one', x: vp.x, y: vp.y });
    handles.push({ id: 'horizon', x: w * 0.5, y: horizon });
    // 以消失点为中心向四周发射，全部裁剪在画布范围内
    guideLines.push(...radialLines(vp, w, h, density));
  } else if (guideMode === 'two-point' || guideMode === 'three-point') {
    const left = { x: settings.vpLeft * w, y: horizon };
    const right = { x: settings.vpRight * w, y: horizon };
    handles.push({ id: 'left', x: left.x, y: left.y }, { id: 'right', x: right.x, y: right.y });
    handles.push({ id: 'horizon', x: w * 0.5, y: horizon });
    guideLines.push(
      ...radialLines(left, w, h, density),
      ...radialLines(right, w, h, density)
    );
    if (guideMode === 'three-point') {
      const bottom = { x: settings.vpX * w, y: settings.vpBottom * h };
      handles.push({ id: 'bottom', x: bottom.x, y: bottom.y });
      guideLines.push(...radialLines(bottom, w, h, density));
    }
  } else if (guideMode === 'grid') {
    // 跟随文档网格间距；至少 4 格、最多 120 条，避免极小间距把画布刷满。
    const step = gridStep > 0 ? Math.max(4, gridStep) : w / 12;
    const maxLines = 120;
    const columns = Math.min(maxLines, Math.floor(w / step));
    const rows = Math.min(maxLines, Math.floor(h / step));
    for (let index = 1; index <= columns; index += 1) {
      guideLines.push({ x1: step * index, y1: 0, x2: step * index, y2: h });
    }
    for (let index = 1; index <= rows; index += 1) {
      guideLines.push({ x1: 0, y1: step * index, x2: w, y2: step * index });
    }
  } else if (guideMode === 'equal') {
    // "等大"改为可配置的实际参考间距：从中线向两侧按固定 px 排线，横竖间距一致。
    for (const x of equalGridOffsets(w, reference)) {
      guideLines.push({ x1: x, y1: 0, x2: x, y2: h });
    }
    for (const y of equalGridOffsets(h, reference)) {
      guideLines.push({ x1: 0, y1: y, x2: w, y2: y });
    }
    guideLines.push({ x1: w / 2, y1: 0, x2: w / 2, y2: h });
    guideLines.push({ x1: 0, y1: h / 2, x2: w, y2: h / 2 });
  }

  return (
    <g pointerEvents="none" data-testid="canvas-guides">
      {symmetryLines.map((line, index) => (
        <g key={`sym-${index}`}>
          <line
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="#e0447a"
            strokeWidth={5 * unit}
            opacity={0.12}
          />
          <line
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="#e0447a"
            strokeWidth={1.6 * unit}
            strokeDasharray={`${9 * unit} ${6 * unit}`}
          />
          <circle cx={line.x1 === line.x2 ? line.x1 : 0} cy={line.x1 === line.x2 ? 0 : line.y1} r={3 * unit} fill="#e0447a" />
        </g>
      ))}

      {guideMode !== 'none' ? (
        <g data-testid="guide-lines" data-guide={guideMode}>
          {horizonLine &&
          (guideMode === 'one-point' ||
            guideMode === 'two-point' ||
            guideMode === 'three-point') ? (
            <line
              x1={horizonLine.x1}
              y1={horizonLine.y1}
              x2={horizonLine.x2}
              y2={horizonLine.y2}
              stroke={soft}
              strokeWidth={1.2 * unit}
              strokeDasharray={`${6 * unit} ${5 * unit}`}
              opacity={0.8}
            />
          ) : null}
          {guideLines.map((line, index) => (
            <line
              key={`guide-${index}`}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke={guideMode === 'grid' ? gridColor : guideMode === 'equal' ? '#d98b2b' : stroke}
              strokeWidth={1 * unit}
              strokeDasharray={guideMode === 'grid' ? `${3 * unit} ${5 * unit}` : dash}
              opacity={guideMode === 'grid' ? 0.55 : 0.4}
            />
          ))}
          {handles.map((handle) => (
            <g key={handle.id} data-vp={handle.id}>
              <circle
                cx={handle.x}
                cy={handle.y}
                r={9 * unit}
                fill="rgba(63, 109, 240, 0.12)"
                stroke={stroke}
                strokeWidth={1.2 * unit}
              />
              <circle cx={handle.x} cy={handle.y} r={3 * unit} fill="#fff" stroke={stroke} strokeWidth={1.4 * unit} />
              <line x1={handle.x - 12 * unit} y1={handle.y} x2={handle.x + 12 * unit} y2={handle.y} stroke={stroke} strokeWidth={1 * unit} />
              <line x1={handle.x} y1={handle.y - 12 * unit} x2={handle.x} y2={handle.y + 12 * unit} stroke={stroke} strokeWidth={1 * unit} />
            </g>
          ))}
          {guideMode === 'equal' ? (
            <text
              x={w / 2}
              y={h / 2 - 8 * unit}
              textAnchor="middle"
              fontSize={11 * unit}
              fill="#b87b25"
              fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
            >
              等大参考
            </text>
          ) : null}
        </g>
      ) : null}
    </g>
  );
});
