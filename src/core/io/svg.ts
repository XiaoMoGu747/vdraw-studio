import type {
  AtomObject,
  BondObject,
  ExportRegion,
  GroupObject,
  ImageObject,
  PathNode,
  PathObject,
  SceneObject,
  TextObject,
  VDrawDocument,
  Vec
} from '../../types/document';
import { buildArrowGeometry } from '../arrow';
import { brushOutlineData } from '../brush';
import { brushMaterialLayers } from '../brushMaterial';
import { grainBudgetIds } from '../grainBudget';
import { clipPathDef } from '../clipShapes';
import {
  eraseMaskDef,
  eraseMaskId,
  hasEraseMask,
  hasStrokeErase,
  strokeEraseMaskDef,
  strokeEraseMaskId
} from '../eraseMask';
import { ATOM_FONT_SIZE, atomParts } from '../chemistry/labels';
import { chemBondShape } from '../chemistry/render';
import { ringGeometry } from '../chemistry/ring-geometry';
import { expandSelection } from '../scene';
import { wrapTextToWidth } from '../textMetrics';

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const solid = (paint: { type: string; color?: string }): string =>
  paint.type === 'solid' && paint.color ? paint.color : 'none';

function hexToRgb(color: string): [number, number, number] | null {
  const value = color.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  if (short) {
    const [r, g, b] = short[1];
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  if (!long) return null;
  return [
    parseInt(long[1].slice(0, 2), 16),
    parseInt(long[1].slice(2, 4), 16),
    parseInt(long[1].slice(4, 6), 16)
  ];
}

/** PDF 导出兜底：把 multiply 预先乘到页面底色上，避免打印管线忽略混合模式。 */
function multiplyHex(color: string, backdrop: string): string {
  const front = hexToRgb(color);
  const back = hexToRgb(backdrop);
  if (!front || !back) return color;
  return `#${front
    .map((value, index) => Math.round((value * back[index]) / 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function styleAttributes(obj: SceneObject): string {
  const fill = solid(obj.style.fill);
  const stroke = solid(obj.style.stroke.paint);
  const dash = obj.style.stroke.dash.length > 0
    ? ` stroke-dasharray="${obj.style.stroke.dash.join(' ')}"`
    : '';
  return [
    `fill="${fill}"`,
    `stroke="${stroke}"`,
    `stroke-width="${obj.style.stroke.width}"`,
    `stroke-linecap="${obj.style.stroke.cap}"`,
    `stroke-linejoin="${obj.style.stroke.join}"`,
    `opacity="${obj.style.opacity}"${dash}`
  ].join(' ');
}

function rotationTransform(obj: SceneObject): string {
  if (!obj.rotation) return '';
  return ` transform="rotate(${obj.rotation} ${obj.x + obj.width / 2} ${obj.y + obj.height / 2})"`;
}

/** 填充擦除统一走 mask：重叠黑块合并，越过外轮廓也不会外泄。 */

export function pathData(nodes: PathNode[], closed: boolean): string {
  if (nodes.length === 0) return '';
  const parts = [`M ${nodes[0].x} ${nodes[0].y}`];
  for (let i = 1; i < nodes.length; i += 1) {
    const prev = nodes[i - 1];
    const node = nodes[i];
    if (prev.handleOut || node.handleIn) {
      const c1 = prev.handleOut
        ? { x: prev.x + prev.handleOut.x, y: prev.y + prev.handleOut.y }
        : { x: prev.x, y: prev.y };
      const c2 = node.handleIn
        ? { x: node.x + node.handleIn.x, y: node.y + node.handleIn.y }
        : { x: node.x, y: node.y };
      parts.push(`C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${node.x} ${node.y}`);
    } else {
      parts.push(`L ${node.x} ${node.y}`);
    }
  }
  if (closed && nodes.length > 1) {
    const last = nodes[nodes.length - 1];
    const first = nodes[0];
    if (last.handleOut || first.handleIn) {
      const c1 = last.handleOut
        ? { x: last.x + last.handleOut.x, y: last.y + last.handleOut.y }
        : { x: last.x, y: last.y };
      const c2 = first.handleIn
        ? { x: first.x + first.handleIn.x, y: first.y + first.handleIn.y }
        : { x: first.x, y: first.y };
      parts.push(`C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${first.x} ${first.y}`);
    } else {
      parts.push('Z');
    }
  }
  return parts.join(' ');
}

function textToSvg(obj: TextObject): string {
  const anchor = obj.align === 'center' ? 'middle' : obj.align === 'right' ? 'end' : 'start';
  const x = obj.align === 'center' ? obj.x + obj.width / 2 : obj.align === 'right' ? obj.x + obj.width : obj.x;
  const lineHeight = obj.lineHeight ?? 1.32;
  if (obj.direction === 'vertical') {
    const characters = [...obj.text.replace(/\n/g, '')];
    const spans = characters
      .map(
        (char, index) =>
          `<tspan x="${x}" y="${obj.y + index * (obj.fontSize * lineHeight + Math.max(0, obj.letterSpacing ?? 0))}">${escapeXml(char)}</tspan>`
      )
      .join('');
    return `<text x="${x}" y="${obj.y}" font-family="${escapeXml(obj.fontFamily)}" font-size="${obj.fontSize}" font-weight="${obj.fontWeight}"${obj.italic ? ' font-style="italic"' : ''} text-anchor="${anchor}" dominant-baseline="hanging" fill="${solid(obj.style.fill)}" opacity="${obj.style.opacity}"${rotationTransform(obj)}>${spans}</text>`;
  }
  // 软换行：导出与画布使用同一套按框宽计算的行，不依赖文档里的硬换行。
  const lines = wrapTextToWidth(
    obj.text,
    obj.maxWidth ?? 0,
    obj.fontSize,
    obj.letterSpacing ?? 0,
    { fontWeight: obj.fontWeight, fontFamily: obj.fontFamily, lineHeight }
  ).split('\n');
  const spans = lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : obj.fontSize * lineHeight}">${escapeXml(line || ' ')}</tspan>`
    )
    .join('');
  return `<text x="${x}" y="${obj.y}" font-family="${escapeXml(obj.fontFamily)}" font-size="${obj.fontSize}" font-weight="${obj.fontWeight}"${obj.italic ? ' font-style="italic"' : ''} letter-spacing="${obj.letterSpacing ?? 0}" text-anchor="${anchor}" dominant-baseline="hanging" fill="${solid(obj.style.fill)}" opacity="${obj.style.opacity}"${rotationTransform(obj)}>${spans}</text>`;
}

