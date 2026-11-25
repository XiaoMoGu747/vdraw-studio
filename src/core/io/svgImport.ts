import type { PathNode, SceneObject, Style, Vec } from '../../types/document';
import {
  createEllipseObject,
  createLineObject,
  createPathObject,
  createPolygonObject,
  createRectObject,
  createTextObject,
  makeNode
} from '../factory';
import { measureText } from '../scene';

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface ImportStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

interface AbsNode {
  x: number;
  y: number;
  inHandle: Vec | null;
  outHandle: Vec | null;
}

interface SubPath {
  nodes: AbsNode[];
  closed: boolean;
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080',
  teal: '#008080',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  none: 'none',
  transparent: 'none'
};

function applyMatrix(matrix: Matrix, point: Vec): Vec {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f
  };
}

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f
  };
}

function decomposeBox(
  matrix: Matrix,
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number; rotation: number } {
  const scaleX = Math.hypot(matrix.a, matrix.b);
  const scaleY = Math.hypot(matrix.c, matrix.d);
  const rotation = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
  const corners = [
    applyMatrix(matrix, { x, y }),
    applyMatrix(matrix, { x: x + width, y }),
    applyMatrix(matrix, { x: x + width, y: y + height }),
    applyMatrix(matrix, { x, y: y + height })
  ];
  const center = {
    x: corners.reduce((sum, point) => sum + point.x, 0) / 4,
    y: corners.reduce((sum, point) => sum + point.y, 0) / 4
  };
  const nextWidth = Math.max(1, width * scaleX);
  const nextHeight = Math.max(1, height * scaleY);
  return {
    x: center.x - nextWidth / 2,
    y: center.y - nextHeight / 2,
    width: nextWidth,
    height: nextHeight,
    rotation
  };
}

function parseTransform(value: string | null): Matrix {
  if (!value) return IDENTITY;
  let matrix = { ...IDENTITY };
  const pattern = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const name = match[1];
    const args = match[2]
      .split(/[\s,]+/)
      .map((item) => Number.parseFloat(item))
      .filter((item) => !Number.isNaN(item));
    let next = { ...IDENTITY };
    if (name === 'translate') {
      next = { ...IDENTITY, e: args[0] ?? 0, f: args[1] ?? 0 };
    } else if (name === 'scale') {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      next = { ...IDENTITY, a: sx, d: sy };
    } else if (name === 'rotate') {
      const angle = ((args[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cx = args[1];
      const cy = args[2];
      if (cx !== undefined && cy !== undefined) {
        next = multiply(
          multiply({ ...IDENTITY, e: cx, f: cy }, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }),
          { ...IDENTITY, e: -cx, f: -cy }
        );
      } else {
        next = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      }
    } else if (name === 'matrix') {
      next = {
        a: args[0] ?? 1,
        b: args[1] ?? 0,
        c: args[2] ?? 0,
        d: args[3] ?? 1,
        e: args[4] ?? 0,
        f: args[5] ?? 0
      };
    }
    matrix = multiply(matrix, next);
  }
  return matrix;
}

function normalizeColor(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const color = value.trim().toLowerCase();
  if (NAMED_COLORS[color]) return NAMED_COLORS[color];
  if (color.startsWith('#')) {
    if (color.length === 4) {
      return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
    }
    return color;
  }
  const rgb = color.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const channels = rgb[1].split(',').map((item) => Number.parseFloat(item));
    const hex = channels
      .slice(0, 3)
      .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  }
  return fallback;
}

