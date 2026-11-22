import type { IconName } from '../types/ui';
import type { ToolId } from '../types/document';
import { RAIL_GROUPS, TOOL_MAP } from './tools';

export interface RailEntry {
  key: string;
  label: string;
  icon: IconName;
  group: string;
  tool: ToolId;
  tools?: ToolId[];
  chemistry?: boolean;
  /** 化学子工具：激活时的原子分类 */
  atomCategory?: 'element' | 'group';
}

const CHEM_ENTRIES: RailEntry[] = [
  { key: 'chem:bond', label: '化学键', icon: 'bond', group: 'chem', tool: 'bond' },
  {
    key: 'chem:element',
    label: '元素',
    icon: 'atom',
    group: 'chem',
    tool: 'atom',
    atomCategory: 'element'
  },
  {
    key: 'chem:group',
    label: '官能团',
    icon: 'molecule',
    group: 'chem',
    tool: 'atom',
    atomCategory: 'group'
  },
  { key: 'chem:ring', label: '苯环 / 环系', icon: 'ring', group: 'chem', tool: 'ring' },
  { key: 'chem:arrow', label: '反应箭头', icon: 'arrow', group: 'chem', tool: 'arrow' },
  { key: 'chem:chem-eraser', label: '化学橡皮', icon: 'eraser', group: 'chem', tool: 'eraser' }
];

export const RAIL_CATALOG: RailEntry[] = [
  ...RAIL_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      key: item.id,
      label: item.label,
      icon: item.icon,
      group: group.id,
      tool: item.tool,
      tools: item.tools,
      chemistry: item.chemistry
    }))
  ),
  ...CHEM_ENTRIES
];

export const DEFAULT_RAIL_ORDER = RAIL_GROUPS.flatMap((group) =>
  group.items.map((item) => item.id)
);

export function railEntry(key: string): RailEntry | null {
  return RAIL_CATALOG.find((item) => item.key === key) ?? null;
}

export function railShortcut(key: string): string | null {
  const entry = railEntry(key);
  if (!entry) return null;
  return TOOL_MAP[entry.tool]?.shortcut ?? null;
}
