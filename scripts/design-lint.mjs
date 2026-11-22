/**
 * 设计令牌守门：扫描样式表，阻止规范外的裸值回潮。
 * 规则（DESIGN_SYSTEM.md 2.3 / 2.4 / 2.5 / 附录 A）：
 *  1. font-size 只能引用 --fs-* 令牌；
 *  2. border-radius 只能引用 --radius-* 令牌或 50%；
 *  3. z-index 只能引用 --z-* 令牌；
 *  4. 裸 hex 只允许出现在 tokens.css，或渐变/url() 等图像数据的函数体内；
 *  5. gap / row-gap / column-gap / padding* / margin* 的 px 值必须落在间距尺度内；
 *  6. transition / animation 时长只能引用 --motion-* 令牌。
 */
import fs from 'node:fs';
import path from 'node:path';

const stylesDir = 'src/styles';
const files = fs.readdirSync(stylesDir).filter((file) => file.endsWith('.css'));
const problems = [];

/** 间距尺度：4 的倍数 + 2 与 6 两个半档，覆盖控件内边距与图标间隙。 */
const SPACING_SCALE = new Set([0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48]);
const SPACING_PROPS = /^(?:gap|row-gap|column-gap|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?)$/;

/**
 * 标出「图像数据函数体」的字符掩码：linear/radial/conic-gradient 与 url()。
 * 只在这段区间内放行裸色值，避免整行豁免成为绕过令牌的口子。
 */
function imageDataMask(text) {
  const mask = new Uint8Array(text.length);
  const re =
    /(?:repeating-)?(?:linear|radial|conic)-gradient\(|url\(/gi;
  let match;
  while ((match = re.exec(text))) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    for (; index < text.length; index += 1) {
      mask[index] = 1;
      if (text[index] === '(') depth += 1;
      else if (text[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    re.lastIndex = index;
  }
  return mask;
}

function checkSpacing(at, decl, prop, raw) {
  const values = raw.replace(/!important/g, '').trim();
  if (values === '' || values === '0') return;
  for (const value of values.split(/\s+/)) {
    if (!value) continue;
    if (value === 'auto' || value === '0') continue;
    if (/^(?:var|calc|min|max|clamp|env)\(/.test(value)) continue;
    if (/%$/.test(value)) continue;
    const px = value.match(/^(-?\d*\.?\d+)px$/);
    if (!px) continue;
    const size = Math.abs(Number(px[1]));
    if (!SPACING_SCALE.has(size)) {
      problems.push(`${at} ${prop} 不在间距尺度内：${value}（允许 0/2/4/6/8/12/16/20/24/32/40/48）`);
    }
  }
}

for (const file of files) {
  const full = path.join(stylesDir, file);
  const text = fs.readFileSync(full, 'utf8');
  const mask = imageDataMask(text);
  const lines = text.split(/\r?\n/);
  let offset = 0;

  lines.forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    const code = line.trim();

    const fontSize = code.match(/font-size:\s*([^;]+);/);
    if (fontSize && !/^var\(--fs-[a-z0-9]+\)(?:\s*!important)?$/.test(fontSize[1].trim())) {
      problems.push(`${at} font-size 必须使用 --fs-* 令牌：${fontSize[1].trim()}`);
    }

    const radius = code.match(/border-radius:\s*([^;]+);/);
    if (radius) {
      const value = radius[1].trim();
      const ok = value === '50%' || value === '0' || /^var\(--radius-[a-z]+\)$/.test(value);
      if (!ok) problems.push(`${at} border-radius 必须使用 --radius-* 令牌：${value}`);
    }

    const zIndex = code.match(/z-index:\s*([^;]+);/);
    if (zIndex && !/^var\(--z-[a-z-]+\)$/.test(zIndex[1].trim())) {
      problems.push(`${at} z-index 必须使用 --z-* 令牌：${zIndex[1].trim()}`);
    }

    if (file !== 'tokens.css') {
      const hex = /#[0-9a-fA-F]{3,8}\b/g;
      let hit;
      while ((hit = hex.exec(line))) {
        // 行内偏移换算到全文偏移，判断是否落在渐变/url 的函数体内。
        const absolute = offset + hit.index;
        if (!mask[absolute]) {
          problems.push(`${at} 裸色值应移入 tokens.css（或写在渐变函数内）：${hit[0]}`);
        }
      }
    }

    const spacing = code.match(/^([a-z-]+):\s*([^;]+);/);
    if (spacing && SPACING_PROPS.test(spacing[1])) {
      checkSpacing(at, spacing[0], spacing[1], spacing[2]);
    }

    const motion = code.match(/^(?:transition|animation):\s*([^;]+);/);
    if (motion && /(?:^|\s)\d*\.?\d+m?s(?:\s|,|$)/.test(motion[1])) {
      problems.push(`${at} 动效时长必须使用 --motion-* 令牌：${motion[1].trim()}`);
    }

    offset += line.length + 1;
  });
}

if (problems.length > 0) {
  console.error(`[design-lint] 发现 ${problems.length} 处规范外写法：`);
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log(
  `[design-lint] ${files.length} 个样式表通过：字号 / 圆角 / 层级 / 色值 / 间距（gap+padding+margin）/ 动效均在令牌内。`
);
