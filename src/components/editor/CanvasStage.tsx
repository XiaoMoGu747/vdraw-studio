import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent
} from 'react';
import { drawLayer, TEMPLATE_MAP } from '../../core/document';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clamp,
  rectFromPoints,
  toPagePoint
} from '../../core/geometry';
import { ExportPanel } from './ExportPanel';
import { ExportRegionOverlay } from './ExportRegionOverlay';
import {
  addObjectsToLayer,
  allObjects,
  boundsOfPoints,
  expandSelection,
  findAtomAt,
  findFillTarget,
  getLayerOfObject,
  getObject,
  getObjectBounds,
  hitTestDocument,
  hitTestObject,
  pointInPolygon,
  replaceObject,
  rectsIntersect,
  rotateDocumentObjects,
  frameLocalToWorld,
  rotatePoint,
  scaleDocumentObjectsInFrame,
  selectionBounds,
  selectionFrame,
  translateDocumentObjects,
  type SelectionFrame
} from '../../core/scene';
import {
  cloneStyle,
  createArrowObject,
  createAtomObject,
  createBondObject,
  createEllipseObject,
  createGroupObject,
  createLineObject,
  createPathObject,
  createPolygonObject,
  createRectObject,
  createTextObject,
  emptyAtomLabel,
  makeNode
} from '../../core/factory';
import { BOND_TYPE_LABEL, ATOM_PRESETS } from '../../core/chemistry/presets';
import { ATOM_FONT_SIZE } from '../../core/chemistry/labels';
import { SHAPE_TOOL_IDS, TOOL_MAP, brushPresetOf } from '../../core/tools';
import {
  brushOutlineData,
  buildBrushNodes,
  type BrushProjection,
  type BrushSample
} from '../../core/brush';
import { hasBrushMaterial } from '../../core/brushMaterial';
import {
  attachBondToGroup,
  attachObjectsToGroup,
  bondExistsBetween,
  bondAnchorScale,
  bondOrderForType,
  findBondAt,
  maxNewBondOrderForAnchor,
  nearestRingAnchor,
  nextBondOrderType,
  nextChainBond,
  validateBondUpgrade,
  type BondAnchor
} from '../../core/chemistry/chain';
import {
  resetSnapHysteresis,
  resolveSnapAnchor
} from '../../core/chemistry/snap-solver';
import { canonicalSupId, supEntryOf } from '../../core/chemistry/sup-library';
import { buildChemGraph } from '../../core/chemistry/graph';
import { deriveHydrogens } from '../../core/chemistry/valence-engine';
import { eraseAlongPath, findErasableAt, type EraserTargets } from '../../core/eraser';
import { validateStructure, type ChemIssue } from '../../core/chemistry/valence';
import { buildRegionFill } from '../../core/regionRaster';
import { splitStrokeAtSelfIntersection } from '../../core/brushSplit';
import { viewRectForViewport } from '../../core/viewport';
import {
  previewObjectIds,
  translatePreviewTransform,
  rotatePreviewTransform
} from '../../core/transformPreview';
import { guideRayDirections } from '../../core/guideSnap';
import { parseTextScripts } from '../../core/textRuns';
import { BrushInkLayer, type BrushInkHandle } from './BrushInkLayer';
import { nibFromTilt, type NibShape } from '../../core/nib';
import { patchTextObject } from '../../core/textLayout';
import { mirrorGroupWithChildren, mirrorObject, mirrorPointList } from '../../core/symmetry';
import { CanvasGuides } from './CanvasGuides';
import { ToolModeBar } from './ToolModeBar';
import { RING_TEMPLATES } from '../../core/chemistry/rings';
import { ringGeometry } from '../../core/chemistry/ring-geometry';
import { benzeneBondTypes, CHEM_GROUP_STYLE, isBenzeneGroup } from '../../core/chemistry/benzene';
import { pathData } from '../../core/io/svg';
import type {
  AtomLabelData,
  AtomObject,
  BondObject,
  GroupObject,
  GuideMode,
  GuideSettings,
  PathNode,
  PathObject,
  Rect,
  SceneObject,
  Style,
  TextObject,
  ToolId,
  VDrawDocument,
  Vec
} from '../../types/document';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { Rulers } from './Rulers';
import { SceneObjectView, SceneRenderer } from './SceneRenderer';
import { TextComposer } from './TextComposer';
import { handleAtPoint, SelectionOverlay, type HandleId } from './SelectionOverlay';

/** 绘制中的画笔预览：中心线 + 每点线宽（页面像素）。 */
interface BrushPreview {
  points: Vec[];
  widths: number[];
}

/** 生效中的键宽：统一由「键宽」参数控制，不再跟随左侧「大小」滑杆。 */
function effectiveChemBondWidth(): number {
  return useAppStore.getState().chemBondWidth;
}

/** 化学键样式：线宽取「设置 → 化学 → 默认粗细」，颜色固定为墨黑。 */
function chemBondStyle(): Style {
  return {
    fill: { type: 'none' },
    stroke: {
      paint: { type: 'solid', color: '#1b1b1b' },
      width: effectiveChemBondWidth(),
      cap: 'round',
      join: 'round',
      dash: []
    },
    opacity: 1
  };
}

/** 化学环系样式：描边宽度与化学键一致，鲍林式内圈才能同粗。 */
function chemGroupStyle(): Style {
  const width = effectiveChemBondWidth();
  return {
    ...CHEM_GROUP_STYLE,
    stroke: { ...CHEM_GROUP_STYLE.stroke, width }
  };
}

const CHEM_ATOM_STYLE: Style = {
  fill: { type: 'solid', color: '#1b1b1b' },
  stroke: { paint: { type: 'none' }, width: 1, cap: 'round', join: 'round', dash: [] },
  opacity: 1
};

const CHEMISTRY_ERASE_TARGETS: EraserTargets = {
  outline: false,
  fill: false,
  chemistry: true
};

/** 化学橡皮固定只擦化学对象；通用橡皮沿用画布下方横栏的多选项。 */
function currentEraseTargets(): EraserTargets {
  const state = useAppStore.getState();
  return state.activeTool === 'eraser' ? CHEMISTRY_ERASE_TARGETS : state.eraserTargets;
}

/** 单笔采样上限：超过后隔点压缩，避免极长笔迹把内存与落笔耗时无限拉高。 */
const MAX_BRUSH_SAMPLES = 24000;

/**
 * 新建化学键：把设置里的键距写进对象，并记录继承自所在结构/锚点的缩放倍率。
 * 旧对象没有 spacing，渲染层按 4.2 兼容。
 */
function makeChemBond(
  layerId: string,
  start: Vec,
  end: Vec,
  bondType: BondObject['bondType'],
  scale = 1,
  aromaticSide?: 1 | -1
): BondObject {
  const state = useAppStore.getState();
  return {
    ...createBondObject(layerId, chemBondStyle(), start, end, bondType, aromaticSide),
    scale,
    spacing: state.chemBondSpacing
  };
}

/** 空锚点视为标准比例，便于各成键路径统一调用。 */
function chemAnchorScale(anchor: BondAnchor | null): number {
  return anchor
    ? bondAnchorScale(anchor, useAppStore.getState().chemAtomSize)
    : 1;
}

/** 新建原子标签：字号随所在结构一起缩放，避免缩放后的结构上贴出“小字”。 */
function makeChemAtom(
  layerId: string,
  position: Vec,
  label: AtomLabelData,
  scale = 1,
  baseFontSize = ATOM_FONT_SIZE
): AtomObject {
  return createAtomObject(layerId, CHEM_ATOM_STYLE, position, {
    ...label,
    fontSize: Math.max(6, (label.fontSize ?? baseFontSize) * scale)
  });
}

const CHEM_ARROW_STYLE: Style = {
  fill: { type: 'none' },
  stroke: {
    paint: { type: 'solid', color: '#1b1b1b' },
    width: 1.8,
    cap: 'round',
    join: 'round',
    dash: []
  },
  opacity: 1
};

/** 共用同一套原子/化学键悬停反馈的化学工具。 */
const CHEM_HOVER_TOOLS: ToolId[] = ['bond', 'atom', 'ring', 'arrow', 'eraser'];

type DragMode =
  | 'move'
  | 'resize'
  | 'rotate'
  | 'marquee'
  | 'create'
  | 'bond'
  | 'arrow'
  | 'node'
  | 'curve'
  | 'erase'
  | 'bucket-fill'
  | 'brush'
  | 'symmetry-axis'
  | 'guide-point'
  | 'pen-handle'
  | 'zoom-marquee'
  | 'text-width';

interface DragState {
  mode: DragMode;
  startPage: Vec;
  startScreen: Vec;
  startDoc: VDrawDocument;
  selectionIds: string[];
  bounds: Rect | null;
  frame: SelectionFrame | null;
  handle: HandleId | null;
  origin: Vec;
  nodeId?: string;
  /** 文本框宽度拖拽：目标文本对象。 */
  textId?: string;
  nodePart?: 'node' | 'in' | 'out';
  /** 节点工具多选：本次拖拽一起移动的节点 id。 */
  nodeIds?: string[];
  pathId?: string;
  curveSegment?: number;
  curvePoint?: Vec;
  curveNodes?: PathNode[];
  curveGrab?: Vec;
  nodeIndex?: number;
  /** 绘画辅助上一次选中的方向，用于加迟滞避免角平分线抖动。 */
  guideDir?: Vec;
  guideHandle?: string;
  axisHandle?: 'vertical' | 'horizontal';
  lastErase?: Vec;
  /** 油漆桶连续填充的上一个落点。 */
  lastFill?: Vec;
  /** 本次擦除是否临时忽略"仅当前图层"（Alt）。 */
  eraseAllLayers?: boolean;
  /** 本次手势内已降过键级的化学键：一次按下→抬起只降一级。 */
  erasedBondIds?: Set<string>;
  discardClick?: boolean;
  /**
   * move / rotate 的拖拽期预览：只改 SVG transform，不写文档。
   * 抬手时按 commit 参数从 startDoc 一次性生成最终文档。
   */
  preview?: {
    ids: string[];
    transform: string;
    commit:
      | { kind: 'move'; dx: number; dy: number }
      | { kind: 'rotate'; center: Vec; delta: number };
  };
  /** resize 的精确预览文档与去重键（sx/sy/anchor 未变时不重算、不写 store）。 */
  previewDoc?: VDrawDocument;
  previewKey?: string;
  /** 最近一次 resize 的缩放系数，用于识别「点了手柄但没拖动」的空提交。 */
  previewScale?: { sx: number; sy: number };
}

interface TextEditorState {
  objectId?: string;
  page: Vec;
  value: string;
  fontSize: number;
  /** 每次打开编辑器的唯一会话号；输入内容变化不改变它。 */
  session: number;
  fontFamily: string;
  fontWeight: number;
  italic?: boolean;
  letterSpacing: number;
  lineHeight: number;
  direction: 'horizontal' | 'vertical';
  /** 编辑框里的字色与对齐要跟最终落字一致（所见即所得）。 */
  color: string;
  align: 'left' | 'center' | 'right';
  rotation: number;
  /** 新建文本：全选方便直接输入；编辑既有文本：不动选区。 */
  selectAll: boolean;
  boxWidth: number;
  boxHeight: number;
}

interface PenDraft {
  nodes: PathNode[];
  cursor: Vec | null;
}

function cursorClass(tool: string, panning: boolean, spaceHeld: boolean): string {
  if (panning) return 'cursor-grabbing';
  if (spaceHeld || tool === 'hand') return 'cursor-grab';
  if (tool === 'zoom') return 'cursor-zoom';
  if (tool === 'text') return 'cursor-text';
  if (tool === 'select' || tool === 'node') return 'cursor-default';
  return 'cursor-crosshair';
}

/** 当前辅助线下允许的绘制方向。 */
function guideDirections(
  origin: Vec,
  mode: GuideMode,
  settings: GuideSettings,
  width: number,
  height: number
): Vec[] {
  const directionTo = (x: number, y: number): Vec | null => {
    const length = Math.hypot(x - origin.x, y - origin.y);
    if (length < 0.5) return null;
    return { x: (x - origin.x) / length, y: (y - origin.y) / length };
  };
  if (mode === 'grid' || mode === 'equal') {
    // 网格 / 等大辅助线只绘制水平与垂直参考线
    return [
      { x: 1, y: 0 },
      { x: 0, y: 1 }
    ];
  }
  // 透视模式：吸附方向量化到画布上真实存在的射线（与 radialLines 同一角度表），
  // 再补上指向消失点的方向，保证"沿 VP 连线"仍能画。
  const rays = guideRayDirections(useAppStore.getState().guideDensity);
  if (mode === 'one-point') {
    const vp = directionTo(settings.vpX * width, settings.horizon * height);
    return vp ? [...rays, vp] : rays;
  }
  if (mode === 'two-point' || mode === 'three-point') {
    const dirs = [
      directionTo(settings.vpLeft * width, settings.horizon * height),
      directionTo(settings.vpRight * width, settings.horizon * height)
    ].filter((dir): dir is Vec => Boolean(dir));
    if (mode === 'three-point') {
      const bottom = directionTo(settings.vpX * width, settings.vpBottom * height);
      if (bottom) dirs.push(bottom);
    }
    return [...rays, ...dirs];
  }
  return [];
}

/** 开启绘画辅助时，把指针点投影到最近的允许方向上。 */
function snapToGuideDirection(
  origin: Vec,
  point: Vec,
  mode: GuideMode,
  settings: GuideSettings,
  width: number,
  height: number,
  preferred?: Vec | null
): Vec {
  const dirs = guideDirections(origin, mode, settings, width, height);
  if (dirs.length === 0) return point;
  const vx = point.x - origin.x;
  const vy = point.y - origin.y;
  const length = Math.hypot(vx, vy);
  if (length < 0.01) return point;
  let best = dirs[0];
  let bestScore = -1;
  for (const dir of dirs) {
    const score = Math.abs(vx * dir.x + vy * dir.y) / length;
    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }
  // 迟滞：已选方向要明显更差才切换，避免在角平分线附近来回抖动。
  if (preferred) {
    const preferredScore = Math.abs(vx * preferred.x + vy * preferred.y) / length;
    if (preferredScore + 0.08 >= bestScore) best = preferred;
  }
  const t = vx * best.x + vy * best.y;
  return { x: origin.x + best.x * t, y: origin.y + best.y * t };
}

function guideHandlePoints(
  mode: GuideMode,
  settings: GuideSettings,
  width: number,
  height: number
): { id: string; point: Vec }[] {
  const horizon = settings.horizon * height;
  const horizonHandle = { id: 'horizon', point: { x: width * 0.5, y: horizon } };
  if (mode === 'one-point') {
    return [{ id: 'one', point: { x: settings.vpX * width, y: horizon } }, horizonHandle];
  }
  if (mode === 'two-point' || mode === 'three-point') {
    const points = [
      { id: 'left', point: { x: settings.vpLeft * width, y: horizon } },
      { id: 'right', point: { x: settings.vpRight * width, y: horizon } },
      horizonHandle
    ];
    if (mode === 'three-point') {
      points.push({ id: 'bottom', point: { x: settings.vpX * width, y: settings.vpBottom * height } });
    }
    return points;
  }
  return [];
}

function gridPoint(point: Vec, doc: VDrawDocument, enabled: boolean, alt: boolean): Vec {
  if (!enabled || alt) return point;
  const step = doc.grid.snapStep || doc.grid.size || 10;
  return {
    x: Math.round(point.x / step) * step,
    y: Math.round(point.y / step) * step
  };
}

/** 形状绘制时的吸附信息，用于实时提示落点与网格线。 */
function shapeSnapInfo(
  point: Vec,
  doc: VDrawDocument,
  enabled: boolean,
  alt: boolean
): { point: Vec; step: number; snapped: boolean } | null {
  if (!enabled || alt) return null;
  const step = doc.grid.snapStep || doc.grid.size || 10;
  const snappedPoint = gridPoint(point, doc, true, false);
  return {
    point: snappedPoint,
    step,
    snapped: Math.abs(snappedPoint.x - point.x) > 0.01 || Math.abs(snappedPoint.y - point.y) > 0.01
  };
}

function findConnection(doc: VDrawDocument, point: Vec, tolerance: number): Vec | null {
  let best: Vec | null = null;
  let bestDistance = tolerance;
  for (const obj of allObjects(doc)) {
    if (!obj.visible) continue;
    const layer = getLayerOfObject(doc, obj.id);
    if (!layer?.visible || layer.locked) continue;
    if (obj.type === 'atom') {
      const distance = Math.hypot(obj.position.x - point.x, obj.position.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = obj.position;
      }
    } else if (obj.type === 'bond') {
      for (const endpoint of [obj.start, obj.end]) {
        const distance = Math.hypot(endpoint.x - point.x, endpoint.y - point.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = endpoint;
        }
      }
    }
  }
  return best;
}

/** 在编组内递归寻找可填充的最深层子对象。 */
function findFillableChild(
  doc: VDrawDocument,
  groupId: string,
  point: Vec,
  tolerance: number
): SceneObject | null {
  const children = allObjects(doc)
    .filter((child) => child.parentId === groupId && child.visible && !child.locked)
    .reverse();
  for (const child of children) {
    if (child.type === 'group') {
      const deep = findFillableChild(doc, child.id, point, tolerance);
      if (deep) return deep;
      continue;
    }
    const insidePolygon =
      child.type === 'polygon'
        ? pointInPolygon(point, child.points)
        : child.type === 'path' && child.closed
          ? pointInPolygon(
              point,
              child.nodes.map((node) => ({ x: node.x, y: node.y }))
            )
          : false;
    if (insidePolygon || hitTestObject(child, point, tolerance)) return child;
  }
  return null;
}

/** 钢笔端点接续：吸附到已有开放路径的首/末节点。 */
function findPathEndpoint(doc: VDrawDocument, point: Vec, tolerance: number): Vec | null {
  let best: Vec | null = null;
  let bestDistance = tolerance;
  for (const object of allObjects(doc)) {
    if (!object.visible || object.type !== 'path' || object.closed) continue;
    const layer = getLayerOfObject(doc, object.id);
    if (!layer?.visible || layer.locked) continue;
    for (const node of [object.nodes[0], object.nodes[object.nodes.length - 1]]) {
      if (!node) continue;
      const distance = Math.hypot(node.x - point.x, node.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x: node.x, y: node.y };
      }
    }
  }
  return best;
}

/**
 * 普通图形的端点吸附：直线/曲线落点优先贴到已有对象的端点、路径节点或原子位置。
 * 只吸收端点，不吸收边中点——避免在密集图形里被"吸到某条线中间"。
 */
function snapToObjectEndpoint(
  doc: VDrawDocument,
  point: Vec,
  tolerance: number,
  exclude?: Set<string>
): Vec | null {
  let best: Vec | null = null;
  let bestDistance = tolerance;
  const consider = (candidate: Vec) => {
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { x: candidate.x, y: candidate.y };
    }
  };
  for (const object of allObjects(doc)) {
    if (!object.visible || object.locked) continue;
    if (exclude?.has(object.id)) continue;
    const layer = getLayerOfObject(doc, object.id);
    if (!layer?.visible || layer.locked) continue;
    if (object.type === 'line' || object.type === 'bond' || object.type === 'arrow') {
      consider(object.start);
      consider(object.end);
    } else if (object.type === 'path') {
      for (const node of object.nodes) consider(node);
    } else if (object.type === 'atom') {
      consider(object.position);
    } else if (
      object.type === 'rect' ||
      object.type === 'ellipse' ||
      object.type === 'text'
    ) {
      consider({ x: object.x, y: object.y });
      consider({ x: object.x + object.width, y: object.y });
      consider({ x: object.x + object.width, y: object.y + object.height });
      consider({ x: object.x, y: object.y + object.height });
    }
  }
  return best;
}

/** 钢笔草稿预览：最后一段按真实贝塞尔（有 handleOut 时）绘制。 */
function penPreviewData(nodes: PathNode[], cursor: Vec): string {
  if (nodes.length === 0) return '';
  if (nodes.length === 1) {
    return `M ${nodes[0].x} ${nodes[0].y} L ${cursor.x} ${cursor.y}`;
  }
  const base = pathData(nodes, false);
  const last = nodes[nodes.length - 1];
  if (last.handleOut) {
    return `${base} C ${last.x + last.handleOut.x} ${last.y + last.handleOut.y} ${cursor.x} ${cursor.y} ${cursor.x} ${cursor.y}`;
  }
  return `${base} L ${cursor.x} ${cursor.y}`;
}

function constrainSquare(start: Vec, end: Vec): Vec {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: start.x + Math.sign(dx || 1) * size,
    y: start.y + Math.sign(dy || 1) * size
  };
}

function rotateVector(point: Vec, angle: number): Vec {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

/**
 * 曲线工具生成的路径只记录折点，控制柄由相邻点自动推导。
 * 两个点保持直线；增加拖拽点后自动变成平滑曲线。
 */
function smoothCurveNodes(nodes: PathNode[], affected?: Set<number>): PathNode[] {
  if (nodes.length <= 2) {
    return nodes.map((node) => ({
      ...node,
      handleIn: null,
      handleOut: null,
      type: 'corner' as const
    }));
  }
  return nodes.map((node, index) => {
    // 只重算受影响的节点；手工调过手柄的节点保持原样，避免被自动平滑覆盖。
    if (node.handleLocked) return node;
    if (affected && !affected.has(index)) return node;
    if (index === 0) {
      const next = nodes[1];
      return {
        ...node,
        handleIn: null,
        handleOut: { x: (next.x - node.x) / 3, y: (next.y - node.y) / 3 },
        type: 'smooth' as const
      };
    }
    if (index === nodes.length - 1) {
      const prev = nodes[index - 1];
      return {
        ...node,
        handleIn: { x: (prev.x - node.x) / 3, y: (prev.y - node.y) / 3 },
        handleOut: null,
        type: 'smooth' as const
      };
    }
    const prev = nodes[index - 1];
    const next = nodes[index + 1];
    const tangent = { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 };
    return {
      ...node,
      handleIn: { x: -tangent.x, y: -tangent.y },
      handleOut: tangent,
      type: 'smooth' as const
    };
  });
}

/** 更新路径节点后同步包围盒，保证选择和缩放框跟随拖拽点。 */
function curvePathWithNodes(path: PathObject, nodes: PathNode[]): PathObject {
  const points: Vec[] = [];
  for (const node of nodes) {
    points.push({ x: node.x, y: node.y });
    if (node.handleIn) points.push({ x: node.x + node.handleIn.x, y: node.y + node.handleIn.y });
    if (node.handleOut) points.push({ x: node.x + node.handleOut.x, y: node.y + node.handleOut.y });
  }
  const bounds = boundsOfPoints(points, path.style.stroke.width);
  return { ...path, nodes, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

/** 页面坐标 → 路径未旋转时的局部坐标。 */
function curveLocalPoint(path: PathObject, point: Vec): Vec {
  if (!path.rotation) return point;
  return rotatePoint(
    point,
    { x: path.x + path.width / 2, y: path.y + path.height / 2 },
    -path.rotation
  );
}

function cubicPoint(p0: Vec, c1: Vec, c2: Vec, p1: Vec, t: number): Vec {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y
  };
}

/** 找到路径上离指针最近的采样点，用于在拖拽位置插入新节点。 */
function nearestCurvePoint(
  nodes: PathNode[],
  point: Vec,
  closed = false
): { segment: number; t: number; point: Vec; distance: number } | null {
  if (nodes.length < 2) return null;
  let best: { segment: number; t: number; point: Vec; distance: number } | null = null;
  const segments = closed ? nodes.length : nodes.length - 1;
  for (let index = 0; index < segments; index += 1) {
    const start = nodes[index];
    const end = nodes[(index + 1) % nodes.length];
    const c1 = start.handleOut
      ? { x: start.x + start.handleOut.x, y: start.y + start.handleOut.y }
      : start;
    const c2 = end.handleIn
      ? { x: end.x + end.handleIn.x, y: end.y + end.handleIn.y }
      : end;
    // 先粗采样定位，再在邻域内三分细化：插入点误差从"段长/48"降到 0.1px 量级。
    let localT = 0;
    let localDistance = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 48; step += 1) {
      const t = step / 48;
      const sample = cubicPoint(start, c1, c2, end, t);
      const distance = Math.hypot(sample.x - point.x, sample.y - point.y);
      if (distance < localDistance) {
        localDistance = distance;
        localT = t;
      }
    }
    let low = Math.max(0, localT - 1 / 48);
    let high = Math.min(1, localT + 1 / 48);
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const m1 = low + (high - low) / 3;
      const m2 = high - (high - low) / 3;
      const p1 = cubicPoint(start, c1, c2, end, m1);
      const p2 = cubicPoint(start, c1, c2, end, m2);
      const d1 = Math.hypot(p1.x - point.x, p1.y - point.y);
      const d2 = Math.hypot(p2.x - point.x, p2.y - point.y);
      if (d1 < d2) high = m2;
      else low = m1;
      if (d1 < localDistance) {
        localDistance = d1;
        localT = m1;
      }
      if (d2 < localDistance) {
        localDistance = d2;
        localT = m2;
      }
    }
    const sample = cubicPoint(start, c1, c2, end, localT);
    if (!best || localDistance < best.distance) {
      best = { segment: index, t: localT, point: sample, distance: localDistance };
    }
  }
  return best;
}

/** 命中曲线拖拽点；端点不允许删除，因此只返回落在中间节点上的索引。 */
function curveHandleIndex(path: PathObject, point: Vec, zoom: number): number {
  const tolerance = 8 / zoom;
  const local = curveLocalPoint(path, point);
  return path.nodes.findIndex(
    (node, index) =>
      index > 0 &&
      index < path.nodes.length - 1 &&
      Math.hypot(local.x - node.x, local.y - node.y) <= tolerance
  );
}

/**
 * 统一落点解算：所有化学吸附都走这里。
 * 半径 = 当前键长 × 0.19（对齐 KingDraw 的 0.15/0.78），钳在 4–14 屏幕像素后按缩放换算。
 * key 非 'idle' 时启用迟滞，拖动期间不会在两个候选之间来回跳。
 */
function snapAnchor(doc: VDrawDocument, point: Vec, key = 'idle'): BondAnchor | null {
  const state = useAppStore.getState();
  return resolveSnapAnchor(doc, point, {
    bondLength: state.chemBondLength,
    zoom: state.viewport.zoom,
    key,
    noHysteresis: key === 'idle'
  });
}

