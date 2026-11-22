import type {
  AtomObject,
  BondObject,
  BondType,
  VDrawDocument,
  Vec
} from '../../types/document';
import { allObjects, getLayerOfObject } from '../scene';

interface ChemVertex {
  id: string;
  point: Vec;
  element: string;
  charge: number;
  isotope: number | null;
  hydrogens: number;
  group: string | null;
}

interface ChemEdge {
  a: number;
  b: number;
  type: BondType;
}

interface ChemGraph {
  vertices: ChemVertex[];
  edges: ChemEdge[];
}

const BOND_ORDER: Record<BondType, number> = {
  single: 1,
  double: 2,
  triple: 3,
  aromatic: 4,
  wedge: 1,
  hashed: 1,
  wavy: 1,
  dative: 1
};

const BOND_SMILES: Record<BondType, string> = {
  single: '',
  double: '=',
  triple: '#',
  aromatic: ':',
  wedge: '',
  hashed: '',
  wavy: '',
  dative: ''
};

/** 化学结构图：以键端点为顶点，显式原子标签优先于隐式碳。 */
function buildGraph(doc: VDrawDocument): ChemGraph {
  const objects = allObjects(doc).filter((obj) => {
    if (!obj.visible) return false;
    const layer = getLayerOfObject(doc, obj.id);
    return Boolean(layer?.visible);
  });
  const atomObjects = objects.filter((obj): obj is AtomObject => obj.type === 'atom');
  const bondObjects = objects.filter((obj): obj is BondObject => obj.type === 'bond');
  const vertices: ChemVertex[] = [];

  const findVertex = (point: Vec): number => {
    for (let index = 0; index < vertices.length; index += 1) {
      if (Math.hypot(vertices[index].point.x - point.x, vertices[index].point.y - point.y) < 1.5) {
        return index;
      }
    }
    return -1;
  };

  const addVertex = (point: Vec, element = 'C', atom?: AtomObject): number => {
    const existing = findVertex(point);
    if (existing >= 0) {
      if (atom) {
        vertices[existing] = {
          ...vertices[existing],
          id: atom.id,
          element: atom.label.element,
          group: atom.label.group,
          charge: atom.label.charge,
          isotope: atom.label.isotope,
          hydrogens: atom.label.hydrogens ?? 0
        };
      }
      return existing;
    }
    vertices.push({
      id: atom?.id ?? `v${vertices.length}`,
      point,
      element: atom ? atom.label.element : element,
      charge: atom?.label.charge ?? 0,
      isotope: atom?.label.isotope ?? null,
      hydrogens: atom?.label.hydrogens ?? 0,
      group: atom?.label.group ?? null
    });
    return vertices.length - 1;
  };

  for (const atom of atomObjects) addVertex(atom.position, atom.label.element, atom);

  const edges: ChemEdge[] = [];
  for (const bond of bondObjects) {
    const a = addVertex(bond.start);
    const b = addVertex(bond.end);
    if (a === b) continue;
    edges.push({ a, b, type: bond.bondType });
  }

  return { vertices, edges };
}

/** MOL V2000：坐标按 40px 键长 = 1 Å 换算，y 轴翻转为化学惯例。 */
export function exportMol(doc: VDrawDocument, name = 'VDraw'): string {
  const { vertices, edges } = buildGraph(doc);
  if (vertices.length === 0) return '';
  const lines: string[] = [];
  lines.push(name);
  lines.push('  VDraw Studio');
  lines.push('');
  lines.push(
    `${String(vertices.length).padStart(3, ' ')}${String(edges.length).padStart(3, ' ')}  0  0  0  0            999 V2000`
  );
  for (const vertex of vertices) {
    const x = (vertex.point.x / 40).toFixed(4).padStart(10, ' ');
    const y = (-vertex.point.y / 40).toFixed(4).padStart(10, ' ');
    const z = '0.0000'.padStart(10, ' ');
    const element = (vertex.element || 'C').slice(0, 3).padEnd(3, ' ');
    lines.push(`${x}${y}${z} ${element} 0  0  0  0  0  0  0  0  0  0  0  0`);
  }
  for (const edge of edges) {
    const order = BOND_ORDER[edge.type] ?? 1;
    const stereo = edge.type === 'wedge' ? 1 : edge.type === 'hashed' ? 6 : 0;
    lines.push(
      `${String(edge.a + 1).padStart(3, ' ')}${String(edge.b + 1).padStart(3, ' ')}${String(order).padStart(3, ' ')}${String(stereo).padStart(3, ' ')}  0  0  0`
    );
  }
  // 电荷/同位素用 M 行表达，避免依赖固定列宽里容易出错的 ccc 字段。
  const charged = vertices
    .map((vertex, index) => ({ index: index + 1, charge: vertex.charge }))
    .filter((item) => item.charge !== 0);
  if (charged.length > 0) {
    const entries = charged
      .map((item) => `${String(item.index).padStart(4, ' ')}${String(item.charge).padStart(4, ' ')}`)
      .join('');
    lines.push(`M  CHG${String(charged.length).padStart(3, ' ')}${entries}`);
  }
  const isotopes = vertices
    .map((vertex, index) => ({ index: index + 1, isotope: vertex.isotope }))
    .filter((item) => item.isotope !== null);
  if (isotopes.length > 0) {
    const entries = isotopes
      .map(
        (item) => `${String(item.index).padStart(4, ' ')}${String(item.isotope).padStart(4, ' ')}`
      )
      .join('');
    lines.push(`M  ISO${String(isotopes.length).padStart(3, ' ')}${entries}`);
  }
  lines.push('M  END');
  return lines.join('\n');
}

