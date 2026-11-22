import type { ChemIssue } from '../../core/chemistry/valence';
import { SHAPE_TOOL_IDS } from '../../core/tools';
import {
  getObject,
  rotatePoint,
  selectionFrame,
  type SelectionFrame
} from '../../core/scene';
import type { PathObject, Rect, ToolId, VDrawDocument, Vec } from '../../types/document';
import { useAppStore } from '../../store/useAppStore';

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export function handlePositions(bounds: Rect, zoom: number): Record<HandleId, Vec> {
  const { x, y, width, height } = bounds;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const right = x + width;
  const bottom = y + height;
  return {
    nw: { x, y },
    n: { x: centerX, y },
    ne: { x: right, y },
    e: { x: right, y: centerY },
    se: { x: right, y: bottom },
    s: { x: centerX, y: bottom },
    sw: { x, y: bottom },
    w: { x, y: centerY },
    rotate: { x: centerX, y: y - 28 / zoom }
  };
}

/** 命中控制点：先按旋转角换算回选中框的局部坐标再比较距离。 */
export function handleAtPoint(
  point: Vec,
  frame: SelectionFrame,
  zoom: number
): HandleId | null {
  const local = frame.rotation
    ? rotatePoint(point, frame.center, -frame.rotation)
    : point;
  const handles = handlePositions(frame.bounds, zoom);
  const tolerance = 9 / zoom;
  for (const id of Object.keys(handles) as HandleId[]) {
    const handle = handles[id];
    if (Math.hypot(local.x - handle.x, local.y - handle.y) <= tolerance) return id;
  }
  return null;
}

interface MarqueeState {
  start: Vec;
  end: Vec;
}

interface SelectionOverlayProps {
  doc: VDrawDocument;
  selection: string[];
  zoom: number;
  activeTool: ToolId;
  marquee: MarqueeState | null;
  guides: {
    x: number[];
    y: number[];
    lines?: { x1: number; y1: number; x2: number; y2: number }[];
  };
  issues: ChemIssue[];
  /** 节点工具内部选中的节点 id（与对象选择分离）。 */
  selectedNodeIds?: string[];
}