function atomToSvg(obj: AtomObject, implicitHydrogens = false): string {
  const parts = atomParts(obj, implicitHydrogens);
  const scale = parts.fontSize / ATOM_FONT_SIZE;
  const color = solid(obj.style.fill) === 'none' ? '#1b1b1b' : solid(obj.style.fill);
  const dots: string[] = [];
  for (let i = 0; i < parts.lonePairs * 2; i += 1) {
    dots.push(
      `<circle cx="${parts.width / 2 + (7 + (i % 2) * 4) * scale}" cy="${(-2 + Math.floor(i / 2) * 4) * scale}" r="${1.1 * scale}" fill="${color}"/>`
    );
  }
  for (let i = 0; i < parts.radicalCount; i += 1) {
    dots.push(
      `<circle cx="${parts.width / 2 + (3 + i * 3.4) * scale}" cy="${-9 * scale}" r="${1.2 * scale}" fill="${color}"/>`
    );
  }
  return `<g transform="translate(${obj.position.x} ${obj.position.y})">
    <text x="0" y="0" text-anchor="middle" dominant-baseline="central" font-family="Cambria, 'Times New Roman', serif" font-size="${parts.fontSize}" fill="${color}">${escapeXml(parts.main)}</text>
    ${parts.isotope ? `<text x="${-parts.width / 2 - 2 * scale}" y="${-7 * scale}" text-anchor="end" font-family="Cambria, serif" font-size="${9 * scale}" fill="${color}">${parts.isotope}</text>` : ''}
    ${parts.charge ? `<text x="${parts.width / 2 + 2 * scale}" y="${-7 * scale}" text-anchor="start" font-family="Cambria, serif" font-size="${9 * scale}" fill="${color}">${escapeXml(parts.charge)}</text>` : ''}
    ${dots.join('')}
  </g>`;
}

const strokeMaskAttr = (obj: SceneObject): string =>
  hasStrokeErase(obj) ? ` mask="url(#${strokeEraseMaskId(obj.id)})"` : '';