/** 找到环上被点击的碳原子/环键，并计算新环贴在该顶点外侧的中心与旋转角。 */
function ringAttachmentAt(
  doc: VDrawDocument,
  point: Vec,
  template: (typeof RING_TEMPLATES)[number],
  zoom: number
): { center: Vec; rotation: number; groupId: string; anchorPoint: Vec } | null {
  let anchor = snapAnchor(doc, point, 'ring');
  if (!anchor || !anchor.group?.ringFrame) {
    const bond = findBondAt(doc, point, 12 / zoom);
    if (bond?.parentId) {
      const endpoint =
        Math.hypot(point.x - bond.start.x, point.y - bond.start.y) <=
        Math.hypot(point.x - bond.end.x, point.y - bond.end.y)
          ? bond.start
          : bond.end;
      anchor = snapAnchor(doc, endpoint, 'ring') ?? anchor;
    }
  }
  if (!anchor || !anchor.group?.ringFrame) return null;
  const group = anchor.group;
  const groupCenter = {
    x: group.x + group.width / 2,
    y: group.y + group.height / 2
  };
  let outward = {
    x: anchor.point.x - groupCenter.x,
    y: anchor.point.y - groupCenter.y
  };
  const outwardLength = Math.hypot(outward.x, outward.y);
  if (outwardLength < 1) {
    outward = { x: 0, y: -1 };
  } else {
    outward = { x: outward.x / outwardLength, y: outward.y / outwardLength };
  }
  // 杂环把杂原子放在 0 号顶点，连接时应选一个未标注的碳顶点。
  const carbonIndex = (() => {
    const index = template.atoms.findIndex((atom) => !atom.label);
    return index >= 0 ? index : 0;
  })();
  const base = template.atoms[carbonIndex];
  // 新环与被点击的碳原子共用顶点，环心应继续朝外侧延伸；
  // 因此让模板选中的顶点指向旧环环心（-outward），而不是指向外侧。
  const rotation =
    Math.atan2(-outward.y, -outward.x) - Math.atan2(base.y, base.x);
  // 环半径 40 + 一条取代基单键长度 40，让新环像甲基一样通过单键连在顶点外侧。
  return {
    center: {
      x: anchor.point.x + outward.x * 80,
      y: anchor.point.y + outward.y * 80
    },
    rotation,
    groupId: group.id,
    anchorPoint: anchor.point
  };
}

/**
 * 从一条环键向上找到整个稠环体系的根编组。
 * 旧版两环结构里公共边仍挂在第一个苯环组下，新环键挂在“萘环”组下；
 * 因此不能只看直接父级，必须沿 parentId 找到最外层 ringFrame。
 */
function ringSystemRoot(doc: VDrawDocument, start: SceneObject | null): GroupObject | null {
  let current = start;
  let root: GroupObject | null = null;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.type === 'group' && (current.ringFrame || current.ringStyle)) root = current;
    if (!current.parentId) break;
    current = getObject(doc, current.parentId) ?? null;
  }
  return root;
}

function pointKey(point: Vec): string {
  return `${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10}`;
}

/**
 * 从键图里找六元环，而不是依赖“一层苯环组 = 一个环”的旧结构。
 * 这样两环、三环、并四苯都能继续从任意一条未共用边并环。
 */
function ringCyclesInGroup(
  doc: VDrawDocument,
  rootId: string
): Array<{ center: Vec; bondIds: string[] }> {
  const objects = allObjects(doc);
  const byId = new Map(objects.map((object) => [object.id, object]));
  const belongsToRoot = (object: SceneObject): boolean => {
    let parentId = object.parentId;
    let guard = 0;
    while (parentId && guard < 32) {
      if (parentId === rootId) return true;
      parentId = byId.get(parentId)?.parentId ?? null;
      guard += 1;
    }
    return false;
  };
  const bonds = objects.filter(
    (object): object is BondObject =>
      object.type === 'bond' && belongsToRoot(object) && Math.hypot(object.end.x - object.start.x, object.end.y - object.start.y) > 1
  );
  if (bonds.length < 6) return [];

  const positions = new Map<string, Vec>();
  const adjacency = new Map<string, Array<{ to: string; bondId: string }>>();
  for (const bond of bonds) {
    const from = pointKey(bond.start);
    const to = pointKey(bond.end);
    if (from === to) continue;
    positions.set(from, bond.start);
    positions.set(to, bond.end);
    if (!adjacency.has(from)) adjacency.set(from, []);
    if (!adjacency.has(to)) adjacency.set(to, []);
    adjacency.get(from)!.push({ to, bondId: bond.id });
    adjacency.get(to)!.push({ to: from, bondId: bond.id });
  }

  const bondLength = (bondId: string): number => {
    const bond = byId.get(bondId);
    return bond && bond.type === 'bond'
      ? Math.hypot(bond.end.x - bond.start.x, bond.end.y - bond.start.y)
      : 0;
  };
  const cycles = new Map<string, { center: Vec; bondIds: string[] }>();
  const nodes = [...adjacency.keys()].sort();

  for (const start of nodes) {
    const pathNodes: string[] = [start];
    const pathBonds: string[] = [];
    const visited = new Set<string>([start]);
    const walk = (current: string) => {
      if (pathBonds.length === 5) {
        const closing = adjacency.get(current)?.find((edge) => edge.to === start);
        if (!closing) return;
        const bondIds = [...pathBonds, closing.bondId];
        if (new Set(bondIds).size !== 6) return;
        if (bondIds.some((id) => bondLength(id) < 30 || bondLength(id) > 50)) return;
        const vertices = pathNodes.map((key) => positions.get(key)!).filter(Boolean);
        if (vertices.length !== 6) return;
        // 正六边形内角约 120°；允许环被整体旋转后的少量浮点误差。
        for (let index = 0; index < 6; index += 1) {
          const previous = vertices[(index + 5) % 6];
          const currentPoint = vertices[index];
          const next = vertices[(index + 1) % 6];
          const ax = previous.x - currentPoint.x;
          const ay = previous.y - currentPoint.y;
          const bx = next.x - currentPoint.x;
          const by = next.y - currentPoint.y;
          const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by);
          if (denominator < 1) return;
          const cosine = (ax * bx + ay * by) / denominator;
          if (cosine < -0.86 || cosine > -0.2) return;
        }
        const center = vertices.reduce(
          (acc, point) => ({ x: acc.x + point.x / 6, y: acc.y + point.y / 6 }),
          { x: 0, y: 0 }
        );
        const key = [...bondIds].sort().join('|');
        if (!cycles.has(key)) cycles.set(key, { center, bondIds });
        return;
      }
      for (const edge of adjacency.get(current) ?? []) {
        if (edge.to === start || visited.has(edge.to) || edge.to < start) continue;
        visited.add(edge.to);
        pathNodes.push(edge.to);
        pathBonds.push(edge.bondId);
        walk(edge.to);
        pathBonds.pop();
        pathNodes.pop();
        visited.delete(edge.to);
      }
    };
    walk(start);
  }
  return [...cycles.values()];
}

type FusedBenzeneTarget = {
  root: GroupObject;
  baseCenter: Vec;
  center: Vec;
  rotation: number;
  ringCount: number;
  makeOuter: boolean;
};

/**
 * 点击已有苯环的某条环键：把下一个苯环镜像到该键的另一侧并共用这条键。
 * 通过键图识别“哪一圈”包含该键；如果该键已被两圈共用则拒绝第三环。
 */
function fusedBenzeneAt(
  doc: VDrawDocument,
  point: Vec,
  zoom: number
): FusedBenzeneTarget | { blocked: string } | null {
  const bond = findBondAt(doc, point, 9 / zoom);
  if (!bond?.parentId) return null;
  const parent = getObject(doc, bond.parentId);
  if (!parent || parent.type !== 'group') return null;
  const root = ringSystemRoot(doc, parent);
  if (!root?.ringFrame) return null;
  // 端点附近仍按“碳原子上加取代基”处理，键身中段才做并环。
  if (
    Math.hypot(point.x - bond.start.x, point.y - bond.start.y) <= 9 / zoom ||
    Math.hypot(point.x - bond.end.x, point.y - bond.end.y) <= 9 / zoom
  ) {
    return null;
  }
  const cycles = ringCyclesInGroup(doc, root.id);
  const containing = cycles.filter((cycle) => cycle.bondIds.includes(bond.id));
  if (containing.length === 0) return null;
  if (containing.length > 1) {
    return { blocked: '该共用键两侧都已有苯环，请选择环外侧的键继续并环' };
  }
  const base = containing[0];
  const template = RING_TEMPLATES.find((item) => item.id === 'benzene');
  if (!template) return null;
  const [p0, p1] = template.atoms;
  const edgeVector = { x: p1.x - p0.x, y: p1.y - p0.y };
  const edgeMid = { x: ((p0.x + p1.x) / 2) * 40, y: ((p0.y + p1.y) / 2) * 40 };
  const midpoint = { x: (bond.start.x + bond.end.x) / 2, y: (bond.start.y + bond.end.y) / 2 };
  // 公共边的方向有两种；用“新环心应落在旧环心反侧”选择正确的一种。
  // 中心必须和旋转角成对计算，否则新环会共用错误的模板边并重复画出公共键。
  const candidates = [
    { start: bond.start, end: bond.end },
    { start: bond.end, end: bond.start }
  ].map((direction) => {
    const rotation =
      Math.atan2(direction.end.y - direction.start.y, direction.end.x - direction.start.x) -
      Math.atan2(edgeVector.y, edgeVector.x);
    const rotatedMid = rotateVector(edgeMid, rotation);
    const center = { x: midpoint.x - rotatedMid.x, y: midpoint.y - rotatedMid.y };
    const outward = { x: center.x - midpoint.x, y: center.y - midpoint.y };
    const towardOld = { x: base.center.x - midpoint.x, y: base.center.y - midpoint.y };
    return { center, rotation, dot: outward.x * towardOld.x + outward.y * towardOld.y };
  });
  candidates.sort((a, b) => a.dot - b.dot);
  const chosen = candidates[0];
  if (cycles.some((cycle) => Math.hypot(cycle.center.x - chosen.center.x, cycle.center.y - chosen.center.y) < 52)) {
    return { blocked: '这个方向已有苯环，无法继续共用这条键' };
  }
  return {
    root,
    baseCenter: base.center,
    center: chosen.center,
    rotation: chosen.rotation,
    ringCount: cycles.length + 1,
    makeOuter: isBenzeneGroup(root)
  };
}

function polygonPoints(start: Vec, end: Vec, sides = 6, star = 0): Vec[] {
  const cx = (start.x + end.x) / 2;
  const cy = (start.y + end.y) / 2;
  const rx = Math.abs(end.x - start.x) / 2;
  const ry = Math.abs(end.y - start.y) / 2;
  // 星形：外顶点与内顶点交替，内径按比例收缩。
  const count = star > 0 ? sides * 2 : sides;
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
    const ratio = star > 0 && index % 2 === 1 ? star : 1;
    return { x: cx + Math.cos(angle) * rx * ratio, y: cy + Math.sin(angle) * ry * ratio };
  });
}

interface ShapeDragOptions {
  shift: boolean;
  cornerRadius?: number;
  sides?: number;
  star?: number;
  fromCenter?: boolean;
  arrowEnd?: boolean;
}

function shapeFromDrag(
  tool: ToolId,
  start: Vec,
  end: Vec,
  layerId: string,
  style: Style,
  options: ShapeDragOptions
): SceneObject | null {
  const { shift, cornerRadius = 0, sides = 6, star = 0, fromCenter = false, arrowEnd = false } =
    options;
  const equalSides =
    tool === 'square' ||
    tool === 'circle' ||
    (shift && (tool === 'rect' || tool === 'ellipse'));
  const constrained = equalSides ? constrainSquare(start, end) : end;
  // 从中心绘制：把终点按起点镜像，矩形/多边形的包围盒自然以起点为中心。
  const point =
    fromCenter && tool !== 'line' && tool !== 'curve'
      ? { x: start.x * 2 - constrained.x, y: start.y * 2 - constrained.y }
      : constrained;
  const rect = rectFromPoints(start, point);
  switch (tool) {
    case 'rect':
    case 'square': {
      const rectObject = createRectObject(
        layerId,
        style,
        rect.x,
        rect.y,
        Math.max(1, rect.width),
        Math.max(1, rect.height)
      );
      return {
        ...rectObject,
        cornerRadius: Math.min(
          Math.max(0, cornerRadius),
          Math.max(1, rect.width) / 2,
          Math.max(1, rect.height) / 2
        )
      };
    }
    case 'ellipse':
    case 'circle':
      return createEllipseObject(layerId, style, rect.x, rect.y, Math.max(1, rect.width), Math.max(1, rect.height));
    case 'line': {
      let target = point;
      if (shift) {
        const dx = point.x - start.x;
        const dy = point.y - start.y;
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        target = { x: start.x + Math.cos(angle) * Math.hypot(dx, dy), y: start.y + Math.sin(angle) * Math.hypot(dx, dy) };
      }
      return {
        ...createLineObject(layerId, style, start, target),
        ...(arrowEnd ? { arrowEnd: true } : {})
      };
    }
    case 'polygon':
      return createPolygonObject(layerId, style, polygonPoints(start, point, sides, star));
    case 'curve': {
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length < 2) return null;
      // 默认画直线；按住 Shift 直接生成一段圆弧（反向弯曲也用它）。
      const first = makeNode(start.x, start.y);
      const last = makeNode(point.x, point.y);
      if (shift) {
        const nx = -dy / length;
        const ny = dx / length;
        const bow = Math.min(90, length * 0.28);
        first.handleOut = { x: dx / 3 + nx * bow, y: dy / 3 + ny * bow };
        last.handleIn = { x: -dx / 3 + nx * bow, y: -dy / 3 + ny * bow };
        first.type = 'smooth';
        last.type = 'smooth';
      }
      const curveStyle = cloneStyle(style);
      curveStyle.fill = { type: 'none' };
      return createPathObject(layerId, curveStyle, [first, last], false);
    }
    default:
      return null;
  }
}

function snapMove(
  doc: VDrawDocument,
  ids: string[],
  bounds: Rect | null,
  dx: number,
  dy: number,
  zoom: number,
  enabled: boolean,
  alt: boolean
): { dx: number; dy: number; guides: { x: number[]; y: number[] } } {
  if (!bounds || !enabled || alt) return { dx, dy, guides: { x: [], y: [] } };
  const expanded = new Set(expandSelection(doc, ids));
  const others = allObjects(doc)
    .filter((obj) => obj.type !== 'group' && !expanded.has(obj.id) && obj.visible)
    .map((obj) => getObjectBounds(obj, doc));
  const xCandidates = [0, doc.page.width / 2, doc.page.width];
  const yCandidates = [0, doc.page.height / 2, doc.page.height];
  for (const rect of others) {
    xCandidates.push(rect.x, rect.x + rect.width / 2, rect.x + rect.width);
    yCandidates.push(rect.y, rect.y + rect.height / 2, rect.y + rect.height);
  }
  const movingX = [bounds.x + dx, bounds.x + bounds.width / 2 + dx, bounds.x + bounds.width + dx];
  const movingY = [bounds.y + dy, bounds.y + bounds.height / 2 + dy, bounds.y + bounds.height + dy];
  const tolerance = 7 / zoom;
  let bestX: { diff: number; guide: number } | null = null;
  let bestY: { diff: number; guide: number } | null = null;
  for (const moving of movingX) {
    for (const candidate of xCandidates) {
      const diff = candidate - moving;
      if (Math.abs(diff) <= tolerance && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
        bestX = { diff, guide: candidate };
      }
    }
  }
  for (const moving of movingY) {
    for (const candidate of yCandidates) {
      const diff = candidate - moving;
      if (Math.abs(diff) <= tolerance && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
        bestY = { diff, guide: candidate };
      }
    }
  }
  const guidesX: number[] = [];
  const guidesY: number[] = [];
  let nextDx = dx;
  let nextDy = dy;
  if (bestX) {
    nextDx += bestX.diff;
    guidesX.push(bestX.guide);
  } else {
    const step = doc.grid.snapStep || 10;
    nextDx += Math.round((bounds.x + dx) / step) * step - (bounds.x + dx);
  }
  if (bestY) {
    nextDy += bestY.diff;
    guidesY.push(bestY.guide);
  } else {
    const step = doc.grid.snapStep || 10;
    nextDy += Math.round((bounds.y + dy) / step) * step - (bounds.y + dy);
  }
  return { dx: nextDx, dy: nextDy, guides: { x: guidesX, y: guidesY } };
}

/**
 * 缩放时对拖动的边进行页面/其它对象对齐吸附，返回吸附后的点和辅助线。
 * 与移动的 snapMove 使用同一组候选线与容差。
 */
function snapResizePoint(
  point: Vec,
  handle: string,
  doc: VDrawDocument,
  zoom: number,
  enabled: boolean,
  alt: boolean,
  selectionIds: string[]
): { point: Vec; guides: { x: number[]; y: number[] } } {
  const gridSnapped = gridPoint(point, doc, enabled, alt);
  if (!enabled || alt) return { point: gridSnapped, guides: { x: [], y: [] } };

  const expanded = new Set(expandSelection(doc, selectionIds));
  const xCandidates = [0, doc.page.width / 2, doc.page.width];
  const yCandidates = [0, doc.page.height / 2, doc.page.height];
  for (const object of allObjects(doc)) {
    if (object.type === 'group' || expanded.has(object.id) || !object.visible) continue;
    const rect = getObjectBounds(object, doc);
    for (const value of [rect.x, rect.x + rect.width / 2, rect.x + rect.width]) {
      if (value >= 0 && value <= doc.page.width) xCandidates.push(value);
    }
    for (const value of [rect.y, rect.y + rect.height / 2, rect.y + rect.height]) {
      if (value >= 0 && value <= doc.page.height) yCandidates.push(value);
    }
  }

  const tolerance = 7 / zoom;
  const next = { ...gridSnapped };
  const guidesX: number[] = [];
  const guidesY: number[] = [];
  const hasX = handle.includes('w') || handle.includes('e');
  const hasY = handle.includes('n') || handle.includes('s');
  if (hasX) {
    let best: { value: number; diff: number } | null = null;
    for (const candidate of xCandidates) {
      const diff = candidate - next.x;
      if (Math.abs(diff) <= tolerance && (!best || Math.abs(diff) < Math.abs(best.diff))) {
        best = { value: candidate, diff };
      }
    }
    if (best) {
      next.x += best.diff;
      guidesX.push(best.value);
    }
  }
  if (hasY) {
    let best: { value: number; diff: number } | null = null;
    for (const candidate of yCandidates) {
      const diff = candidate - next.y;
      if (Math.abs(diff) <= tolerance && (!best || Math.abs(diff) < Math.abs(best.diff))) {
        best = { value: candidate, diff };
      }
    }
    if (best) {
      next.y += best.diff;
      guidesY.push(best.value);
    }
  }
  // 吸附范围不超出画布
  next.x = Math.min(doc.page.width, Math.max(0, next.x));
  next.y = Math.min(doc.page.height, Math.max(0, next.y));
  return { point: next, guides: { x: guidesX, y: guidesY } };
}

function atomLabelFromChem(chem: ReturnType<typeof useAppStore.getState>['chem']): AtomLabelData {
  const preset = ATOM_PRESETS.find((item) => item.id === chem.atomPresetId);
  // 自定义元素（面板里直接输入的元素符号）没有预设项，回落到 chem.element。
  const element = (preset?.element ?? chem.element ?? 'C').trim() || 'C';
  return {
    element,
    charge: chem.charge,
    isotope: chem.isotope,
    radical: chem.radical,
    lonePairs: chem.lonePairs,
    hydrogens: null,
    group: preset?.kind === 'group' ? preset.display : null,
    // 官能团同时记录 SUP 条目 id：折叠态仍显示 group 文本，展开/统计走 supId。
    supId: preset?.kind === 'group' ? canonicalSupId(preset.id) : null
  };
}