export function SelectionOverlay({
  doc,
  selection,
  zoom,
  activeTool,
  marquee,
  guides,
  issues,
  selectedNodeIds
}: SelectionOverlayProps) {
  const dragPreview = useAppStore((state) => state.dragPreview);
  // resize 预览文档会让选框直接按缩放后的几何计算；move/rotate 则套同一 transform。
  const overlayDoc = dragPreview?.doc ?? doc;
  const previewTransform =
    dragPreview?.transform && selection.some((id) => dragPreview.ids.includes(id))
      ? dragPreview.transform
      : undefined;
  const frame = selection.length > 0 ? selectionFrame(overlayDoc, selection) : null;
  const bounds = frame?.bounds ?? null;
  const single = selection.length === 1 ? getObject(overlayDoc, selection[0]) : null;
  const editingPath = activeTool === 'node' && single?.type === 'path' ? (single as PathObject) : null;
  // 绘制类工具下不画选择框：画笔连续作画时包围框会一直压在墨迹上。
  const showFrame = activeTool !== 'brush';
  const unit = 1 / zoom;
  const multiFrames =
    selection.length > 1
      ? selection
          .map((id) => selectionFrame(overlayDoc, [id]))
          .filter((item): item is SelectionFrame => Boolean(item))
      : [];

  return (
    <g className="selection-overlay" pointerEvents="none">
      {guides.x.map((x) => (
        <g key={`guide-x-${x}`}>
          <line
            x1={x}
            y1={0}
            x2={x}
            y2={doc.page.height}
            stroke="#ff5a5f"
            strokeWidth={5 * unit}
            opacity={0.12}
            data-snap-guide="x"
          />
          <line
            x1={x}
            y1={0}
            x2={x}
            y2={doc.page.height}
            stroke="#ff5a5f"
            strokeWidth={1.2 * unit}
            strokeDasharray={`${7 * unit} ${5 * unit}`}
            data-snap-guide="x"
          />
          <circle cx={x} cy={0} r={3 * unit} fill="#ff5a5f" />
          <text
            x={x + 7 * unit}
            y={13 * unit}
            fontSize={9.5 * unit}
            fill="#d63b40"
            fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
          >
            x {Math.round(x)}
          </text>
        </g>
      ))}
      {guides.y.map((y) => (
        <g key={`guide-y-${y}`}>
          <line
            x1={0}
            y1={y}
            x2={doc.page.width}
            y2={y}
            stroke="#ff5a5f"
            strokeWidth={5 * unit}
            opacity={0.12}
            data-snap-guide="y"
          />
          <line
            x1={0}
            y1={y}
            x2={doc.page.width}
            y2={y}
            stroke="#ff5a5f"
            strokeWidth={1.2 * unit}
            strokeDasharray={`${7 * unit} ${5 * unit}`}
            data-snap-guide="y"
          />
          <circle cx={0} cy={y} r={3 * unit} fill="#ff5a5f" />
          <text
            x={7 * unit}
            y={y - 6 * unit}
            fontSize={9.5 * unit}
            fill="#d63b40"
            fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
          >
            y {Math.round(y)}
          </text>
        </g>
      ))}

      {guides.lines?.map((line, index) => (
        <line
          key={`guide-line-${index}`}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke="#ff5a5f"
          strokeWidth={1.2 * unit}
          strokeDasharray={`${7 * unit} ${5 * unit}`}
          data-snap-guide="angle"
        />
      ))}

      {showFrame && multiFrames.length > 0 ? (
        <g transform={previewTransform} data-selection-preview="multi">
          {multiFrames.map((item, index) => (
            <rect
              key={`multi-frame-${index}`}
              x={item.bounds.x}
              y={item.bounds.y}
              width={item.bounds.width}
              height={item.bounds.height}
              transform={
                item.rotation
                  ? `rotate(${item.rotation} ${item.center.x} ${item.center.y})`
                  : undefined
              }
              fill="rgba(63, 109, 240, 0.045)"
              stroke="#3f6df0"
              strokeWidth={1.15 * unit}
              strokeDasharray={`${4 * unit} ${3 * unit}`}
              data-multi-frame="true"
            />
          ))}
        </g>
      ) : null}

      {showFrame && bounds && frame && selection.length > 0 ? (
        <g transform={previewTransform} data-selection-preview="frame">
          <g
            transform={
              frame.rotation
                ? `rotate(${frame.rotation} ${frame.center.x} ${frame.center.y})`
                : undefined
            }
          >
          <rect
            x={bounds.x}
            y={bounds.y}
            width={bounds.width}
            height={bounds.height}
            fill="none"
            stroke="#3f6df0"
            strokeWidth={unit}
            opacity={0.9}
          />
          {activeTool === 'select' || (SHAPE_TOOL_IDS.includes(activeTool) && activeTool !== 'curve')
            ? (Object.keys(handlePositions(bounds, zoom)) as HandleId[]).map((id) => {
                const point = handlePositions(bounds, zoom)[id];
                if (id === 'rotate') {
                  return (
                    <g key={id}>
                      <line
                        x1={point.x}
                        y1={point.y}
                        x2={point.x}
                        y2={bounds.y}
                        stroke="#3f6df0"
                        strokeWidth={unit}
                      />
                      <circle
                        data-handle={id}
                        cx={point.x}
                        cy={point.y}
                        r={5 * unit}
                        fill="#ffffff"
                        stroke="#3f6df0"
                        strokeWidth={1.4 * unit}
                      />
                    </g>
                  );
                }
                return (
                  <rect
                    key={id}
                    data-handle={id}
                    x={point.x - 4 * unit}
                    y={point.y - 4 * unit}
                    width={8 * unit}
                    height={8 * unit}
                    fill="#ffffff"
                    stroke="#3f6df0"
                    strokeWidth={1.4 * unit}
                  />
                );
              })
            : null}
          </g>
        </g>
      ) : null}

      {editingPath
        ? editingPath.nodes.map((node, index) => {
            const nodeSelected = selectedNodeIds?.includes(node.id) ?? false;
            return (
              <g key={node.id}>
                {node.handleIn ? (
                  <>
                    <line
                      x1={node.x}
                      y1={node.y}
                      x2={node.x + node.handleIn.x}
                      y2={node.y + node.handleIn.y}
                      stroke="#8b5cf6"
                      strokeWidth={unit}
                    />
                    <rect
                      x={node.x + node.handleIn.x - 3 * unit}
                      y={node.y + node.handleIn.y - 3 * unit}
                      width={6 * unit}
                      height={6 * unit}
                      fill="#ffffff"
                      stroke="#8b5cf6"
                      strokeWidth={1.2 * unit}
                    />
                  </>
                ) : null}
                {node.handleOut ? (
                  <>
                    <line
                      x1={node.x}
                      y1={node.y}
                      x2={node.x + node.handleOut.x}
                      y2={node.y + node.handleOut.y}
                      stroke="#8b5cf6"
                      strokeWidth={unit}
                    />
                    <rect
                      x={node.x + node.handleOut.x - 3 * unit}
                      y={node.y + node.handleOut.y - 3 * unit}
                      width={6 * unit}
                      height={6 * unit}
                      fill="#ffffff"
                      stroke="#8b5cf6"
                      strokeWidth={1.2 * unit}
                    />
                  </>
                ) : null}
                <circle
                  data-node-id={node.id}
                  data-node-type={node.type}
                  data-node-selected={nodeSelected ? 'true' : undefined}
                  cx={node.x}
                  cy={node.y}
                  r={(nodeSelected ? 5 : 4) * unit}
                  fill={index === 0 || nodeSelected ? '#3f6df0' : '#ffffff'}
                  stroke={nodeSelected ? '#1d4ed8' : '#3f6df0'}
                  strokeWidth={(nodeSelected ? 1.9 : 1.4) * unit}
                />
              </g>
            );
          })
        : null}

      {marquee ? (
        <rect
          x={Math.min(marquee.start.x, marquee.end.x)}
          y={Math.min(marquee.start.y, marquee.end.y)}
          width={Math.abs(marquee.end.x - marquee.start.x)}
          height={Math.abs(marquee.end.y - marquee.start.y)}
          fill="rgba(63, 109, 240, 0.08)"
          stroke="#3f6df0"
          strokeWidth={unit}
          strokeDasharray={`${5 * unit} ${4 * unit}`}
        />
      ) : null}

      {issues.map((issue) => (
        <g key={issue.id}>
          <circle
            cx={issue.position.x}
            cy={issue.position.y}
            r={17 * unit + 4}
            fill="rgba(229, 72, 77, 0.08)"
            stroke="#e5484d"
            strokeWidth={1.3 * unit}
            strokeDasharray={`${3 * unit} ${3 * unit}`}
          />
        </g>
      ))}
    </g>
  );
}