function parseStyle(element: Element, inherited: ImportStyle): ImportStyle {
  const next = { ...inherited };
  const styleText = element.getAttribute('style') ?? '';
  const declarations = new Map<string, string>();
  for (const part of styleText.split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    declarations.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  const fill = declarations.get('fill') ?? element.getAttribute('fill');
  const stroke = declarations.get('stroke') ?? element.getAttribute('stroke');
  const strokeWidth = declarations.get('stroke-width') ?? element.getAttribute('stroke-width');
  const opacity = declarations.get('opacity') ?? element.getAttribute('opacity');
  if (fill) next.fill = normalizeColor(fill, next.fill);
  if (stroke) next.stroke = normalizeColor(stroke, next.stroke);
  if (strokeWidth) {
    const parsed = Number.parseFloat(strokeWidth);
    if (!Number.isNaN(parsed)) next.strokeWidth = parsed;
  }
  if (opacity) {
    const parsed = Number.parseFloat(opacity);
    if (!Number.isNaN(parsed)) next.opacity = Math.max(0.02, Math.min(1, parsed));
  }
  return next;
}

function toStyle(style: ImportStyle, scale: number): Style {
  return {
    fill: style.fill === 'none' ? { type: 'none' } : { type: 'solid', color: style.fill },
    stroke: {
      paint: style.stroke === 'none' ? { type: 'none' } : { type: 'solid', color: style.stroke },
      width: Math.max(0, style.strokeWidth * scale),
      cap: 'round',
      join: 'round',
      dash: []
    },
    opacity: style.opacity
  };
}

function numberAttr(element: Element, name: string, fallback = 0): number {
  const value = Number.parseFloat(element.getAttribute(name) ?? '');
  return Number.isNaN(value) ? fallback : value;
}

function transformNode(node: AbsNode, matrix: Matrix): AbsNode {
  return {
    x: applyMatrix(matrix, { x: node.x, y: node.y }).x,
    y: applyMatrix(matrix, { x: node.x, y: node.y }).y,
    inHandle: node.inHandle
      ? {
          x: applyMatrix(matrix, node.inHandle).x - applyMatrix(matrix, { x: node.x, y: node.y }).x,
          y: applyMatrix(matrix, node.inHandle).y - applyMatrix(matrix, { x: node.x, y: node.y }).y
        }
      : null,
    outHandle: node.outHandle
      ? {
          x: applyMatrix(matrix, node.outHandle).x - applyMatrix(matrix, { x: node.x, y: node.y }).x,
          y: applyMatrix(matrix, node.outHandle).y - applyMatrix(matrix, { x: node.x, y: node.y }).y
        }
      : null
  };
}

function tokenizePath(data: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const pattern = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(data)) !== null) {
    const value = match[0];
    tokens.push(/[a-zA-Z]/.test(value) ? value : Number.parseFloat(value));
  }
  return tokens;
}

function arcToCubics(
  start: Vec,
  end: Vec,
  rxInput: number,
  ryInput: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean
): Array<{ c1: Vec; c2: Vec; end: Vec }> {
  let rx = Math.abs(rxInput);
  let ry = Math.abs(ryInput);
  if (rx < 1e-6 || ry < 1e-6 || (start.x === end.x && start.y === end.y)) {
    return [{ c1: start, c2: end, end }];
  }
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const numerator = Math.max(
    0,
    rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  );
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = denominator === 0 ? 0 : sign * Math.sqrt(numerator / denominator);
  const cxp = (coefficient * (rx * y1p)) / ry;
  const cyp = (coefficient * (-ry * x1p)) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2;

  const vectorAngle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const length = Math.max(1e-9, Math.hypot(ux, uy) * Math.hypot(vx, vy));
    const angle = Math.acos(Math.min(1, Math.max(-1, dot / length)));
    return ux * vy - uy * vx < 0 ? -angle : angle;
  };
  const theta1 = vectorAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = vectorAngle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry
  );
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const curves: Array<{ c1: Vec; c2: Vec; end: Vec }> = [];
  const mapPoint = (x: number, y: number): Vec => ({
    x: cx + cosPhi * x - sinPhi * y,
    y: cy + sinPhi * x + cosPhi * y
  });
  for (let index = 0; index < segments; index += 1) {
    const a1 = theta1 + step * index;
    const a2 = a1 + step;
    const alpha = (4 / 3) * Math.tan((a2 - a1) / 4);
    const p1 = { x: Math.cos(a1), y: Math.sin(a1) };
    const p2 = { x: Math.cos(a2), y: Math.sin(a2) };
    curves.push({
      c1: mapPoint(p1.x * rx - alpha * p1.y * ry, p1.y * ry + alpha * p1.x * rx),
      c2: mapPoint(p2.x * rx + alpha * p2.y * ry, p2.y * ry - alpha * p2.x * rx),
      end: index === segments - 1 ? end : mapPoint(p2.x * rx, p2.y * ry)
    });
  }
  return curves;
}