export function CanvasStage() {
  const doc = useAppStore((state) => state.doc);
  const viewport = useAppStore((state) => state.viewport);
  const activeTool = useAppStore((state) => state.activeTool);
  const selection = useAppStore((state) => state.selection);
  const showGrid = useAppStore((state) => state.showGrid);
  const showRulers = useAppStore((state) => state.showRulers);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const fitToken = useAppStore((state) => state.fitToken);
  const chemReport = useAppStore((state) => state.chemReport);
  const inlineValence = useAppStore((state) => state.inlineValence);
  const defaultStyle = useAppStore((state) => state.defaultStyle);
  const textSettings = useAppStore((state) => state.textSettings);
  const toolEpoch = useAppStore((state) => state.toolEpoch);
  const symmetry = useAppStore((state) => state.symmetry);
  const symmetryAxis = useAppStore((state) => state.symmetryAxis);
  const guideMode = useAppStore((state) => state.guideMode);
  const guideSettings = useAppStore((state) => state.guideSettings);
  const guideAssist = useAppStore((state) => state.guideAssist);
  const guideDensity = useAppStore((state) => state.guideDensity);
  const guideSpacing = useAppStore((state) => state.guideSpacing);
  const hoverHighlight = useAppStore((state) => state.hoverHighlight);
  const brushSize = useAppStore((state) => state.brushSize);
  const brushOpacity = useAppStore((state) => state.brushOpacity);
  const eraserSize = useAppStore((state) => state.eraserSize);
  const bucketMode = useAppStore((state) => state.bucketMode);
  const cursor = useAppStore((state) => state.cursor);

  const setViewport = useAppStore((state) => state.setViewport);
  const setViewportSize = useAppStore((state) => state.setViewportSize);
  const canvasLeftInset = useAppStore((state) => state.canvasLeftInset);
  const setCanvasLeftInset = useAppStore((state) => state.setCanvasLeftInset);
  const leftDockOpen = useAppStore((state) => state.leftDockOpen);
  const focusCanvas = useAppStore((state) => state.focusCanvas);
  const fitToCanvas = useAppStore((state) => state.fitToCanvas);
  const zoomAt = useAppStore((state) => state.zoomAt);
  const panBy = useAppStore((state) => state.panBy);
  const setCursor = useAppStore((state) => state.setCursor);
  const openProperties = useAppStore((state) => state.openProperties);
  const exportPanelOpen = useAppStore((state) => state.exportPanelOpen);
  const exportScope = useAppStore((state) => state.exportScope);
  const exportRegion = useAppStore((state) => state.exportRegion);
  const setExportRegion = useAppStore((state) => state.setExportRegion);

  // 化合价：报告里的问题 + 实时"超价"错误（仅 error，避免每个碳都报提示造成噪音）。
  const liveIssues = useMemo<ChemIssue[]>(() => {
    if (!inlineValence) return [];
    try {
      return validateStructure(doc)
        .filter((issue) => issue.severity === 'error')
        .slice(0, 40);
    } catch {
      return [];
    }
  }, [doc, inlineValence]);
  const overlayIssues = useMemo<ChemIssue[]>(() => {
    const merged = new Map<string, ChemIssue>();
    for (const issue of chemReport?.issues ?? []) merged.set(issue.id, issue);
    for (const issue of liveIssues) merged.set(issue.id, issue);
    return [...merged.values()];
  }, [chemReport, liveIssues]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SVGGElement>(null);
  const fittedDocRef = useRef<string | null>(null);
  const fittedInsetRef = useRef(0);
  const lastAutoFitRef = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);
  const panRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const textEditorRef = useRef<TextEditorState | null>(null);
  /** 打开编辑框时激活的工具：用于区分"切换工具"与"双击进入编辑"。 */
  const textEditorToolRef = useRef<ToolId | null>(null);
  /** 合成器状态的即时镜像：供事件回调读取最新值，避免闭包过期。 */
  const textComposerRef = useRef<{ text: string; center: Vec } | null>(null);
  const textSessionRef = useRef(0);
  const textCommitRef = useRef(false);
  /** 横栏插入上下标/项目符号后的光标位置。 */
  const textCaretRef = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [sizeHud, setSizeHud] = useState(false);
  const [toolHover, setToolHover] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [preview, setPreview] = useState<SceneObject | null>(null);
  const [brushPreview, setBrushPreview] = useState<BrushPreview | null>(null);
  const brushSamplesRef = useRef<BrushSample[]>([]);
  const brushProjectionRef = useRef<BrushProjection | null>(null);
  const brushPointerTypeRef = useRef<string>('mouse');
  const brushRafRef = useRef<number | null>(null);
  const brushInkRef = useRef<BrushInkHandle | null>(null);
  const brushSeedRef = useRef(1);
  const pendingCursorRef = useRef<Vec | null>(null);
  const lastCursorRef = useRef<Vec | null>(null);
  const touchPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const touchGestureRef = useRef<{ dist: number; x: number; y: number } | null>(null);
  const lastPenAtRef = useRef(0);
  const [bondHover, setBondHover] = useState<
    | { kind: 'atom'; point: Vec }
    | { kind: 'bond'; bondId: string; start: Vec; end: Vec }
    | null
  >(null);

  useEffect(() => {
    if (!CHEM_HOVER_TOOLS.includes(activeTool) || !hoverHighlight) setBondHover(null);
  }, [activeTool, hoverHighlight]);
  const [marquee, setMarquee] = useState<{ start: Vec; end: Vec } | null>(null);
  const [snapHint, setSnapHint] = useState<{
    point: Vec;
    step: number;
    snapped: boolean;
  } | null>(null);
  const [guides, setGuides] = useState<{
    x: number[];
    y: number[];
    lines?: { x1: number; y1: number; x2: number; y2: number }[];
  }>({ x: [], y: [] });
  const [penDraft, setPenDraft] = useState<PenDraft | null>(null);
  /** 节点工具内的节点选择（与对象选择分离，Shift 可多选）。 */
  const [nodeSelection, setNodeSelection] = useState<string[]>([]);
  const nodeSelectionRef = useRef<string[]>([]);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  /**
   * 文字合成器：内容 + 落点（页面坐标）。
   * 为空表示面板收起；内容只随左侧输入变化，右侧工具只改 textSettings。
   */
  const [textComposer, setTextComposer] = useState<{ text: string; center: Vec } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    objectId: string;
    name: string;
    type: SceneObject['type'];
  } | null>(null);

  const page = doc.page;
  const template = TEMPLATE_MAP[doc.templateId];
  const zoom = viewport.zoom;
  const objectCount = doc.layers.reduce((total, layer) => total + layer.objects.length, 0);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setSize(next);
      setViewportSize(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [setViewportSize]);

  // 左侧调色板是浮层：测量它实际覆盖的宽度，画布仍铺满整个工作区，
  // 但页面适配/居中只使用露出的区域，避免被面板压住。
  useEffect(() => {
    const dock = document.querySelector<HTMLElement>('.left-dock');
    if (!dock) {
      setCanvasLeftInset(0);
      return;
    }
    const measure = () => {
      const next = Math.round(dock.getBoundingClientRect().width);
      if (useAppStore.getState().canvasLeftInset !== next) setCanvasLeftInset(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [leftDockOpen, focusCanvas, setCanvasLeftInset]);

  useEffect(() => {
    if (size.width < 40 || size.height < 40) return;
    const current = useAppStore.getState().viewport;
    const last = lastAutoFitRef.current;
    const unchanged =
      !last ||
      (Math.abs(current.zoom - last.zoom) < 0.0001 &&
        Math.abs(current.pan.x - last.pan.x) < 0.5 &&
        Math.abs(current.pan.y - last.pan.y) < 0.5);
    const insetChanged = fittedInsetRef.current !== canvasLeftInset;
    const fitKey = `${doc.id}:${fitToken}`;
    if (fittedDocRef.current === fitKey && !unchanged && !insetChanged) return;
    fittedDocRef.current = fitKey;
    fittedInsetRef.current = canvasLeftInset;
    if (doc.page.infinite) {
      // 无限画布：保持 100%，从露出区域中心开始浏览
      const visibleWidth = Math.max(80, size.width - canvasLeftInset);
      useAppStore.getState().setViewport({
        zoom: 1,
        pan: {
          x: Math.round(canvasLeftInset + visibleWidth / 2 - doc.page.width / 2),
          y: Math.round(size.height / 2 - doc.page.height / 2)
        }
      });
    } else {
      fitToCanvas(size, 56);
    }
    lastAutoFitRef.current = useAppStore.getState().viewport;
  }, [doc.id, fitToken, size, fitToCanvas, canvasLeftInset]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      // 底部工具横栏/缩放坞自己处理滚轮（横向浏览），不要再缩放画布。
      const target = event.target as HTMLElement | null;
      if (target?.closest('.mode-dock, .zoom-dock')) return;
      event.preventDefault();
      // 绘制/拖拽过程中禁止缩放：视口一变，进行中的笔迹坐标就会跳变。
      if (dragRef.current || panRef.current) return;
      const rect = element.getBoundingClientRect();
      // 单滚轮直接缩放；Ctrl/⌘ + 滚轮（触控板捏合）仍保持同一行为。
      const factor = Math.exp(-event.deltaY * 0.0016);
      zoomAt(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [zoomAt, panBy]);

  // 组件卸载时取消挂起的画笔预览帧，避免对已卸载组件 setState。
  useEffect(
    () => () => {
      if (brushRafRef.current !== null) {
        window.cancelAnimationFrame(brushRafRef.current);
        brushRafRef.current = null;
      }
    },
    []
  );

  // 尺寸 HUD：调整画笔/橡皮尺寸后短暂显示直径，避免只能靠光标环估算。
  useEffect(() => {
    if (activeTool !== 'brush' && activeTool !== 'eraser' && activeTool !== 'eraser-live') return;
    setSizeHud(true);
    const timer = window.setTimeout(() => setSizeHud(false), 900);
    return () => window.clearTimeout(timer);
  }, [activeTool, brushSize, eraserSize]);

  // 新建文本时同步横栏样式：编辑浮层与最终落字保持一致。
  useEffect(() => {
    if (!textEditor || textEditor.objectId) return;
    setTextEditor((current) => {
      if (!current || current.objectId) return current;
      const next = {
        ...current,
        fontSize: textSettings.fontSize,
        fontFamily: textSettings.fontFamily,
        fontWeight: textSettings.fontWeight,
        italic: textSettings.italic,
        letterSpacing: textSettings.letterSpacing,
        lineHeight: textSettings.lineHeight,
        direction: textSettings.direction
      };
      textEditorRef.current = next;
      return next;
    });
  }, [textSettings, textEditor?.objectId]);

  // 实时笔迹层同样只属于当前操作：切工具/换文档立即清空，避免残影。
  useEffect(() => {
    brushInkRef.current?.clear();
  }, [activeTool, doc.id]);

  // 钢笔草稿只属于"钢笔 + 当前文档"：切工具或换文档必须清理，避免残留草稿被 Enter 落笔。
  useEffect(() => {
    if (activeTool !== 'pen') setPenDraft(null);
  }, [activeTool]);

  useEffect(() => {
    setPenDraft(null);
  }, [doc.id]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(
        element &&
          (element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA' ||
            element.tagName === 'SELECT' ||
            element.isContentEditable)
      );
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isTypingTarget(event.target)) {
        event.preventDefault();
        setSpaceHeld(true);
      }
      if (penDraft) {
        if (event.key === 'Enter') {
          event.preventDefault();
          finishPen(false);
        } else if (event.key === 'Escape') {
          setPenDraft(null);
        } else if (event.key === 'Backspace' && !isTypingTarget(event.target)) {
          // 撤销上一个节点，不必整条重画。
          event.preventDefault();
          setPenDraft((draft) => {
            if (!draft) return draft;
            const nodes = draft.nodes.slice(0, -1);
            return nodes.length === 0 ? null : { ...draft, nodes };
          });
        }
      }
      if (event.key === 'Escape' && !textEditor && (dragRef.current || preview)) {
        cancelActiveOperation('已取消当前操作');
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    const handleBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  });

  useEffect(() => {
    if (!textEditor) return;
    const textarea = textAreaRef.current;
    if (!textarea) return;
    textCommitRef.current = false;
    const selectAll = textEditor.selectAll;
    // 只有新建文本才全选；编辑既有文本时把光标放到末尾，避免误替换全文。
    const focusEditor = () => {
      if (textAreaRef.current !== textarea) return;
      textarea.focus({ preventScroll: true });
      if (selectAll) {
        textarea.select();
      } else {
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      }
    };
    focusEditor();
    // pointerdown 的浏览器默认行为（把焦点交回 body）可能排在本次提交之后：
    // 再补一帧把焦点抢回来，否则刚弹出的文本框会立刻失焦并被 onBlur 静默关掉。
    const frame = window.requestAnimationFrame(focusEditor);
    return () => window.cancelAnimationFrame(frame);
  }, [textEditor?.session, textEditor?.selectAll]);

  // 工具切换：选中文字工具即弹出合成器；切到别的工具则收起（未确定的草稿不落字）。
  useEffect(() => {
    if (activeTool === 'text') {
      if (!textComposerRef.current) openTextComposer();
      return;
    }
    if (textComposerRef.current) closeTextComposer();
    // 只在工具真的变化时触发；openTextComposer 内部只读 ref 与 store，不参与依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, toolEpoch]);

  /** 画布中央的实时草稿：内容来自左侧输入框，格式来自右侧工具。 */
  const textDraftObject = useMemo(() => {
    if (!textComposer) return null;
    const layer = drawLayer(doc);
    if (!layer) return null;
    return buildTextObject(textComposer.text, textComposer.center, layer.id);
    // textSettings / defaultStyle 变化即重算，右侧工具才能实时改画布
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textComposer, textSettings, defaultStyle, doc]);

  const gridPaths = useMemo(() => {
    // 网格随缩放降级：屏幕间距小于 7px 时按 2× 逐级合并，避免摩尔纹。
    let step = Math.max(1, doc.grid.size);
    let guard = 0;
    while (step * zoom < 7 && guard < 12) {
      step *= 2;
      guard += 1;
    }
    const majorStep = step * Math.max(1, doc.grid.subdivisions);
    const minor: string[] = [];
    const major: string[] = [];
    for (let x = step; x < page.width; x += step) {
      (Math.abs(x % majorStep) < 0.001 ? major : minor).push(`M${x} 0V${page.height}`);
    }
    for (let y = step; y < page.height; y += step) {
      (Math.abs(y % majorStep) < 0.001 ? major : minor).push(`M0 ${y}H${page.width}`);
    }
    return { minor: minor.join(' '), major: major.join(' ') };
  }, [doc.grid.size, doc.grid.subdivisions, page.width, page.height, zoom]);

  // 网格反相：深色纸面用浅线，浅色纸面用深线；密度由上面的 zoom 降级控制。
  const gridStroke = useMemo(() => {
    const raw = page.background.replace('#', '');
    const hex = raw.length === 3 ? raw.split('').map((char) => char + char).join('') : raw;
    const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map((value) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    );
    const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    return luminance < 0.42
      ? { minor: 'rgba(255, 255, 255, 0.12)', major: 'rgba(255, 255, 255, 0.2)' }
      : { minor: '#eef1f6', major: '#e2e7ef' };
  }, [page.background]);

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const element = viewportRef.current;
    if (!element) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const pagePoint = (event: { clientX: number; clientY: number }) => {
    const state = useAppStore.getState();
    // 用场景组的实际屏幕矩阵反算页面坐标，避免 CSS 缩放、标尺偏移或高倍缩放时
    // 手动计算 pan/zoom 与真实渲染位置不一致。
    const matrix = sceneRef.current?.getScreenCTM();
    if (matrix) {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      return { x: point.x, y: point.y };
    }
    return toPagePoint(localPoint(event), state.viewport.pan, state.viewport.zoom);
  };

  function capture(event: ReactPointerEvent<HTMLDivElement>) {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 合成事件或指针已释放时忽略 */
    }
  }

  /** 双指手势：两指中点平移 + 指距缩放（触控板/触屏均可用）。 */
  function startTouchGesture() {
    const points = [...touchPointersRef.current.values()].slice(0, 2);
    if (points.length < 2) return;
    touchGestureRef.current = {
      dist: Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)),
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2
    };
  }

  function updateTouchGesture(): boolean {
    const points = [...touchPointersRef.current.values()].slice(0, 2);
    if (points.length < 2) return false;
    const dist = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
    const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    const previous = touchGestureRef.current;
    touchGestureRef.current = { dist, x: center.x, y: center.y };
    if (!previous) return true;
    const factor = dist / previous.dist;
    if (Math.abs(factor - 1) > 0.002) {
      zoomAt(factor, localPoint({ clientX: center.x, clientY: center.y }));
    }
    panBy(center.x - previous.x, center.y - previous.y);
    return true;
  }

  /** 第二指落下时静默取消进行中的笔迹（不进历史、不切工具）。 */
  function abortBrushStroke() {
    flushBrushFrame();
    const state = useAppStore.getState();
    if (dragRef.current?.mode === 'brush') state.endTransaction();
    dragRef.current = null;
    brushSamplesRef.current = [];
    brushProjectionRef.current = null;
    pendingCursorRef.current = null;
    setBrushPreview(null);
    brushInkRef.current?.clear();
  }

  /** 统一锁定守卫：先校验再落笔，避免"画完才报错"。 */
  function drawableLayerFor(action: string) {
    const state = useAppStore.getState();
    const layer = drawLayer(state.doc);
    if (!layer) {
      state.notify('没有可绘制的图层', 'warn');
      return null;
    }
    if (layer.locked) {
      state.notify(`「${layer.name}」已锁定，无法${action}`, 'warn');
      return null;
    }
    return layer;
  }

  /** 记录本次吸附方向，下一次按"迟滞"优先沿用，避免角平分线抖动。 */
  function noteGuideDir(drag: DragState, origin: Vec, target: Vec) {
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const length = Math.hypot(dx, dy);
    if (length > 0.01) drag.guideDir = { x: dx / length, y: dy / length };
  }

  /** 连续区域填充：拖拽经过的每个闭合区域都上色（每 40px 一次，避免逐像素重复计算）。 */
  function bucketRegionFillAt(point: Vec): boolean {
    const state = useAppStore.getState();
    if (state.bucketMode === 'stroke') return false;
    const fillColor =
      state.defaultStyle.fill.type === 'solid'
        ? state.defaultStyle.fill.color
        : state.defaultStyle.stroke.paint.type === 'solid'
          ? state.defaultStyle.stroke.paint.color
          : null;
    if (!fillColor) return false;
    const region = buildRegionFill(state.doc, point, {
      gap: state.bucketGap,
      expand: state.bucketExpand
    });
    if (!region) return false;
    const layer = drawableLayerFor('填充区域');
    if (!layer) return false;
    const style = cloneStyle(state.defaultStyle);
    style.fill = { type: 'solid', color: fillColor };
    style.stroke = { ...style.stroke, paint: { type: 'none' }, dash: [] };
    const path = createPathObject(
      layer.id,
      style,
      region.outline.map((node) => makeNode(node.x, node.y)),
      true
    );
    path.holes = region.holes;
    state.addObjects([path]);
    return true;
  }

  /** 对象所在图层是否锁定（用于编辑既有对象/批量改样式）。 */
  function objectLayerLocked(objectId: string): boolean {
    const state = useAppStore.getState();
    return Boolean(getLayerOfObject(state.doc, objectId)?.locked);
  }

  /** 从画布拾取颜色（取色工具与油漆桶 Alt 共用）。 */
  function pickColorAt(point: Vec): boolean {
    const state = useAppStore.getState();
    const hit = hitTestDocument(state.doc, point, 8 / state.viewport.zoom);
    if (!hit) {
      state.notify('该位置没有可拾取的颜色', 'warn');
      return false;
    }
    const fill = hit.style.fill.type === 'solid' ? hit.style.fill.color : null;
    const stroke = hit.style.stroke.paint.type === 'solid' ? hit.style.stroke.paint.color : null;
    const color = fill ?? stroke;
    if (!color) {
      state.notify('该对象没有可拾取的颜色', 'warn');
      return false;
    }
    state.setDefaultFill(color);
    state.notify(`已拾取颜色 ${color.toUpperCase()}`, 'success');
    return true;
  }

  function beginDrag(
    mode: DragMode,
    start: Vec,
    local: Vec,
    extra: Partial<DragState> = {}
  ) {
    const state = useAppStore.getState();
    // 新一次拖动开始：清掉上一次的吸附迟滞，避免旧候选把落点“粘”住。
    resetSnapHysteresis();
    dragRef.current = {
      mode,
      startPage: start,
      startScreen: local,
      startDoc: state.doc,
      selectionIds: state.selection,
      bounds: state.selection.length > 0 ? selectionBounds(state.doc, state.selection) : null,
      frame: state.selection.length > 0 ? selectionFrame(state.doc, state.selection) : null,
      handle: null,
      origin: start,
      ...extra
    };
  }

  /** 拖拽期只更新轻量 transform；同一 transform 不重复写 store。 */
  function applyTransformPreview(
    drag: DragState,
    transform: string,
    commit: NonNullable<DragState['preview']>['commit']
  ) {
    const ids = drag.preview?.ids ?? previewObjectIds(drag.startDoc, drag.selectionIds);
    if (!drag.preview) drag.preview = { ids, transform: '', commit };
    drag.preview.ids = ids;
    drag.preview.commit = commit;
    if (drag.preview.transform === transform) return;
    drag.preview.transform = transform;
    useAppStore.getState().setDragPreview({ ids, transform });
  }

  /** 抬手时把预览一次性落到文档；null 表示没有实际变换。 */
  function commitTransformDrag(drag: DragState): VDrawDocument | null {
    // resize 直接提交预览用的同一份文档，避免重算导致的跳变；
    // 但 sx/sy 均为 1 时不能提交（否则会压入一条无变化的撤销记录）。
    if (drag.mode === 'resize') {
      const scale = drag.previewScale;
      if (
        scale &&
        Math.abs(scale.sx - 1) < 1e-6 &&
        Math.abs(scale.sy - 1) < 1e-6
      ) {
        return null;
      }
      return drag.previewDoc ?? null;
    }
    const commit = drag.preview?.commit;
    if (!commit) return null;
    if (commit.kind === 'move') {
      if (Math.abs(commit.dx) < 1e-6 && Math.abs(commit.dy) < 1e-6) return null;
      return translateDocumentObjects(drag.startDoc, drag.selectionIds, commit.dx, commit.dy);
    }
    if (Math.abs(commit.delta) < 1e-6) return null;
    return rotateDocumentObjects(drag.startDoc, drag.selectionIds, commit.center, commit.delta);
  }

  function openTextEditor(state: Omit<TextEditorState, 'session'>) {
    const next = { ...state, session: (textSessionRef.current += 1) };
    textEditorRef.current = next;
    textCommitRef.current = false;
    textEditorToolRef.current = useAppStore.getState().activeTool;
    setTextEditor(next);
  }

  /** 编辑既有文本：带原始字体/旋转/尺寸，锁定图层直接拒绝。 */
  function openTextEditorForObject(object: TextObject) {
    if (objectLayerLocked(object.id)) {
      useAppStore.getState().notify('该文本所在图层已锁定，无法编辑', 'warn');
      return;
    }
    // 原地编辑优先：合成器让位，避免两个输入框同时抢焦点。
    if (textComposerRef.current) closeTextComposer();
    openTextEditor({
      objectId: object.id,
      page: { x: object.x, y: object.y },
      value: object.text,
      fontSize: object.fontSize,
      fontFamily: object.fontFamily,
      fontWeight: object.fontWeight,
      italic: object.italic,
      letterSpacing: object.letterSpacing ?? 0,
      lineHeight: object.lineHeight ?? 1.32,
      direction: object.direction ?? 'horizontal',
      color: object.style.fill.type === 'solid' ? object.style.fill.color : '#1b1b1b',
      align: object.align,
      rotation: object.rotation ?? 0,
      selectAll: false,
      boxWidth: object.width,
      boxHeight: object.height
    });
  }

  useEffect(() => {
    if (activeTool === 'text' || !textEditor) return;
    // 只有"真的换了工具"才收尾：双击/右键进入的编辑可能仍停留在选择工具上，
    // 直接按 activeTool !== 'text' 收尾会把文本框在同一帧里立刻提交关掉。
    if (activeTool === textEditorToolRef.current) return;
    // 切换到其他工具时，已有内容自动提交，空文本框直接关闭
    if (textEditor.value.trim()) {
      commitText();
    } else {
      textCommitRef.current = true;
      textEditorRef.current = null;
      setTextEditor(null);
      useAppStore.getState().endTransaction();
    }
  }, [activeTool, textEditor]);

  // 节点选择只对"节点工具 + 单条路径"有效；换工具/换对象时自动清空。
  useEffect(() => {
    const current = nodeSelectionRef.current;
    if (activeTool !== 'node' || selection.length !== 1) {
      if (current.length) applyNodeSelection([]);
      return;
    }
    const path = getObject(doc, selection[0]);
    if (path?.type !== 'path') {
      if (current.length) applyNodeSelection([]);
      return;
    }
    const next = current.filter((id) => path.nodes.some((node) => node.id === id));
    if (next.length !== current.length) applyNodeSelection(next);
  }, [activeTool, selection, doc]);

  // Delete/Backspace 删除选中的节点；capture 阶段截断，避免误删整条路径。
  useEffect(() => {
    if (activeTool !== 'node' || nodeSelection.length === 0) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const state = useAppStore.getState();
      if (state.selection.length !== 1) return;
      const path = getObject(state.doc, state.selection[0]);
      if (!path || path.type !== 'path') return;
      const selected = new Set(nodeSelection);
      const remaining = path.nodes.filter((node) => !selected.has(node.id));
      const minimum = path.closed ? 3 : 2;
      if (remaining.length < minimum) {
        state.notify(`至少保留 ${minimum} 个节点`, 'warn');
        return;
      }
      const next = curvePathWithNodes(path, remaining);
      state.updateDoc(replaceObject(state.doc, path.id, () => next), true);
      applyNodeSelection([]);
      state.notify(`已删除 ${path.nodes.length - remaining.length} 个节点`, 'info');
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [activeTool, nodeSelection]);

  // 横栏“确认/关闭”通过事件提交当前文本，避免仅收起面板而没有落字
  useEffect(() => {
    const handler = () => commitText();
    window.addEventListener('vdraw:commit-text', handler);
    return () => window.removeEventListener('vdraw:commit-text', handler);
  }, [textEditor]);

  // 横栏的上下标/项目符号按钮：把模板插入当前光标（选中内容替换 {} 占位）。
  useEffect(() => {
    const handler = (event: Event) => {
      const template = (event as CustomEvent<string>).detail ?? '';
      const current = textEditorRef.current;
      const element = textAreaRef.current;
      if (!current || !element) return;
      const start = element.selectionStart ?? current.value.length;
      const end = element.selectionEnd ?? start;
      const selected = current.value.slice(start, end);
      const inserted = template.replace('{}', selected || '');
      const value = current.value.slice(0, start) + inserted + current.value.slice(end);
      const next = { ...current, value };
      textEditorRef.current = next;
      setTextEditor(next);
      textCaretRef.current = start + inserted.length;
    };
    window.addEventListener('vdraw:insert-text', handler);
    return () => window.removeEventListener('vdraw:insert-text', handler);
  }, []);

  useEffect(() => {
    if (textCaretRef.current === null) return;
    const element = textAreaRef.current;
    const caret = textCaretRef.current;
    textCaretRef.current = null;
    if (!element) return;
    element.focus();
    element.setSelectionRange(caret, caret);
  }, [textEditor?.value]);

  // 横栏改字体/字号/字重等：正在输入的文本框要立刻呈现，别等提交才生效。
  useEffect(() => {
    type StylePatch = Partial<{
      fontFamily: string;
      fontSize: number;
      fontWeight: number;
      italic: boolean;
      color: string;
      align: 'left' | 'center' | 'right';
      letterSpacing: number;
      lineHeight: number;
      direction: 'horizontal' | 'vertical';
      maxWidth: number;
    }>;
    const handler = (event: Event) => {
      const patch = (event as CustomEvent<StylePatch>).detail;
      const current = textEditorRef.current;
      if (!patch || !current) return;
      const next: TextEditorState = {
        ...current,
        fontFamily: patch.fontFamily ?? current.fontFamily,
        fontSize: patch.fontSize ?? current.fontSize,
        fontWeight: patch.fontWeight ?? current.fontWeight,
        italic: patch.italic ?? current.italic,
        letterSpacing: patch.letterSpacing ?? current.letterSpacing,
        lineHeight: patch.lineHeight ?? current.lineHeight,
        direction: patch.direction ?? current.direction,
        color: patch.color ?? current.color,
        align: patch.align ?? current.align,
        boxWidth: patch.maxWidth ?? current.boxWidth
      };
      if (
        next.fontFamily === current.fontFamily &&
        next.fontSize === current.fontSize &&
        next.fontWeight === current.fontWeight &&
        next.italic === current.italic &&
        next.letterSpacing === current.letterSpacing &&
        next.lineHeight === current.lineHeight &&
        next.direction === current.direction &&
        next.color === current.color &&
        next.align === current.align &&
        next.boxWidth === current.boxWidth
      ) {
        return;
      }
      textEditorRef.current = next;
      setTextEditor(next);
    };
    window.addEventListener('vdraw:text-style', handler);
    return () => window.removeEventListener('vdraw:text-style', handler);
  }, []);

  // 文本工具只在画布点击时打开编辑器，避免工具一激活就在页面中心弹框。

  function commitText(session?: number) {
    const current = textEditorRef.current;
    if (!current) return;
    if (session !== undefined && current.session !== session) return;
    if (textCommitRef.current) return;
    textCommitRef.current = true;
    const editor = current;
    textEditorRef.current = null;
    setTextEditor(null);
    const value = editor.value;
    const state = useAppStore.getState();
    if (editor.objectId) {
      const obj = getObject(state.doc, editor.objectId);
      if (!obj || obj.type !== 'text') return;
      if (objectLayerLocked(obj.id)) {
        state.notify('该文本所在图层已锁定，未保存修改', 'warn');
        return;
      }
      // 清空内容 = 删除该文本对象（可撤销），否则用户无法把一段文字删干净。
      if (!value.trim()) {
        state.deleteSelection();
        return;
      }
      // 段落原文入库；换行只在测量/渲染阶段计算，收窄再放宽可以还原段落。
      const parsedText = parseTextScripts(value);
      const next = patchTextObject(obj, { text: parsedText });
      state.updateDoc(replaceObject(state.doc, obj.id, () => next), true);
      state.endTransaction();
      return;
    }
    if (!value.trim()) {
      state.endTransaction();
      return;
    }
    const layer = drawableLayerFor('创建文本');
    if (!layer) return;
    const style = cloneStyle(state.defaultStyle);
    style.stroke = { ...style.stroke, paint: { type: 'none' }, dash: [] };
    style.fill = { type: 'solid', color: textSettings.color };
    // 新建文本使用"提交时"的横栏设置：用户在输入过程中调字体/字号应立即生效。
    const object = createTextObject(
      layer.id,
      style,
      editor.page,
      value,
      textSettings.fontSize,
      {
        fontFamily: textSettings.fontFamily,
        fontWeight: textSettings.fontWeight,
        italic: textSettings.italic,
        align: textSettings.align,
        letterSpacing: textSettings.letterSpacing,
        direction: textSettings.direction,
        lineHeight: textSettings.lineHeight,
        maxWidth: textSettings.maxWidth
      }
    );
    addWithSymmetry([object]);
    state.endTransaction();
    // 保持文本工具选中，属性横栏持续可用，可连续添加文本
  }

  function cancelText() {
    textCommitRef.current = true;
    textEditorRef.current = null;
    setTextEditor(null);
    useAppStore.getState().endTransaction();
  }

  /* ---------------- 文字合成器（画布下方"输入 + 工具"双面板） ---------------- */

  function setComposer(next: { text: string; center: Vec } | null) {
    textComposerRef.current = next;
    setTextComposer(next);
    useAppStore.getState().setTextComposerOpen(Boolean(next));
  }

  /** 合成器落点：视口中心（即"画布中央"）。 */
  function viewportCenterPage(): Vec {
    const element = viewportRef.current;
    if (!element) return { x: page.width / 2, y: page.height / 2 };
    const rect = element.getBoundingClientRect();
    const inset = useAppStore.getState().canvasLeftInset;
    return pagePoint({
      clientX: rect.left + inset + (rect.width - inset) / 2,
      clientY: rect.top + rect.height / 2
    });
  }

  /** 草稿与落字共用同一条排版链路，保证"画布上看到的"就是最终结果。 */
  function buildTextObject(text: string, center: Vec, layerId: string): TextObject | null {
    const parsed = parseTextScripts(text);
    if (!parsed.trim()) return null;
    const state = useAppStore.getState();
    const settings = state.textSettings;
    const style = cloneStyle(state.defaultStyle);
    style.stroke = { ...style.stroke, paint: { type: 'none' }, dash: [] };
    style.fill = { type: 'solid', color: settings.color };
    const created = createTextObject(layerId, style, { x: center.x, y: center.y }, parsed, settings.fontSize, {
      fontFamily: settings.fontFamily,
      fontWeight: settings.fontWeight,
      italic: settings.italic,
      align: settings.align,
      letterSpacing: settings.letterSpacing,
      direction: settings.direction,
      lineHeight: settings.lineHeight,
      maxWidth: settings.maxWidth
    });
    const measured = patchTextObject(created, {});
    // 居中对齐也要按包围盒居中：左/右对齐时锚点不同，直接套 center 会偏。
    return {
      ...measured,
      x: measured.x + (center.x - (measured.x + measured.width / 2)),
      y: measured.y + (center.y - (measured.y + measured.height / 2))
    };
  }

  function openTextComposer() {
    if (textComposerRef.current) return;
    if (!drawableLayerFor('创建文本')) return;
    setComposer({ text: '', center: viewportCenterPage() });
  }

  function closeTextComposer() {
    if (!textComposerRef.current) return;
    setComposer(null);
  }

  function confirmTextComposer() {
    const draft = textComposerRef.current;
    const state = useAppStore.getState();
    const layer = drawLayer(state.doc);
    setComposer(null);
    if (!draft) return;
    const object = layer ? buildTextObject(draft.text, draft.center, layer.id) : null;
    if (!object) {
      state.notify('请先输入文字内容', 'info');
      return;
    }
    addWithSymmetry([object]);
    state.setSelection([object.id]);
    // 落字后直接进选择工具：确定即可拖动/缩放/旋转，点画布其他区域收尾。
    state.setTool('select');
  }

  function finishPen(closed: boolean) {
    const draft = penDraft;
    setPenDraft(null);
    if (!draft) return;
    const state = useAppStore.getState();
    if (draft.nodes.length < 2) {
      // 只有一个节点时给出明确提示，而不是静默丢弃。
      state.notify('至少需要两个节点才能生成路径', 'info');
      return;
    }
    const layer = drawableLayerFor('创建路径');
    if (!layer) return;
    const style = cloneStyle(state.defaultStyle);
    if (!closed) style.fill = { type: 'none' };
    const path = createPathObject(layer.id, style, draft.nodes, closed);
    addWithSymmetry([path]);
  }

  function handlePenDown(point: Vec, options: { alt: boolean; shift: boolean }) {
    const draft = penDraft;
    if (draft && draft.nodes.length >= 2) {
      const first = draft.nodes[0];
      if (Math.hypot(point.x - first.x, point.y - first.y) <= 11 / zoom) {
        finishPen(true);
        return;
      }
    }
    // 落笔前校验锁定，避免画完整条后才丢草稿。
    if (!drawableLayerFor('创建路径')) return;
    const state = useAppStore.getState();
    // 端点接续优先于网格吸附：点击已有路径端点即可从那里继续。
    const endpoint = draft ? null : findPathEndpoint(state.doc, point, 8 / zoom);
    const snapped =
      endpoint ?? gridPoint(point, state.doc, state.snapEnabled && !options.alt, false);
    const last = draft?.nodes[draft.nodes.length - 1];
    let target = snapped;
    if (options.shift && last) {
      // Shift：与上一节点保持 45° 整数倍方向。
      const dx = snapped.x - last.x;
      const dy = snapped.y - last.y;
      const length = Math.hypot(dx, dy);
      if (length > 0.5) {
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        target = { x: last.x + Math.cos(angle) * length, y: last.y + Math.sin(angle) * length };
      }
    }
    // 钢笔节点同样沿辅助线方向（从上一节点出发）。
    if (guideAssist && guideMode !== 'none' && last) {
      target = snapToGuideDirection(
        last,
        target,
        guideMode,
        guideSettings,
        page.width,
        page.height
      );
    }
    // 双击/重复点击不产生零长段。
    if (last && Math.hypot(target.x - last.x, target.y - last.y) < 0.5) return;
    const node = makeNode(target.x, target.y);
    setPenDraft({ nodes: [...(draft?.nodes ?? []), node], cursor: target });
    beginDrag('pen-handle', target, localPoint({ clientX: 0, clientY: 0 }), {
      nodeId: node.id
    });
  }

  function addAtomAt(point: Vec) {
    const state = useAppStore.getState();
    const layer = drawLayer(state.doc);
    if (!layer || layer.locked) {
      state.notify('当前图层已锁定，无法添加原子', 'warn');
      return;
    }
    const preset =
      ATOM_PRESETS.find((item) => item.id === state.chem.atomPresetId) ?? ATOM_PRESETS[0];
    const label = atomLabelFromChem(state.chem);
    // 吸附到最近的原子或键端点，保证标签与化学键严格对齐
    const anchor = snapAnchor(state.doc, point);
    const anchorScale = chemAnchorScale(anchor);

    // 官能团（OH / NH₂ / COOH…）与氢原子作为取代基挂接，绝不替换环骨架原子。
    // SUP 里 smiles 不含 `*` 的整分子不可挂键（对齐 KingDraw 的 isRHave=0），只能独立放置。
    const supInfo = preset.kind === 'group' ? supEntryOf(preset.id) : null;
    const attachable = preset.element === 'H' || !supInfo || Boolean(supInfo.anchor);
    if ((preset.kind === 'group' || preset.element === 'H') && anchor && attachable) {
      if (anchor.atom && anchor.atom.label.group === preset.display) {
        state.notify('该原子已连接相同基团', 'info');
        return;
      }
      if (preset.element === 'H' && anchor.atom?.label.element === 'H') {
        state.notify('该位置已有氢原子', 'info');
        return;
      }
      const geometry = nextChainBond(
        state.doc,
        anchor,
        null,
        1,
        state.chemBondLength * anchorScale
      );
      if (!geometry) {
        state.notify(
          `${anchor.element} 原子已无剩余化合价，无法连接${preset.display}`,
          'warn'
        );
        return;
      }
      if (bondExistsBetween(state.doc, geometry.start, geometry.end)) {
        state.notify('该位置已存在化学键', 'warn');
        return;
      }
      const bond = makeChemBond(
        layer.id,
        geometry.start,
        geometry.end,
        'single',
        anchorScale
      );
      const atom = makeChemAtom(
        layer.id,
        geometry.end,
        label,
        anchorScale,
        state.chemAtomSize
      );
      if (anchor.group) {
        const attached = attachObjectsToGroup(state.doc, anchor.group.id, [bond, atom]);
        if (attached) {
          state.updateDoc(attached, true);
          addMirrorsOnly([bond, atom]);
          state.setSelection([atom.id]);
          return;
        }
      }
      addWithSymmetry([bond, atom]);
      return;
    }

    const target = anchor ? anchor.point : gridPoint(point, state.doc, state.snapEnabled, false);
    const existing = findAtomAt(state.doc, target, 6);
    if (existing) {
      // 重贴标签只改"元素/基团"身份；电荷/同位素/孤对属于用户已录入的化学语义，必须保留。
      // 氢数则必须跟着新元素走：旧实现原样保留，O→N 会留下 OH 的 1 个氢。
      // 约定：null = 未标注氢（继续不显示）；数值 = 按新元素价态首次适配重算。
      const bondSum = buildChemGraph(state.doc).bondSumOf(existing.id);
      const derived =
        existing.explicitH != null
          ? null
          : deriveHydrogens(label.element, label.charge, bondSum);
      const nextHydrogens =
        existing.explicitH != null
          ? existing.label.hydrogens
          : existing.label.hydrogens === null
            ? null
            : derived?.hydrogens ?? existing.label.hydrogens;
      state.updateDoc(
        replaceObject(state.doc, existing.id, (obj) =>
          obj.type === 'atom'
            ? {
                ...obj,
                label: {
                  ...label,
                  charge: existing.label.charge,
                  isotope: existing.label.isotope,
                  radical: existing.label.radical,
                  lonePairs: existing.label.lonePairs,
                  hydrogens: nextHydrogens,
                  fontSize: existing.label.fontSize
                }
              }
            : obj
        ),
        true
      );
      state.setSelection([existing.id]);
      return;
    }
    const atom = makeChemAtom(
      layer.id,
      target,
      label,
      anchorScale,
      state.chemAtomSize
    );
    if (anchor?.group) {
      // 环上的原子标签并入环编组，移动环时标签跟随
      const attached = attachObjectsToGroup(state.doc, anchor.group.id, [atom]);
      if (attached) {
        state.updateDoc(attached, true);
        addMirrorsOnly([atom]);
        state.setSelection([atom.id]);
        return;
      }
    }
    addWithSymmetry([atom]);
  }

  function addWithSymmetry(objects: SceneObject[]) {
    const state = useAppStore.getState();
    const mirrored =
      state.symmetry === 'none' ? [] : mirrorObjectsForState(state, objects, objects);
    state.addObjects([...objects, ...mirrored]);
  }

  /** 只添加镜像副本（用于已挂接/已入组的对象）。 */
  function addMirrorsOnly(objects: SceneObject[]) {
    const state = useAppStore.getState();
    if (state.symmetry === 'none') return;
    const mirrored = mirrorObjectsForState(state, objects);
    if (mirrored.length > 0) state.addObjects(mirrored);
  }

  /** 编组对象走整组镜像，普通对象逐个镜像。 */
  function mirrorObjectsForState(
    state: ReturnType<typeof useAppStore.getState>,
    objects: SceneObject[],
    pool: SceneObject[] = allObjects(state.doc)
  ): SceneObject[] {
    const extra: SceneObject[] = [];
    const { width, height } = state.doc.page;
    for (const object of objects) {
      if (object.type === 'group') {
        const children = pool.filter((child) => child.parentId === object.id);
        const groups = mirrorGroupWithChildren(
          object,
          children,
          state.symmetryAxis,
          state.symmetry,
          width,
          height
        );
        for (const item of groups) extra.push(item.group, ...item.children);
      } else {
        extra.push(
          ...mirrorObject(object, state.symmetryAxis, state.symmetry, width, height)
        );
      }
    }
    return extra;
  }

  function insertRing(
    center: Vec,
    options: {
      rotation?: number;
      snap?: boolean;
      attachGroupId?: string;
      anchorPoint?: Vec;
    } = {}
  ) {
    const state = useAppStore.getState();
    const template = RING_TEMPLATES.find((item) => item.id === state.chem.ringTemplateId);
    const layer = drawLayer(state.doc);
    if (!template) return;
    if (!layer || layer.locked) {
      state.notify('当前图层已锁定，无法插入环系', 'warn');
      return;
    }
    const snappedCenter =
      options.snap === false ? center : gridPoint(center, state.doc, state.snapEnabled, false);
    const scale = state.chemBondLength * Math.max(0.5, Math.min(2, state.chem.ringScale ?? 1));
    const rotation = options.rotation ?? 0;
    const points = template.atoms.map((atom) => {
      const rotated = rotateVector({ x: atom.x * scale, y: atom.y * scale }, rotation);
      return {
        x: snappedCenter.x + rotated.x,
        y: snappedCenter.y + rotated.y
      };
    });
    const isBenzene = template.id === 'benzene';
    const benzeneStyle = state.chem.benzeneStyle;
    const overrideTypes = isBenzene ? benzeneBondTypes(benzeneStyle) : null;
    const baseGroup = createGroupObject(layer.id, template.name, { x: 0, y: 0, width: 0, height: 0 }, []);
    const group: GroupObject = {
      ...baseGroup,
      ringFrame: true,
      ...(isBenzene
        ? { style: cloneStyle(chemGroupStyle()), ringStyle: benzeneStyle }
        : {})
    };
    const children: SceneObject[] = [];
    template.bonds.forEach((bond, index) => {
      const start = points[bond.a];
      const end = points[bond.b];
      const normal = { x: -(end.y - start.y), y: end.x - start.x };
      const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const side =
        normal.x * (snappedCenter.x - midpoint.x) + normal.y * (snappedCenter.y - midpoint.y) >= 0
          ? 1
          : -1;
      const bondType = overrideTypes?.[index] ?? bond.type;
      children.push({
        ...makeChemBond(
          layer.id,
          start,
          end,
          bondType,
          1,
          isBenzene ? undefined : side
        ),
        parentId: group.id,
        ringInnerSide: isBenzene && bondType === 'double' ? side : undefined
      });
    });
    template.atoms.forEach((atom, index) => {
      if (!atom.label) return;
      children.push({
        ...makeChemAtom(
          layer.id,
          points[index],
          emptyAtomLabel(atom.label),
          1,
          state.chemAtomSize
        ),
        parentId: group.id
      });
    });
    if (options.anchorPoint) {
      const carbonIndex = (() => {
        const index = template.atoms.findIndex((atom) => !atom.label);
        return index >= 0 ? index : 0;
      })();
      children.push({
        ...makeChemBond(
          layer.id,
          options.anchorPoint,
          points[carbonIndex],
          'single',
          1
        ),
        parentId: group.id
      });
    }
    const bounds = boundsOfPoints(
      options.anchorPoint ? [...points, options.anchorPoint] : points,
      16
    );
    const groupWithBounds: GroupObject = {
      ...group,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      childIds: children.map((child) => child.id)
    };
    if (options.attachGroupId) {
      const attached = attachObjectsToGroup(state.doc, options.attachGroupId, [
        groupWithBounds
      ]);
      if (attached) {
        const layerId = groupWithBounds.layerId;
        const attachedWithChildren: VDrawDocument = {
          ...attached,
          layers: attached.layers.map((item) =>
            item.id === layerId ? { ...item, objects: [...item.objects, ...children] } : item
          )
        };
        state.updateDoc(attachedWithChildren, true);
        // 挂接的环不经过 addWithSymmetry，这里补镜像，避免"对称开启但只长出一侧"。
        if (state.symmetry !== 'none') {
          const pool = allObjects(attachedWithChildren);
          const mirrors = mirrorObjectsForState(state, [groupWithBounds], pool);
          if (mirrors.length > 0) state.addObjects(mirrors);
        }
        state.setSelection([groupWithBounds.id]);
        state.notify(`已连接${template.name}`, 'success');
        return;
      }
    }
    const mirroredRings =
      state.symmetry === 'none'
        ? []
        : mirrorGroupWithChildren(
            groupWithBounds,
            children,
            state.symmetryAxis,
            state.symmetry,
            page.width,
            page.height
          );
    const objects: SceneObject[] = [...children, groupWithBounds];
    for (const ring of mirroredRings) objects.push(...ring.children, ring.group);
    state.addObjects(objects);
  }

  /**
   * 并环：第二个及后续苯环复用被点击的环键作为公共边，只新增其余 5 条键。
   * 第一次并环把旧苯环包进“萘环”外层；后续三环、四环直接扩展到同一外层，
   * 避免一级一级嵌套，移动/选择/图层列表仍保持一个稠环体系。
   */
  function insertFusedBenzene(fused: FusedBenzeneTarget) {
    const state = useAppStore.getState();
    const template = RING_TEMPLATES.find((item) => item.id === 'benzene');
    const layer = getLayerOfObject(state.doc, fused.root.id);
    if (!template) return;
    if (!layer || layer.locked) {
      state.notify('当前图层已锁定，无法插入环系', 'warn');
      return;
    }
    const points = template.atoms.map((atom) => {
      const rotated = rotateVector({ x: atom.x * 40, y: atom.y * 40 }, fused.rotation);
      return { x: fused.center.x + rotated.x, y: fused.center.y + rotated.y };
    });
    const pauling = state.chem.benzeneStyle === 'pauling';
    const bondTypes = template.bonds.map((_, index) => {
      if (pauling) return 'single' as const;
      // 两个苯环共用一条边后，萘环总共只有 5 条双键；
      // 新环固定画 2 条，公共边原有的键级保留为第 5 条（或单键）。
      const double = index === 2 || index === 4;
      return double ? ('double' as const) : ('single' as const);
    });
    const newChildren: SceneObject[] = [];
    // 0 号边就是被点击的公共边，不再重复创建。
    for (let index = 1; index < template.bonds.length; index += 1) {
      const edge = template.bonds[index];
      const start = points[edge.a];
      const end = points[edge.b];
      const normal = { x: -(end.y - start.y), y: end.x - start.x };
      const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const side =
        normal.x * (fused.center.x - midpoint.x) + normal.y * (fused.center.y - midpoint.y) >= 0
          ? 1
          : -1;
      const bondType = bondTypes[index];
      newChildren.push({
        ...makeChemBond(layer.id, start, end, bondType, 1),
        parentId: '',
        ringInnerSide: bondType === 'double' ? side : undefined
      });
    }
    const newBounds = boundsOfPoints(points, 16);
    const oldBounds = getObjectBounds(fused.root, state.doc);
    const left = Math.min(oldBounds.x, newBounds.x);
    const top = Math.min(oldBounds.y, newBounds.y);
    const right = Math.max(oldBounds.x + oldBounds.width, newBounds.x + newBounds.width);
    const bottom = Math.max(oldBounds.y + oldBounds.height, newBounds.y + newBounds.height);
    const name =
      fused.ringCount === 2
        ? '萘环'
        : fused.ringCount === 3
          ? '三环芳烃'
          : fused.ringCount === 4
            ? '四环芳烃'
            : '多环芳烃';
    const nextIds = newChildren.map((child) => child.id);

    if (fused.makeOuter) {
      const baseGroup = createGroupObject(
        layer.id,
        name,
        { x: left, y: top, width: right - left, height: bottom - top },
        []
      );
      const fusedGroup: GroupObject = {
        ...baseGroup,
        ringFrame: true,
        style: cloneStyle(CHEM_GROUP_STYLE),
        // 圆心同时用于“点环内部选中稠环”，因此凯库勒式也保留。
        ringCenters: [fused.baseCenter, fused.center],
        ringCircleStyle: pauling ? 'pauling' : undefined,
        childIds: [fused.root.id, ...nextIds]
      };
      for (const child of newChildren) child.parentId = fusedGroup.id;
      let next = replaceObject(state.doc, fused.root.id, (obj) => ({
        ...obj,
        parentId: fusedGroup.id,
        // 内圈统一由外层按圆心绘制，避免旧苯环重复画一个圆。
        ringStyle: undefined
      }));
      next = addObjectsToLayer(next, layer.id, [...newChildren, fusedGroup]);
      state.updateDoc(next, true);
      state.setSelection([fusedGroup.id]);
      state.notify('已通过共用键连接苯环', 'success');
      return;
    }

    // 三环/四环：直接把 5 条新键挂到现有稠环外层，不再生成新的父编组。
    for (const child of newChildren) child.parentId = fused.root.id;
    const updatedRoot: GroupObject = {
      ...fused.root,
      name,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      ringCenters: [...(fused.root.ringCenters ?? []), fused.center],
      childIds: [...fused.root.childIds, ...nextIds]
    };
    let next = replaceObject(state.doc, fused.root.id, () => updatedRoot);
    next = addObjectsToLayer(next, layer.id, newChildren);
    state.updateDoc(next, true);
    state.setSelection([fused.root.id]);
    state.notify(`已连接第 ${fused.ringCount} 个苯环`, 'success');
  }

  /** 同步节点选择到 ref：同一帧内的连续 Shift 点击也不会丢选择。 */
  function applyNodeSelection(ids: string[]) {
    nodeSelectionRef.current = ids;
    setNodeSelection(ids);
  }

  function startNodeDrag(
    path: PathObject,
    part: 'node' | 'in' | 'out',
    nodeId: string,
    point: Vec,
    local: Vec,
    nodeIds?: string[]
  ) {
    const state = useAppStore.getState();
    if (part !== 'node') applyNodeSelection([nodeId]);
    state.beginTransaction();
    beginDrag('node', point, local, {
      pathId: path.id,
      nodeId,
      nodePart: part,
      nodeIds: nodeIds ?? [nodeId],
      handle: null,
      selectionIds: [path.id]
    });
    dragRef.current!.handle = null;
  }

  /** Alt 点击节点：在尖角与平滑之间切换（平滑时按前后节点重新生成对称手柄）。 */
  function toggleNodeSmooth(path: PathObject, nodeId: string) {
    const state = useAppStore.getState();
    const index = path.nodes.findIndex((node) => node.id === nodeId);
    if (index < 0) return;
    const nodes = path.nodes.map((node, itemIndex) => {
      if (itemIndex !== index) return node;
      if (node.type === 'smooth') {
        return { ...node, type: 'corner' as const, handleIn: null, handleOut: null, handleLocked: true };
      }
      const prev = path.nodes[itemIndex - 1] ?? (path.closed ? path.nodes[path.nodes.length - 1] : null);
      const next = path.nodes[itemIndex + 1] ?? (path.closed ? path.nodes[0] : null);
      if (!prev || !next) return { ...node, type: 'smooth' as const };
      const tangent = { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 };
      return {
        ...node,
        type: 'smooth' as const,
        handleIn: { x: -tangent.x, y: -tangent.y },
        handleOut: tangent,
        handleLocked: false
      };
    });
    state.updateDoc(
      replaceObject(state.doc, path.id, () => curvePathWithNodes(path, nodes)),
      true
    );
    state.setSelection([path.id]);
    state.notify(nodes[index].type === 'smooth' ? '节点已平滑' : '节点已改为尖角', 'info');
  }

  function updateDrag(point: Vec, shift: boolean, alt: boolean) {
    const drag = dragRef.current;
    if (!drag) return;
    const state = useAppStore.getState();
    const currentZoom = state.viewport.zoom;

    if (drag.mode === 'move') {
      const rawDx = point.x - drag.startPage.x;
      const rawDy = point.y - drag.startPage.y;
      // 单击也会触发一次 pointerup；不要让它被吸附成 3–11px 的静默位移。
      if (Math.hypot(rawDx, rawDy) < 2) {
        setGuides({ x: [], y: [] });
        applyTransformPreview(drag, translatePreviewTransform(0, 0), {
          kind: 'move',
          dx: 0,
          dy: 0
        });
        return;
      }
      const snapped = snapMove(
        drag.startDoc,
        drag.selectionIds,
        drag.bounds,
        rawDx,
        rawDy,
        currentZoom,
        state.snapEnabled,
        alt
      );
      setGuides(snapped.guides);
      // 移动是刚体平移：拖拽期只改 SVG transform，文档与历史完全不动。
      applyTransformPreview(drag, translatePreviewTransform(snapped.dx, snapped.dy), {
        kind: 'move',
        dx: snapped.dx,
        dy: snapped.dy
      });
      return;
    }

    if (drag.mode === 'resize' && drag.frame && drag.handle) {
      const frame = drag.frame;
      const bounds = frame.bounds;
      const handle = drag.handle;
      // 旋转后的对象：先把指针换算回选中框本地坐标，缩放方向才与选框一致
      const local = frame.rotation
        ? rotatePoint(point, frame.center, -frame.rotation)
        : point;
      // Alt 用于"从中心缩放"，因此缩放期间不再承担"临时关闭吸附"。
      const snapped = snapResizePoint(
        local,
        handle,
        state.doc,
        currentZoom,
        state.snapEnabled,
        false,
        drag.selectionIds
      );
      setGuides(snapped.guides);
      const target = snapped.point;
      const hasW = handle.includes('w');
      const hasE = handle.includes('e');
      const hasN = handle.includes('n');
      const hasS = handle.includes('s');
      // 锚点在本地盒里算，再换算到页面坐标交给缩放（旋转后直接传本地值会漂移）。
      const cornerAnchor = frameLocalToWorld(frame, {
        x: hasW ? bounds.x + bounds.width : bounds.x,
        y: hasN ? bounds.y + bounds.height : bounds.y
      });
      const anchor = alt ? frame.center : cornerAnchor;
      let sx = alt
        ? hasE || hasW
          ? Math.max(0.02, (Math.abs(target.x - frame.center.x) * 2) / Math.max(1, bounds.width))
          : 1
        : hasE
          ? Math.max(0.02, (target.x - bounds.x) / Math.max(1, bounds.width))
          : hasW
            ? Math.max(0.02, (anchor.x - target.x) / Math.max(1, bounds.width))
            : 1;
      let sy = alt
        ? hasN || hasS
          ? Math.max(0.02, (Math.abs(target.y - frame.center.y) * 2) / Math.max(1, bounds.height))
          : 1
        : hasS
          ? Math.max(0.02, (target.y - bounds.y) / Math.max(1, bounds.height))
          : hasN
            ? Math.max(0.02, (anchor.y - target.y) / Math.max(1, bounds.height))
            : 1;
      // 角手柄始终等比缩放：长宽共用变化更大的轴作为统一因子，锚点不变。
      // 边手柄仍只改一个方向，保留自由拉伸。
      if ((hasE || hasW) && (hasN || hasS)) {
        const uniform = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
        sx = uniform;
        sy = uniform;
      }
      // 缩放不是单一仿射：提交会分别改变包围盒 / 字号 / 笔迹节点宽度。
      // 因此拖拽期把「提交用的那一份文档」直接放进轻量预览状态，
      // 不写 doc / 历史 / isDirty；抬手时提交同一份，预览与结果零跳变。
      const key = `${sx.toFixed(4)}|${sy.toFixed(4)}|${anchor.x.toFixed(3)}|${anchor.y.toFixed(3)}`;
      if (drag.previewKey === key && drag.previewDoc) return;
      drag.previewKey = key;
      drag.previewScale = { sx, sy };
      const previewDoc = scaleDocumentObjectsInFrame(
        drag.startDoc,
        drag.selectionIds,
        frame,
        anchor,
        sx,
        sy
      );
      drag.previewDoc = previewDoc;
      const ids = previewObjectIds(drag.startDoc, drag.selectionIds);
      state.setDragPreview({ ids, doc: previewDoc });
      return;
    }

    if (drag.mode === 'rotate' && drag.frame) {
      const center = drag.frame.center;
      const startAngle = Math.atan2(drag.startPage.y - center.y, drag.startPage.x - center.x);
      const currentAngle = Math.atan2(point.y - center.y, point.x - center.x);
      let delta = ((currentAngle - startAngle) * 180) / Math.PI;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      // 旋转默认自由；只有按住 Shift 才按 15° 步进（吸附开关只管移动/缩放）。
      const shouldSnapAngle = shift;
      if (shouldSnapAngle) {
        delta = Math.round(delta / 15) * 15;
        // 旋转吸附时显示参考线，并裁剪在画布边界内
        const angle = startAngle + (delta * Math.PI) / 180;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        let rayLength = Number.POSITIVE_INFINITY;
        if (dx > 0) rayLength = Math.min(rayLength, (page.width - center.x) / dx);
        if (dx < 0) rayLength = Math.min(rayLength, -center.x / dx);
        if (dy > 0) rayLength = Math.min(rayLength, (page.height - center.y) / dy);
        if (dy < 0) rayLength = Math.min(rayLength, -center.y / dy);
        const reach = Number.isFinite(rayLength)
          ? Math.max(0, rayLength)
          : Math.hypot(page.width, page.height);
        const end = {
          x: Math.min(page.width, Math.max(0, center.x + dx * reach)),
          y: Math.min(page.height, Math.max(0, center.y + dy * reach))
        };
        setGuides({
          x: [],
          y: [],
          lines: [{ x1: center.x, y1: center.y, x2: end.x, y2: end.y }]
        });
      } else {
        setGuides({ x: [], y: [] });
      }
      // 旋转同样是刚体变换，可以用 transform 精确预览。
      applyTransformPreview(drag, rotatePreviewTransform(delta, center), {
        kind: 'rotate',
        center,
        delta
      });
      return;
    }

    if (drag.mode === 'node' && drag.pathId && drag.nodeId) {
      const path = getObject(drag.startDoc, drag.pathId);
      if (!path || path.type !== 'path') return;
      const primary = path.nodes.find((item) => item.id === drag.nodeId);
      if (!primary) return;
      const target = gridPoint(point, state.doc, state.snapEnabled, alt);
      if (drag.nodePart === 'node') {
        // 多选节点：以主节点吸附后的位移为基准，所有选中节点同步平移。
        const ids = new Set(drag.nodeIds?.length ? drag.nodeIds : [drag.nodeId]);
        const dx = target.x - primary.x;
        const dy = target.y - primary.y;
        const nodes = path.nodes.map((item) =>
          ids.has(item.id) ? { ...item, x: item.x + dx, y: item.y + dy } : item
        );
        state.updateDoc(replaceObject(state.doc, path.id, () => ({ ...path, nodes })), false);
        return;
      }
      // 拖控制柄：只改该节点的一侧，另一侧保持不动并锁定自动平滑。
      const handle = { x: target.x - primary.x, y: target.y - primary.y };
      const nodes = path.nodes.map((item) =>
        item.id === drag.nodeId
          ? drag.nodePart === 'in'
            ? { ...item, handleIn: handle, handleLocked: true }
            : { ...item, handleOut: handle, handleLocked: true }
          : item
      );
      state.updateDoc(replaceObject(state.doc, path.id, () => ({ ...path, nodes })), false);
      return;
    }

    if (drag.mode === 'curve' && drag.pathId) {
      const path = getObject(state.doc, drag.pathId);
      if (!path || path.type !== 'path' || !drag.nodeId) return;
      const localTarget = curveLocalPoint(path, point);
      const baseNodes = drag.curveNodes ?? path.nodes;
      const index =
        drag.nodeIndex ?? baseNodes.findIndex((node) => node.id === drag.nodeId);
      if (index < 0) return;
      const grab = drag.curveGrab ?? { x: 0, y: 0 };
      let tx = localTarget.x + grab.x;
      let ty = localTarget.y + grab.y;
      if (shift) {
        // Shift：把节点镜像到前后节点连线的另一侧，形成反向弯曲。
        const prev =
          baseNodes[index - 1] ?? (path.closed ? baseNodes[baseNodes.length - 1] : null);
        const nextNode =
          baseNodes[index + 1] ?? (path.closed ? baseNodes[0] : null);
        if (prev && nextNode) {
          const dx = nextNode.x - prev.x;
          const dy = nextNode.y - prev.y;
          const lengthSq = dx * dx + dy * dy;
          if (lengthSq > 0.01) {
            const t = ((tx - prev.x) * dx + (ty - prev.y) * dy) / lengthSq;
            const projection = { x: prev.x + t * dx, y: prev.y + t * dy };
            tx = 2 * projection.x - tx;
            ty = 2 * projection.y - ty;
          }
        }
      }
      const nodes = baseNodes.map((node) =>
        node.id === drag.nodeId ? { ...node, x: tx, y: ty } : node
      );
      const affected = new Set(
        [index - 1, index, index + 1].filter((item) => item >= 0 && item < nodes.length)
      );
      const next = curvePathWithNodes(path, smoothCurveNodes(nodes, affected));
      state.updateDoc(replaceObject(state.doc, path.id, () => next), false);
      return;
    }

    if (drag.mode === 'create') {
      const layer = drawLayer(state.doc);
      const snap = shapeSnapInfo(point, state.doc, state.snapEnabled, alt);
      setSnapHint(snap);
      const snapped = snap?.point ?? point;
      // 多边形同样沿辅助线方向；化学键保持键角/价态规则，不参与透视约束。
      const guided =
        guideAssist && guideMode !== 'none' && state.activeTool === 'polygon'
          ? snapToGuideDirection(
              drag.origin,
              snapped,
              guideMode,
              guideSettings,
              page.width,
              page.height
            )
          : snapped;
      // 端点吸附：直线/曲线终点贴近已有端点时对齐；辅助线模式下让位给方向约束。
      const endpoint =
        (state.activeTool === 'line' || state.activeTool === 'curve') &&
        !alt &&
        !(guideAssist && guideMode !== 'none')
          ? snapToObjectEndpoint(state.doc, guided, 8 / currentZoom)
          : null;
      const target = endpoint ?? guided;
      const shape = layer
        ? shapeFromDrag(
            state.activeTool,
            drag.origin,
            target,
            layer.id,
            cloneStyle(state.defaultStyle),
            {
              shift,
              cornerRadius: state.cornerRadius,
              sides: state.polygonSides,
              star: state.polygonStar,
              fromCenter: state.shapeFromCenter,
              arrowEnd: state.lineArrowEnd
            }
          )
        : null;
      setPreview(shape);
      return;
    }

    if (drag.mode === 'bond' || drag.mode === 'arrow') {
      const layer = drawLayer(state.doc);
      if (!layer) return;
      const tolerance = 11 / currentZoom;
      const startAnchor =
        drag.mode === 'bond'
          ? snapAnchor(state.doc, drag.origin, 'drag')
          : null;
      const startScale = chemAnchorScale(startAnchor);
      const baseLength = state.chemBondLength * startScale;
      const rawDistance = Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y);
      const preferred = { x: point.x - drag.origin.x, y: point.y - drag.origin.y };
      let end = findConnection(state.doc, point, tolerance) ?? point;
      if (end === point) {
        if (state.snapEnabled && !alt) {
          end = gridPoint(end, state.doc, true, false);
        }
        if (drag.mode === 'bond' && startAnchor && !shift) {
          // 从已有结构延伸时先按价层/杂化选择规范方向，再套用长度规则：
          // 预览和落笔共用同一方向，避免松手后键突然跳到另一个角度。
          const plannedOrder = Math.max(
            1,
            Math.min(bondOrderForType(state.chem.bondType), maxNewBondOrderForAnchor(startAnchor))
          );
          const geometry = nextChainBond(
            state.doc,
            startAnchor,
            preferred,
            plannedOrder,
            baseLength
          );
          if (geometry) {
            const direction = {
              x: geometry.end.x - geometry.start.x,
              y: geometry.end.y - geometry.start.y
            };
            const directionLength = Math.max(0.001, Math.hypot(direction.x, direction.y));
            const length =
              state.chem.bondFixed || startScale !== 1
                ? baseLength
                : rawDistance > 24 && rawDistance < 180
                  ? rawDistance
                  : baseLength;
            end = {
              x: drag.origin.x + (direction.x / directionLength) * length,
              y: drag.origin.y + (direction.y / directionLength) * length
            };
          }
        } else if (!shift) {
          const dx = end.x - drag.origin.x;
          const dy = end.y - drag.origin.y;
          const length = Math.hypot(dx, dy);
          if (length > 6) {
            const angle = Math.atan2(dy, dx);
            const step = Math.PI / 12;
            let snappedAngle = Math.round(angle / step) * step;
            let snappedLength = length;
            const ideal = Math.round(length / baseLength) * baseLength;
            if (Math.abs(length - ideal) < 8) snappedLength = ideal;
            // 固定化学键：预览与落笔长度一致；从已缩放结构延伸时也沿用同一比例。
            if (drag.mode === 'bond' && (state.chem.bondFixed || startScale !== 1)) {
              snappedLength = baseLength;
            }
            if (drag.mode === 'arrow' && shift) snappedAngle = angle;
            end = {
              x: drag.origin.x + Math.cos(snappedAngle) * snappedLength,
              y: drag.origin.y + Math.sin(snappedAngle) * snappedLength
            };
          }
        }
      }
      if (drag.mode === 'bond') {
        setPreview(
          makeChemBond(
            layer.id,
            drag.origin,
            end,
            state.chem.bondType,
            startScale
          )
        );
      } else {
        setPreview(
          createArrowObject(layer.id, CHEM_ARROW_STYLE, drag.origin, end, state.chem.arrowKind)
        );
      }
      return;
    }

    if (drag.mode === 'pen-handle' && drag.nodeId) {
      setPenDraft((draft) => {
        if (!draft || draft.nodes.length === 0) return draft;
        const nodes = [...draft.nodes];
        const last = nodes[nodes.length - 1];
        const handle = { x: point.x - last.x, y: point.y - last.y };
        nodes[nodes.length - 1] = alt
          ? {
              // Alt 拖拽：只生成出向手柄，得到尖角节点。
              ...last,
              handleOut: handle,
              handleIn: null,
              type: 'corner'
            }
          : {
              ...last,
              handleOut: handle,
              handleIn: { x: -handle.x, y: -handle.y },
              type: 'smooth'
            };
        return { ...draft, nodes, cursor: point };
      });
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const nativeDown = event.nativeEvent as PointerEvent;
    if (nativeDown.pointerType === 'pen') lastPenAtRef.current = performance.now();
    // 触摸：双指进入手势；笔在屏或刚离开时丢弃触摸（掌拒）。
    if (nativeDown.pointerType === 'touch') {
      const palm =
        (dragRef.current && brushPointerTypeRef.current === 'pen') ||
        performance.now() - lastPenAtRef.current < 500;
      if (palm) return;
      touchPointersRef.current.set(nativeDown.pointerId, {
        x: nativeDown.clientX,
        y: nativeDown.clientY
      });
      if (touchPointersRef.current.size >= 2) {
        event.preventDefault();
        if (dragRef.current) abortBrushStroke();
        startTouchGesture();
        return;
      }
    }
    if (contextMenu) setContextMenu(null);
    if (event.button === 1 || activeTool === 'hand' || spaceHeld) {
      event.preventDefault();
      capture(event);
      panRef.current = {
        x: event.clientX,
        y: event.clientY,
        panX: viewport.pan.x,
        panY: viewport.pan.y
      };
      setPanning(true);
      return;
    }
    if (event.button !== 0) return;

    // 画布是自己的绘制面：必须吃掉 pointerdown 的默认行为（文字选择、原生拖拽）。
    // 否则按住拖动会先触发 selectstart，浏览器再进入原生 DnD 并派发 pointercancel，
    // 画布侧把整条手势 cancelActiveOperation 回滚——橡皮"擦了又复原"就是这条链路。
    const target = event.target as HTMLElement | null;
    const editable =
      Boolean(target) &&
      (target!.tagName === 'TEXTAREA' ||
        target!.tagName === 'INPUT' ||
        target!.tagName === 'SELECT' ||
        target!.isContentEditable === true);
    if (!editable) event.preventDefault();

    const state = useAppStore.getState();
    const local = localPoint(event);
    const point = pagePoint(event);
    setCursor(point);

    if (activeTool === 'zoom') {
      // 拖出矩形 = 框选缩放；原地单击仍按 1.25 倍放大（Alt 缩小）。
      beginDrag('zoom-marquee', point, local);
      capture(event);
      return;
    }

    if (activeTool === 'eyedropper') {
      const hit = hitTestDocument(state.doc, point, 8 / state.viewport.zoom);
      if (!hit) return;
      const fill = hit.style.fill.type === 'solid' ? hit.style.fill.color : null;
      const stroke =
        hit.style.stroke.paint.type === 'solid' ? hit.style.stroke.paint.color : null;
      const color = fill ?? stroke;
      if (!color) {
        state.notify('该对象没有可拾取的颜色', 'warn');
        return;
      }
      // Shift = 取到描边色；取色完成后回到取色前的工具，避免中断当前工作。
      if (event.shiftKey) state.setDefaultStroke(color);
      else state.setDefaultFill(color);
      state.notify(
        `已拾取${event.shiftKey ? '描边' : '填充'}色 ${color.toUpperCase()}`,
        'success'
      );
      state.restoreToolAfterEyedropper();
      return;
    }

    if (activeTool === 'symmetry') {
      const wx = symmetryAxis.x * page.width;
      const hy = symmetryAxis.y * page.height;
      const vertical = symmetry === 'vertical' || symmetry === 'both';
      const horizontal = symmetry === 'horizontal' || symmetry === 'both';
      if (!vertical && !horizontal) {
        state.notify('请先在画布下方的对称横栏选择对称方式', 'info');
        return;
      }
      const hitV = vertical && Math.abs(point.x - wx) <= 10 / state.viewport.zoom;
      const hitH = horizontal && Math.abs(point.y - hy) <= 10 / state.viewport.zoom;
      if (hitV || hitH) {
        beginDrag('symmetry-axis', point, local, {
          axisHandle:
            hitV && (!hitH || Math.abs(point.x - wx) <= Math.abs(point.y - hy))
              ? 'vertical'
              : 'horizontal'
        });
        capture(event);
      }
      return;
    }

    if (activeTool === 'guides') {
      const handles = guideHandlePoints(guideMode, guideSettings, page.width, page.height);
      const threshold = 14 / state.viewport.zoom;
      const hit = handles.find(
        (handle) => Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= threshold
      );
      if (hit) {
        beginDrag('guide-point', point, local, { guideHandle: hit.id });
        capture(event);
      }
      return;
    }

    if (activeTool === 'text') {
      // 阻止浏览器默认的焦点迁移：否则刚插入的 textarea 会在同一次 pointerdown
      // 里被 blur，onBlur 又把空内容静默提交，表现为"点了文字工具却没有输入框"。
      event.preventDefault();
      // 先提交旧编辑器，再打开新位置；否则旧 textarea 的 blur 会用过期状态覆盖新编辑器。
      if (textEditorRef.current) commitText(textEditorRef.current.session);
      // 选中文本后拖右边缘 = 调整框宽（画布上的所见即所得换行）。
      if (state.selection.length === 1) {
        const selected = getObject(state.doc, state.selection[0]);
        if (selected?.type === 'text') {
          const right = selected.x + selected.width;
          const tolerance = 9 / state.viewport.zoom;
          if (
            Math.abs(point.x - right) <= tolerance &&
            point.y >= selected.y - tolerance &&
            point.y <= selected.y + selected.height + tolerance
          ) {
            state.beginTransaction();
            beginDrag('text-width', point, local, {
              textId: selected.id,
              origin: { x: selected.x, y: selected.y }
            });
            capture(event);
            return;
          }
        }
      }
      // 点在已有文本上：进入编辑而不是叠一个新文本框。
      const hit = hitTestDocument(state.doc, point, 8 / state.viewport.zoom);
      if (hit?.type === 'text') {
        openTextEditorForObject(hit);
        return;
      }
      // 新建文本不再在画布上开输入框：统一走画布下方的"输入 + 工具"面板，
      // 文字固定出现在画布中央，落点由确定后的拖动来微调。
      if (!textComposerRef.current) openTextComposer();
      return;
    }

    if (activeTool === 'eraser' || activeTool === 'eraser-live') {
      if (state.eraserCurrentLayer) {
        const layer = drawLayer(state.doc);
        if (layer?.locked) {
          state.notify(`「${layer.name}」已锁定，无法擦除`, 'warn');
          return;
        }
      }
      state.beginTransaction();
      // 一次手势内对同一条化学键只降一级：三键→双键→单键→擦除。
      const erasedBondIds = new Set<string>();
      beginDrag('erase', point, local, {
        lastErase: point,
        eraseAllLayers: event.altKey,
        erasedBondIds
      });
      eraseStrokeAt([[point]], currentEraseTargets(), event.altKey, erasedBondIds);
      capture(event);
      return;
    }

    if (activeTool === 'brush') {
      const layer = drawLayer(state.doc);
      if (!layer || layer.locked) {
        state.notify('当前图层已锁定，无法绘制', 'warn');
        return;
      }
      state.beginTransaction();
      const native = event.nativeEvent as PointerEvent;
      const pointerType = native.pointerType || 'mouse';
      brushPointerTypeRef.current = pointerType;
      const projection = currentBrushProjection(pointerType);
      brushProjectionRef.current = projection;
      brushSamplesRef.current = [toBrushSample(point, native, pointerType)];
      pendingCursorRef.current = point;
      lastCursorRef.current = point;
      beginBrushInk(projection);
      beginDrag('brush', point, local);
      capture(event);
      return;
    }

    if (activeTool === 'bucket') {
      // Alt = 临时取色，避免为吸色切工具。
      if (event.altKey) {
        pickColorAt(point);
        return;
      }
      const tolerance = 10 / state.viewport.zoom;
      const hitInfo = findFillTarget(state.doc, point, tolerance);
      if (hitInfo?.locked) {
        const layerName = getLayerOfObject(state.doc, hitInfo.object.id)?.name ?? '图层';
        state.notify(`「${layerName}」已锁定，无法填充`, 'warn');
        return;
      }
      let target = hitInfo?.object ?? null;
      if (target?.type === 'group') {
        const child = findFillableChild(state.doc, target.id, point, tolerance);
        if (!child) {
          state.notify('组内没有可填充的图形', 'info');
          return;
        }
        target = child;
      }
      if (target && (target.type === 'bond' || target.type === 'atom')) {
        state.notify('化学对象不支持油漆桶填充，请使用属性面板', 'info');
        return;
      }
      const fillColor =
        state.defaultStyle.fill.type === 'solid'
          ? state.defaultStyle.fill.color
          : state.defaultStyle.stroke.paint.type === 'solid'
            ? state.defaultStyle.stroke.paint.color
            : null;
      const strokeColor =
        state.defaultStyle.stroke.paint.type === 'solid'
          ? state.defaultStyle.stroke.paint.color
          : fillColor;
      if (!fillColor && !strokeColor) {
        state.notify('当前颜色为“无填充/无描边”，请先在调色板选择颜色', 'warn');
        return;
      }
      if ((bucketMode === 'fill' || bucketMode === 'both') && !fillColor) {
        state.notify('当前颜色为“无填充”，无法填充', 'warn');
        return;
      }
      if ((bucketMode === 'stroke' || bucketMode === 'both') && !strokeColor) {
        state.notify('当前颜色为“无描边”，无法描边', 'warn');
        return;
      }

      if (target) {
        state.updateDoc(
          replaceObject(state.doc, target.id, (obj) => {
            const style = { ...obj.style };
            if (bucketMode === 'fill' || bucketMode === 'both') {
              style.fill = { type: 'solid', color: fillColor! };
            }
            if (bucketMode === 'stroke' || bucketMode === 'both') {
              style.stroke = {
                ...style.stroke,
                width: Math.max(1, style.stroke.width),
                paint: { type: 'solid', color: strokeColor! }
              };
            }
            return { ...obj, style };
          }),
          true
        );
        state.setSelection([target.id]);
        state.notify(
          bucketMode === 'both' ? '已填充并描边' : bucketMode === 'stroke' ? '已应用描边' : '已填充',
          'success'
        );
        return;
      }

      // 没点中对象：走"区域填充"，用于两笔围出的闭合区域。
      if (bucketMode === 'stroke') {
        state.notify('描边模式需要点击图形', 'info');
        return;
      }
      const region = buildRegionFill(state.doc, point, {
        gap: state.bucketGap,
        expand: state.bucketExpand
      });
      if (!region) {
        state.notify('没有可填充的闭合区域，可调大“断线容差”后重试', 'info');
        return;
      }
      const layer = drawableLayerFor('填充区域');
      if (!layer) return;
      const style = cloneStyle(state.defaultStyle);
      style.fill = { type: 'solid', color: fillColor! };
      style.stroke = { ...style.stroke, paint: { type: 'none' }, dash: [] };
      const path = createPathObject(
        layer.id,
        style,
        region.outline.map((node) => makeNode(node.x, node.y)),
        true
      );
      path.holes = region.holes;
      // 一次按住拖动可能连续填充多个区域：整段手势合并为一条撤销记录。
      // beginDrag 必须在 addObjects 前调用，这样取消时能回滚到本次填充之前。
      state.beginTransaction();
      beginDrag('bucket-fill', point, local, { lastFill: point });
      state.addObjects([path]);
      state.notify('已填充闭合区域', 'success');
      capture(event);
      return;
    }

    if (activeTool === 'atom') {
      addAtomAt(point);
      return;
    }

    if (activeTool === 'ring') {
      const template = RING_TEMPLATES.find((item) => item.id === state.chem.ringTemplateId);
      if (template?.id === 'benzene') {
        const fused = fusedBenzeneAt(state.doc, point, state.viewport.zoom);
        if (fused) {
          if ('blocked' in fused) {
            state.notify(fused.blocked, 'info');
            return;
          }
          insertFusedBenzene(fused);
          return;
        }
      }
      const attachment = template
        ? ringAttachmentAt(state.doc, point, template, state.viewport.zoom)
        : null;
      if (attachment) {
        insertRing(attachment.center, {
          rotation: attachment.rotation,
          snap: false,
          attachGroupId: attachment.groupId,
          anchorPoint: attachment.anchorPoint
        });
      } else {
        insertRing(point);
      }
      return;
    }

    if (activeTool === 'pen') {
      handlePenDown(point, { alt: event.altKey, shift: event.shiftKey });
      capture(event);
      return;
    }

    if (activeTool === 'node') {
      const single = selection.length === 1 ? getObject(state.doc, selection[0]) : null;
      if (single?.type === 'path') {
        const path = single as PathObject;
        const tolerance = 7 / state.viewport.zoom;
        for (const node of path.nodes) {
          if (node.handleIn) {
            const handle = { x: node.x + node.handleIn.x, y: node.y + node.handleIn.y };
            if (Math.hypot(point.x - handle.x, point.y - handle.y) <= tolerance) {
              startNodeDrag(path, 'in', node.id, point, local);
              capture(event);
              return;
            }
          }
          if (node.handleOut) {
            const handle = { x: node.x + node.handleOut.x, y: node.y + node.handleOut.y };
            if (Math.hypot(point.x - handle.x, point.y - handle.y) <= tolerance) {
              startNodeDrag(path, 'out', node.id, point, local);
              capture(event);
              return;
            }
          }
          if (Math.hypot(point.x - node.x, point.y - node.y) <= tolerance) {
            let ids = nodeSelectionRef.current;
            if (event.shiftKey) {
              ids = ids.includes(node.id)
                ? ids.filter((id) => id !== node.id)
                : [...ids, node.id];
              applyNodeSelection(ids);
              if (!ids.includes(node.id)) return;
            } else if (!ids.includes(node.id)) {
              ids = [node.id];
              applyNodeSelection(ids);
            }
            startNodeDrag(path, 'node', node.id, point, local, ids);
            capture(event);
            return;
          }
        }
      }
      const hit = hitTestDocument(state.doc, point, 6 / state.viewport.zoom);
      if (hit) {
        state.setSelection([hit.id]);
      } else {
        state.clearSelection();
      }
      return;
    }

    if (activeTool === 'curve') {
      // 曲线工具在已创建的曲线上继续操作：拖节点或拖线身增加一个可拖拽点。
      // 必须放在形状创建/选择移动之前，否则会误拖整条路径。
      const selectedPath =
        selection.length === 1 && getObject(state.doc, selection[0])?.type === 'path'
          ? (getObject(state.doc, selection[0]) as PathObject)
          : null;
      const hit = hitTestDocument(state.doc, point, 6 / state.viewport.zoom);
      const hitPath = hit?.type === 'path' ? (hit as PathObject) : null;
      const path = selectedPath ?? hitPath;
      if (path) {
        const layer = getLayerOfObject(state.doc, path.id);
        if (!layer || layer.locked) {
          state.notify('当前图层已锁定，无法编辑曲线', 'warn');
          return;
        }
        const localPoint = curveLocalPoint(path, point);
        const tolerance = 8 / state.viewport.zoom;
        let nodeIndex = path.nodes.findIndex(
          (item) => Math.hypot(localPoint.x - item.x, localPoint.y - item.y) <= tolerance
        );
        if (nodeIndex >= 0) {
          const node = path.nodes[nodeIndex];
          if (!selection.includes(path.id)) state.setSelection([path.id]);
          state.beginTransaction();
          beginDrag('curve', point, local, {
            pathId: path.id,
            nodeId: node.id,
            nodeIndex,
            curveNodes: path.nodes,
            curveGrab: { x: node.x - localPoint.x, y: node.y - localPoint.y },
            selectionIds: [path.id]
          });
          capture(event);
          return;
        }
        // 单击线身即插点（不再要求拖 2px），Alt 插尖角。
        const nearest = nearestCurvePoint(path.nodes, localPoint, path.closed);
        if (nearest && nearest.distance <= tolerance) {
          if (!selection.includes(path.id)) state.setSelection([path.id]);
          state.beginTransaction();
          const insertedNode = makeNode(nearest.point.x, nearest.point.y);
          if (event.altKey) {
            insertedNode.type = 'corner';
            insertedNode.handleIn = null;
            insertedNode.handleOut = null;
          }
          const raw = [
            ...path.nodes.slice(0, nearest.segment + 1),
            insertedNode,
            ...path.nodes.slice(nearest.segment + 1)
          ];
          const affected = new Set(
            event.altKey
              ? [nearest.segment + 1]
              : [nearest.segment, nearest.segment + 1, nearest.segment + 2]
          );
          const inserted = curvePathWithNodes(path, smoothCurveNodes(raw, affected));
          state.updateDoc(replaceObject(state.doc, path.id, () => inserted), false);
          nodeIndex = inserted.nodes.findIndex((item) => item.id === insertedNode.id);
          beginDrag('curve', point, local, {
            pathId: path.id,
            nodeId: insertedNode.id,
            nodeIndex,
            curveNodes: inserted.nodes,
            curveGrab: { x: 0, y: 0 },
            selectionIds: [path.id]
          });
          capture(event);
          return;
        }
      }
    }

    const shapeToolActive = SHAPE_TOOL_IDS.includes(activeTool);
    let discardSeedClick = false;
    if (
      (activeTool === 'select' || activeTool === 'bond' || activeTool === 'arrow' || shapeToolActive) &&
      state.selection.length > 0
    ) {
      const frame = selectionFrame(state.doc, state.selection);
      if (frame && (activeTool === 'select' || shapeToolActive)) {
        const handle = handleAtPoint(point, frame, state.viewport.zoom);
        if (handle) {
          state.beginTransaction();
          beginDrag(handle === 'rotate' ? 'rotate' : 'resize', point, local, {
            handle,
            bounds: frame.bounds,
            frame,
            selectionIds: state.selection
          });
          capture(event);
          return;
        }
      }
    }

    // 选择工具下也能拖对称轴/透视手柄：构图时不必来回切工具。
    if (activeTool === 'select' && state.selection.length === 0) {
      const tolerance = 10 / state.viewport.zoom;
      if (symmetry !== 'none') {
        const wx = symmetryAxis.x * page.width;
        const hy = symmetryAxis.y * page.height;
        const vertical = symmetry === 'vertical' || symmetry === 'both';
        const horizontal = symmetry === 'horizontal' || symmetry === 'both';
        const hitV = vertical && Math.abs(point.x - wx) <= tolerance;
        const hitH = horizontal && Math.abs(point.y - hy) <= tolerance;
        if (hitV || hitH) {
          beginDrag('symmetry-axis', point, local, {
            axisHandle:
              hitV && (!hitH || Math.abs(point.x - wx) <= Math.abs(point.y - hy))
                ? 'vertical'
                : 'horizontal'
          });
          capture(event);
          return;
        }
      }
      if (guideMode !== 'none') {
        const handles = guideHandlePoints(guideMode, guideSettings, page.width, page.height);
        const hit = handles.find(
          (handle) =>
            Math.hypot(handle.point.x - point.x, handle.point.y - point.y) <=
            14 / state.viewport.zoom
        );
        if (hit) {
          beginDrag('guide-point', point, local, { guideHandle: hit.id });
          capture(event);
          return;
        }
      }
    }

    if (activeTool === 'select' || (shapeToolActive && state.selection.length > 0)) {
      const hit = hitTestDocument(state.doc, point, 6 / state.viewport.zoom);
      if (hit) {
        let ids = state.selection;
        if (event.shiftKey) {
          state.setSelection([hit.id], true);
          ids = useAppStore.getState().selection;
          if (!ids.includes(hit.id)) return;
        } else if (!ids.includes(hit.id)) {
          state.setSelection([hit.id]);
          ids = [hit.id];
        }
        const layer = getLayerOfObject(state.doc, hit.id);
        if (layer && layer.id !== state.doc.activeLayerId) state.setActiveLayer(layer.id);
        // Alt 拖拽 = 原位复制后拖动副本（复制历史与移动历史分开，可逐步撤销）。
        if (event.altKey && activeTool === 'select') {
          state.duplicateSelection();
          const duplicated = useAppStore.getState();
          ids = duplicated.selection;
          if (ids.length > 0) {
            // duplicateSelection 默认偏移 12px；Alt 复制应"原地"起步。
            duplicated.updateDoc(
              translateDocumentObjects(duplicated.doc, ids, -12, -12),
              false
            );
          }
        }
        state.beginTransaction();
        const live = useAppStore.getState();
        beginDrag('move', point, local, {
          selectionIds: ids,
          bounds: selectionBounds(live.doc, ids)
        });
        capture(event);
        return;
      }
      if (shapeToolActive) {
        // 选中图形时在空白处拖拽应直接开始新图形；仅单击空白则只取消选择。
        discardSeedClick = true;
        state.clearSelection();
      } else if (!event.shiftKey) {
        state.clearSelection();
        setMarquee({ start: point, end: point });
        beginDrag('marquee', point, local);
        capture(event);
        return;
      } else {
        setMarquee({ start: point, end: point });
        beginDrag('marquee', point, local);
        capture(event);
        return;
      }
    }

    if (
      activeTool === 'rect' ||
      activeTool === 'square' ||
      activeTool === 'ellipse' ||
      activeTool === 'circle' ||
      activeTool === 'polygon' ||
      activeTool === 'line' ||
      activeTool === 'curve'
    ) {
      const layer = drawLayer(state.doc);
      if (!layer || layer.locked) {
        state.notify('当前图层已锁定，无法创建图形', 'warn');
        return;
      }
      const endpointSnap =
        (activeTool === 'line' || activeTool === 'curve') && !event.altKey
          ? snapToObjectEndpoint(state.doc, point, 8 / state.viewport.zoom)
          : null;
      const origin = endpointSnap ?? gridPoint(point, state.doc, state.snapEnabled, event.altKey);
      beginDrag('create', point, local, { origin, discardClick: discardSeedClick });
      setPreview(null);
      capture(event);
      return;
    }

    if (activeTool === 'bond' || activeTool === 'arrow') {
      const layer = drawLayer(state.doc);
      if (!layer || layer.locked) {
        state.notify('当前图层已锁定，无法绘制', 'warn');
        return;
      }
      const origin =
        findConnection(state.doc, point, 12 / state.viewport.zoom) ??
        gridPoint(point, state.doc, state.snapEnabled, event.altKey);
      beginDrag(activeTool === 'bond' ? 'bond' : 'arrow', point, local, { origin });
      setPreview(null);
      capture(event);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const nativeMove = event.nativeEvent as PointerEvent;
    if (nativeMove.pointerType === 'pen') lastPenAtRef.current = performance.now();
    if (nativeMove.pointerType === 'touch' && touchPointersRef.current.has(nativeMove.pointerId)) {
      touchPointersRef.current.set(nativeMove.pointerId, {
        x: nativeMove.clientX,
        y: nativeMove.clientY
      });
      if (touchPointersRef.current.size >= 2) {
        event.preventDefault();
        updateTouchGesture();
        return;
      }
    }
    const state = useAppStore.getState();
    // 兜底：鼠标/笔已经松开但没收到 pointerup（切窗口、捕获丢失）时，
    // 不能继续以拖动状态绘制，否则会出现"不按键也在画"的卡笔现象。
    if (dragRef.current && nativeMove.pointerType !== 'touch' && nativeMove.buttons === 0) {
      cancelActiveOperation('指针已松开，已取消当前操作');
      return;
    }
    const point = pagePoint(event);
    pendingCursorRef.current = point;
    // 画笔拖动期间光标与笔迹预览合并到同一帧提交，其余工具保持即时反馈。
    if (dragRef.current?.mode !== 'brush') setCursor(point);

    if (panRef.current) {
      setViewport({
        zoom: state.viewport.zoom,
        pan: {
          x: panRef.current.panX + (event.clientX - panRef.current.x),
          y: panRef.current.panY + (event.clientY - panRef.current.y)
        }
      });
      return;
    }

    const drag = dragRef.current;
    if (!drag) {
      // 所有化学工具共用同一套悬停反馈：原子圈选 / 化学键描边。
      if (hoverHighlight && CHEM_HOVER_TOOLS.includes(activeTool)) {
        const anchor = snapAnchor(state.doc, point, 'hover');
        if (anchor) {
          setBondHover({ kind: 'atom', point: anchor.point });
        } else {
          const hoveredBond = findBondAt(state.doc, point, 9 / state.viewport.zoom);
          setBondHover(
            hoveredBond
              ? {
                  kind: 'bond',
                  bondId: hoveredBond.id,
                  start: hoveredBond.start,
                  end: hoveredBond.end
                }
              : null
          );
        }
      } else if (bondHover) {
        setBondHover(null);
      }
      // 油漆桶/橡皮的悬停预览：先看到会作用到哪个对象，再决定是否点击。
      if (activeTool === 'bucket') {
        const tolerance = 10 / state.viewport.zoom;
        const info = findFillTarget(state.doc, point, tolerance);
        const target = info && !info.locked ? info.object : null;
        const bounds = target ? getObjectBounds(target, state.doc) : null;
        setToolHover(
          bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null
        );
      } else if (activeTool === 'eraser' || activeTool === 'eraser-live') {
        // 悬停按当前擦除目标取"真正会命中的对象"，与点击结果完全一致。
        const layerId = state.eraserCurrentLayer ? drawLayer(state.doc)?.id ?? null : null;
        const target = findErasableAt(state.doc, point, {
          targets: currentEraseTargets(),
          radius: state.eraserSize,
          layerId
        });
        const bounds = target ? getObjectBounds(target, state.doc) : null;
        setToolHover(
          bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null
        );
      } else if (toolHover) {
        setToolHover(null);
      }
      if (penDraft) setPenDraft({ ...penDraft, cursor: point });
      return;
    }
    if (drag.mode === 'text-width') {
      if (!drag.textId) return;
      const base = getObject(drag.startDoc, drag.textId);
      if (!base || base.type !== 'text') return;
      const width = Math.max(20, point.x - base.x);
      const patched = patchTextObject(base, { maxWidth: width });
      state.updateDoc(replaceObject(state.doc, drag.textId, () => patched), false);
      return;
    }
    if (drag.mode === 'bucket-fill') {
      const last = drag.lastFill ?? drag.startPage;
      if (Math.hypot(point.x - last.x, point.y - last.y) < 40 / state.viewport.zoom) return;
      drag.lastFill = point;
      bucketRegionFillAt(point);
      return;
    }
    if (drag.mode === 'marquee' || drag.mode === 'zoom-marquee') {
      setMarquee({ start: drag.startPage, end: point });
      return;
    }
    if (drag.mode === 'pen-handle') {
      updateDrag(point, event.shiftKey, event.altKey);
      return;
    }
    if (drag.mode === 'symmetry-axis') {
      // 靠近页面中线时吸附，便于做严格对称；按住 Shift 可保持自由位置。
      const snap = (value: number, size: number) =>
        !event.shiftKey && Math.abs(value - 0.5) * size <= 6 / state.viewport.zoom
          ? 0.5
          : value;
      if (drag.axisHandle === 'vertical') {
        useAppStore.getState().setSymmetryAxis({
          x: snap(Math.min(0.98, Math.max(0.02, point.x / page.width)), page.width),
          y: state.symmetryAxis.y
        });
      } else {
        useAppStore.getState().setSymmetryAxis({
          x: state.symmetryAxis.x,
          y: snap(Math.min(0.98, Math.max(0.02, point.y / page.height)), page.height)
        });
      }
      return;
    }
    if (drag.mode === 'guide-point') {
      const fx = Math.min(1.6, Math.max(-0.6, point.x / page.width));
      const fy = Math.min(2.2, Math.max(-0.5, point.y / page.height));
      if (drag.guideHandle === 'horizon') {
        useAppStore.getState().setGuideSettings({
          horizon: Math.min(1.2, Math.max(-0.2, fy))
        });
      } else if (drag.guideHandle === 'left') {
        useAppStore.getState().setGuideSettings({ vpLeft: fx, horizon: fy });
      } else if (drag.guideHandle === 'right') {
        useAppStore.getState().setGuideSettings({ vpRight: fx, horizon: fy });
      } else if (drag.guideHandle === 'bottom') {
        useAppStore.getState().setGuideSettings({ vpBottom: fy, vpX: fx });
      } else {
        useAppStore.getState().setGuideSettings({ vpX: fx, horizon: fy });
      }
      return;
    }
    if (drag.mode === 'erase') {
      const target =
        guideAssist && guideMode !== 'none'
          ? snapToGuideDirection(
              drag.startPage,
              point,
              guideMode,
              guideSettings,
              page.width,
              page.height
            )
          : point;
      noteGuideDir(drag, drag.startPage, target);
      // 只处理"上一落点 → 当前点"这一段：相邻分段首尾相接，扫掠区连续无缺口。
      const from = drag.lastErase ?? drag.startPage;
      drag.lastErase = target;
      if (Math.hypot(target.x - from.x, target.y - from.y) <= 0.01) return;
      eraseStrokeAt(
        [[from, target]],
        currentEraseTargets(),
        drag.eraseAllLayers,
        drag.erasedBondIds
      );
      return;
    }
    if (drag.mode === 'brush') {
      const pointerType = brushPointerTypeRef.current;
      const native = event.nativeEvent as PointerEvent;
      // 合并事件：指针硬件采样率往往高于事件派发率，丢掉子帧会明显损失笔迹细节。
      const coalesced =
        typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      const events: PointerEvent[] = coalesced.length > 0 ? coalesced : [native];
      const samples = brushSamplesRef.current;
      for (const item of events) {
        const raw = pagePoint(item);
        const target =
          guideAssist && guideMode !== 'none'
            ? snapToGuideDirection(
                drag.startPage,
                raw,
                guideMode,
                guideSettings,
                page.width,
                page.height,
                drag.guideDir
              )
            : raw;
        if (target !== raw) noteGuideDir(drag, drag.startPage, target);
        const previous = samples[samples.length - 1];
        const sample = toBrushSample(target, item, pointerType);
        samples.push(sample);
        if (samples.length > MAX_BRUSH_SAMPLES) {
          // 超长笔迹：隔点压缩（保留首尾），内存与落笔耗时有上界。
          const keep = samples.filter((_, index) => index % 2 === 0);
          const tail = samples[samples.length - 1];
          if (keep[keep.length - 1] !== tail) keep.push(tail);
          samples.length = 0;
          samples.push(...keep);
        }
        if (previous) {
          drawInkSegment(previous, sample, nibFromTilt(sample.tiltX, sample.tiltY));
        }
      }
      pendingCursorRef.current = point;
      scheduleBrushFrame();
      return;
    }
    updateDrag(point, event.shiftKey, event.altKey);
  }

  function finishCreate(point: Vec, shift: boolean, alt = false) {
    const drag = dragRef.current;
    if (!drag) return;
    const state = useAppStore.getState();
    const layer = drawableLayerFor('创建图形');
    if (!layer) return;
    const snappedPoint = gridPoint(point, state.doc, state.snapEnabled, alt);
    const distance = Math.hypot(snappedPoint.x - drag.origin.x, snappedPoint.y - drag.origin.y);
    if (distance < 5 && drag.discardClick) {
      setPreview(null);
      return;
    }
    let end =
      distance < 5
        ? {
            x: drag.origin.x + (state.activeTool === 'line' ? 140 : 120),
            y: drag.origin.y + (state.activeTool === 'line' ? 0 : 84)
          }
        : snappedPoint;
    // 绘画辅助开启时，矩形/椭圆类图形约束为水平或垂直方向
    const axisConstrained = ['rect', 'square', 'ellipse', 'circle'].includes(state.activeTool);
    if (guideAssist && guideMode !== 'none' && axisConstrained) {
      const dx = Math.abs(end.x - drag.origin.x);
      const dy = Math.abs(end.y - drag.origin.y);
      end = dx >= dy ? { x: end.x, y: drag.origin.y } : { x: drag.origin.x, y: end.y };
    }
    // 直线/曲线也沿辅助线方向，避免"只有画笔和矩形能用辅助线"。
    if (
      guideAssist &&
      guideMode !== 'none' &&
      (state.activeTool === 'line' || state.activeTool === 'curve')
    ) {
      end = snapToGuideDirection(
        drag.origin,
        end,
        guideMode,
        guideSettings,
        page.width,
        page.height
      );
    }
    if (
      (state.activeTool === 'line' || state.activeTool === 'curve') &&
      !alt &&
      !(guideAssist && guideMode !== 'none')
    ) {
      end = snapToObjectEndpoint(state.doc, end, 8 / zoom) ?? end;
    }
    const shape = shapeFromDrag(
      state.activeTool,
      drag.origin,
      end,
      layer.id,
      cloneStyle(state.defaultStyle),
      {
        shift,
        cornerRadius: state.cornerRadius,
        sides: state.polygonSides,
        star: state.polygonStar,
        fromCenter: state.shapeFromCenter,
        arrowEnd: state.lineArrowEnd
      }
    );
    if (shape) {
      const objects = [shape];
      if (state.symmetry !== 'none') {
        objects.push(
          ...mirrorObject(shape, state.symmetryAxis, state.symmetry, page.width, page.height)
        );
      }
      state.addObjects(objects);
      // 绘制完成即选中新形状：保持形状工具的同时直接提供缩放/旋转/移动控制点
      state.setSelection(objects.map((item) => item.id));
    }
  }

  function createBondFromAnchor(anchor: BondAnchor, targetPoint: Vec): boolean {
    const state = useAppStore.getState();
    const layer = drawLayer(state.doc);
    if (!layer || layer.locked) return true;
    const zoom = state.viewport.zoom;
    const targetAnchor =
      snapAnchor(state.doc, targetPoint) ??
      nearestRingAnchor(state.doc, targetPoint);
    const directTarget =
      targetAnchor &&
      Math.hypot(
        targetAnchor.point.x - targetPoint.x,
        targetAnchor.point.y - targetPoint.y
      ) <= 12 / zoom &&
      Math.hypot(targetAnchor.point.x - anchor.point.x, targetAnchor.point.y - anchor.point.y) > 6
        ? targetAnchor
        : null;
    let endPoint: Vec;
    let limitAnchor: BondAnchor | null = directTarget;
    const requestedType = state.chem.bondType;
    const requestedOrder = bondOrderForType(requestedType);
    const anchorScale = chemAnchorScale(anchor);
    // 绘制期补全：键级同时受两端价层容量约束，而不是只看向哪一端起笔。
    // 目标端装不下时降级（并给出原因），避免画出超价结构。
    const targetCapacity = directTarget
      ? maxNewBondOrderForAnchor(directTarget)
      : requestedOrder;
    const plannedOrder = Math.max(
      1,
      Math.min(requestedOrder, maxNewBondOrderForAnchor(anchor), targetCapacity)
    );
    if (plannedOrder < requestedOrder) {
      state.notify(
        `按两端价层容量，键型已降级为${plannedOrder >= 3 ? '三键' : plannedOrder >= 2 ? '双键' : '单键'}`,
        'info'
      );
    }

    if (directTarget) {
      endPoint = directTarget.point;
    } else {
      const preferred = {
        x: targetPoint.x - anchor.point.x,
        y: targetPoint.y - anchor.point.y
      };
      const geometry = nextChainBond(
        state.doc,
        anchor,
        preferred,
        plannedOrder,
        state.chemBondLength * anchorScale
      );
      if (!geometry) {
        state.notify(`${anchor.element} 原子已无剩余化合价，无法继续成键`, 'warn');
        return true;
      }
      const baseLength = Math.hypot(
        geometry.end.x - geometry.start.x,
        geometry.end.y - geometry.start.y
      );
      const dragLength = Math.hypot(preferred.x, preferred.y);
      // 固定化学键时忽略拖拽距离；已缩放结构也沿用同一比例。
      const length =
        state.chem.bondFixed || anchorScale !== 1
          ? baseLength
          : dragLength > 24 && dragLength < 180
            ? dragLength
            : baseLength;
      const direction =
        baseLength > 0.001
          ? {
              x: (geometry.end.x - geometry.start.x) / baseLength,
              y: (geometry.end.y - geometry.start.y) / baseLength
            }
          : { x: 1, y: 0 };
      endPoint = {
        x: anchor.point.x + direction.x * length,
        y: anchor.point.y + direction.y * length
      };
      // 环内 120° 间隙同样可能被选为“最大空隙”，必须显式拒绝落点进入环内。
      if (anchor.onRing && anchor.group) {
        const group = getObject(state.doc, anchor.group.id);
        if (group && group.type === 'group') {
          const ringBonds = group.childIds
            .map((id) => getObject(state.doc, id))
            .filter((obj): obj is BondObject => Boolean(obj && obj.type === 'bond'));
          const geometry = ringGeometry(ringBonds);
          if (
            geometry?.closed &&
            Math.hypot(endPoint.x - geometry.center.x, endPoint.y - geometry.center.y) <
              geometry.vertexRadius - 2
          ) {
            const outwardLength = Math.hypot(
              endPoint.x - anchor.point.x,
              endPoint.y - anchor.point.y
            );
            const radial = Math.hypot(
              anchor.point.x - geometry.center.x,
              anchor.point.y - geometry.center.y
            );
            const outward =
              radial > 0.001
                ? {
                    x: (anchor.point.x - geometry.center.x) / radial,
                    y: (anchor.point.y - geometry.center.y) / radial
                  }
                : { x: 1, y: 0 };
            endPoint = {
              x: anchor.point.x + outward.x * outwardLength,
              y: anchor.point.y + outward.y * outwardLength
            };
          }
        }
      }
      const connection = findConnection(state.doc, endPoint, 7);
      if (connection) {
        const connectionAnchor = snapAnchor(state.doc, connection, 'drag');
        if (
          connectionAnchor &&
          Math.hypot(
            connectionAnchor.point.x - anchor.point.x,
            connectionAnchor.point.y - anchor.point.y
          ) > 6
        ) {
          endPoint = connectionAnchor.point;
          limitAnchor = connectionAnchor;
        }
      }
    }

    if (bondExistsBetween(state.doc, anchor.point, endPoint)) {
      state.notify('这两个原子之间已存在化学键', 'warn');
      return true;
    }

    const limits = [maxNewBondOrderForAnchor(anchor)];
    if (limitAnchor) limits.push(maxNewBondOrderForAnchor(limitAnchor));
    const maxOrder = Math.min(...limits);
    if (maxOrder < 1) {
      state.notify(`${anchor.element} 原子价层已无空余容量，无法继续成键`, 'warn');
      return true;
    }
    let bondType = requestedType;
    if (requestedOrder > maxOrder) {
      bondType = maxOrder >= 3 ? 'triple' : maxOrder >= 2 ? 'double' : 'single';
      state.notify(
        `按 ${anchor.element} 的 σ/π 价层容量，键型已调整为${BOND_TYPE_LABEL[bondType]}`,
        'info'
      );
    }

    const bond = makeChemBond(
      layer.id,
      anchor.point,
      endPoint,
      bondType,
      anchorScale
    );
    const crossGroup =
      Boolean(anchor.group && directTarget?.group) &&
      anchor.group!.id !== directTarget!.group!.id;
    // 连接两个不同环的键不能只挂在其中一个环上，否则移动任一环都会把键拉断。
    const groupId = crossGroup ? null : anchor.group?.id ?? limitAnchor?.group?.id ?? null;
    if (groupId) {
      const attached = attachBondToGroup(state.doc, groupId, bond);
      if (attached) {
        state.updateDoc(attached, true);
        state.setSelection([bond.id]);
        return true;
      }
    }
    addWithSymmetry([bond]);
    return true;
  }

  function finishLinear(point: Vec, shift: boolean) {
    const drag = dragRef.current;
    if (!drag) return;
    const state = useAppStore.getState();
    const layer = drawLayer(state.doc);
    if (!layer || layer.locked) return;
    const tolerance = 11 / state.viewport.zoom;
    // 以按下时的原始指针位置判断单击，避免网格吸附把单击误判成拖拽
    const clicked = Math.hypot(point.x - drag.startPage.x, point.y - drag.startPage.y) < 5;

    // 拖拽成键必须与单击成键共用同一套目标吸附/价层/编组逻辑。
    // 之前只有单击分支做这些校验，拖拽会绕过它们生成超价、重复或环内键。
    if (!clicked && drag.mode === 'bond') {
      const originAnchor = snapAnchor(state.doc, drag.origin, 'drag');
      if (originAnchor) {
        createBondFromAnchor(originAnchor, point);
        return;
      }
      const targetAnchor =
        snapAnchor(state.doc, point, 'drag') ??
        nearestRingAnchor(state.doc, point);
      if (targetAnchor) {
        createBondFromAnchor(targetAnchor, drag.origin);
        return;
      }
    }

    if (clicked && drag.mode === 'bond') {
      // 1) 点在已有键身上：循环键级（单 → 双 → 三 → 单）
      const targetBond = findBondAt(state.doc, point, 8 / state.viewport.zoom);
      if (targetBond) {
        const parent = targetBond.parentId ? getObject(state.doc, targetBond.parentId) : null;
        if (parent && parent.type === 'group' && parent.ringStyle) {
          // 芳香环内部的键级属于共振式表达，由环样式统一控制；其余键走价层容量推导
          const groupBonds = allObjects(state.doc).filter(
            (obj): obj is BondObject => obj.type === 'bond' && obj.parentId === parent.id
          );
          const internal =
            ringGeometry(groupBonds)?.ringBonds.some((bond) => bond.id === targetBond.id) ?? false;
          if (internal) {
            state.notify('环内键的键级由环样式统一控制', 'info');
            return;
          }
        }
        const nextType = nextBondOrderType(targetBond.bondType);
        const validation = validateBondUpgrade(state.doc, targetBond, nextType);
        if (!validation.ok) {
          state.notify(validation.reason ?? '该键不能切换为多重键', 'warn');
          return;
        }
        state.updateDoc(
          replaceObject(state.doc, targetBond.id, (obj) =>
            obj.type === 'bond' ? { ...obj, bondType: nextType } : obj
          ),
          true
        );
        state.setSelection([targetBond.id]);
        state.notify(`键级切换为${BOND_TYPE_LABEL[nextType]}`, 'info');
        return;
      }

      // 2) 点在原子/键端点上：按杂化与剩余化合价计算规范几何后延伸
      const originAnchor =
        snapAnchor(state.doc, drag.origin, 'drag') ?? null;
      const targetAnchor =
        snapAnchor(state.doc, point, 'drag') ??
        nearestRingAnchor(state.doc, point);
      const anchor = originAnchor ?? targetAnchor;
      if (anchor) {
        const anchorScale = chemAnchorScale(anchor);
        const anchorLimit = maxNewBondOrderForAnchor(anchor);
        const requestedOrder = bondOrderForType(state.chem.bondType);
        const plannedOrder = Math.max(1, Math.min(requestedOrder, anchorLimit));
        // 从一个已有原子/端点拖到另一个原子/端点时，直接连接两点。
        // 只有没有明确目标时才回退到“标准键长 + 规范键角”的链增长。
        const directTarget =
          originAnchor &&
          targetAnchor &&
          Math.hypot(targetAnchor.point.x - originAnchor.point.x, targetAnchor.point.y - originAnchor.point.y) > 6
            ? targetAnchor
            : null;
        if (directTarget) {
          if (bondExistsBetween(state.doc, anchor.point, directTarget.point)) {
            state.notify('这两个原子之间已存在化学键', 'warn');
            return;
          }
          const targetLimit = maxNewBondOrderForAnchor(directTarget);
          const maxOrder = Math.min(anchorLimit, targetLimit);
          if (maxOrder < 1) {
            state.notify(
              `${anchor.element} 或目标原子价层已无空余容量，无法连接`,
              'warn'
            );
            return;
          }
          let bondType = state.chem.bondType;
          if (bondOrderForType(bondType) > maxOrder) {
            bondType = maxOrder >= 3 ? 'triple' : maxOrder >= 2 ? 'double' : 'single';
            state.notify(
              `按两端原子的 σ/π 价层容量，键型已调整为${BOND_TYPE_LABEL[bondType]}`,
              'info'
            );
          }
          const bond = makeChemBond(
            layer.id,
            anchor.point,
            directTarget.point,
            bondType,
            Math.max(anchorScale, chemAnchorScale(directTarget))
          );
          if (anchor.group) {
            const attached = attachBondToGroup(state.doc, anchor.group.id, bond);
            if (attached) {
              state.updateDoc(attached, true);
              state.setSelection([bond.id]);
              return;
            }
          }
          addWithSymmetry([bond]);
          return;
        }

        const preferred = {
          x: point.x - anchor.point.x,
          y: point.y - anchor.point.y
        };
        const geometry = nextChainBond(
          state.doc,
          anchor,
          preferred,
          plannedOrder,
          state.chemBondLength * anchorScale
        );
        if (!geometry) {
          state.notify(`${anchor.element} 原子已无剩余化合价，无法继续成键`, 'warn');
          return;
        }
        // 若规范落点正好落在已有原子/键端点上，则直接与之成键（符合绘图习惯）
        const targetConnection = findConnection(state.doc, geometry.end, 8);
        const target = targetConnection ?? geometry.end;
        if (bondExistsBetween(state.doc, geometry.start, target)) {
          state.notify('该位置已存在化学键', 'warn');
          return;
        }
        const targetConnAnchor = targetConnection
          ? snapAnchor(state.doc, target, 'drag')
          : null;
        // 由两端原子的价层 σ/π 容量推导可用的最高键级，而不是按工具/环类型写死
        const limits = [maxNewBondOrderForAnchor(anchor)];
        if (targetConnAnchor) limits.push(maxNewBondOrderForAnchor(targetConnAnchor));
        const maxOrder = Math.min(...limits);
        if (maxOrder < 1) {
          state.notify(`${anchor.element} 原子价层已无空余容量，无法继续成键`, 'warn');
          return;
        }
        let bondType = state.chem.bondType;
        if (bondOrderForType(bondType) > maxOrder) {
          bondType = maxOrder >= 3 ? 'triple' : maxOrder >= 2 ? 'double' : 'single';
          state.notify(
            `按 ${anchor.element} 的 σ/π 价层容量，键型已调整为${BOND_TYPE_LABEL[bondType]}`,
            'info'
          );
        }
        const bond = makeChemBond(
          layer.id,
          geometry.start,
          target,
          bondType,
          anchorScale
        );
        if (anchor.group) {
          // 苯环上长出的取代基并入环编组，随环一起移动/旋转
          const attached = attachBondToGroup(state.doc, anchor.group.id, bond);
          if (attached) {
            state.updateDoc(attached, true);
            state.setSelection([bond.id]);
            return;
          }
        }
        addWithSymmetry([bond]);
        return;
      }

      // 3) 空白处点击：沿用标准键长的默认方向
      addWithSymmetry([
        makeChemBond(
          layer.id,
          drag.origin,
          { x: drag.origin.x + state.chemBondLength, y: drag.origin.y },
          state.chem.bondType
        )
      ]);
      return;
    }

    const connection = findConnection(state.doc, point, tolerance);
    const startAnchor = snapAnchor(state.doc, drag.origin, 'drag');
    const startScale = drag.mode === 'bond' ? chemAnchorScale(startAnchor) : 1;
    const baseBondLength = state.chemBondLength * startScale;
    let end = connection ?? point;
    if (!connection) {
      if (state.snapEnabled && !shift) {
        end = gridPoint(end, state.doc, true, false);
      }
      if (!shift) {
        const dx = end.x - drag.origin.x;
        const dy = end.y - drag.origin.y;
        const length = Math.hypot(dx, dy);
        if (length > 6) {
          const angle = Math.atan2(dy, dx);
          const step = Math.PI / 12;
          const snappedAngle = Math.round(angle / step) * step;
          let snappedLength = length;
          const ideal = Math.round(length / baseBondLength) * baseBondLength;
          if (Math.abs(length - ideal) < 8) snappedLength = ideal;
          end = {
            x: drag.origin.x + Math.cos(snappedAngle) * snappedLength,
            y: drag.origin.y + Math.sin(snappedAngle) * snappedLength
          };
        }
      }
    }
    if (Math.hypot(end.x - drag.origin.x, end.y - drag.origin.y) < 5) {
      // 箭头在空白处单击时使用固定长度
      end = { x: drag.origin.x + 64, y: drag.origin.y };
    }
    if (
      drag.mode === 'bond' &&
      (state.chem.bondFixed || startScale !== 1)
    ) {
      // 固定化学键：拖拽只决定方向与摆放，长度回落到当前键长参数；已缩放结构沿用同一比例。
      const dx = end.x - drag.origin.x;
      const dy = end.y - drag.origin.y;
      const length = Math.hypot(dx, dy);
      if (length > 1) {
        end = {
          x: drag.origin.x + (dx / length) * baseBondLength,
          y: drag.origin.y + (dy / length) * baseBondLength
        };
      }
    }
    if (drag.mode === 'bond') {
      if (connection && Math.hypot(end.x - drag.origin.x, end.y - drag.origin.y) < 6) return;
      const endAnchor = connection ? snapAnchor(state.doc, connection, 'drag') : null;
      const bondType = state.chem.bondType;
      const order = bondOrderForType(bondType);
      if (startAnchor && startAnchor.free < order) {
        state.notify(`${startAnchor.element} 原子剩余化合价不足`, 'warn');
        return;
      }
      if (endAnchor && endAnchor.free < order) {
        state.notify(`${endAnchor.element} 原子剩余化合价不足`, 'warn');
        return;
      }
      addWithSymmetry([
        makeChemBond(layer.id, drag.origin, end, bondType, startScale)
      ]);
    } else {
      addWithSymmetry([
        createArrowObject(layer.id, CHEM_ARROW_STYLE, drag.origin, end, state.chem.arrowKind)
      ]);
    }
  }

  /**
   * 橡皮擦：按当前擦除目标，沿"本次新增的笔刷扫掠段"擦除。
   *
   * 每个 pointermove 只处理新增线段，相邻分段在手势起止处自然衔接：
   * 长手势不会退化成整条轨迹重算，快速划过时也不会漏擦中间区域。
   */
  function eraseStrokeAt(
    segments: Vec[][],
    targets: EraserTargets,
    allLayers = false,
    degradedBondIds?: Set<string>
  ) {
    if (segments.length === 0) return;
    const state = useAppStore.getState();
    // 橡皮半径与画笔一致使用页面单位：缩放后两者手感保持同级。
    const radius = state.eraserSize;
    // 默认只擦当前图层，Alt 临时全图层；避免分层作业时切断下方上色层。
    const layerId =
      state.eraserCurrentLayer && !allLayers ? drawLayer(state.doc)?.id ?? null : null;
    let nextDoc = state.doc;

    const apply = (path: Vec[]) => {
      if (path.length === 0) return;
      nextDoc = eraseAlongPath(nextDoc, path, { targets, radius, layerId, degradedBondIds });
    };

    for (const path of segments) {
      apply(path);
      if (state.symmetry === 'none') continue;
      // 对称：镜像同一段轨迹，与画笔的镜像落笔保持同一套几何关系。
      const fromMirrors = mirrorPointList(
        path[0],
        state.symmetryAxis,
        state.symmetry,
        page.width,
        page.height
      );
      const toMirrors =
        path.length > 1
          ? mirrorPointList(
              path[path.length - 1],
              state.symmetryAxis,
              state.symmetry,
              page.width,
              page.height
            )
          : [];
      fromMirrors.forEach((start, index) => {
        const end = toMirrors[index];
        if (end) apply([start, end]);
        else if (path.length === 1) apply([start]);
      });
    }

    if (nextDoc === state.doc) return;
    state.updateDoc(nextDoc, false);
    const remaining = new Set(allObjects(nextDoc).map((obj) => obj.id));
    const selection = state.selection.filter((id) => remaining.has(id));
    if (selection.length !== state.selection.length) state.setSelection(selection);
  }

  /** 画笔投影参数：预设决定压感/笔锋，滑杆决定线宽与平滑。 */
  function currentBrushProjection(pointerType: string): BrushProjection {
    const state = useAppStore.getState();
    const preset = brushPresetOf(state.brushPreset);
    return {
      smoothing: state.brushSmoothing,
      // 压感/渐隐来自当前笔刷（预设或自定义），鼠标不启用压感。
      pressure: state.brushPressure && pointerType === 'pen',
      taper: state.brushTaper,
      width: state.brushSize || preset.width,
      minRatio: 0.35,
      pressureCurve: state.brushPressureCurve
    };
  }

  function toBrushSample(
    point: Vec,
    event: { pressure?: number; timeStamp?: number; tiltX?: number; tiltY?: number } | null,
    pointerType: string
  ): BrushSample {
    const raw = pointerType === 'pen' ? (event?.pressure ?? 0.5) : 1;
    return {
      x: point.x,
      y: point.y,
      pressure: Math.max(0.02, Math.min(1, raw)),
      t: event?.timeStamp ?? performance.now(),
      tiltX: pointerType === 'pen' ? event?.tiltX ?? 0 : 0,
      tiltY: pointerType === 'pen' ? event?.tiltY ?? 0 : 0
    };
  }

  /** 画笔实时层颜色：与 finishBrush 完全同源（填充色优先，回落到描边色）。 */
  function brushInkColor(): string {
    const style = useAppStore.getState().defaultStyle;
    if (style.fill.type === 'solid') return style.fill.color;
    if (style.stroke.paint.type === 'solid') return style.stroke.paint.color;
    return '#1b1b1b';
  }

  /** 画一段实时笔迹；对称开启时在同一帧补上镜像段。 */
  function drawInkSegment(from: BrushSample, to: BrushSample, nib?: NibShape) {
    const layer = brushInkRef.current;
    if (!layer) return;
    layer.segment(from, to, nib, 0);
    const state = useAppStore.getState();
    if (state.symmetry === 'none') return;
    const fromMirrors = mirrorPointList(
      from,
      state.symmetryAxis,
      state.symmetry,
      page.width,
      page.height
    );
    const toMirrors = mirrorPointList(
      to,
      state.symmetryAxis,
      state.symmetry,
      page.width,
      page.height
    );
    fromMirrors.forEach((mirrorFrom, index) => {
      const mirrorTo = toMirrors[index];
      // 每个镜像通道独立记录采样，避免与原笔迹互相干扰。
      if (mirrorTo) {
        layer.segment(
          { ...from, x: mirrorFrom.x, y: mirrorFrom.y },
          { ...to, x: mirrorTo.x, y: mirrorTo.y },
          nib,
          index + 1
        );
      }
    });
  }

  function beginBrushInk(projection: BrushProjection) {
    const state = useAppStore.getState();
    // 实时 dab 与落笔后的矢量 dab 共用一个种子，松手时纹理不会跳变。
    brushSeedRef.current = Math.floor(Math.random() * 0x7fffffff) + 1;
    brushInkRef.current?.begin({
      color: brushInkColor(),
      opacity: state.brushOpacity,
      hardness: state.brushHardness,
      spacing: state.brushSpacing,
      texture: state.brushTexture,
      flow: state.brushFlow,
      blendMode: state.brushBlendMode,
      // dab 间距以标称笔宽为基准，与落笔后的最大节点宽度口径一致。
      size: state.brushSize,
      // 与 finishBrush 同源：没有入库材质的普通勾线，实时层也不再额外画软边/dab。
      material: hasBrushMaterial({
        hardness: state.brushHardness,
        texture: state.brushTexture,
        flow: state.brushFlow,
        blendMode: state.brushBlendMode
      }),
      projection,
      seed: brushSeedRef.current
    });
    const first = brushSamplesRef.current[0];
    if (!first) return;
    // 极短段 + 圆头 = 落笔圆点（倾斜时是椭圆）
    drawInkSegment(first, { ...first, x: first.x + 0.01 }, nibFromTilt(first.tiltX, first.tiltY));
  }

  /**
   * 预览帧：所有 pointermove（含合并后的子帧采样）只在下一帧更新一次光标；
   * 笔迹本身由 Canvas 实时层直接绘制，不再重算 SVG 轮廓。
   */
  function scheduleBrushFrame() {
    if (brushRafRef.current !== null) return;
    brushRafRef.current = window.requestAnimationFrame(() => {
      brushRafRef.current = null;
      const pendingCursor = pendingCursorRef.current;
      if (pendingCursor && pendingCursor !== lastCursorRef.current) {
        lastCursorRef.current = pendingCursor;
        setCursor(pendingCursor);
      }
    });
  }

  function flushBrushFrame() {
    if (brushRafRef.current !== null) {
      window.cancelAnimationFrame(brushRafRef.current);
      brushRafRef.current = null;
    }
  }

  /** 结束自由绘制：采样 → 平滑 → 抽稀 → 贝塞尔拟合 → 入档。 */
  function finishBrush(releasePoint?: Vec) {
    flushBrushFrame();
    const state = useAppStore.getState();
    const projection = brushProjectionRef.current ?? currentBrushProjection('mouse');
    const samples = brushSamplesRef.current;
    // 抬手补点：滤波会让最后一个采样落后于指针，不补点会明显缩短笔迹末端。
    const tail = samples[samples.length - 1];
    if (releasePoint && tail && Math.hypot(releasePoint.x - tail.x, releasePoint.y - tail.y) > 0.05) {
      const releaseSample = {
        x: releasePoint.x,
        y: releasePoint.y,
        pressure: tail.pressure,
        t: tail.t + 8
      };
      // 实时层也补到真实释放点：否则末段只在矢量层出现，松手会"长出一截"。
      drawInkSegment(tail, releaseSample, nibFromTilt(tail.tiltX, tail.tiltY));
      samples.push(releaseSample);
    }
    brushSamplesRef.current = [];
    brushProjectionRef.current = null;
    pendingCursorRef.current = null;
    setBrushPreview(null);

    const layer = drawLayer(state.doc);
    if (!layer || samples.length === 0) {
      // 没有可落笔的图层/采样：实时层没有任何矢量层接管，必须立刻清掉。
      brushInkRef.current?.clear();
      state.endTransaction();
      return;
    }
    const { nodes } = buildBrushNodes(samples, projection);
    if (nodes.length < 2) {
      brushInkRef.current?.clear();
      state.endTransaction();
      return;
    }
    // 倾斜笔迹：把平均倾斜写入节点，落笔后的矢量轮廓与导出保持扁笔效果。
    const tilted = samples.filter(
      (sample) => typeof sample.tiltX === 'number' || typeof sample.tiltY === 'number'
    );
    if (tilted.length > 0) {
      const avgX = tilted.reduce((sum, sample) => sum + (sample.tiltX ?? 0), 0) / tilted.length;
      const avgY = tilted.reduce((sum, sample) => sum + (sample.tiltY ?? 0), 0) / tilted.length;
      const nib = nibFromTilt(avgX, avgY);
      if (nib.aspect < 0.985) {
        for (const node of nodes) {
          node.nibAngle = nib.angle;
          node.nibAspect = nib.aspect;
        }
      }
    }
    const style = cloneStyle(state.defaultStyle);
    // 画笔颜色以"当前填充色"为主，回落到描边色，最后是默认墨色。
    const paint =
      state.defaultStyle.fill.type === 'solid'
        ? state.defaultStyle.fill.color
        : state.defaultStyle.stroke.paint.type === 'solid'
          ? state.defaultStyle.stroke.paint.color
          : '#1b1b1b';
    style.fill = { type: 'none' };
    style.stroke = {
      ...style.stroke,
      width: projection.width,
      paint: { type: 'solid', color: paint },
      cap: 'round',
      join: 'round',
      dash: []
    };
    style.opacity = state.brushOpacity;
    // P6：低不透明度笔迹在自交处切段，让交叉区域真正叠色；高不透明度保持单路径。
    const splitParts =
      state.brushOpacity < 0.95 ? splitStrokeAtSelfIntersection(nodes) : null;
    const parts = splitParts ?? [nodes];
    // 只有真正偏离"实心硬边"的笔才存材质；阈值与实时层共用 hasBrushMaterial。
    const material = hasBrushMaterial({
      hardness: state.brushHardness,
      texture: state.brushTexture,
      flow: state.brushFlow,
      blendMode: state.brushBlendMode
    })
        ? {
            hardness: state.brushHardness,
            spacing: state.brushSpacing,
            texture: state.brushTexture,
            // 与实时层同一颗种子：松手后纹理图案原地保留，不会重新生成。
            seed: brushSeedRef.current,
            flow: state.brushFlow,
            blendMode: state.brushBlendMode
          }
        : null;
    const objects: SceneObject[] = [];
    for (const part of parts) {
      const path = createPathObject(layer.id, cloneStyle(style), part, false);
      // 同一笔切出的多段共享名称，图层面板里能看出它们属于同一条笔迹。
      path.name = '画笔笔迹';
      if (material) path.brushMaterial = { ...material };
      objects.push(path);
      if (state.symmetry !== 'none') {
        objects.push(
          ...mirrorObject(
            path,
            state.symmetryAxis,
            state.symmetry,
            page.width,
            page.height
          )
        );
      }
    }
    state.addObjects(objects);
    // 成品已入库：下一帧把实时层整层清掉（无过渡），避免两层重叠造成闪烁。
    brushInkRef.current?.handoff();
    state.endTransaction();
  }

  function finishMarquee(shift: boolean, endPoint: Vec) {
    const drag = dragRef.current;
    if (!drag) return;
    const state = useAppStore.getState();
    const rect = rectFromPoints(drag.startPage, endPoint);
    if (rect.width < 2 && rect.height < 2) {
      if (!shift) state.clearSelection();
      return;
    }
    const ids: string[] = [];
    for (const layer of state.doc.layers) {
      if (!layer.visible || layer.locked) continue;
      for (const obj of layer.objects) {
        if (!obj.visible || obj.parentId) continue;
        if (rectsIntersect(rect, getObjectBounds(obj, state.doc))) ids.push(obj.id);
      }
    }
    state.setSelection(ids, shift);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const nativeUp = event.nativeEvent as PointerEvent;
    if (nativeUp.pointerType === 'touch' && touchPointersRef.current.has(nativeUp.pointerId)) {
      const wasGesture = touchGestureRef.current !== null;
      touchPointersRef.current.delete(nativeUp.pointerId);
      if (touchPointersRef.current.size < 2) touchGestureRef.current = null;
      if (wasGesture) {
        try {
          event.currentTarget.releasePointerCapture(nativeUp.pointerId);
        } catch {
          /* 合成事件无需释放 */
        }
        return;
      }
    }
    const drag = dragRef.current;
    const state = useAppStore.getState();
    const point = pagePoint(event);
    setSnapHint(null);

    if (panRef.current) {
      panRef.current = null;
      setPanning(false);
    }

    if (drag) {
      if (drag.mode === 'move' || drag.mode === 'resize' || drag.mode === 'rotate' || drag.mode === 'node' || drag.mode === 'curve') {
        const moved = Math.hypot(point.x - drag.startPage.x, point.y - drag.startPage.y) >= 2;
        // 没有位移且没有预览时不重算：避免 node/resize 的一次单击压入空撤销记录；
        // 已经产生过预览的手势仍要更新到最终点，保证「拖出去又拖回来」能正确收尾。
        if (moved || drag.preview || drag.previewDoc) {
          updateDrag(point, event.shiftKey, event.altKey);
        }
        if (drag.mode === 'move' || drag.mode === 'rotate' || drag.mode === 'resize') {
          // 事务仍在（beginTransaction 于按下时开启），这里用 record=false 写入最终文档，
          // 由 endTransaction 统一压一条历史并同步镜像。
          const finalDoc = commitTransformDrag(drag);
          if (finalDoc) state.updateDoc(finalDoc, false);
          state.setDragPreview(null);
        }
        state.endTransaction();
      } else if (drag.mode === 'create') {
        finishCreate(point, event.shiftKey, event.altKey);
      } else if (drag.mode === 'bond' || drag.mode === 'arrow') {
        finishLinear(point, event.shiftKey);
      } else if (drag.mode === 'erase') {
        // 抬起时补齐最后一个采样点，避免快速划出画布时留下未擦除的尾巴
        const target =
          guideAssist && guideMode !== 'none'
            ? snapToGuideDirection(
                drag.startPage,
                point,
                guideMode,
                guideSettings,
                page.width,
                page.height
              )
            : point;
        const from = drag.lastErase ?? drag.startPage;
        drag.lastErase = target;
        if (Math.hypot(target.x - from.x, target.y - from.y) > 0.01) {
          eraseStrokeAt(
            [[from, target]],
            currentEraseTargets(),
            drag.eraseAllLayers,
            drag.erasedBondIds
          );
        }
        state.endTransaction();
      } else if (drag.mode === 'brush') {
        // 抬手补点同样要服从绘画辅助约束，否则笔迹末端会甩出一条偏离辅助线的尾巴。
        const release =
          guideAssist && guideMode !== 'none'
            ? snapToGuideDirection(
                drag.startPage,
                point,
                guideMode,
                guideSettings,
                page.width,
                page.height
              )
            : point;
        finishBrush(release);
      } else if (drag.mode === 'bucket-fill' || drag.mode === 'text-width') {
        // 连续填充/框宽拖拽的手势事务在这里统一提交，中间不再各写一条历史。
        state.endTransaction();
      } else if (drag.mode === 'zoom-marquee') {
        const rect = rectFromPoints(drag.startPage, point);
        if (rect.width < 8 || rect.height < 8) {
          zoomAt(event.altKey ? 1 / 1.25 : 1.25, drag.startScreen);
        } else {
          const totalWidth = state.viewportSize.width || size.width;
          const height = state.viewportSize.height || size.height;
          const inset = state.canvasLeftInset;
          const width = Math.max(80, totalWidth - inset);
          const zoom = clamp(
            Math.min(width / rect.width, height / rect.height),
            MIN_ZOOM,
            MAX_ZOOM
          );
          const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          state.setViewport({
            zoom,
            pan: {
              x: inset + width / 2 - center.x * zoom,
              y: height / 2 - center.y * zoom
            }
          });
        }
      } else if (drag.mode === 'marquee') {
        finishMarquee(event.shiftKey, point);
      }
      dragRef.current = null;
    }
    // 兜底：任何手势结束都不残留 transform 预览。
    state.setDragPreview(null);

    setPreview(null);
    setMarquee(null);
    setGuides({ x: [], y: [] });
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* 合成事件无需释放 */
    }
  }

  /** 指针交互被中断时清理平移/触控状态，避免下一次移动继续沿用旧手势。 */
  function resetPointerInteraction(pointerId?: number) {
    if (panRef.current) {
      panRef.current = null;
      setPanning(false);
    }
    if (typeof pointerId === 'number') touchPointersRef.current.delete(pointerId);
    if (touchPointersRef.current.size < 2) touchGestureRef.current = null;
  }

  /** pointercancel 表示手势被系统中断（笔离开、触控被接管等）：必须丢弃，不能当抬笔提交。 */
  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current) cancelActiveOperation('指针中断，已取消当前操作');
    resetPointerInteraction(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* 合成事件无需释放 */
    }
    setCursor(null);
    setBondHover(null);
    setSnapHint(null);
  }

  /** 捕获被系统回收时不会再有 pointerup：主动取消，避免"未按键也继续画"。 */
  function handleLostPointerCapture() {
    resetPointerInteraction();
    if (!dragRef.current) return;
    cancelActiveOperation('指针捕获丢失，已取消当前操作');
  }

  /** 右键或 Esc 取消进行中的绘制：回滚拖拽产生的文档修改并结束交互。 */
  function cancelActiveOperation(message = '已取消本次绘制'): boolean {
    const drag = dragRef.current;
    const state = useAppStore.getState();
    const hadOperation = Boolean(drag || penDraft || preview);
    if (drag) {
      // 这些手势会"边拖边改文档"：取消时必须回滚，否则 Esc 反而提交已改内容。
      const docMutating =
        drag.mode === 'move' ||
        drag.mode === 'resize' ||
        drag.mode === 'rotate' ||
        drag.mode === 'node' ||
        drag.mode === 'curve' ||
        drag.mode === 'erase' ||
        drag.mode === 'bucket-fill' ||
        drag.mode === 'text-width';
      if (docMutating) state.updateDoc(drag.startDoc, false);
      // 任何手势都可能持有 pendingSnapshot：统一收口。未改动文档时 endTransaction 不会产生历史。
      state.endTransaction();
      state.setDragPreview(null);
      dragRef.current = null;
    }
    setPreview(null);
    setMarquee(null);
    setGuides({ x: [], y: [] });
    flushBrushFrame();
    brushSamplesRef.current = [];
    brushProjectionRef.current = null;
    pendingCursorRef.current = null;
    setBrushPreview(null);
    brushInkRef.current?.clear();
    setPenDraft(null);
    setContextMenu(null);
    if (hadOperation) {
      // 取消只放弃本次操作，不强制切换工具：连续作画时不必重新选笔。
      state.notify(message, 'info');
    }
    return hadOperation;
  }

  function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    // 右击时浏览器可能保留上一段文本选择，导致菜单文字看起来全部处于选中态。
    window.getSelection()?.removeAllRanges();
    const state = useAppStore.getState();
    const local = localPoint(event);
    const point = pagePoint(event);
    const hit = hitTestDocument(state.doc, point, 8 / state.viewport.zoom);

    if (penDraft) {
      // 行业惯例：右键结束路径；Alt+右键才是取消。避免"想收笔却丢整条"。
      if (event.altKey) cancelActiveOperation('已取消当前路径');
      else finishPen(false);
      return;
    }
    if (dragRef.current || preview) {
      cancelActiveOperation();
      return;
    }

    if (activeTool === 'curve' && state.selection.length === 1) {
      const selected = getObject(state.doc, state.selection[0]);
      if (selected?.type === 'path') {
        const index = curveHandleIndex(selected, point, state.viewport.zoom);
        if (index > 0) {
          const layer = getLayerOfObject(state.doc, selected.id);
          if (!layer || layer.locked) {
            state.notify('当前图层已锁定，无法删除拖拽点', 'warn');
            return;
          }
          const nodes = selected.nodes.filter((_, itemIndex) => itemIndex !== index);
          const next = curvePathWithNodes(selected, smoothCurveNodes(nodes));
          state.updateDoc(replaceObject(state.doc, selected.id, () => next), true);
          state.setSelection([selected.id]);
          setContextMenu(null);
          state.notify('已删除拖拽点并还原该处形状', 'info');
          return;
        }
      }
    }

    if (!hit) {
      setContextMenu(null);
      if (activeTool !== 'select' && activeTool !== 'hand' && activeTool !== 'zoom') {
        state.setTool('select');
        state.notify('已取消当前操作，返回选择工具', 'info');
      } else {
        state.clearSelection();
      }
      return;
    }
    state.setSelection([hit.id]);
    const layer = getLayerOfObject(state.doc, hit.id);
    if (layer) state.setActiveLayer(layer.id);
    setContextMenu({
      x: Math.max(8, Math.min(local.x, size.width - 214)),
      y: Math.max(8, Math.min(local.y, size.height - 228)),
      objectId: hit.id,
      name: hit.name,
      type: hit.type
    });
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    const state = useAppStore.getState();
    // 双击结束钢笔路径（第二次按下会被重合点去重，不会留下零长段）。
    if (state.activeTool === 'pen' && penDraft) {
      finishPen(false);
      return;
    }
    const point = pagePoint(event);
    const hit = hitTestDocument(state.doc, point, 8 / state.viewport.zoom);
    if (!hit) return;
    if (hit.type === 'text') {
      state.setSelection([hit.id]);
      openTextEditorForObject(hit as TextObject);
      return;
    }
    if (hit.type === 'bond') {
      const bond = getObject(state.doc, hit.id);
      if (!bond || bond.type !== 'bond') return;
      // 双击键循环键型：单 → 双 → 三 → 芳香 → 单；跳过价层不允许的档位。
      const order = ['single', 'double', 'triple', 'aromatic'] as const;
      const found = order.indexOf(bond.bondType as (typeof order)[number]);
      // 楔形/虚线楔等立体键从「单键」开始轮转。
      const startIndex = found >= 0 ? found : -1;
      let nextType = nextBondOrderType(bond.bondType);
      let lastReason: string | null = null;
      for (let step = 1; step <= order.length; step += 1) {
        const candidate = order[(startIndex + step) % order.length];
        const validation = validateBondUpgrade(state.doc, bond, candidate);
        if (validation.ok) {
          nextType = candidate;
          lastReason = null;
          break;
        }
        lastReason = validation.reason ?? lastReason;
      }
      if (lastReason) {
        state.notify(lastReason, 'warn');
        return;
      }
      state.setSelection([bond.id]);
      state.updateDoc(
        replaceObject(state.doc, bond.id, (obj) =>
          obj.type === 'bond' ? { ...obj, bondType: nextType } : obj
        ),
        true
      );
      state.notify(`键型已切换为 ${BOND_TYPE_LABEL[nextType] ?? nextType}`, 'success');
      return;
    }
    if (hit.type === 'atom') {
      state.setSelection([hit.id]);
      state.openProperties();
      window.requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('[data-prop-focus="atom-element"]');
        input?.focus();
        input?.select();
      });
      return;
    }
    if (hit.type === 'rect' || hit.type === 'ellipse') {
      state.setSelection([hit.id]);
      state.openProperties();
      window.requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-prop-focus="transform"] input'
        );
        input?.focus();
        input?.select();
      });
      return;
    }
    if (hit.type === 'arrow') {
      // 与矩形/椭圆一致：双击直接进入可编辑字段，不再只弹一条指路 toast。
      state.setSelection([hit.id]);
      state.openProperties();
      window.requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-prop-focus="arrow-label"] input'
        );
        input?.focus();
        input?.select();
      });
      return;
    }
    if (hit.type === 'path' && state.activeTool === 'node') {
      const path = hit as PathObject;
      const layer = getLayerOfObject(state.doc, path.id);
      if (!layer || layer.locked) {
        state.notify('当前图层已锁定，无法编辑节点', 'warn');
        return;
      }
      const localPoint = curveLocalPoint(path, point);
      const tolerance = 10 / state.viewport.zoom;
      const nodeHit = path.nodes.find(
        (node) => Math.hypot(localPoint.x - node.x, localPoint.y - node.y) <= tolerance
      );
      if (nodeHit) {
        toggleNodeSmooth(path, nodeHit.id);
        applyNodeSelection([nodeHit.id]);
        return;
      }
      const nearest = nearestCurvePoint(path.nodes, localPoint, path.closed);
      if (!nearest || nearest.distance > tolerance) return;
      const insertedNode = makeNode(nearest.point.x, nearest.point.y);
      const raw = [
        ...path.nodes.slice(0, nearest.segment + 1),
        insertedNode,
        ...path.nodes.slice(nearest.segment + 1)
      ];
      const affected = new Set([
        nearest.segment,
        nearest.segment + 1,
        nearest.segment + 2
      ]);
      const inserted = curvePathWithNodes(path, smoothCurveNodes(raw, affected));
      state.updateDoc(replaceObject(state.doc, path.id, () => inserted), true);
      state.setSelection([path.id]);
      applyNodeSelection([insertedNode.id]);
      state.notify('已插入节点，双击其他位置可继续加点', 'info');
      return;
    }
    if (hit.type === 'path' && state.activeTool === 'curve') {
      state.setSelection([hit.id]);
      state.setTool('node');
      return;
    }
    if (hit.type === 'group') {
      for (const layer of state.doc.layers) {
        for (const obj of layer.objects) {
          if (obj.parentId === hit.id && hitTestObject(obj, point, 8 / state.viewport.zoom)) {
            state.setSelection([obj.id]);
            return;
          }
        }
      }
    }
  }

  const overlayScale = Math.min(1 / zoom, page.width / 420, page.height / 300);
  const mirroredPreviews =
    preview && symmetry !== 'none'
      ? mirrorObject(preview, symmetryAxis, symmetry, page.width, page.height)
      : [];
  // 钢笔草稿的镜像虚影：让"对称绘制"在落笔前就可见。
  const penMirrorPaths: string[] =
    activeTool === 'pen' && penDraft && penDraft.nodes.length > 1 && symmetry !== 'none'
      ? mirrorObject(
          {
            id: 'pen-preview',
            type: 'path',
            name: '',
            layerId: '',
            parentId: null,
            visible: true,
            locked: false,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            rotation: 0,
            style: {
              fill: { type: 'none' },
              stroke: { paint: { type: 'none' }, width: 1, cap: 'round', join: 'round', dash: [] },
              opacity: 1
            },
            nodes: penDraft.nodes,
            closed: false
          } as PathObject,
          symmetryAxis,
          symmetry,
          page.width,
          page.height
        )
          .filter((item): item is PathObject => item.type === 'path')
          .map((item) => pathData(item.nodes, false))
      : [];
  const eraserMirrorPoints =
    (activeTool === 'eraser' || activeTool === 'eraser-live') && cursor && symmetry !== 'none'
      ? mirrorPointList(cursor, symmetryAxis, symmetry, page.width, page.height)
      : [];
  const selectedObject = selection.length === 1 ? getObject(doc, selection[0]) : null;
  const contextPath = contextMenu ? getObject(doc, contextMenu.objectId) : null;
  const contextPathClosed = contextPath?.type === 'path' ? contextPath.closed : false;
  const contextLocked = contextPath?.locked === true;
  const curveEditingPath =
    activeTool === 'curve' && selectedObject?.type === 'path'
      ? selectedObject
      : null;
  // C8：只渲染视口内节点，超密笔迹再按步长抽样，避免长笔迹拖慢编辑。
  const curveDisplayNodes = useMemo(() => {
    if (!curveEditingPath) return [] as { node: PathNode; index: number }[];
    const margin = 60 / zoom;
    const left = -viewport.pan.x / zoom - margin;
    const top = -viewport.pan.y / zoom - margin;
    const right = (size.width - viewport.pan.x) / zoom + margin;
    const bottom = (size.height - viewport.pan.y) / zoom + margin;
    const entries = curveEditingPath.nodes
      .map((node, index) => ({ node, index }))
      .filter(
        ({ node }) => node.x >= left && node.x <= right && node.y >= top && node.y <= bottom
      );
    if (entries.length <= 400) return entries;
    const stride = Math.ceil(entries.length / 400);
    return entries.filter(
      (_, position) => position % stride === 0 || position === entries.length - 1
    );
  }, [curveEditingPath, viewport.pan.x, viewport.pan.y, zoom, size.width, size.height]);
  // E5：大文档才启用视口裁剪，普通文档保持"全部渲染"，
  // 避免小文档里贴边对象因裁剪消失（也保持既有冒烟计数不变）。
  const sceneViewRect = useMemo(() => {
    let total = 0;
    let nodes = 0;
    for (const layer of doc.layers) {
      total += layer.objects.length;
      for (const object of layer.objects) {
        if (object.type === 'path') nodes += object.nodes.length;
      }
    }
    // 对象多或路径节点多都值得裁剪：一条数千节点的笔迹比几十个小图形更贵。
    return total > 250 || nodes > 6000 ? viewRectForViewport(size, viewport) : undefined;
  }, [doc, size.width, size.height, viewport]);
  // 绘制预览：与落笔后同样按"中心线 + 宽度包络"生成轮廓，尺寸/压感所见即所得。
  const brushPreviewOutlines: string[] = [];
  if (brushPreview && brushPreview.points.length > 1) {
    const buildOutline = (points: Vec[], widths: number[]) => {
      const nodes = points.map((point, index) => {
        const node = makeNode(point.x, point.y);
        node.width = widths[index] ?? widths[0] ?? brushSize;
        return node;
      });
      return brushOutlineData(nodes);
    };
    const main = buildOutline(brushPreview.points, brushPreview.widths);
    if (main) brushPreviewOutlines.push(main);
    if (symmetry !== 'none') {
      const mirrored = brushPreview.points.map((point) =>
        mirrorPointList(point, symmetryAxis, symmetry, page.width, page.height)
      );
      const count = mirrored[0]?.length ?? 0;
      for (let index = 0; index < count; index += 1) {
        const outline = buildOutline(
          mirrored.map((list) => list[index]),
          brushPreview.widths
        );
        if (outline) brushPreviewOutlines.push(outline);
      }
    }
  }
  const brushPreviewDot =
    brushPreview && brushPreview.points.length === 1
      ? { point: brushPreview.points[0], width: brushPreview.widths[0] ?? brushSize }
      : null;
  const brushPaintWidth = brushSize;
  const brushPaintOpacity = brushOpacity;
  const defaultStrokeColor =
    defaultStyle.fill.type === 'solid'
      ? defaultStyle.fill.color
      : defaultStyle.stroke.paint.type === 'solid'
        ? defaultStyle.stroke.paint.color
        : '#1b1b1b';

  return (
    <div
      className={`canvas-area${showRulers ? '' : ' canvas-area--no-rulers'}`}
      style={{ '--canvas-inset-left': `${canvasLeftInset}px` } as CSSProperties}
    >
      {showRulers ? (
        <Rulers
          width={size.width}
          height={size.height}
          viewport={viewport}
          pageWidth={page.width}
          pageHeight={page.height}
        />
      ) : null}

      <div
        ref={viewportRef}
        className={`canvas-viewport ${cursorClass(activeTool, panning, spaceHeld)}`}
        data-testid="canvas-hit"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onPointerLeave={() => {
          setCursor(null);
          setBondHover(null);
          setSnapHint(null);
        }}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        style={{ inset: showRulers ? '22px 0 0 22px' : 0 }}
      >
        <ToolModeBar />
        {textComposer ? (
          <TextComposer
            value={textComposer.text}
            onChange={(text) =>
              setComposer(textComposerRef.current ? { ...textComposerRef.current, text } : null)
            }
            onConfirm={confirmTextComposer}
            onCancel={() => closeTextComposer()}
          />
        ) : null}
        {guideAssist && guideMode !== 'none' ? (
          <div className="guide-assist-badge" data-testid="guide-assist-badge">
            沿辅助线绘制
          </div>
        ) : null}
        {sizeHud ? (
          <div className="brush-hud" data-testid="brush-hud" aria-hidden="true">
            <span
              className="brush-hud__dot"
              style={{
                width: Math.min(96, Math.max(4, (activeTool === 'brush' ? brushSize : eraserSize) * zoom)),
                height: Math.min(96, Math.max(4, (activeTool === 'brush' ? brushSize : eraserSize) * zoom))
              }}
            />
            <span className="brush-hud__value">
              {activeTool === 'brush' ? `画笔 ${brushSize}px` : `橡皮 ${eraserSize}px`}
            </span>
          </div>
        ) : null}
        {!textComposer && !doc.layers.some((layer) => layer.objects.length > 0) ? (
          <div
            className="canvas-empty-guide"
            data-testid="canvas-empty-guide"
            role="note"
            style={{ left: `calc(50% + ${canvasLeftInset / 2}px)` }}
          >
            <strong>开始绘制</strong>
            <ul>
              <li>
                <kbd>B</kbd> 拖拽画化学键；单击按标准键长落笔
              </li>
              <li>左侧「化学工具 → 苯环」插入芳香环</li>
              <li>
                <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存到本地 .vdraw 文件
              </li>
            </ul>
            <span>画下第一笔后，本提示自动消失</span>
          </div>
        ) : null}
        <svg className="canvas-svg" width={size.width} height={size.height}>
          <defs>
            <filter id="page-shadow" x="-12%" y="-12%" width="124%" height="124%">
              <feDropShadow dx="0" dy="5" stdDeviation="9" floodColor="#1b2333" floodOpacity="0.16" />
            </filter>
            <linearGradient id="placeholder-stroke" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#c3cfe6" />
              <stop offset="1" stopColor="#d7dbe6" />
            </linearGradient>
            <pattern id="transparent-checker" width={16} height={16} patternUnits="userSpaceOnUse">
              <rect width={16} height={16} fill="#ffffff" />
              <rect width={8} height={8} fill="#e6e9ef" />
              <rect x={8} y={8} width={8} height={8} fill="#e6e9ef" />
            </pattern>
          </defs>

          <g ref={sceneRef} transform={`translate(${viewport.pan.x} ${viewport.pan.y}) scale(${zoom})`}>
            <rect
              data-testid="canvas-page"
              data-page-width={page.width}
              data-page-height={page.height}
              x={0}
              y={0}
              width={page.width}
              height={page.height}
              data-background-visible={page.backgroundVisible !== false}
              fill={
                page.backgroundVisible === false
                  ? 'url(#transparent-checker)'
                  : page.background
              }
              filter={page.infinite ? undefined : 'url(#page-shadow)'}
            />

            {showGrid ? (
              <>
                <path d={gridPaths.minor} stroke={gridStroke.minor} strokeWidth={1 / zoom} fill="none" />
                <path d={gridPaths.major} stroke={gridStroke.major} strokeWidth={1 / zoom} fill="none" />
              </>
            ) : null}

            <rect
              x={0}
              y={0}
              width={page.width}
              height={page.height}
              fill="none"
              stroke="#dbe0e9"
              strokeWidth={1 / zoom}
            />

            <CanvasGuides
              pageWidth={page.width}
              pageHeight={page.height}
              zoom={zoom}
              symmetry={symmetry}
              axis={symmetryAxis}
              guideMode={guideMode}
              settings={guideSettings}
              density={guideDensity}
              gridStep={doc.grid.size}
              reference={guideSpacing}
            />

            <SceneRenderer doc={doc} viewRect={sceneViewRect} />
            {preview ? <SceneObjectView object={preview} doc={doc} /> : null}
            {textDraftObject ? (
              <g pointerEvents="none" data-testid="text-draft">
                <SceneObjectView object={textDraftObject} doc={doc} />
              </g>
            ) : null}
            {mirroredPreviews.map((mirror) => (
              <SceneObjectView key={mirror.id} object={mirror} doc={doc} />
            ))}

            {brushPreviewOutlines.length > 0 || brushPreviewDot ? (
              <g pointerEvents="none" data-testid="brush-preview">
                {brushPreviewOutlines.map((outline, index) => (
                  <path
                    key={`brush-preview-${index}`}
                    d={outline}
                    fill={defaultStrokeColor}
                    fillRule="nonzero"
                    stroke="none"
                    opacity={brushPaintOpacity}
                  />
                ))}
                {brushPreviewDot ? (
                  <circle
                    cx={brushPreviewDot.point.x}
                    cy={brushPreviewDot.point.y}
                    r={Math.max(0.25, brushPreviewDot.width / 2)}
                    fill={defaultStrokeColor}
                    opacity={brushPaintOpacity}
                  />
                ) : null}
              </g>
            ) : null}

            {penDraft ? (
              <g pointerEvents="none">
                {penDraft.nodes.length > 0 ? (
                  <path
                    d={penPreviewData(penDraft.nodes, penDraft.cursor ?? penDraft.nodes[penDraft.nodes.length - 1])}
                    fill="none"
                    stroke="#3f6df0"
                    strokeWidth={1.4 / zoom}
                    strokeDasharray={`${5 / zoom} ${4 / zoom}`}
                  />
                ) : null}
                {penDraft.nodes.map((node, index) => (
                  <circle
                    key={node.id}
                    cx={node.x}
                    cy={node.y}
                    r={4 / zoom}
                    fill={index === 0 ? '#3f6df0' : '#ffffff'}
                    stroke="#3f6df0"
                    strokeWidth={1.4 / zoom}
                  />
                ))}
                {(() => {
                  const last = penDraft.nodes[penDraft.nodes.length - 1];
                  if (!last?.handleOut) return null;
                  return (
                    <g>
                      <line
                        x1={last.x}
                        y1={last.y}
                        x2={last.x + last.handleOut.x}
                        y2={last.y + last.handleOut.y}
                        stroke="#8b5cf6"
                        strokeWidth={1 / zoom}
                      />
                      <circle
                        cx={last.x + last.handleOut.x}
                        cy={last.y + last.handleOut.y}
                        r={2.6 / zoom}
                        fill="#ffffff"
                        stroke="#8b5cf6"
                        strokeWidth={1.2 / zoom}
                      />
                    </g>
                  );
                })()}
              </g>
            ) : null}

            {penMirrorPaths.length > 0 ? (
              <g pointerEvents="none" opacity={0.35}>
                {penMirrorPaths.map((d, index) => (
                  <path
                    key={`pen-mirror-${index}`}
                    d={d}
                    fill="none"
                    stroke="#3f6df0"
                    strokeWidth={1.4 / zoom}
                    strokeDasharray={`${5 / zoom} ${4 / zoom}`}
                  />
                ))}
              </g>
            ) : null}

            <SelectionOverlay
              doc={doc}
              selection={selection}
              zoom={zoom}
              activeTool={activeTool}
              marquee={marquee}
              guides={guides}
              issues={overlayIssues}
              selectedNodeIds={nodeSelection}
            />

            {curveEditingPath ? (
              <g
                data-testid="curve-points"
                data-curve-point-count={curveEditingPath.nodes.length}
                pointerEvents="none"
                transform={
                  curveEditingPath.rotation
                    ? `rotate(${curveEditingPath.rotation} ${
                        curveEditingPath.x + curveEditingPath.width / 2
                      } ${curveEditingPath.y + curveEditingPath.height / 2})`
                    : undefined
                }
              >
                {curveDisplayNodes.map(({ node, index }) => {
                  const interior = index > 0 && index < curveEditingPath.nodes.length - 1;
                  return (
                    <g key={node.id} data-curve-point-index={index}>
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={(interior ? 5.5 : 4) / zoom}
                        fill={interior ? '#ffffff' : '#3f6df0'}
                        stroke="#3f6df0"
                        strokeWidth={1.5 / zoom}
                      />
                      {interior ? (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={2 / zoom}
                          fill="#3f6df0"
                        />
                      ) : null}
                    </g>
                  );
                })}
              </g>
            ) : null}

            {toolHover ? (
              <rect
                data-testid="tool-hover"
                x={toolHover.x}
                y={toolHover.y}
                width={toolHover.width}
                height={toolHover.height}
                fill="none"
                stroke="#3f6df0"
                strokeWidth={1.2 / zoom}
                strokeDasharray={`${5 / zoom} ${4 / zoom}`}
                opacity={0.7}
                pointerEvents="none"
              />
            ) : null}

            {snapHint ? (
              <g pointerEvents="none" data-testid="shape-snap-hint">
                <line
                  x1={snapHint.point.x}
                  y1={0}
                  x2={snapHint.point.x}
                  y2={page.height}
                  stroke="#3f6df0"
                  strokeWidth={1 / zoom}
                  strokeDasharray={`${4 / zoom} ${5 / zoom}`}
                  opacity={0.38}
                />
                <line
                  x1={0}
                  y1={snapHint.point.y}
                  x2={page.width}
                  y2={snapHint.point.y}
                  stroke="#3f6df0"
                  strokeWidth={1 / zoom}
                  strokeDasharray={`${4 / zoom} ${5 / zoom}`}
                  opacity={0.38}
                />
                <circle
                  cx={snapHint.point.x}
                  cy={snapHint.point.y}
                  r={5.5 / zoom}
                  fill="#ffffff"
                  stroke="#3f6df0"
                  strokeWidth={1.6 / zoom}
                />
                <circle
                  cx={snapHint.point.x}
                  cy={snapHint.point.y}
                  r={1.6 / zoom}
                  fill="#3f6df0"
                />
                <g
                  transform={`translate(${snapHint.point.x + 11 / zoom} ${
                    snapHint.point.y + 11 / zoom
                  })`}
                >
                  <rect
                    width={(118 + String(snapHint.step).length * 6) / zoom}
                    height={17 / zoom}
                    rx={3 / zoom}
                    fill="rgba(37, 48, 68, 0.9)"
                  />
                  <text
                    x={6 / zoom}
                    y={12 / zoom}
                    fontSize={10 / zoom}
                    fill="#ffffff"
                    fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
                  >
                    吸附 {snapHint.step}px · {Math.round(snapHint.point.x)},{' '}
                    {Math.round(snapHint.point.y)}
                  </text>
                </g>
              </g>
            ) : null}

            {bondHover ? (
              <g pointerEvents="none" data-testid="bond-hover">
                {bondHover.kind === 'atom' ? (
                  <>
                    <circle
                      cx={bondHover.point.x}
                      cy={bondHover.point.y}
                      r={11 / zoom}
                      fill="rgba(63, 109, 240, 0.1)"
                      stroke="#3f6df0"
                      strokeWidth={1.4 / zoom}
                      strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                    />
                    <circle
                      cx={bondHover.point.x}
                      cy={bondHover.point.y}
                      r={2.2 / zoom}
                      fill="#3f6df0"
                    />
                  </>
                ) : (
                  <>
                    <line
                      x1={bondHover.start.x}
                      y1={bondHover.start.y}
                      x2={bondHover.end.x}
                      y2={bondHover.end.y}
                      stroke="#3f6df0"
                      strokeWidth={12 / zoom}
                      strokeLinecap="round"
                      opacity={0.18}
                    />
                    <line
                      x1={bondHover.start.x}
                      y1={bondHover.start.y}
                      x2={bondHover.end.x}
                      y2={bondHover.end.y}
                      stroke="#3f6df0"
                      strokeWidth={1.4 / zoom}
                      strokeLinecap="round"
                      strokeDasharray={`${5 / zoom} ${3 / zoom}`}
                      opacity={0.85}
                    />
                  </>
                )}
              </g>
            ) : null}

            {cursor && (activeTool === 'eraser' || activeTool === 'eraser-live') ? (
              <g pointerEvents="none" data-testid="eraser-cursor">
                <circle
                  cx={cursor.x}
                  cy={cursor.y}
                  r={eraserSize}
                  fill="rgba(63, 109, 240, 0.08)"
                  stroke="#3f6df0"
                  strokeWidth={1.2 / zoom}
                  strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                />
                {eraserMirrorPoints.map((mirror, index) => (
                  <circle
                    key={`eraser-mirror-${index}`}
                    cx={mirror.x}
                    cy={mirror.y}
                    r={eraserSize}
                    fill="none"
                    stroke="#3f6df0"
                    strokeWidth={1 / zoom}
                    strokeDasharray={`${3 / zoom} ${4 / zoom}`}
                    opacity={0.4}
                  />
                ))}
              </g>
            ) : null}

            {cursor && activeTool === 'brush' ? (
              <g pointerEvents="none" data-testid="brush-cursor">
                {/* 双环：外白内深，深浅纸面与彩色墨迹上都能看清 */}
                <circle
                  cx={cursor.x}
                  cy={cursor.y}
                  r={brushPaintWidth / 2}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={3 / zoom}
                  opacity={0.85}
                />
                <circle
                  cx={cursor.x}
                  cy={cursor.y}
                  r={brushPaintWidth / 2}
                  fill="none"
                  stroke="#1b2430"
                  strokeWidth={1.1 / zoom}
                  opacity={0.9}
                />
              </g>
            ) : null}

            {objectCount === 0 && !preview && !textDraftObject ? (
              <g pointerEvents="none">
                <rect
                  x={44}
                  y={44}
                  width={page.width - 88}
                  height={page.height - 88}
                  rx={10}
                  fill="none"
                  stroke="#dfe4ec"
                  strokeWidth={1.1 / zoom}
                  strokeDasharray={`${9 / zoom} ${8 / zoom}`}
                />
                <text
                  x={26}
                  y={30}
                  fontSize={10}
                  fill="#b3bac6"
                  fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
                >
                  {template?.name ?? '画布'} · {page.width} × {page.height} px
                </text>
                <g transform={`translate(${page.width / 2} ${page.height / 2}) scale(${overlayScale})`}>
                  <g transform="translate(-138 -76)">
                    <rect x={0} y={8} width={54} height={42} rx={7} fill="#f6f8fc" stroke="#d5dce8" strokeWidth={1.4} />
                    <ellipse cx={90} cy={26} rx={27} ry={19} fill="#f3f7ff" stroke="#c8d5ef" strokeWidth={1.4} />
                    <path d="M152 58C166 26 190 64 214 32" fill="none" stroke="url(#placeholder-stroke)" strokeWidth={1.8} strokeLinecap="round" />
                    <g fill="#ffffff" stroke="#b9c6dd" strokeWidth={1.4}>
                      <rect x={147} y={53} width={8} height={8} rx={1.5} />
                      <rect x={209} y={27} width={8} height={8} rx={1.5} />
                    </g>
                    <path d="M262 18l14 8v16l-14 8-14-8V26z" fill="#f2faf8" stroke="#b9dcd5" strokeWidth={1.4} />
                    <circle cx={262} cy={34} r={5} fill="none" stroke="#b9dcd5" strokeWidth={1.2} />
                    <path d="M262 50v14" stroke="#dfe4ec" strokeWidth={1.4} />
                  </g>
                  <text x={0} y={30} textAnchor="middle" fontSize={21} fontWeight={600} fill="#8e97a8" fontFamily="Segoe UI, Microsoft YaHei, sans-serif">
                    空白画布
                  </text>
                </g>
              </g>
            ) : null}
          </g>
        </svg>
        <BrushInkLayer ref={brushInkRef} pan={viewport.pan} zoom={zoom} />

        {exportPanelOpen && exportScope === 'region' ? (
          <ExportRegionOverlay
            region={exportRegion ?? { x: 0, y: 0, width: page.width, height: page.height }}
            page={page}
            zoom={zoom}
            pan={viewport.pan}
            interactive={!spaceHeld}
            toPage={pagePoint}
            onChange={setExportRegion}
          />
        ) : null}

        {textEditor ? (
          <textarea
            ref={textAreaRef}
            className="canvas-text-editor"
            value={textEditor.value}
            spellCheck={false}
            placeholder="输入文本"
            style={{
              left: textEditor.page.x * zoom + viewport.pan.x,
              top: textEditor.page.y * zoom + viewport.pan.y,
              width: Math.max(
                180,
                (textEditor.boxWidth || 280) * zoom + 16
              ),
              height: Math.max(
                34,
                textEditor.value.split('\n').length *
                  textEditor.fontSize *
                  textEditor.lineHeight *
                  zoom +
                  10
              ),
              fontSize: Math.max(12, textEditor.fontSize * zoom),
              fontFamily: textEditor.fontFamily,
              fontWeight: textEditor.fontWeight,
              fontStyle: textEditor.italic ? 'italic' : 'normal',
              letterSpacing: `${textEditor.letterSpacing * zoom}px`,
              lineHeight: textEditor.lineHeight,
              // 编辑框就是成品的样子：字色与对齐跟最终落字保持一致。
              color: textEditor.color,
              caretColor: textEditor.color,
              textAlign: textEditor.align,
              writingMode:
                textEditor.direction === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
              transform: textEditor.rotation ? `rotate(${textEditor.rotation}deg)` : undefined,
              transformOrigin: `${(textEditor.boxWidth / 2) * zoom}px ${
                (textEditor.boxHeight / 2) * zoom
              }px`
            }}
            onChange={(event) => {
              const next = { ...textEditor, value: event.target.value };
              textEditorRef.current = next;
              setTextEditor(next);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              const related = event.relatedTarget as HTMLElement | null;
              // 点击字体/字号等横栏控件不应结束文本编辑
              if (related?.closest('.mode-bars, .mode-docks')) return;
              const session = textEditor.session;
              // 等一帧再判断：浏览器默认焦点行为与浮层重挂载都在这一帧内完成。
              // 会话已切换（点去别处）或焦点仍在本文本框时都不提交，
              // 避免"刚弹出就被自己关掉"和"空内容静默丢弃"。
              window.requestAnimationFrame(() => {
                if (textEditorRef.current?.session !== session) return;
                if (document.activeElement === textAreaRef.current) return;
                commitText(session);
              });
            }}
            onKeyDown={(event) => {
              // 输入法组合态：回车用于选词，不能当成提交。
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter') {
                // 与主流文本编辑一致：回车换行，Ctrl/Cmd+回车才收尾。
                if (event.metaKey || event.ctrlKey) {
                  event.preventDefault();
                  commitText();
                }
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelText();
              }
            }}
            onCompositionStart={() => {
              // 组合期间禁止 blur 提交，避免中文候选未上屏就落字。
              textCommitRef.current = false;
            }}
          />
        ) : null}

        {contextMenu ? (
          <div
            className="object-menu"
            data-testid="object-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <div className="object-menu__head">
              <Icon name="properties" size={13} />
              <span>{contextMenu.name}</span>
              <em>右键属性</em>
            </div>
            <button
              type="button"
              className="object-menu__primary"
              data-testid="object-menu-properties"
              onClick={() => {
                const state = useAppStore.getState();
                state.setSelection([contextMenu.objectId]);
                openProperties();
                setContextMenu(null);
              }}
            >
              <Icon name="properties" size={14} />
              属性
            </button>
            <button
              type="button"
              data-testid="object-menu-duplicate"
              onClick={() => {
                const state = useAppStore.getState();
                state.setSelection([contextMenu.objectId]);
                state.duplicateSelection();
                setContextMenu(null);
              }}
            >
              <Icon name="copy" size={13} />
              复制
              <em>Ctrl+D</em>
            </button>
            <button
              type="button"
              data-testid="object-menu-lock"
              onClick={() => {
                const state = useAppStore.getState();
                state.setSelection([contextMenu.objectId]);
                state.toggleObjectLock();
                setContextMenu(null);
              }}
            >
              <Icon name="lock" size={13} />
              {contextLocked ? '解锁对象' : '锁定对象'}
            </button>
            {contextPath?.type !== 'path' &&
            ['rect', 'ellipse', 'polygon', 'line'].includes(contextMenu.type) ? (
              <button
                type="button"
                data-testid="object-menu-to-path"
                onClick={() => {
                  const state = useAppStore.getState();
                  state.setSelection([contextMenu.objectId]);
                  state.convertSelectionToPath();
                  setContextMenu(null);
                }}
              >
                <Icon name="pen" size={13} />
                转换为路径
              </button>
            ) : null}
            {contextPath?.type === 'path' ? (
              <button
                type="button"
                data-testid="object-menu-toggle-closed"
                onClick={() => {
                  const state = useAppStore.getState();
                  const target = getObject(state.doc, contextMenu.objectId);
                  if (target?.type !== 'path') return;
                  const next = { ...target, closed: !target.closed };
                  state.updateDoc(replaceObject(state.doc, target.id, () => next), true);
                  state.setSelection([target.id]);
                  setContextMenu(null);
                  state.notify(next.closed ? '已闭合路径' : '已断开路径', 'info');
                }}
              >
                <Icon name="curve" size={13} />
                {contextPathClosed ? '断开路径' : '闭合路径'}
              </button>
            ) : null}
            <div className="object-menu__sep" />
            <button
              type="button"
              onClick={() => {
                const state = useAppStore.getState();
                state.setSelection([contextMenu.objectId]);
                state.reorderSelection('front');
                setContextMenu(null);
              }}
            >
              置于顶层
            </button>
            <button
              type="button"
              onClick={() => {
                const state = useAppStore.getState();
                state.setSelection([contextMenu.objectId]);
                state.reorderSelection('back');
                setContextMenu(null);
              }}
            >
              置于底层
            </button>
            {contextMenu.type === 'group' ? (
              <button
                type="button"
                onClick={() => {
                  const state = useAppStore.getState();
                  state.setSelection([contextMenu.objectId]);
                  state.ungroupSelection();
                  setContextMenu(null);
                }}
              >
                取消编组
              </button>
            ) : null}
            <div className="object-menu__sep" />
            <button
              type="button"
              className="object-menu__danger"
              onClick={() => {
                const state = useAppStore.getState();
                state.setSelection([contextMenu.objectId]);
                state.deleteSelection();
                setContextMenu(null);
              }}
            >
              <Icon name="trash" size={13} />
              删除
            </button>
          </div>
        ) : null}

        <div className="canvas-badge" title={`${TOOL_MAP[activeTool].label} · ${TOOL_MAP[activeTool].hint}`}>
          <span className="canvas-badge__dot" />
          {TOOL_MAP[activeTool].label}
        </div>

        <div className="canvas-modes" data-testid="canvas-modes">
          {symmetry !== 'none' ? (
            <button
              type="button"
              className="canvas-mode-chip"
              title="对称已开启，点击打开对称设置"
              onClick={() => useAppStore.getState().setTool('symmetry')}
            >
              对称 ·{' '}
              {symmetry === 'vertical' ? '左右' : symmetry === 'horizontal' ? '上下' : '四象限'}
            </button>
          ) : null}
          {guideMode !== 'none' ? (
            <button
              type="button"
              className="canvas-mode-chip"
              title="辅助线已开启，点击打开辅助线设置"
              onClick={() => useAppStore.getState().setTool('guides')}
            >
              辅助线 ·{' '}
              {guideMode === 'one-point'
                ? '一点'
                : guideMode === 'two-point'
                  ? '两点'
                  : guideMode === 'three-point'
                    ? '三点'
                    : guideMode === 'grid'
                      ? '网格'
                      : '等大'}
            </button>
          ) : null}
          {!snapEnabled ? (
            <button
              type="button"
              className="canvas-mode-chip is-off"
              title="吸附已关闭，点击开启"
              onClick={() => useAppStore.getState().toggleSnap()}
            >
              吸附 · 关
            </button>
          ) : null}
        </div>


        <ExportPanel />
      </div>
    </div>
  );
}