/** 有机子集：可以裸写的元素。 */
const BARE_ELEMENTS = new Set(['B', 'C', 'N', 'O', 'P', 'S', 'F', 'Cl', 'Br', 'I']);

function atomToken(vertex: ChemVertex): string {
  const bracket =
    !BARE_ELEMENTS.has(vertex.element) ||
    vertex.charge !== 0 ||
    vertex.isotope !== null ||
    vertex.hydrogens > 0 ||
    vertex.group !== null;
  if (!bracket) return vertex.element;
  const isotope = vertex.isotope ? String(vertex.isotope) : '';
  const hydrogens =
    vertex.hydrogens > 0 ? `H${vertex.hydrogens > 1 ? vertex.hydrogens : ''}` : '';
  const charge =
    vertex.charge === 0
      ? ''
      : vertex.charge > 0
        ? `+${vertex.charge > 1 ? vertex.charge : ''}`
        : `-${Math.abs(vertex.charge) > 1 ? Math.abs(vertex.charge) : ''}`;
  return `[${isotope}${vertex.element}${hydrogens}${charge}]`;
}

interface TreeNode {
  vertex: number;
  bond: string;
  children: TreeNode[];
  suffix: string[];
}

/**
 * SMILES：DFS 生成树 + 环闭合编号。
 * 不处理立体化学与复杂芳香性，但足以导出常见结构（链、苯环、取代基）。
 */
export function exportSmiles(doc: VDrawDocument): string {
  const { vertices, edges } = buildGraph(doc);
  if (vertices.length === 0) return '';
  const adjacency: { to: number; type: BondType }[][] = vertices.map(() => []);
  for (const edge of edges) {
    adjacency[edge.a].push({ to: edge.b, type: edge.type });
    adjacency[edge.b].push({ to: edge.a, type: edge.type });
  }

  const visited = new Array(vertices.length).fill(false);
  const ringLabels = new Map<string, number>();
  const nodes = new Map<number, TreeNode>();
  let ringCounter = 0;
  const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  const build = (vertex: number, parent: number, bond: string): TreeNode => {
    visited[vertex] = true;
    const node: TreeNode = { vertex, bond, children: [], suffix: [] };
    nodes.set(vertex, node);
    for (const neighbor of adjacency[vertex]) {
      if (neighbor.to === parent) continue;
      if (!visited[neighbor.to]) {
        node.children.push(build(neighbor.to, vertex, BOND_SMILES[neighbor.type]));
        continue;
      }
      const key = edgeKey(vertex, neighbor.to);
      if (ringLabels.has(key)) continue;
      ringCounter += 1;
      const label = ringCounter;
      ringLabels.set(key, label);
      const text = `${BOND_SMILES[neighbor.type]}${label > 9 ? `%${label}` : label}`;
      node.suffix.push(text);
      const other = nodes.get(neighbor.to);
      // 同一条回边在两端各需要一个闭合编号；祖先节点已存在时补在它的后缀。
      if (other && other !== node) other.suffix.push(text);
    }
    return node;
  };

  const render = (node: TreeNode): string =>
    atomToken(vertices[node.vertex]) +
    node.children.map((child) => `${child.bond}${render(child)}`).join('') +
    node.suffix.join('');

  const parts: string[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    if (visited[index]) continue;
    parts.push(render(build(index, -1, '')));
  }
  return parts.join('.');
}
