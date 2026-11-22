/**
 * 语义令牌对比度守门：解析 tokens.css 的浅色 / 深色两套变量，
 * 对正文与状态文字逐对计算 WCAG 2.1 对比度，低于 4.5:1 时失败。
 * 只检查令牌层，不替代 axe-core 的 DOM 级审计，但能防止 M5-2 类回退。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TOKENS_PATH = path.join(ROOT, 'src/styles/tokens.css');
const MIN_RATIO = 4.5;

const source = fs.readFileSync(TOKENS_PATH, 'utf8');
const darkIndex = source.indexOf("html[data-theme='dark']");
if (darkIndex < 0) {
  console.error('[contrast] 未找到深色主题块');
  process.exit(1);
}
const lightSource = source.slice(0, darkIndex);
const darkSource = source.slice(darkIndex);

function parseDeclarations(block) {
  const map = new Map();
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

const palettes = {
  light: parseDeclarations(lightSource),
  dark: parseDeclarations(darkSource)
};

function resolve(name, map, depth = 0) {
  if (depth > 12) return null;
  const raw = map.get(name);
  if (!raw) return null;
  const direct = raw.match(/^#([0-9a-f]{3,8})$/i);
  if (direct) return normalizeHex(direct[1]);
  const reference = raw.match(/^var\(--([\w-]+)\)$/);
  if (reference) return resolve(reference[1], map, depth + 1);
  return null;
}

function normalizeHex(value) {
  const hex = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
  if (hex.length !== 6) return null;
  return hex.toUpperCase();
}

function luminance(hex) {
  const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const PAIRS = [
  ['text-1', 'bg-panel'],
  ['text-1', 'bg-panel-2'],
  ['text-2', 'bg-panel'],
  ['text-2', 'bg-panel-2'],
  ['text-2', 'bg-hover'],
  ['text-3', 'bg-panel'],
  ['text-3', 'bg-panel-2'],
  ['text-3', 'bg-hover'],
  ['text-3', 'bg-active'],
  ['text-3', 'neutral-0'],
  ['on-accent', 'accent'],
  ['accent-text', 'accent-soft'],
  ['accent-text', 'neutral-0'],
  ['chem-text', 'chem-soft'],
  ['warning-text', 'warning-soft'],
  ['danger-text', 'danger-soft'],
  ['success-text', 'success-soft']
];

const failures = [];

for (const [theme, map] of Object.entries(palettes)) {
  for (const [fgName, bgName] of PAIRS) {
    const foreground = resolve(fgName, map);
    const background = resolve(bgName, map);
    if (!foreground || !background) {
      failures.push(`${theme}: 无法解析 ${fgName} / ${bgName}`);
      continue;
    }
    const ratio = contrast(foreground, background);
    if (ratio < MIN_RATIO) {
      failures.push(
        `${theme}: --${fgName} (${foreground}) on --${bgName} (${background}) = ${ratio.toFixed(2)}:1 < ${MIN_RATIO}:1`
      );
    }
  }
}

if (failures.length > 0) {
  console.error('[contrast] 以下语义色对未达 WCAG AA：');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log(`[contrast] ${PAIRS.length * 2} 组语义色对均 ≥ ${MIN_RATIO}:1（浅色 / 深色）`);
