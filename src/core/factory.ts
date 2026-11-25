import type {
  ArrowKind,
  ArrowObject,
  AtomLabelData,
  AtomObject,
  BondObject,
  BondType,
  EllipseObject,
  GroupObject,
  ImageObject,
  LineObject,
  PathNode,
  PathObject,
  PolygonObject,
  RectObject,
  Rect,
  SceneObject,
  SceneObjectBase,
  Style,
  TextObject,
  Vec
} from '../types/document';
import { createId, createNodeId } from './id';
import { boundsOfPoints, measureText, pathPoints } from './scene';
import { wrapTextToWidth } from './textMetrics';
import { parseTextScripts } from './textRuns';

export function cloneStyle(style: Style): Style {
  return {
    fill: { ...style.fill },
    stroke: {
      ...style.stroke,
      paint: { ...style.stroke.paint },
      dash: [...style.stroke.dash]
    },
    opacity: style.opacity
  };
}

function base(
  type: SceneObject['type'],
  name: string,
  layerId: string,
  style: Style,
  x: number,
  y: number,
  width: number,
  height: number
): SceneObjectBase {
  return {
    id: createId(type),
    type,
    name,
    layerId,
    parentId: null,
    visible: true,
    locked: false,
    x,
    y,
    width,
    height,
    rotation: 0,
    style: cloneStyle(style)
  };
}

export function createRectObject(
  layerId: string,
  style: Style,
  x: number,
  y: number,
  width: number,
  height: number
): RectObject {
  return {
    ...base('rect', '矩形', layerId, style, x, y, width, height),
    type: 'rect',
    cornerRadius: 0
  };
}

/** 位图对象：src 必须是内嵌 data URL；样式只保留 opacity，描边/填充不参与渲染。 */
export function createImageObject(
  layerId: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  placement: { x: number; y: number; width: number; height: number },
  name = '位图',
  imageFormat?: ImageObject['imageFormat']
): ImageObject {
  return {
    ...base(
      'image',
      name,
      layerId,
      {
        fill: { type: 'none' },
        stroke: { paint: { type: 'none' }, width: 0, cap: 'round', join: 'round', dash: [] },
        opacity: 1
      },
      placement.x,
      placement.y,
      placement.width,
      placement.height
    ),
    type: 'image',
    src,
    naturalWidth: Math.max(1, naturalWidth),
    naturalHeight: Math.max(1, naturalHeight),
    ...(imageFormat ? { imageFormat } : {})
  };
}

export function createEllipseObject(
  layerId: string,
  style: Style,
  x: number,
  y: number,
  width: number,
  height: number
): EllipseObject {
  return {
    ...base('ellipse', '椭圆', layerId, style, x, y, width, height),
    type: 'ellipse'
  };
}

export function createLineObject(
  layerId: string,
  style: Style,
  start: Vec,
  end: Vec
): LineObject {
  const bounds = boundsOfPoints([start, end], style.stroke.width);
  return {
    ...base('line', '直线', layerId, style, bounds.x, bounds.y, bounds.width, bounds.height),
    type: 'line',
    start,
    end
  };
}

export function createPolygonObject(
  layerId: string,
  style: Style,
  points: Vec[]
): PolygonObject {
  const bounds = boundsOfPoints(points, style.stroke.width);
  return {
    ...base('polygon', '多边形', layerId, style, bounds.x, bounds.y, bounds.width, bounds.height),
    type: 'polygon',
    points
  };
}

export function createPathObject(
  layerId: string,
  style: Style,
  nodes: PathNode[],
  closed: boolean
): PathObject {
  const bounds = boundsOfPoints(pathPoints(nodes), style.stroke.width);
  return {
    ...base('path', '路径', layerId, style, bounds.x, bounds.y, bounds.width, bounds.height),
    type: 'path',
    nodes,
    closed
  };
}

