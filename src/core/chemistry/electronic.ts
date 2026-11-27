import type { BondObject } from '../../types/document';

/**
 * 化学规则基础数据与推导。
 *
 * 这里保留的是元素本身的参考数据（周期、价电子数），
 * 具体某根键能否升级、某个原子还能成几根键，全部由
 * σ 键数量、π 键数量、价层电子容量与杂化状态实时推导。
 */
export interface ElementProfile {
  symbol: string;
  period: number;
  valenceElectrons: number;
  /** 第三周期以后可能出现的常见价态（扩展八隅体） */
  expandedValences?: number[];
}

export type Hybridization = 's' | 'sp' | 'sp2' | 'sp3' | 'unknown';

const ELEMENTS: Record<string, ElementProfile> = {
  H: { symbol: 'H', period: 1, valenceElectrons: 1 },
  B: { symbol: 'B', period: 2, valenceElectrons: 3 },
  C: { symbol: 'C', period: 2, valenceElectrons: 4 },
  N: { symbol: 'N', period: 2, valenceElectrons: 5 },
  O: { symbol: 'O', period: 2, valenceElectrons: 6 },
  F: { symbol: 'F', period: 2, valenceElectrons: 7 },
  Li: { symbol: 'Li', period: 2, valenceElectrons: 1 },
  Si: { symbol: 'Si', period: 3, valenceElectrons: 4, expandedValences: [4] },
  P: { symbol: 'P', period: 3, valenceElectrons: 5, expandedValences: [3, 5] },
  S: { symbol: 'S', period: 3, valenceElectrons: 6, expandedValences: [2, 4, 6] },
  Na: { symbol: 'Na', period: 3, valenceElectrons: 1 },
  Mg: { symbol: 'Mg', period: 3, valenceElectrons: 2 },
  Al: { symbol: 'Al', period: 3, valenceElectrons: 3 },
  Cl: { symbol: 'Cl', period: 3, valenceElectrons: 7, expandedValences: [1, 3, 5, 7] },
  K: { symbol: 'K', period: 4, valenceElectrons: 1 },
  Ca: { symbol: 'Ca', period: 4, valenceElectrons: 2 },
  Br: { symbol: 'Br', period: 4, valenceElectrons: 7, expandedValences: [1, 3, 5, 7] },
  I: { symbol: 'I', period: 5, valenceElectrons: 7, expandedValences: [1, 3, 5, 7] }
};

/**
 * 常见金属的成键价：碱金属 1、碱土金属 2、铝 3。
 * 金属阳离子的正电荷会占用价电子，因此可再成键数按电荷递减。
 */
const METAL_VALENCE: Record<string, number> = {
  Li: 1,
  Na: 1,
  K: 1,
  Mg: 2,
  Ca: 2,
  Al: 3
};

export function elementProfile(element: string): ElementProfile | null {
  return ELEMENTS[element] ?? null;
}

/** 由价电子数推导八隅体允许的总键价；电荷会改变价电子数。 */
export function octetCapacity(element: string, charge = 0): number | null {
  const profile = elementProfile(element);
  if (!profile) return null;
  if (profile.period === 1) return charge === 0 ? 1 : 0;
  if (profile.period === 2) {
    // 第二周期按八隅体推导；B/C 的电离/碳负离子按常见价态修正
    if (element === 'B') return Math.max(0, 3 - charge);
    if (element === 'C') return Math.max(0, 4 - Math.abs(charge));
    if (element === 'N') return Math.max(0, 3 + charge);
    if (element === 'O') return Math.max(0, 2 + charge);
    if (element === 'F') return charge === 0 ? 1 : 0;
    return Math.max(0, 8 - (profile.valenceElectrons - charge));
  }
  return null;
}

/**
 * 元素可接受的最大总键价。
 * 第二周期严格服从八隅体（C=4、N=3、O=2…）；
 * 第三周期以后允许表列扩展价态。
 */
