import type { ArrowKind, BondType } from '../../types/document';

export interface BondPreset {
  type: BondType;
  name: string;
  hint: string;
}

export const BOND_PRESETS: BondPreset[] = [
  { type: 'single', name: '单键', hint: 'σ 键' },
  { type: 'double', name: '双键', hint: 'C=C / C=O' },
  { type: 'triple', name: '三键', hint: 'C≡C / C≡N' },
  { type: 'aromatic', name: '芳香键', hint: '共轭环' },
  { type: 'wedge', name: '楔形键', hint: '朝向观察者' },
  { type: 'hashed', name: '虚线楔键', hint: '背离观察者' },
  { type: 'wavy', name: '波浪键', hint: '未知立体化学' },
  { type: 'dative', name: '配位键', hint: '孤对给予' }
];

export const BOND_TYPE_LABEL: Record<BondType, string> = BOND_PRESETS.reduce(
  (acc, preset) => ({ ...acc, [preset.type]: preset.name }),
  {} as Record<BondType, string>
);

export interface AtomPreset {
  id: string;
  display: string;
  element: string;
  kind: 'element' | 'group';
  hint: string;
}

export const ATOM_PRESETS: AtomPreset[] = [
  { id: 'C', display: 'C', element: 'C', kind: 'element', hint: '碳原子' },
  { id: 'N', display: 'N', element: 'N', kind: 'element', hint: '氮原子' },
  { id: 'O', display: 'O', element: 'O', kind: 'element', hint: '氧原子' },
  { id: 'S', display: 'S', element: 'S', kind: 'element', hint: '硫原子' },
  { id: 'P', display: 'P', element: 'P', kind: 'element', hint: '磷原子' },
  { id: 'B', display: 'B', element: 'B', kind: 'element', hint: '硼原子' },
  { id: 'Si', display: 'Si', element: 'Si', kind: 'element', hint: '硅原子' },
  { id: 'F', display: 'F', element: 'F', kind: 'element', hint: '氟原子' },
  { id: 'Cl', display: 'Cl', element: 'Cl', kind: 'element', hint: '氯原子' },
  { id: 'Br', display: 'Br', element: 'Br', kind: 'element', hint: '溴原子' },
  { id: 'I', display: 'I', element: 'I', kind: 'element', hint: '碘原子' },
  { id: 'Li', display: 'Li', element: 'Li', kind: 'element', hint: '锂原子 / 锂离子' },
  { id: 'Na', display: 'Na', element: 'Na', kind: 'element', hint: '钠原子 / 钠离子' },
  { id: 'K', display: 'K', element: 'K', kind: 'element', hint: '钾原子 / 钾离子' },
  { id: 'Mg', display: 'Mg', element: 'Mg', kind: 'element', hint: '镁原子 / 镁离子' },
  { id: 'Ca', display: 'Ca', element: 'Ca', kind: 'element', hint: '钙原子 / 钙离子' },
  { id: 'Al', display: 'Al', element: 'Al', kind: 'element', hint: '铝原子' },
  { id: 'H', display: 'H', element: 'H', kind: 'element', hint: '氢原子' },
  { id: 'CH3', display: 'CH₃', element: 'C', kind: 'group', hint: '甲基' },
  { id: 'OH', display: 'OH', element: 'O', kind: 'group', hint: '羟基' },
  { id: 'NH2', display: 'NH₂', element: 'N', kind: 'group', hint: '氨基' },
  { id: 'COOH', display: 'COOH', element: 'C', kind: 'group', hint: '羧基' },
  { id: 'COO-', display: 'COO⁻', element: 'C', kind: 'group', hint: '羧酸根' },
  { id: 'CHO', display: 'CHO', element: 'C', kind: 'group', hint: '醛基' },
  { id: 'NO2', display: 'NO₂', element: 'N', kind: 'group', hint: '硝基' },
  { id: 'NH3+', display: 'NH₃⁺', element: 'N', kind: 'group', hint: '铵基' },
  { id: 'CN', display: 'CN', element: 'C', kind: 'group', hint: '氰基' },
  { id: 'OMe', display: 'OMe', element: 'O', kind: 'group', hint: '甲氧基' },
  { id: 'OEt', display: 'OEt', element: 'O', kind: 'group', hint: '乙氧基' },
  { id: 'Et', display: 'Et', element: 'C', kind: 'group', hint: '乙基' },
  { id: 'iPr', display: 'iPr', element: 'C', kind: 'group', hint: '异丙基' },
  { id: 'Ph', display: 'Ph', element: 'C', kind: 'group', hint: '苯基' },
  { id: 'Bn', display: 'Bn', element: 'C', kind: 'group', hint: '苄基' },
  { id: 'COOMe', display: 'COOMe', element: 'C', kind: 'group', hint: '甲酯基' },
  { id: 'CONH2', display: 'CONH₂', element: 'C', kind: 'group', hint: '酰胺基' },
  { id: 'tBu', display: 'tBu', element: 'C', kind: 'group', hint: '叔丁基' },
  { id: 'Boc', display: 'Boc', element: 'C', kind: 'group', hint: '叔丁氧羰基' },
  { id: 'CF3', display: 'CF₃', element: 'C', kind: 'group', hint: '三氟甲基' },
  { id: 'SO3H', display: 'SO₃H', element: 'S', kind: 'group', hint: '磺酸基' }
];

export interface ArrowPreset {
  kind: ArrowKind;
  name: string;
  hint: string;
}

export const ARROW_PRESETS: ArrowPreset[] = [
  { kind: 'reaction', name: '反应箭头', hint: '正向反应' },
  { kind: 'equilibrium', name: '平衡箭头', hint: '可逆反应' },
  { kind: 'retro', name: '逆合成箭头', hint: '合成拆分' },
  { kind: 'mechanism', name: '机理箭头', hint: '电子转移' }
];