export function createTextObject(
  layerId: string,
  style: Style,
  position: Vec,
  text: string,
  fontSize = 20,
  options: {
    fontFamily?: string;
    fontWeight?: number;
    italic?: boolean;
    align?: 'left' | 'center' | 'right';
    letterSpacing?: number;
    direction?: 'horizontal' | 'vertical';
    lineHeight?: number;
    maxWidth?: number;
  } = {}
): TextObject {
  const letterSpacing = options.letterSpacing ?? 0;
  const direction = options.direction ?? 'horizontal';
  const fontFamily = options.fontFamily ?? 'Segoe UI, Microsoft YaHei, sans-serif';
  const fontWeight = options.fontWeight ?? 400;
  const lineHeight = options.lineHeight ?? 1.32;
  const maxWidth = options.maxWidth ?? 0;
  // 上下标标记先转成 Unicode；换行只用于度量，原始段落仍保存在 text 里。
  const parsed = parseTextScripts(text);
  const wrapped = wrapTextToWidth(parsed, maxWidth, fontSize, letterSpacing, {
    fontWeight,
    fontFamily,
    lineHeight
  });
  const metrics = measureText(wrapped, fontSize, letterSpacing, direction, {
    fontWeight,
    fontFamily,
    lineHeight
  });
  return {
    ...base('text', '文本', layerId, style, position.x, position.y, metrics.width, metrics.height),
    type: 'text',
    text: parsed,
    maxWidth,
    fontFamily,
    fontSize,
    fontWeight,
    italic: options.italic === true ? true : undefined,
    letterSpacing,
    direction,
    lineHeight,
    align: options.align ?? 'left'
  };
}

export function createBondObject(
  layerId: string,
  style: Style,
  start: Vec,
  end: Vec,
  bondType: BondType,
  aromaticSide?: 1 | -1
): BondObject {
  const bounds = boundsOfPoints([start, end], style.stroke.width);
  return {
    ...base('bond', '化学键', layerId, style, bounds.x, bounds.y, bounds.width, bounds.height),
    type: 'bond',
    bondType,
    start,
    end,
    aromaticSide
  };
}

export function emptyAtomLabel(element = 'C'): AtomLabelData {
  return {
    element,
    charge: 0,
    isotope: null,
    radical: 'none',
    lonePairs: 0,
    hydrogens: null,
    group: null
  };
}

export function createAtomObject(
  layerId: string,
  style: Style,
  position: Vec,
  label: AtomLabelData
): AtomObject {
  return {
    ...base('atom', '原子标签', layerId, style, position.x - 20, position.y - 16, 40, 32),
    type: 'atom',
    position,
    label
  };
}

export function createArrowObject(
  layerId: string,
  style: Style,
  start: Vec,
  end: Vec,
  arrowKind: ArrowKind,
  label = ''
): ArrowObject {
  const bounds = boundsOfPoints([start, end], 14);
  return {
    ...base('arrow', '反应箭头', layerId, style, bounds.x, bounds.y, bounds.width, bounds.height),
    type: 'arrow',
    arrowKind,
    start,
    end,
    label
  };
}

const DEFAULT_LIGHT_STYLE: Style = {
  fill: { type: 'none' },
  stroke: { paint: { type: 'none' }, width: 1, cap: 'round', join: 'round', dash: [] },
  opacity: 1
};

export function createGroupObject(
  layerId: string,
  name: string,
  bounds: Rect,
  childIds: string[]
): GroupObject {
  return {
    ...base('group', name, layerId, { ...DEFAULT_LIGHT_STYLE }, bounds.x, bounds.y, bounds.width, bounds.height),
    type: 'group',
    childIds
  };
}

export function makeNode(x: number, y: number, handleIn: Vec | null = null, handleOut: Vec | null = null): PathNode {
  return {
    id: createNodeId(),
    x,
    y,
    handleIn,
    handleOut,
    type: handleIn && handleOut ? 'smooth' : 'corner'
  };
}
