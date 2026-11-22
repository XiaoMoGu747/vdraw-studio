import type { BondType, Rect, Vec } from '../../types/document';

export interface RingAtom {
  x: number;
  y: number;
  label?: string;
}

export interface RingBond {
  a: number;
  b: number;
  type: BondType;
}

export interface RingTemplate {
  id: string;
  name: string;
  formula: string;
  tag: string;
  atoms: RingAtom[];
  bonds: RingBond[];
}

/** 生成以中心为原点、首顶点朝上的正多边形顶点，y 轴向下。 */
function regularPolygon(sides: number, radius = 1, rotation = 90): Vec[] {
  return Array.from({ length: sides }, (_, index) => {
    const angle = ((rotation + (360 / sides) * index) * Math.PI) / 180;
    return { x: Math.cos(angle) * radius, y: -Math.sin(angle) * radius };
  });
}

function ringPoints(sides: number): RingAtom[] {
  return regularPolygon(sides).map((point) => ({ x: point.x, y: point.y }));
}

function cycle(sides: number, type: BondType): RingBond[] {
  return Array.from({ length: sides }, (_, index) => ({
    a: index,
    b: (index + 1) % sides,
    type
  }));
}

const naphthaleneAtoms: RingAtom[] = [
  { x: -0.866, y: -1 },
  { x: -1.732, y: -0.5 },
  { x: -1.732, y: 0.5 },
  { x: -0.866, y: 1 },
  { x: 0, y: 0.5 },
  { x: 0, y: -0.5 },
  { x: 0.866, y: -1 },
  { x: 1.732, y: -0.5 },
  { x: 1.732, y: 0.5 },
  { x: 0.866, y: 1 }
];

const naphthaleneBonds: RingBond[] = [
  { a: 0, b: 1, type: 'double' },
  { a: 1, b: 2, type: 'single' },
  { a: 2, b: 3, type: 'double' },
  { a: 3, b: 4, type: 'single' },
  { a: 4, b: 5, type: 'double' },
  { a: 5, b: 0, type: 'single' },
  { a: 5, b: 6, type: 'single' },
  { a: 6, b: 7, type: 'double' },
  { a: 7, b: 8, type: 'single' },
  { a: 8, b: 9, type: 'double' },
  { a: 9, b: 4, type: 'single' }
];

export const RING_TEMPLATES: RingTemplate[] = [
  {
    id: 'benzene',
    name: '苯环',
    formula: 'C6H6',
    tag: '芳香环',
    atoms: ringPoints(6),
    bonds: cycle(6, 'aromatic')
  },
  {
    id: 'cyclohexane',
    name: '环己烷',
    formula: 'C6H12',
    tag: '脂环',
    atoms: ringPoints(6),
    bonds: cycle(6, 'single')
  },
  {
    id: 'cyclopentane',
    name: '环戊烷',
    formula: 'C5H10',
    tag: '脂环',
    atoms: ringPoints(5),
    bonds: cycle(5, 'single')
  },
  {
    id: 'cyclopropane',
    name: '环丙烷',
    formula: 'C3H6',
    tag: '小环',
    atoms: ringPoints(3),
    bonds: cycle(3, 'single')
  },
  {
    id: 'cyclobutane',
    name: '环丁烷',
    formula: 'C4H8',
    tag: '小环',
    atoms: ringPoints(4),
    bonds: cycle(4, 'single')
  },
  {
    id: 'pyridine',
    name: '吡啶',
    formula: 'C5H5N',
    tag: '杂环',
    atoms: ringPoints(6).map((atom, index) => (index === 0 ? { ...atom, label: 'N' } : atom)),
    bonds: cycle(6, 'aromatic')
  },
  {
    id: 'naphthalene',
    name: '萘环',
    formula: 'C10H8',
    tag: '稠环',
    atoms: naphthaleneAtoms,
    bonds: naphthaleneBonds
  },
  {
    id: 'furan',
    name: '呋喃',
    formula: 'C4H4O',
    tag: '杂环',
    atoms: ringPoints(5).map((atom, index) => (index === 0 ? { ...atom, label: 'O' } : atom)),
    bonds: [
      { a: 0, b: 1, type: 'single' },
      { a: 1, b: 2, type: 'double' },
      { a: 2, b: 3, type: 'single' },
      { a: 3, b: 4, type: 'double' },
      { a: 4, b: 0, type: 'single' }
    ]
  },
  {
    id: 'thiophene',
    name: '噻吩',
    formula: 'C4H4S',
    tag: '杂环',
    atoms: ringPoints(5).map((atom, index) => (index === 0 ? { ...atom, label: 'S' } : atom)),
    bonds: [
      { a: 0, b: 1, type: 'single' },
      { a: 1, b: 2, type: 'double' },
      { a: 2, b: 3, type: 'single' },
      { a: 3, b: 4, type: 'double' },
      { a: 4, b: 0, type: 'single' }
    ]
  },
  {
    id: 'pyrrole',
    name: '吡咯',
    formula: 'C4H5N',
    tag: '杂环',
    atoms: ringPoints(5).map((atom, index) => (index === 0 ? { ...atom, label: 'N' } : atom)),
    bonds: [
      { a: 0, b: 1, type: 'single' },
      { a: 1, b: 2, type: 'double' },
      { a: 2, b: 3, type: 'single' },
      { a: 3, b: 4, type: 'double' },
      { a: 4, b: 0, type: 'single' }
    ]
  }
];

export const RING_MAP: Record<string, RingTemplate> = Object.fromEntries(
  RING_TEMPLATES.map((template) => [template.id, template])
);

export function ringBounds(atoms: RingAtom[]): Rect {
  const xs = atoms.map((atom) => atom.x);
  const ys = atoms.map((atom) => atom.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY
  };
}