const strokeOnlyAttributes = (obj: SceneObject): string => {
  const dash =
    obj.style.stroke.dash.length > 0
      ? ` stroke-dasharray="${obj.style.stroke.dash.join(' ')}"`
      : '';
  return [
    `fill="none"`,
    `stroke="${solid(obj.style.stroke.paint)}"`,
    `stroke-width="${obj.style.stroke.width}"`,
    `stroke-linecap="${obj.style.stroke.cap}"`,
    `stroke-linejoin="${obj.style.stroke.join}"`,
    `opacity="${obj.style.opacity}"${dash}`
  ].join(' ');
};

function objectToSvg(
  obj: SceneObject,
  doc: VDrawDocument,
  bakeMultiply = false,
  forceBuckets = false
): string {
  switch (obj.type) {
    case 'rect': {
      const geometry = `x="${obj.x}" y="${obj.y}" width="${obj.width}" height="${obj.height}" rx="${obj.cornerRadius}"`;
      if (hasStrokeErase(obj)) {
        return (
          `<rect ${geometry} fill="${solid(obj.style.fill)}" stroke="none" opacity="${obj.style.opacity}"${rotationTransform(obj)}/>` +
          `<g${strokeMaskAttr(obj)}><rect ${geometry} ${strokeOnlyAttributes(obj)}${rotationTransform(obj)}/></g>`
        );
      }
      return `<rect ${geometry} ${styleAttributes(obj)}${rotationTransform(obj)}/>`;
    }
    case 'ellipse': {
      const geometry = `cx="${obj.x + obj.width / 2}" cy="${obj.y + obj.height / 2}" rx="${obj.width / 2}" ry="${obj.height / 2}"`;
      if (hasStrokeErase(obj)) {
        return (
          `<ellipse ${geometry} fill="${solid(obj.style.fill)}" stroke="none" opacity="${obj.style.opacity}"${rotationTransform(obj)}/>` +
          `<g${strokeMaskAttr(obj)}><ellipse ${geometry} ${strokeOnlyAttributes(obj)}${rotationTransform(obj)}/></g>`
        );
      }
      return `<ellipse ${geometry} ${styleAttributes(obj)}${rotationTransform(obj)}/>`;
    }
    case 'line': {
      const lineStroke = solid(obj.style.stroke.paint) === 'none' ? '#1b1b1b' : solid(obj.style.stroke.paint);
      const dx = obj.end.x - obj.start.x;
      const dy = obj.end.y - obj.start.y;
      const length = Math.hypot(dx, dy);
      const size = Math.max(7, (obj.style.stroke.width || 1) * 4);
      const ux = length > 0 ? dx / length : 1;
      const uy = length > 0 ? dy / length : 0;
      const base = { x: obj.end.x - ux * size, y: obj.end.y - uy * size };
      const wing = size * 0.45;
      const arrow =
        obj.arrowEnd && length > 0.01
          ? `<polygon points="${obj.end.x},${obj.end.y} ${base.x - uy * wing},${base.y + ux * wing} ${base.x + uy * wing},${base.y - ux * wing}" fill="${lineStroke}" opacity="${obj.style.opacity}"/>`
          : '';
      const content = `<line x1="${obj.start.x}" y1="${obj.start.y}" x2="${obj.end.x}" y2="${obj.end.y}" ${styleAttributes(obj)}/>${arrow}`;
      return hasStrokeErase(obj) ? `<g${strokeMaskAttr(obj)}>${content}</g>` : content;
    }
    case 'polygon': {
      const points = obj.points.map((point) => `${point.x},${point.y}`).join(' ');
      if (hasStrokeErase(obj)) {
        return (
          `<polygon points="${points}" fill="${solid(obj.style.fill)}" stroke="none" opacity="${obj.style.opacity}"/>` +
          `<g${strokeMaskAttr(obj)}><polygon points="${points}" ${strokeOnlyAttributes(obj)}/></g>`
        );
      }
      return `<polygon points="${points}" ${styleAttributes(obj)}/>`;
    }
    case 'path': {
      const outline = pathData(obj.nodes, obj.closed);
      // 填充擦除优先于画笔材质：mask 中黑色=擦掉，重叠黑块合并，越界黑块不会外泄。
      if (hasEraseMask(obj)) {
        const fill = solid(obj.style.fill);
        const stroke = solid(obj.style.stroke.paint);
        return (
          `<path d="${outline}" fill="${fill}" stroke="none" opacity="${obj.style.opacity}" mask="url(#${eraseMaskId(obj.id)})"/>` +
          `<g${strokeMaskAttr(obj)}><path d="${outline}" fill="none" stroke="${stroke}" stroke-width="${obj.style.stroke.width}" opacity="${obj.style.opacity}"/></g>`
        );
      }
      // 画笔笔迹：中心线 + 宽度包络 → 填充轮廓，保证压感变宽在导出后仍是矢量。
      const brushOutline = brushOutlineData(obj.nodes);
      const material = obj.brushMaterial
        ? brushMaterialLayers(obj.nodes, obj.brushMaterial, obj.style.stroke.width || 2, {
            forceBuckets
          })
        : null;
      const brushFill = solid(obj.style.stroke.paint);
      const bake = bakeMultiply && material?.blendMode === 'multiply';
      // PDF 兜底：multiply 直接乘到页面底色上，输出普通 fill；SVG/PNG/JPG 仍保留真实混合。
      const materialFill = bake
        ? multiplyHex(brushFill, doc.page.background || '#ffffff')
        : brushFill;
      const dashAttr =
        obj.style.stroke.dash.length > 0
          ? ` stroke-dasharray="${obj.style.stroke.dash.join(' ')}"`
          : '';
      // 主体/软边共用一个组：flow 缩放整体不透明度，blendMode 让整笔与背景混合。
      // grain 已单独乘过 flow 并各自带混合模式，不能重复套进这个组。
      const bodyOpen = material
        ? `<g opacity="${material.bodyOpacity}"${
            !bake && material.blendMode === 'multiply' ? ' style="mix-blend-mode:multiply"' : ''
          }>`
        : '<g>';
      if (brushOutline) {
        const main = `<path d="${brushOutline}" fill="${materialFill}" fill-rule="nonzero" stroke="none" opacity="${obj.style.opacity}"/>`;
        if (!material) {
          return hasStrokeErase(obj)
            ? `<g${strokeMaskAttr(obj)}>${main}</g>`
            : main;
        }
        // 软边在主笔迹之前、颗粒在之后：与画布渲染顺序一致。
        const edges = material.edges
          .map(
            (layer) =>
              `<path d="${layer.d}" fill="${materialFill}" fill-rule="nonzero" stroke="none" opacity="${obj.style.opacity * layer.opacity}"/>`
          )
          .join('');
        const grain = material.grain
          .map(
            (layer) =>
              `<path d="${layer.d}" fill="${materialFill}" fill-rule="nonzero" stroke="none" opacity="${obj.style.opacity * layer.opacity}"${
                !bake && layer.blendMode === 'multiply' ? ' style="mix-blend-mode:multiply"' : ''
              }/>`
          )
          .join('');
        return `<g${strokeMaskAttr(obj)}>${bodyOpen}${edges}${main}</g>${grain}</g>`;
      }
      if (material) {
        const edges = material.edges
          .map(
            (layer) =>
              `<path d="${layer.d}" fill="${materialFill}" fill-rule="nonzero" stroke="none" opacity="${obj.style.opacity * layer.opacity}"/>`
          )
          .join('');
        const main = bake
          ? `<path d="${outline}" fill="none" stroke="${materialFill}" stroke-width="${obj.style.stroke.width}" stroke-linecap="${obj.style.stroke.cap}" stroke-linejoin="${obj.style.stroke.join}" opacity="${obj.style.opacity}"${dashAttr}${rotationTransform(obj)}/>`
          : `<path d="${outline}" ${styleAttributes(obj)}${rotationTransform(obj)}/>`;
        const grain = material.grain
          .map(
            (layer) =>
              `<path d="${layer.d}" fill="${materialFill}" fill-rule="nonzero" stroke="none" opacity="${obj.style.opacity * layer.opacity}"${
                !bake && layer.blendMode === 'multiply' ? ' style="mix-blend-mode:multiply"' : ''
              }/>`
          )
          .join('');
        return `<g${strokeMaskAttr(obj)}>${bodyOpen}${edges}${main}</g>${grain}</g>`;
      }
      if (hasStrokeErase(obj)) {
        return (
          `<path d="${outline}" fill="${solid(obj.style.fill)}" stroke="none" opacity="${obj.style.opacity}"/>` +
          `<g${strokeMaskAttr(obj)}><path d="${outline}" ${strokeOnlyAttributes(obj)}/></g>`
        );
      }
      return `<path d="${outline}" ${styleAttributes(obj)}/>`;
    }
    case 'text':
      return textToSvg(obj);
    case 'image': {
      const image = obj as ImageObject;
      return `<image x="${image.x}" y="${image.y}" width="${Math.max(0, image.width)}" height="${Math.max(0, image.height)}" preserveAspectRatio="none" href="${escapeXml(image.src)}" opacity="${image.style.opacity}"${rotationTransform(image)}/>`;
    }
    case 'bond': {
      const shape = chemBondShape(doc, obj);
      const stroke = solid(obj.style.stroke.paint) === 'none' ? '#1b1b1b' : solid(obj.style.stroke.paint);
      const width = obj.style.stroke.width || 2;
      const lines = shape.geometry.segments
        .map((segment) => `<line x1="${segment.x1}" y1="${segment.y1}" x2="${segment.x2}" y2="${segment.y2}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`)
        .join('');
      const polygons = shape.geometry.polygons
        .map((polygon) => `<polygon points="${polygon.map((point) => `${point.x},${point.y}`).join(' ')}" fill="${stroke}"/>`)
        .join('');
      const wavy = shape.geometry.wavyPath
        ? `<path d="${shape.geometry.wavyPath}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`
        : '';
      return `<g opacity="${obj.style.opacity}">${lines}${polygons}${wavy}</g>`;
    }
    case 'atom':
      return atomToSvg(obj, doc.implicitHydrogens === true);
    case 'arrow': {
      const geometry = buildArrowGeometry(obj.arrowKind, obj.start, obj.end);
      const stroke = solid(obj.style.stroke.paint) === 'none' ? '#1b1b1b' : solid(obj.style.stroke.paint);
      const width = obj.style.stroke.width || 1.8;
      const lines = geometry.lines
        .map((line) => `<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`)
        .join('');
      const polygons = geometry.polygons
        .map((polygon) => `<polygon points="${polygon.map((point) => `${point.x},${point.y}`).join(' ')}" fill="${stroke}"/>`)
        .join('');
      const curve = geometry.curve
        ? `<path d="${geometry.curve}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`
        : '';
      const labelX = (obj.start.x + obj.end.x) / 2;
      const label = obj.label
        ? `<text x="${labelX}" y="${(obj.start.y + obj.end.y) / 2 - 10}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="12" fill="#1b1b1b">${obj.label
            .split('\n')
            .map(
              (line, index) =>
                `<tspan x="${labelX}" dy="${index === 0 ? 0 : 13}">${escapeXml(line || ' ')}</tspan>`
            )
            .join('')}</text>`
        : '';
      return `<g opacity="${obj.style.opacity}">${lines}${polygons}${curve}${label}</g>`;
    }
    case 'group': {
      const group = obj as GroupObject;
      const stroke =
        solid(group.style.stroke.paint) === 'none' ? '#1b1b1b' : solid(group.style.stroke.paint);
      if (
        group.ringCircleStyle === 'pauling' &&
        group.ringCenters &&
        group.ringCenters.length > 0
      ) {
        return group.ringCenters
          .map(
            (center) =>
              `<circle cx="${center.x}" cy="${center.y}" r="${22 * (group.ringScale ?? 1)}" fill="none" stroke="${stroke}" stroke-width="${group.style.stroke.width || 2.2}" opacity="${group.style.opacity}"/>`
          )
          .join('');
      }
      if (group.ringStyle !== 'pauling') return '';
      // 与画布一致：内圈由环骨架顶点推导，导出后不会与六元环错位
      const geometry = ringGeometry(
        doc.layers.flatMap((layer) =>
          layer.objects.filter(
            (item): item is BondObject => item.type === 'bond' && item.parentId === group.id
          )
        )
      );
      if (!geometry || !geometry.closed) return '';
      return `<circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="${geometry.circleRadius}" fill="none" stroke="${stroke}" stroke-width="${group.style.stroke.width || 2.2}" opacity="${group.style.opacity}"/>`;
    }
    default:
      return '';
  }
}

