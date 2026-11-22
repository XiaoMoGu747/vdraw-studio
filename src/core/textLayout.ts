import type { TextObject } from '../types/document';
import { measureText } from './scene';
import { wrapTextToWidth } from './textMetrics';

export type TextPatch = Partial<
  Pick<
    TextObject,
    | 'text'
    | 'fontFamily'
    | 'fontSize'
    | 'fontWeight'
    | 'italic'
    | 'letterSpacing'
    | 'direction'
    | 'lineHeight'
    | 'maxWidth'
    | 'align'
  >
> & { color?: string };

/**
 * 文本对象唯一的排版入口：换行 → 实测 → 对齐锚点修正。
 * 横栏、右侧属性、画布输入提交都必须走这里，避免出现"面板显示一套、渲染另一套"。
 */
export function patchTextObject(obj: TextObject, patch: TextPatch): TextObject {
  const text = patch.text ?? obj.text;
  const fontFamily = patch.fontFamily ?? obj.fontFamily;
  const fontSize = Math.max(1, patch.fontSize ?? obj.fontSize);
  const fontWeight = patch.fontWeight ?? obj.fontWeight;
  const letterSpacing = patch.letterSpacing ?? obj.letterSpacing ?? 0;
  const direction = patch.direction ?? obj.direction ?? 'horizontal';
  const lineHeight = patch.lineHeight ?? obj.lineHeight ?? 1.32;
  const maxWidth = Math.max(0, patch.maxWidth ?? obj.maxWidth ?? 0);
  const align = patch.align ?? obj.align;

  const wrapped = wrapTextToWidth(text, maxWidth, fontSize, letterSpacing, {
    fontWeight,
    fontFamily,
    lineHeight
  });
  const metrics = measureText(wrapped, fontSize, letterSpacing, direction, {
    fontWeight,
    fontFamily,
    lineHeight
  });

  // 居中/右对齐的锚点随宽度变化：平移 x，避免改字号/框宽后整体漂移。
  const shiftX =
    align === 'center'
      ? (obj.width - metrics.width) / 2
      : align === 'right'
        ? obj.width - metrics.width
        : 0;

  return {
    ...obj,
    text,
    fontFamily,
    fontSize,
    fontWeight,
    italic: patch.italic ?? obj.italic,
    letterSpacing,
    direction,
    lineHeight,
    maxWidth,
    align,
    width: metrics.width,
    height: metrics.height,
    x: obj.x + shiftX,
    style: patch.color
      ? { ...obj.style, fill: { type: 'solid' as const, color: patch.color } }
      : obj.style
  };
}
