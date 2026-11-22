import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  REGION_HANDLES,
  moveRegion,
  pageRegionBounds,
  regionFromPoints,
  resizeRegion,
  type RegionHandle
} from '../../core/io/region';
import type { ExportRegion, Vec } from '../../types/document';

interface ExportRegionOverlayProps {
  region: ExportRegion;
  page: { width: number; height: number };
  zoom: number;
  pan: Vec;
  /** 按住空格平移画布时让出指针，避免抢走画布拖动。 */
  interactive: boolean;
  /** 指针 → 页面坐标（由画布用实际渲染矩阵换算）。 */
  toPage: (event: { clientX: number; clientY: number }) => Vec;
  onChange: (region: ExportRegion) => void;
}

type DragState =
  | { mode: 'create'; anchor: Vec }
  | { mode: 'move'; start: Vec; origin: ExportRegion }
  | { mode: 'resize'; handle: RegionHandle; origin: ExportRegion };

const HANDLE_CURSOR: Record<RegionHandle, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize'
};

/** 画布上的导出选框：拖拽新建、拖动整体、8 向把手调整尺寸。 */
export function ExportRegionOverlay({
  region,
  page,
  zoom,
  pan,
  interactive,
  toPage,
  onChange
}: ExportRegionOverlayProps) {
  const dragRef = useRef<DragState | null>(null);
  const bounds = pageRegionBounds(page);

  const left = pan.x + region.x * zoom;
  const top = pan.y + region.y * zoom;
  const width = region.width * zoom;
  const height = region.height * zoom;

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 中键留给画布平移，右键留给上下文菜单。
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const target = event.target as HTMLElement;
    const handle = target.dataset.handle as RegionHandle | undefined;
    const point = toPage(event);

    if (handle) {
      dragRef.current = { mode: 'resize', handle, origin: region };
      return;
    }
    if (target.dataset.role === 'frame') {
      dragRef.current = { mode: 'move', start: point, origin: region };
      return;
    }
    // 先只记录锚点，等真正拖动后再落选区，避免单击把选区缩成 1×1。
    dragRef.current = { mode: 'create', anchor: point };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.stopPropagation();
    const point = toPage(event);
    if (drag.mode === 'create') {
      onChange(regionFromPoints(drag.anchor, point, bounds));
      return;
    }
    if (drag.mode === 'move') {
      onChange(
        moveRegion(drag.origin, { x: point.x - drag.start.x, y: point.y - drag.start.y }, bounds)
      );
      return;
    }
    onChange(resizeRegion(drag.origin, drag.handle, point, bounds));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.stopPropagation();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* 指针已释放 */
    }
  };

  return (
    <div
      className="export-region"
      data-testid="export-region-overlay"
      role="presentation"
      style={{ pointerEvents: interactive ? 'auto' : 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="export-region__frame"
        data-role="frame"
        data-testid="export-region-frame"
        style={{ left, top, width, height }}
      >
        <span className="export-region__grid export-region__grid--v1" />
        <span className="export-region__grid export-region__grid--v2" />
        <span className="export-region__grid export-region__grid--h1" />
        <span className="export-region__grid export-region__grid--h2" />
        <span className="export-region__size">
          {region.width} × {region.height} px
        </span>
        {REGION_HANDLES.map((handle) => (
          <span
            key={handle}
            className={`export-region__handle export-region__handle--${handle}`}
            data-handle={handle}
            style={{
              left: handle.includes('w') ? 0 : handle.includes('e') ? width : width / 2,
              top: handle.includes('n') ? 0 : handle.includes('s') ? height : height / 2,
              cursor: HANDLE_CURSOR[handle]
            }}
          />
        ))}
      </div>
      <div className="export-region__hint">拖拽画布框选导出范围 · 空格 + 拖动可平移</div>
    </div>
  );
}
