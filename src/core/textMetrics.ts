import { setTextMeasurer } from './scene';
import type { TextMeasureOptions } from './scene';

type Metrics = { width: number; height: number };

const cache = new Map<string, Metrics>();
let context: CanvasRenderingContext2D | null | undefined;

function getContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  if (typeof document === 'undefined') {
    context = null;
    return context;
  }
  const canvas = document.createElement('canvas');
  context = canvas.getContext('2d');
  return context;
}

function trimCache(): void {
  if (cache.size <= 500) return;
  // 简单 FIFO：删除最早插入的 100 项，避免无界增长。
  let removed = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    removed += 1;
    if (removed >= 100) break;
  }
}

/**
 * 按文本框宽度计算软换行：只返回排版结果，不修改文档里的原始段落文本。
 * maxWidth<=0 表示不换行。无 Canvas 时按字符数粗略估计。
 */
const wrapCache = new Map<string, string>();

function trimWrapCache(): void {
  if (wrapCache.size <= 400) return;
  let removed = 0;
  for (const key of wrapCache.keys()) {
    wrapCache.delete(key);
    removed += 1;
    if (removed >= 80) break;
  }
}

export function wrapTextToWidth(
  text: string,
  maxWidth: number,
  fontSize: number,
  letterSpacing: number,
  options: Required<TextMeasureOptions>
): string {
  if (!(maxWidth > 0)) return text;
  // 渲染/导出每帧都会调用：按"文本 + 排版参数"缓存，避免逐字重测。
  const key = `${maxWidth}|${fontSize}|${letterSpacing}|${options.fontWeight}|${options.fontFamily}|${options.lineHeight}|${text}`;
  const cached = wrapCache.get(key);
  if (cached !== undefined) return cached;
  const ctx = getContext();
  if (ctx) ctx.font = `${options.fontWeight} ${fontSize}px ${options.fontFamily}`;
  const measure = (value: string): number => {
    if (!value) return 0;
    const spacing = [...value].length > 1 ? letterSpacing * ([...value].length - 1) : 0;
    return ctx ? ctx.measureText(value).width + spacing : [...value].length * fontSize * 0.6;
  };
  const result = text
    .split('\n')
    .map((paragraph) => {
      if (!paragraph) return '';
      const lines: string[] = [];
      let current = '';
      for (const char of [...paragraph]) {
        const candidate = current + char;
        if (current && measure(candidate) > maxWidth) {
          lines.push(current);
          current = char;
        } else {
          current = candidate;
        }
      }
      lines.push(current);
      return lines.join('\n');
    })
    .join('\n');
  wrapCache.set(key, result);
  trimWrapCache();
  return result;
}

/** 用 Canvas 实测文本宽度；字体/字重/行高变化都会反映到包围盒。 */
export function installCanvasTextMeasurer(): void {
  setTextMeasurer(
    (
      text: string,
      fontSize: number,
      letterSpacing: number,
      direction: 'horizontal' | 'vertical',
      options: Required<TextMeasureOptions>
    ): Metrics => {
      const key = [
        direction,
        fontSize,
        letterSpacing,
        options.fontWeight,
        options.fontFamily,
        options.lineHeight,
        text
      ].join('|');
      const cached = cache.get(key);
      if (cached) return cached;

      const ctx = getContext();
      const lines = text.split('\n');
      let metrics: Metrics;

      if (!ctx) {
        // 无 Canvas（极端环境）时退回保守估算，保证不崩溃。
        const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
        metrics = {
          width: Math.max(12, Math.ceil(longest * fontSize * 0.6) + 4),
          height: Math.max(fontSize, Math.ceil(fontSize + (lines.length - 1) * fontSize * options.lineHeight))
        };
      } else if (direction === 'vertical') {
        ctx.font = `${options.fontWeight} ${fontSize}px ${options.fontFamily}`;
        const characters = [...lines.join('')];
        let widest = 0;
        for (const char of characters) {
          widest = Math.max(widest, ctx.measureText(char).width);
        }
        const gap = Math.max(0, letterSpacing);
        const height =
          characters.length === 0
            ? fontSize
            : characters.length * fontSize * options.lineHeight +
              (characters.length - 1) * gap;
        metrics = {
          width: Math.max(fontSize * 0.5, Math.ceil(widest) + 4),
          height: Math.max(fontSize, Math.ceil(height))
        };
      } else {
        ctx.font = `${options.fontWeight} ${fontSize}px ${options.fontFamily}`;
        let widest = 0;
        for (const line of lines) {
          const chars = [...line];
          const base = ctx.measureText(line).width;
          const spacing = chars.length > 1 ? letterSpacing * (chars.length - 1) : 0;
          widest = Math.max(widest, base + spacing);
        }
        metrics = {
          width: Math.max(12, Math.ceil(widest) + 4),
          height: Math.max(
            fontSize,
            Math.ceil(fontSize + (lines.length - 1) * fontSize * options.lineHeight)
          )
        };
      }

      cache.set(key, metrics);
      trimCache();
      return metrics;
    }
  );
}
