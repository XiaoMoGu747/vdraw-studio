import type { SceneObject } from '../types/document';
import { brushOutlineData } from './brush';

/** 可作为裁剪轮廓的对象类型。 */
export function canClip(object: SceneObject): boolean {
  if (object.type === 'rect' || object.type === 'ellipse' || object.type === 'polygon') return true;
  return object.type === 'path' && (object.closed || object.nodes.some((node) => typeof node.width === 'number'));
}

function rotationTransform(object: SceneObject): string {
  if (!object.rotation) return '';
  const cx = object.x + object.width / 2;
  const cy = object.y + object.height / 2;
  return ` transform="rotate(${object.rotation} ${cx} ${cy})"`;
}

/**
 * 返回对象在 clipPath 内使用的剪影 SVG（字符串）。
 * 画布渲染与 SVG 导出共用同一份几何，保证双端一致。
 */
export function clipShapeSvg(object: SceneObject): string {
  const transform = rotationTransform(object);
  switch (object.type) {
    case 'rect':
      return `<rect x="${object.x}" y="${object.y}" width="${Math.max(0, object.width)}" height="${Math.max(0, object.height)}" rx="${object.cornerRadius}"${transform}/>`;
    case 'ellipse':
      return `<ellipse cx="${object.x + object.width / 2}" cy="${object.y + object.height / 2}" rx="${Math.max(0, object.width / 2)}" ry="${Math.max(0, object.height / 2)}"${transform}/>`;
    case 'polygon':
      return `<polygon points="${object.points.map((point) => `${point.x},${point.y}`).join(' ')}"${transform}/>`;
    case 'path': {
      const outline = brushOutlineData(object.nodes);
      if (outline) return `<path d="${outline}"${transform}/>`;
      const d = object.nodes
        .map((node, index) => `${index === 0 ? 'M' : 'L'} ${node.x} ${node.y}`)
        .join(' ');
      return `<path d="${d}${object.closed ? ' Z' : ''}"${transform}/>`;
    }
    default:
      // 线/文本/化学/编组没有可直接用作 clip 的填充轮廓，退化为包围盒。
      return `<rect x="${object.x}" y="${object.y}" width="${Math.max(0, object.width)}" height="${Math.max(0, object.height)}"${transform}/>`;
  }
}

/** 生成某个对象的 clipPath 定义；引用不到的对象返回空串。 */
export function clipPathDef(doc: { layers: { objects: SceneObject[] }[] }, object: SceneObject): string {
  if (!object.clipIds?.length) return '';
  const shapes: string[] = [];
  for (const id of object.clipIds) {
    for (const layer of doc.layers) {
      const target = layer.objects.find((item) => item.id === id);
      if (target) {
        shapes.push(clipShapeSvg(target));
        break;
      }
    }
  }
  if (shapes.length === 0) return '';
  return `<clipPath id="clip-${object.id}" clipPathUnits="userSpaceOnUse">${shapes.join('')}</clipPath>`;
}
