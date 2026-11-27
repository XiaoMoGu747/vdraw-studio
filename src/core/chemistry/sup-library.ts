/**
 * 官能团（SUP）库。
 *
 * 对齐 KingDraw 的 `GSGroupModel`：官能团不是"一串散装文本"，而是带锚点的整体。
 * `smiles` 里的 `*` 表示可挂接点；没有 `*` 的是完整分子，只能独立放置，
 * 对应 KingDraw 的 `isRHave = 0`（docs/kingdraw-rea-analysis.md §8.2）。
 */

export type SupAnchorKind = 'single' | null;

export interface SupEntry {
  /** 与 ATOM_PRESETS.id 一致，便于面板与数据互通 */
  id: string;
  /** 折叠态显示文本 */
  display: string;
  /** 中文名，用于提示与检索 */
  name: string;
  /** 含 `*` 表示可挂键；无 `*` 表示完整分子 */
  smiles: string;
  /** 可挂接点数量；0 表示不可挂接 */
  anchor: SupAnchorKind;
  /** 除碳以外的重原子数，用于分子式与价态统计 */
  heteroAtoms: number;
  /** 是否提供展开结构（本轮仅内置少量手写展开） */
  expandable: boolean;
}

const entry = (
  id: string,
  display: string,
  name: string,
  smiles: string,
  heteroAtoms: number,
  expandable = false
): SupEntry => ({
  id,
  display,
  name,
  smiles,
  anchor: smiles.includes('*') ? 'single' : null,
  heteroAtoms,
  expandable
});

export const SUP_ENTRIES: SupEntry[] = [
  entry('CH3', 'CH₃', '甲基', '*C', 0, true),
  entry('OH', 'OH', '羟基', '*O', 1, true),
  entry('NH2', 'NH₂', '氨基', '*N', 1, true),
  entry('COOH', 'COOH', '羧基', '*C(=O)O', 2, true),
  entry('COO-', 'COO⁻', '羧酸根', '*C(=O)[O-]', 2, true),
  entry('CHO', 'CHO', '醛基', '*C=O', 1, true),
  entry('NO2', 'NO₂', '硝基', '*[N+](=O)[O-]', 3, true),
  entry('NH3+', 'NH₃⁺', '铵基', '*[NH3+]', 1, false),
  entry('CN', 'CN', '氰基', '*C#N', 1, true),
  entry('OMe', 'OMe', '甲氧基', '*OC', 1, true),
  entry('OEt', 'OEt', '乙氧基', '*OCC', 1, true),
  entry('Et', 'Et', '乙基', '*CC', 0, true),
  entry('iPr', 'iPr', '异丙基', '*C(C)C', 0, true),
  entry('Ph', 'Ph', '苯基', '*c1ccccc1', 0, false),
  entry('Bn', 'Bn', '苄基', '*Cc1ccccc1', 0, false),
  entry('COOMe', 'COOMe', '甲酯基', '*C(=O)OC', 2, false),
  entry('CONH2', 'CONH₂', '酰胺基', '*C(=O)N', 2, false),
  entry('tBu', 'tBu', '叔丁基', '*C(C)(C)C', 0, false),
  entry('Boc', 'Boc', '叔丁氧羰基', '*C(=O)OC(C)(C)C', 2, false),
  entry('CF3', 'CF₃', '三氟甲基', '*C(F)(F)F', 3, false),
  entry('SO3H', 'SO₃H', '磺酸基', '*S(=O)(=O)O', 3, false)
];

const BY_ID = new Map(SUP_ENTRIES.map((item) => [item.id, item]));

export function supEntryOf(id: string | null | undefined): SupEntry | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

/** 折叠态显示文本；未知条目回落到 id 本身（兼容旧 `label.group` 字面量）。 */
export function supDisplayOf(id: string | null | undefined): string | null {
  if (!id) return null;
  return BY_ID.get(id)?.display ?? id;
}

/** 是否可作为取代基挂到键上。 */
export function supIsAttachable(id: string | null | undefined): boolean {
  const sup = supEntryOf(id);
  return Boolean(sup && sup.anchor);
}

/** 旧文件里的纯文本基团映射成 SUP id，保证可继续渲染与统计。 */
export function canonicalSupId(rawGroup: string | null | undefined): string | null {
  if (!rawGroup) return null;
  const normalized = rawGroup.replace(/[₀-₉⁰-⁹⁺⁻]/g, (char) => {
    const subs: Record<string, string> = {
      '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
      '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
      '⁺': '+', '⁻': '-'
    };
    return subs[char] ?? char;
  });
  const direct = SUP_ENTRIES.find(
    (item) => item.display === rawGroup || item.id === normalized || item.id === rawGroup
  );
  if (direct) return direct.id;
  return `legacy:${rawGroup}`;
}