function parsePath(data: string): SubPath[] {
  const tokens = tokenizePath(data);
  const result: SubPath[] = [];
  let nodes: AbsNode[] = [];
  let current: Vec = { x: 0, y: 0 };
  let start: Vec = { x: 0, y: 0 };
  let command = '';
  let index = 0;
  let lastControl: Vec | null = null;
  let lastQuad: Vec | null = null;
  let closed = false;

  const push = (node: AbsNode) => {
    nodes.push(node);
  };

  const finish = () => {
    if (nodes.length > 1) result.push({ nodes, closed });
    nodes = [];
    closed = false;
  };

  const readPoint = (relative: boolean): Vec => {
    const x = (tokens[index] as number) ?? 0;
    const y = (tokens[index + 1] as number) ?? 0;
    index += 2;
    return relative ? { x: current.x + x, y: current.y + y } : { x, y };
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (typeof token === 'string') {
      command = token;
      index += 1;
      if (command === 'Z' || command === 'z') {
        closed = true;
        finish();
        current = { ...start };
        lastControl = null;
        lastQuad = null;
        continue;
      }
    }
    const relative = command === command.toLowerCase();
    switch (command.toUpperCase()) {
      case 'M': {
        const point = readPoint(relative);
        if (nodes.length > 0) finish();
        current = point;
        start = { ...point };
        push({ x: point.x, y: point.y, inHandle: null, outHandle: null });
        command = relative ? 'l' : 'L';
        lastControl = null;
        lastQuad = null;
        break;
      }
      case 'L': {
        const point = readPoint(relative);
        push({ x: point.x, y: point.y, inHandle: null, outHandle: null });
        current = point;
        lastControl = null;
        lastQuad = null;
        break;
      }
      case 'H': {
        const value = (tokens[index] as number) ?? 0;
        index += 1;
        const point = { x: relative ? current.x + value : value, y: current.y };
        push({ x: point.x, y: point.y, inHandle: null, outHandle: null });
        current = point;
        break;
      }
      case 'V': {
        const value = (tokens[index] as number) ?? 0;
        index += 1;
        const point = { x: current.x, y: relative ? current.y + value : value };
        push({ x: point.x, y: point.y, inHandle: null, outHandle: null });
        current = point;
        break;
      }
      case 'C': {
        const c1 = readPoint(relative);
        const c2 = readPoint(relative);
        const end = readPoint(relative);
        if (nodes.length === 0) push({ ...current, inHandle: null, outHandle: null });
        nodes[nodes.length - 1].outHandle = c1;
        push({ x: end.x, y: end.y, inHandle: c2, outHandle: null });
        current = end;
        lastControl = c2;
        lastQuad = null;
        break;
      }
      case 'S': {
        const c2 = readPoint(relative);
        const end = readPoint(relative);
        const reflected = lastControl ? { x: 2 * current.x - lastControl.x, y: 2 * current.y - lastControl.y } : { ...current };
        if (nodes.length === 0) push({ ...current, inHandle: null, outHandle: null });
        nodes[nodes.length - 1].outHandle = reflected;
        push({ x: end.x, y: end.y, inHandle: c2, outHandle: null });
        current = end;
        lastControl = c2;
        lastQuad = null;
        break;
      }
      case 'Q': {
        const q = readPoint(relative);
        const end = readPoint(relative);
        const c1 = { x: current.x + (2 / 3) * (q.x - current.x), y: current.y + (2 / 3) * (q.y - current.y) };
        const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
        if (nodes.length === 0) push({ ...current, inHandle: null, outHandle: null });
        nodes[nodes.length - 1].outHandle = c1;
        push({ x: end.x, y: end.y, inHandle: c2, outHandle: null });
        current = end;
        lastQuad = q;
        lastControl = null;
        break;
      }
      case 'T': {
        const end = readPoint(relative);
        const q: Vec = lastQuad
          ? { x: 2 * current.x - lastQuad.x, y: 2 * current.y - lastQuad.y }
          : { ...current };
        const c1 = { x: current.x + (2 / 3) * (q.x - current.x), y: current.y + (2 / 3) * (q.y - current.y) };
        const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
        if (nodes.length === 0) push({ ...current, inHandle: null, outHandle: null });
        nodes[nodes.length - 1].outHandle = c1;
        push({ x: end.x, y: end.y, inHandle: c2, outHandle: null });
        current = end;
        lastQuad = q;
        lastControl = null;
        break;
      }
      case 'A': {
        const rx = (tokens[index] as number) ?? 0;
        const ry = (tokens[index + 1] as number) ?? 0;
        const rotation = (tokens[index + 2] as number) ?? 0;
        const largeArc = Boolean(tokens[index + 3]);
        const sweep = Boolean(tokens[index + 4]);
        index += 5;
        const end = readPoint(relative);
        const curves = arcToCubics(current, end, rx, ry, rotation, largeArc, sweep);
        for (const curve of curves) {
          if (nodes.length === 0) push({ ...current, inHandle: null, outHandle: null });
          nodes[nodes.length - 1].outHandle = curve.c1;
          push({ x: curve.end.x, y: curve.end.y, inHandle: curve.c2, outHandle: null });
          current = curve.end;
        }
        lastControl = curves.length > 0 ? curves[curves.length - 1].c2 : null;
        lastQuad = null;
        break;
      }
      default: {
        index += 1;
        break;
      }
    }
  }
  finish();
  return result;
}