export function maxValenceFor(element: string, charge = 0): number | null {
  const metal = METAL_VALENCE[element];
  if (metal !== undefined) {
    // 金属按常见阳离子价态计：Na⁺/K⁺/Li⁺ 为 0，Ca²⁺/Mg²⁺ 为 0，Al³⁺ 为 0。
    return Math.max(0, metal - Math.max(0, charge));
  }
  const profile = elementProfile(element);
  if (!profile) return element === 'C' ? 4 : null;
  const octet = octetCapacity(element, charge);
  if (octet !== null) return octet;
  const states = profile.expandedValences ?? [];
  if (states.length === 0) return Math.max(1, profile.valenceElectrons - charge);
  return Math.max(1, Math.max(...states) + charge);
}

export function valenceStatesFor(element: string, charge = 0): number[] {
  const profile = elementProfile(element);
  if (!profile) return [];
  const max = maxValenceFor(element, charge);
  const states = new Set<number>();
  if (max !== null) states.add(max);
  for (const value of profile.expandedValences ?? []) states.add(value + charge);
  return [...states].filter((value) => value >= 0).sort((a, b) => a - b);
}

export interface BondingState {
  /** σ 键数量：显式键 + 氢（不含孤对，用于键价容量） */
  sigma: number;
  /** π 键数量：由键级减一累计 */
  pi: number;
  /** 总成键价层占用（σ+π） */
  used: number;
  /** 参与杂化的轨道数：σ 键 + 孤对 */
  orbitals: number;
}

export function bondingState(
  bonds: BondObject[],
  hydrogens = 0,
  lonePairs = 0,
  aromatic = false,
  ringBondIds: Set<string> = new Set()
): BondingState {
  const sigma = bonds.length + hydrogens;
  const orbitals = sigma + lonePairs;
  // 芳香环的离域 π 体系对每个环原子折算为 1 个 π 电子
  let pi = aromatic ? 1 : 0;
  for (const bond of bonds) {
    if (aromatic && ringBondIds.has(bond.id)) continue;
    pi += Math.max(0, bondOrderOf(bond) - 1);
  }
  return { sigma, pi, used: sigma + pi, orbitals };
}

function bondOrderOf(bond: BondObject): number {
  if (bond.bondType === 'double') return 2;
  if (bond.bondType === 'triple') return 3;
  if (bond.bondType === 'aromatic') return 1.5;
  return 1;
}

/**
 * 已有键升级到更高键级时，按两端原子的 σ/π 容量推导最大键级。
 * 当前键已经占用 1 个 σ 和 (currentOrder-1) 个 π。
 */
export function maxUpgradeOrder(
  capacity: number,
  state: Pick<BondingState, 'sigma' | 'pi'>,
  currentOrder: number
): number {
  const otherSigma = Math.max(0, state.sigma - 1);
  const otherPi = Math.max(0, state.pi - Math.max(0, currentOrder - 1));
  return Math.max(0, Math.min(3, capacity - otherSigma - otherPi));
}

/** 新增一根键时允许的最高键级（键本身占用 σ1 + π(n-1)）。 */
export function maxNewBondOrder(
  capacity: number,
  state: Pick<BondingState, 'sigma' | 'pi'>
): number {
  return Math.max(0, Math.min(3, capacity - state.sigma - state.pi));
}

export function hybridizationFor(orbitals: number, pi: number): Hybridization {
  if (pi >= 1.5) return 'sp';
  if (pi >= 0.5) return 'sp2';
  if (orbitals >= 1) return 'sp3';
  return 'unknown';
}

export function idealBondAngle(hybridization: Hybridization): number {
  if (hybridization === 'sp') return 180;
  if (hybridization === 'sp2') return 120;
  if (hybridization === 'sp3') return 109.47;
  return 120;
}

export function hybridizationLabel(hybridization: Hybridization): string {
  if (hybridization === 'sp') return 'sp';
  if (hybridization === 'sp2') return 'sp²';
  if (hybridization === 'sp3') return 'sp³';
  return '未知杂化';
}