export interface SvgExportOptions {
  includeBackground?: boolean;
  /** 只导出页面上的一块矩形；为空表示整页。 */
  region?: ExportRegion | null;
  /** 只导出这些对象（分组自动展开为后代）；为空表示所有可见对象。 */
  includeIds?: string[] | null;
  /**
   * PDF 导出兜底：把笔刷 multiply 预乘到页面底色并输出普通 fill。
   * SVG/PNG/JPG 保持 false，继续使用 mix-blend-mode 的逐 dab 混合。
   */
  bakeMultiply?: boolean;
}

/**
 * 把导出区域规整成合法的矩形（宽高至少 1px）。
 *
 * 注意：这里**不按纸张裁剪**。选中对象可能压在纸边甚至越出纸边，
 * 一旦裁剪就会把对象切掉或整个漏掉；背景色块是按导出框铺的，
 * 越界部分同样得到纸张底色，视觉上没有副作用。
 */
export function resolveExportBox(
  doc: VDrawDocument,
  region?: ExportRegion | null
): { x: number; y: number; width: number; height: number } {
  const pageWidth = Math.max(1, doc.page.width);
  const pageHeight = Math.max(1, doc.page.height);
  if (!region) return { x: 0, y: 0, width: pageWidth, height: pageHeight };
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  return {
    x: finite(region.x, 0),
    y: finite(region.y, 0),
    width: Math.max(1, finite(region.width, pageWidth)),
    height: Math.max(1, finite(region.height, pageHeight))
  };
}

