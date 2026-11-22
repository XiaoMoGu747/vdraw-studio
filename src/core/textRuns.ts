/**
 * 轻量上下标：把 ^{...} / _{...} 转成 Unicode 上下标字符。
 * 这样文本对象仍是纯字符串，渲染、度量、SVG 导出、复制粘贴全链路无需改动。
 * 未收录的字符原样保留（不会丢字），适合化学式 H_{2}O、数学式 x^{2}。
 */
const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ',
  h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ',
  o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ',
  w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ'
};

const SUBSCRIPTS: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ',
  m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ',
  u: 'ᵤ', v: 'ᵥ', x: 'ₓ'
};

function mapChars(value: string, table: Record<string, string>): string {
  return [...value].map((char) => table[char] ?? char).join('');
}

export function parseTextScripts(text: string): string {
  // 只识别显式花括号写法，避免把普通文本里的 "_" 或 "^" 吃掉。
  return text
    .replace(/\^\{([^}]*)\}/g, (_, value: string) => mapChars(value, SUPERSCRIPTS))
    .replace(/_\{([^}]*)\}/g, (_, value: string) => mapChars(value, SUBSCRIPTS));
}