export interface SvgImportResult {
  objects: SceneObject[];
  warning: string | null;
  /** SVG 自带的画布尺寸（viewBox 宽高或 width/height 属性）。 */
  width: number;
  height: number;
  /** 暂不支持、被跳过的元素数量。 */
  skipped: number;
}

export interface SvgImportOptions {
  /**
   * contain（默认）：等比缩放进页面留白内并居中；
   * none：保持 SVG 用户单位，只把 viewBox 原点平移到 0,0（用于「新建画布」）。
   */
  fit?: 'contain' | 'none';
  /** contain 模式的页面留白。 */
  margin?: number;
}

export function parseSvgToObjects(
  text: string,
  layerId: string,
  pageWidth: number,
  pageHeight: number,
  options: SvgImportOptions = {}
): SvgImportResult {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'image/svg+xml');
  const errorNode = xml.querySelector('parsererror');
  if (errorNode) throw new Error('SVG 解析失败：XML 结构不完整');
  const root = xml.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') {
    throw new Error('不是有效的 SVG 文件：根元素必须是 <svg>');
  }

  const viewBox = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value));
  const rootWidth = hasViewBox && viewBox[2] > 0 ? viewBox[2] : numberAttr(root, 'width', 800);
  const rootHeight = hasViewBox && viewBox[3] > 0 ? viewBox[3] : numberAttr(root, 'height', 600);
  const originX = hasViewBox ? viewBox[0] : 0;
  const originY = hasViewBox ? viewBox[1] : 0;
  const fit = options.fit ?? 'contain';
  const margin = options.margin ?? 32;
  let scale = 1;
  let offsetX = -originX;
  let offsetY = -originY;
  if (fit === 'contain') {
    scale = Math.min(
      1,
      Math.max(1, pageWidth - margin * 2) / Math.max(1, rootWidth),
      Math.max(1, pageHeight - margin * 2) / Math.max(1, rootHeight)
    );
    offsetX = margin + (Math.max(1, pageWidth - margin * 2) - rootWidth * scale) / 2 - originX * scale;
    offsetY =
      margin + (Math.max(1, pageHeight - margin * 2) - rootHeight * scale) / 2 - originY * scale;
  }
  const rootMatrix: Matrix = { a: scale, b: 0, c: 0, d: scale, e: offsetX, f: offsetY };

  const objects: SceneObject[] = [];
  let skipped = 0;
  const baseStyle: ImportStyle = { fill: '#000000', stroke: 'none', strokeWidth: 1, opacity: 1 };

  const addPath = (subpaths: SubPath[], matrix: Matrix, style: ImportStyle) => {
    const scaleFactor = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));
    for (const subpath of subpaths) {
      if (subpath.nodes.length < 2) continue;
      const nodes: PathNode[] = subpath.nodes.map((node) => {
        const transformed = transformNode(node, matrix);
        return makeNode(transformed.x, transformed.y, transformed.inHandle, transformed.outHandle);
      });
      objects.push(
        createPathObject(layerId, toStyle(style, scaleFactor), nodes, subpath.closed)
      );
    }
  };

  const walk = (element: Element, inherited: ImportStyle, matrix: Matrix) => {
    for (const child of Array.from(element.children)) {
      const tag = child.nodeName.toLowerCase();
      if (tag === 'defs' || tag === 'style' || tag === 'title' || tag === 'metadata') continue;
      const localMatrix = multiply(matrix, parseTransform(child.getAttribute('transform')));
      const style = parseStyle(child, inherited);
      const localScale = Math.sqrt(
        Math.abs(localMatrix.a * localMatrix.d - localMatrix.b * localMatrix.c)
      );

      if (tag === 'g' || tag === 'svg' || tag === 'symbol' || tag === 'a') {
        walk(child, style, localMatrix);
        continue;
      }

      if (tag === 'rect') {
        const x = numberAttr(child, 'x');
        const y = numberAttr(child, 'y');
        const width = numberAttr(child, 'width');
        const height = numberAttr(child, 'height');
        if (width <= 0 || height <= 0) continue;
        const box = decomposeBox(localMatrix, x, y, width, height);
        const object = createRectObject(
          layerId,
          toStyle(style, localScale),
          box.x,
          box.y,
          box.width,
          box.height
        );
        if (Math.abs(box.rotation) > 0.01) object.rotation = box.rotation;
        object.cornerRadius = numberAttr(child, 'rx') * localScale;
        objects.push(object);
        continue;
      }

      if (tag === 'circle' || tag === 'ellipse') {
        const cx = numberAttr(child, 'cx');
        const cy = numberAttr(child, 'cy');
        const rx = tag === 'circle' ? numberAttr(child, 'r') : numberAttr(child, 'rx');
        const ry = tag === 'circle' ? numberAttr(child, 'r') : numberAttr(child, 'ry');
        const center = applyMatrix(localMatrix, { x: cx, y: cy });
        const radiusX = Math.abs(rx * Math.hypot(localMatrix.a, localMatrix.b));
        const radiusY = Math.abs(ry * Math.hypot(localMatrix.c, localMatrix.d));
        const object = createEllipseObject(
          layerId,
          toStyle(style, localScale),
          center.x - radiusX,
          center.y - radiusY,
          Math.max(1, radiusX * 2),
          Math.max(1, radiusY * 2)
        );
        const rotation = (Math.atan2(localMatrix.b, localMatrix.a) * 180) / Math.PI;
        if (Math.abs(rotation) > 0.01) object.rotation = rotation;
        objects.push(object);
        continue;
      }

      if (tag === 'line') {
        const start = applyMatrix(localMatrix, {
          x: numberAttr(child, 'x1'),
          y: numberAttr(child, 'y1')
        });
        const end = applyMatrix(localMatrix, {
          x: numberAttr(child, 'x2'),
          y: numberAttr(child, 'y2')
        });
        objects.push(createLineObject(layerId, toStyle(style, localScale), start, end));
        continue;
      }

      if (tag === 'polygon' || tag === 'polyline') {
        const raw = (child.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
        const points: Vec[] = [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
          if (Number.isNaN(raw[i]) || Number.isNaN(raw[i + 1])) continue;
          points.push(applyMatrix(localMatrix, { x: raw[i], y: raw[i + 1] }));
        }
        if (points.length < 2) continue;
        if (tag === 'polygon') {
          objects.push(createPolygonObject(layerId, toStyle(style, localScale), points));
        } else {
          const nodes = points.map((point) => makeNode(point.x, point.y));
          objects.push(createPathObject(layerId, toStyle(style, localScale), nodes, false));
        }
        continue;
      }

      if (tag === 'path') {
        const data = child.getAttribute('d');
        if (!data) continue;
        addPath(parsePath(data), localMatrix, style);
        continue;
      }

      if (tag === 'text') {
        const content = (child.textContent ?? '').trim();
        if (!content) continue;
        const x = numberAttr(child, 'x');
        const y = numberAttr(child, 'y');
        const fontSize = numberAttr(child, 'font-size', 16) * localScale;
        const point = applyMatrix(localMatrix, { x, y });
        const fillColor = style.fill === 'none' ? style.stroke : style.fill;
        const object = createTextObject(
          layerId,
          {
            ...toStyle(style, localScale),
            fill: { type: 'solid', color: fillColor === 'none' ? '#1b1b1b' : fillColor },
            stroke: { ...toStyle(style, localScale).stroke, paint: { type: 'none' } }
          },
          { x: point.x, y: point.y - fontSize },
          content,
          Math.max(6, fontSize)
        );
        const anchor = child.getAttribute('text-anchor');
        const metrics = measureText(content, Math.max(6, fontSize));
        if (anchor === 'middle') object.x -= metrics.width / 2;
        if (anchor === 'end') object.x -= metrics.width;
        object.width = metrics.width;
        object.height = metrics.height;
        objects.push(object);
        continue;
      }

      skipped += 1;
    }
  };

  walk(root, baseStyle, rootMatrix);
  return {
    objects,
    warning:
      skipped > 0 ? `已导入 ${objects.length} 个图元，跳过 ${skipped} 个暂不支持的元素` : null,
    width: rootWidth,
    height: rootHeight,
    skipped
  };
}