export function documentToSvgString(doc: VDrawDocument, options: SvgExportOptions = {}): string {
  const includeBackground = options.includeBackground ?? true;
  const box = resolveExportBox(doc, options.region);
  // 分组本身不渲染（出图靠子对象），选中分组时必须把后代一起纳入白名单。
  const allowed =
    options.includeIds && options.includeIds.length > 0
      ? new Set(expandSelection(doc, options.includeIds))
      : null;
  // 与画布共用同一份文档级预算：选中导出只统计实际导出的对象。
  const perDabIds = grainBudgetIds(doc, allowed);
  const content = doc.layers
    .filter((layer) => layer.visible)
    .map((layer) => {
      const content = layer.objects
        .filter((obj) => obj.visible && (!allowed || allowed.has(obj.id)))
        .map((obj) => {
          const forceBuckets =
            obj.type === 'path' &&
            obj.brushMaterial?.blendMode === 'multiply' &&
            !perDabIds.has(obj.id);
          const svg = objectToSvg(
            obj,
            doc,
            options.bakeMultiply === true,
            forceBuckets
          );
          return obj.clipIds?.length
            ? `<g clip-path="url(#clip-${obj.id})">${svg}</g>`
            : svg;
        })
        .join('\n');
      // 图层混合模式：导出端用 mix-blend-mode 保持与画布一致。
      if (!content || !layer.blendMode || layer.blendMode === 'normal') return content;
      return `<g data-layer-id="${layer.id}" style="mix-blend-mode:${layer.blendMode}">${content}</g>`;
    })
    .join('\n');

  // 选区内绘制 / alpha 锁：导出端同步输出 clipPath 定义，避免导出"漏出"裁剪范围。
  const clipDefs = doc.layers
    .flatMap((layer) => layer.objects)
    .filter((obj) => obj.clipIds?.length)
    .map((obj) => clipPathDef(doc, obj))
    .filter(Boolean)
    .join('\n');
  // 填充擦除 mask：与画布共用同一份定义，导出后孔洞重叠/越界表现一致。
  const eraseDefs = doc.layers
    .flatMap((layer) => layer.objects)
    .filter((obj): obj is PathObject => obj.type === 'path' && hasEraseMask(obj))
    .map((obj) => eraseMaskDef(obj))
    .filter(Boolean)
    .join('\n');
  const strokeEraseDefs = doc.layers
    .flatMap((layer) => layer.objects)
    .filter((obj) => hasStrokeErase(obj))
    .map((obj) => strokeEraseMaskDef(obj))
    .filter(Boolean)
    .join('\n');
  const defs = `${clipDefs}${eraseDefs}${strokeEraseDefs}`;

  // 背景铺满导出框：框选区域同样得到纸张底色，而不是只覆盖页面左上角。
  const background = includeBackground
    ? `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${doc.page.background}"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}">
${defs ? `<defs>${defs}</defs>\n` : ''}${background}
${content}
</svg>`;
}

export function svgPointList(points: Vec[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}
