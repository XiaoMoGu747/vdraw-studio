/**
 * 19 种化合物结构式总表（浏览器端脚本，由 Vite 以模块方式加载）。
 *
 * 只用 VDraw 自己的化学对象模型落笔：
 * - createBondObject / createAtomObject 生成化学键与元素标签；
 * - 环骨架按正六边形模板几何铺点，所有碳原子都是键的端点/交点，不生成 C 标签；
 * - 每个分子先在自己的局部坐标里绘制，再按实际包围盒居中到单元格，
 *   名称标注放在结构正下方，避免与下一行结构重叠。
 *
 * 统一参数：键长 91、键宽 5、键距 20、元素字号 55。
 */
import { useAppStore } from '/src/store/useAppStore.ts';
import {
  createAtomObject,
  createBondObject,
  createTextObject,
  emptyAtomLabel
} from '/src/core/factory.ts';
import { atomParts } from '/src/core/chemistry/labels.ts';
import { createDocument } from '/src/core/document.ts';

export const CHEM_PARAMS = {
  bondLength: 91,
  bondWidth: 5,
  bondGap: 20,
  ringBondGap: 20,
  atomFont: 55
};

const L = CHEM_PARAMS.bondLength;
const GAP = CHEM_PARAMS.bondGap;
const RING_GAP = CHEM_PARAMS.ringBondGap;
const FONT = CHEM_PARAMS.atomFont;
/** 正六边形中心到边的垂距（apothem），也是相邻稠环环心的半距。 */
const H = (L * Math.sqrt(3)) / 2;

const BOND_STYLE = {
  fill: { type: 'none' },
  stroke: {
    paint: { type: 'solid', color: '#1b1b1b' },
    width: CHEM_PARAMS.bondWidth,
    cap: 'round',
    join: 'round',
    dash: []
  },
  opacity: 1
};

const ATOM_STYLE = {
  fill: { type: 'solid', color: '#1b1b1b' },
  stroke: { paint: { type: 'none' }, width: 1, cap: 'round', join: 'round', dash: [] },
  opacity: 1
};

const TEXT_STYLE = {
  fill: { type: 'solid', color: '#1b1b1b' },
  stroke: { paint: { type: 'none' }, width: 1, cap: 'round', join: 'round', dash: [] },
  opacity: 1
};

const rad = (deg) => (deg * Math.PI) / 180;
const vec = (deg) => ({ x: Math.cos(rad(deg)), y: Math.sin(rad(deg)) });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const len = (a) => Math.hypot(a.x, a.y);
const unit = (a) => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const at = (origin, deg, distance = L) => add(origin, mul(vec(deg), distance));

/** 首顶点朝上的正六边形；rot=30 时变成左右顶点朝外（平顶）。 */
function hexVerts(cx, cy, rot = 0) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = -90 + rot + index * 60;
    return { x: cx + L * Math.cos(rad(angle)), y: cy + L * Math.sin(rad(angle)) };
  });
}

const pointKey = (p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;
const edgeKey = (a, b) => {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

function perfectMatching(adjacency) {
  const keys = [...adjacency.keys()].sort();
  const used = new Set();
  const matched = new Set();
  const walk = () => {
    const next = keys.find((key) => !used.has(key));
    if (!next) return true;
    used.add(next);
    for (const edge of adjacency.get(next) ?? []) {
      if (used.has(edge.to)) continue;
      used.add(edge.to);
      matched.add(edge.key);
      if (walk()) return true;
      used.delete(edge.to);
      matched.delete(edge.key);
    }
    used.delete(next);
    return false;
  };
  walk();
  return matched;
}

class Sheet {
  constructor(layerId) {
    this.layerId = layerId;
    this.objects = [];
    this.bonds = 0;
    this.atoms = 0;
  }

  bond(a, b, type = 'single', sideRef = null) {
    let innerSide;
    let ringLike = false;
    if (sideRef) {
      const direction = unit(sub(b, a));
      const normal = { x: -direction.y, y: direction.x };
      const center = mid(a, b);
      const offset = Math.abs(
        normal.x * (sideRef.x - center.x) + normal.y * (sideRef.y - center.y)
      );
      // 环心明显偏离键轴才算环内键；端子双键的 sideRef 与键轴共线，按单独双键绘制。
      ringLike = offset > 1;
      if (type === 'double' && ringLike) {
        innerSide =
          normal.x * (sideRef.x - center.x) + normal.y * (sideRef.y - center.y) >= 0 ? 1 : -1;
      }
    }
    const bond = createBondObject(this.layerId, BOND_STYLE, a, b, type, undefined);
    bond.spacing = ringLike ? RING_GAP : GAP;
    bond.scale = 1;
    bond.ringInnerSide = innerSide;
    this.objects.push(bond);
    this.bonds += 1;
    return bond;
  }

  atom(position, element, options = {}) {
    const label = emptyAtomLabel(element);
    label.fontSize = FONT;
    if (options.group) label.group = options.group;
    if (options.charge) label.charge = options.charge;
    if (options.hydrogens !== undefined) label.hydrogens = options.hydrogens;
    const atom = createAtomObject(this.layerId, ATOM_STYLE, position, label);
    this.objects.push(atom);
    this.atoms += 1;
    return atom;
  }

  /** 单个六元环；aromatic=true 时按 Kekulé 交替双键，双键内线朝环心。 */
  hexagon(center, rot = 0, aromatic = true) {
    const verts = hexVerts(center.x, center.y, rot);
    const doubleEdges = new Set([0, 2, 4]);
    for (let index = 0; index < 6; index += 1) {
      const a = verts[index];
      const b = verts[(index + 1) % 6];
      this.bond(a, b, aromatic && doubleEdges.has(index) ? 'double' : 'single', center);
    }
    return verts;
  }

  /** 稠环：centers 为相邻六边形圆心，自动去重公共边并求 Kekulé 完美匹配。 */
  fused(centers, rot = 0, aromatic = true) {
    const vertexMap = new Map();
    const edges = new Map();
    centers.forEach((center) => {
      const verts = hexVerts(center.x, center.y, rot);
      verts.forEach((point) => {
        const key = pointKey(point);
        if (!vertexMap.has(key)) vertexMap.set(key, point);
      });
      for (let index = 0; index < 6; index += 1) {
        const a = verts[index];
        const b = verts[(index + 1) % 6];
        const key = edgeKey(a, b);
        if (!edges.has(key)) {
          edges.set(key, { a: vertexMap.get(pointKey(a)), b: vertexMap.get(pointKey(b)), rings: [] });
        }
        edges.get(key).rings.push(center);
      }
    });

    const adjacency = new Map();
    for (const [key, edge] of edges) {
      const ka = pointKey(edge.a);
      const kb = pointKey(edge.b);
      if (!adjacency.has(ka)) adjacency.set(ka, []);
      if (!adjacency.has(kb)) adjacency.set(kb, []);
      adjacency.get(ka).push({ to: kb, key });
      adjacency.get(kb).push({ to: ka, key });
    }
    const doubles = aromatic ? perfectMatching(adjacency) : new Set();
    for (const [key, edge] of edges) {
      this.bond(edge.a, edge.b, doubles.has(key) ? 'double' : 'single', edge.rings[0]);
    }
    return vertexMap;
  }
}

function nameLabel(text, centerX, topY, layerId) {
  const object = createTextObject(layerId, TEXT_STYLE, { x: 0, y: topY }, text, 38, {
    align: 'center',
    fontWeight: 500
  });
  object.x = centerX - object.width / 2;
  return object;
}

/** 构图元素（键 + 原子标签）的实际包围盒，含双键偏移与标签外框。 */
function contentBounds(objects) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const object of objects) {
    if (object.type === 'bond') {
      const pad = CHEM_PARAMS.bondWidth / 2 + GAP;
      include(Math.min(object.start.x, object.end.x) - pad, Math.min(object.start.y, object.end.y) - pad);
      include(Math.max(object.start.x, object.end.x) + pad, Math.max(object.start.y, object.end.y) + pad);
    } else if (object.type === 'atom') {
      const parts = atomParts(object);
      const halfWidth = Math.max(28, parts.width + 18) / 2 + 6;
      const halfHeight = parts.fontSize * 0.62;
      include(object.position.x - halfWidth, object.position.y - halfHeight);
      include(object.position.x + halfWidth, object.position.y + halfHeight);
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const VALENCE = { C: 4, N: 3, O: 2, S: 6, Cl: 1, Na: 0, H: 1 };
const HILL_ORDER = (a, b) => {
  if (a === 'C') return -1;
  if (b === 'C') return 1;
  if (a === 'H') return -1;
  if (b === 'H') return 1;
  return a.localeCompare(b);
};

/**
 * 按连通图还原分子式：键级求和 + 原子价态补氢。
 * 盐类的 Na⁺ 是独立分量，仍计入同一分子式。
 */
function formulaOf(objects) {
  const bonds = objects.filter((object) => object.type === 'bond');
  const atoms = objects.filter((object) => object.type === 'atom');
  const atomAt = new Map(atoms.map((atom) => [pointKey(atom.position), atom]));
  const vertices = new Map();
  const ensure = (point) => {
    const key = pointKey(point);
    if (!vertices.has(key)) {
      const atom = atomAt.get(key) ?? null;
      vertices.set(key, {
        point,
        atom,
        element: atom ? atom.label.element : 'C',
        explicitH: atom?.label.group ? (atom.label.group.match(/H/g) ?? []).length : 0,
        charge: atom ? atom.label.charge : 0,
        order: 0
      });
    }
    return vertices.get(key);
  };
  for (const atom of atoms) ensure(atom.position);
  for (const bond of bonds) {
    const order = bond.bondType === 'double' ? 2 : bond.bondType === 'triple' ? 3 : 1;
    ensure(bond.start).order += order;
    ensure(bond.end).order += order;
  }
  const counts = new Map();
  for (const vertex of vertices.values()) {
    const element = vertex.element;
    const valence =
      element === 'O' && vertex.charge === -1 ? 1 : (VALENCE[element] ?? 0);
    const hydrogens = Math.max(0, valence - vertex.order - vertex.explicitH) + vertex.explicitH;
    counts.set(element, (counts.get(element) ?? 0) + 1);
    if (hydrogens > 0) counts.set('H', (counts.get('H') ?? 0) + hydrogens);
  }
  return [...counts.entries()]
    .sort((a, b) => HILL_ORDER(a[0], b[0]))
    .map(([element, count]) => `${element}${count > 1 ? count : ''}`)
    .join('');
}

/** 19 个化合物的局部几何；返回 { name, formula, build(sheet) }。 */
function molecules() {
  return [
    {
      name: '水杨酸',
      formula: 'C7H6O3',
      build(s) {
        const ring = s.hexagon({ x: 0, y: 0 }, 0, true);
        const carbonyl = at(ring[0], -90);
        const acidO = at(carbonyl, -30);
        const carbonylO = at(carbonyl, 210);
        s.bond(ring[0], carbonyl, 'single');
        s.bond(carbonyl, carbonylO, 'double', at(carbonylO, 210));
        s.bond(carbonyl, acidO, 'single');
        s.atom(carbonylO, 'O');
        s.atom(acidO, 'O', { group: 'OH' });
        // 酚羟基接在 C2（与羧基邻位）。
        const phenolO = at(ring[1], -30);
        s.bond(ring[1], phenolO, 'single');
        s.atom(phenolO, 'O', { group: 'OH' });
      }
    },
    {
      name: '乙酰水杨酸',
      formula: 'C9H8O4',
      build(s) {
        const ring = s.hexagon({ x: 0, y: 0 }, 0, true);
        const carbonyl = at(ring[0], -90);
        const acidO = at(carbonyl, -30);
        const carbonylO = at(carbonyl, 210);
        s.bond(ring[0], carbonyl, 'single');
        s.bond(carbonyl, carbonylO, 'double', at(carbonylO, 210));
        s.bond(carbonyl, acidO, 'single');
        s.atom(carbonylO, 'O');
        s.atom(acidO, 'O', { group: 'OH' });

        // C2 上的乙酰氧基：Ar–O–C(=O)–CH3。
        const esterO = at(ring[1], -30);
        s.bond(ring[1], esterO, 'single');
        s.atom(esterO, 'O');
        const esterCarbonyl = at(esterO, -30);
        s.bond(esterO, esterCarbonyl, 'single');
        s.bond(esterCarbonyl, at(esterCarbonyl, -90), 'double', at(esterCarbonyl, -90));
        s.bond(esterCarbonyl, at(esterCarbonyl, 30), 'single');
        s.atom(at(esterCarbonyl, -90), 'O');
      }
    },
    {
      name: '乙酸酐',
      formula: 'C4H6O3',
      build(s) {
        const etherO = { x: 0, y: 0 };
        const leftCarbonyl = at(etherO, 210);
        const rightCarbonyl = at(etherO, 330);
        s.bond(leftCarbonyl, etherO, 'single');
        s.bond(etherO, rightCarbonyl, 'single');
        s.atom(etherO, 'O');
        const leftO = at(leftCarbonyl, 150);
        const leftMethyl = at(leftCarbonyl, 90);
        s.bond(leftCarbonyl, leftO, 'double', at(leftO, 150));
        s.bond(leftCarbonyl, leftMethyl, 'single');
        s.atom(leftO, 'O');
        const rightO = at(rightCarbonyl, 30);
        const rightMethyl = at(rightCarbonyl, 90);
        s.bond(rightCarbonyl, rightO, 'double', at(rightO, 30));
        s.bond(rightCarbonyl, rightMethyl, 'single');
        s.atom(rightO, 'O');
      }
    },
    {
      name: '硫酸',
      formula: 'H2O4S',
      build(s) {
        const sulfur = { x: 0, y: 0 };
        s.atom(sulfur, 'S');
        [225, 315].forEach((direction) => {
          const point = at(sulfur, direction);
          s.bond(sulfur, point, 'double', at(point, direction));
          s.atom(point, 'O');
        });
        [135, 45].forEach((direction, index) => {
          const point = at(sulfur, direction);
          s.bond(sulfur, point, 'single');
          // 入键在右上方：左侧写 HO、右侧写 OH，键都接在 O 一侧。
          s.atom(point, 'O', { group: index === 0 ? 'HO' : 'OH' });
        });
      }
    },
    {
      name: '苯酚',
      formula: 'C6H6O',
      build(s) {
        const ring = s.hexagon({ x: 0, y: 0 }, 0, true);
        const oxygen = at(ring[0], -90);
        s.bond(ring[0], oxygen, 'single');
        s.atom(oxygen, 'O', { group: 'OH' });
      }
    },
    {
      name: '苯酚钠',
      formula: 'C6H5NaO',
      build(s) {
        const ring = s.hexagon({ x: 0, y: 0 }, 0, true);
        const oxygen = at(ring[0], -90);
        s.bond(ring[0], oxygen, 'single');
        s.atom(oxygen, 'O', { charge: -1 });
        s.atom({ x: 92, y: -238 }, 'Na', { charge: 1 });
      }
    },
    {
      name: '萘',
      formula: 'C10H8',
      build(s) {
        s.fused([{ x: -H, y: 0 }, { x: H, y: 0 }], 0, true);
      }
    },
    {
      name: '联苯',
      formula: 'C12H10',
      build(s) {
        s.hexagon({ x: -1.5 * L, y: 0 }, 30, true);
        s.hexagon({ x: 1.5 * L, y: 0 }, 30, true);
        s.bond({ x: -0.5 * L, y: 0 }, { x: 0.5 * L, y: 0 }, 'single');
      }
    },
    {
      name: '二苯甲烷',
      formula: 'C13H12',
      build(s) {
        // 中心 CH2 在原点，两个环心沿 210°/330° 各退两个键长；
        // 环上指向中心的顶点与中心 CH2 恰好相隔一个键长，键角 120°。
        const methane = { x: 0, y: 0 };
        const leftCenter = at(methane, 210, 2 * L);
        const rightCenter = at(methane, 330, 2 * L);
        const leftRing = s.hexagon(leftCenter, 0, true);
        const rightRing = s.hexagon(rightCenter, 0, true);
        s.bond(methane, leftRing[2], 'single');
        s.bond(methane, rightRing[4], 'single');
      }
    },
    {
      name: '蒽',
      formula: 'C14H10',
      build(s) {
        s.fused(
          [{ x: -2 * H, y: 0 }, { x: 0, y: 0 }, { x: 2 * H, y: 0 }],
          0,
          true
        );
      }
    },
    {
      name: '菲',
      formula: 'C14H10',
      build(s) {
        // 第三个环并中环右上斜边，环心相对中环偏移 (√3/2)L、(3/2)L。
        s.fused(
          [
            { x: -H, y: 0 },
            { x: H, y: 0 },
            { x: H + 0.8660254037844386 * L, y: -1.5 * L }
          ],
          0,
          true
        );
      }
    },
    {
      name: '三联苯',
      formula: 'C18H14',
      build(s) {
        [-3 * L, 0, 3 * L].forEach((x) => s.hexagon({ x, y: 0 }, 30, true));
        s.bond({ x: -2 * L, y: 0 }, { x: -L, y: 0 }, 'single');
        s.bond({ x: L, y: 0 }, { x: 2 * L, y: 0 }, 'single');
      }
    },
    {
      name: '联环己烷',
      formula: 'C12H22',
      build(s) {
        s.hexagon({ x: -1.5 * L, y: 0 }, 30, false);
        s.hexagon({ x: 1.5 * L, y: 0 }, 30, false);
        s.bond({ x: -0.5 * L, y: 0 }, { x: 0.5 * L, y: 0 }, 'single');
      }
    },
    {
      name: '萘烷',
      formula: 'C10H18',
      build(s) {
        s.fused([{ x: -H, y: 0 }, { x: H, y: 0 }], 0, false);
      }
    },
    {
      name: '螺[5,5]十一烷',
      formula: 'C11H20',
      build(s) {
        // 平顶六边形：左环右顶点与右环左顶点重合于原点，即螺碳。
        const leftRing = hexVerts(-L, 0, 30);
        const rightRing = hexVerts(L, 0, 30);
        for (let index = 0; index < 6; index += 1) {
          s.bond(leftRing[index], leftRing[(index + 1) % 6], 'single');
          s.bond(rightRing[index], rightRing[(index + 1) % 6], 'single');
        }
      }
    },
    {
      name: '苯磺酸',
      formula: 'C6H6O3S',
      build(s) {
        const ring = s.hexagon({ x: 0, y: 0 }, 0, true);
        const sulfur = at(ring[0], -90);
        s.bond(ring[0], sulfur, 'single');
        s.atom(sulfur, 'S');
        [-180, 0].forEach((direction) => {
          const oxygen = at(sulfur, direction);
          s.bond(sulfur, oxygen, 'double', at(oxygen, direction));
          s.atom(oxygen, 'O');
        });
        const hydroxyl = at(sulfur, -90);
        s.bond(sulfur, hydroxyl, 'single');
        s.atom(hydroxyl, 'O', { group: 'OH' });
      }
    },
    {
      name: '苯磺酸钠',
      formula: 'C6H5NaO3S',
      build(s) {
        const ring = s.hexagon({ x: 0, y: 0 }, 0, true);
        const sulfur = at(ring[0], -90);
        s.bond(ring[0], sulfur, 'single');
        s.atom(sulfur, 'S');
        [-180, 0].forEach((direction) => {
          const oxygen = at(sulfur, direction);
          s.bond(sulfur, oxygen, 'double', at(oxygen, direction));
          s.atom(oxygen, 'O');
        });
        const oxygen = at(sulfur, -90);
        s.bond(sulfur, oxygen, 'single');
        s.atom(oxygen, 'O', { charge: -1 });
        s.atom({ x: 108, y: -330 }, 'Na', { charge: 1 });
      }
    },
    {
      name: '乙酰氯',
      formula: 'C2H3ClO',
      build(s) {
        const carbonyl = { x: 0, y: 0 };
        const methyl = at(carbonyl, 145);
        const chlorine = at(carbonyl, 35);
        const oxygen = at(carbonyl, -90);
        s.bond(carbonyl, methyl, 'single');
        s.bond(carbonyl, chlorine, 'single');
        s.bond(carbonyl, oxygen, 'double', at(oxygen, -90));
        s.atom(chlorine, 'Cl');
        s.atom(oxygen, 'O');
      }
    },
    {
      name: '乙酸钠',
      formula: 'C2H3NaO2',
      build(s) {
        const carbonyl = { x: 0, y: 0 };
        const methyl = at(carbonyl, 145);
        const oxygenAnion = at(carbonyl, 35);
        const oxygen = at(carbonyl, -90);
        s.bond(carbonyl, methyl, 'single');
        s.bond(carbonyl, oxygenAnion, 'single');
        s.bond(carbonyl, oxygen, 'double', at(oxygen, -90));
        s.atom(oxygenAnion, 'O', { charge: -1 });
        s.atom(oxygen, 'O');
        s.atom({ x: 156, y: 76 }, 'Na', { charge: 1 });
      }
    }
  ];
}

export function drawSheet() {
  const store = useAppStore;
  // 直接载入空白化学稿，避免 startDocument 在已编辑文档上弹“是否放弃”确认。
  store.getState().loadDocument(createDocument('chem-sheet', '19种化合物结构式'), null, false);
  let state = store.getState();
  const chemLayer =
    state.doc.layers.find((layer) => layer.kind === 'chemistry') ?? state.doc.layers[0];
  const annotationLayer =
    state.doc.layers.find((layer) => layer.kind === 'annotation') ??
    state.doc.layers[state.doc.layers.length - 1];

  // 参数与界面保持一致（键长 / 键宽 / 键距 / 元素字号）。
  state.setChemBondLength(CHEM_PARAMS.bondLength);
  state.setChemBondWidth(CHEM_PARAMS.bondWidth);
  state.setChemBondSpacing(CHEM_PARAMS.bondGap);
  state.setChemRingBondSpacing(CHEM_PARAMS.ringBondGap);
  state.setChemAtomSize(CHEM_PARAMS.atomFont);

  const page = { width: 3400, height: 3700 };
  state.updateDoc(
    {
      ...state.doc,
      name: '19种化合物结构式',
      page: { ...state.doc.page, ...page, background: '#ffffff' },
      grid: { ...state.doc.grid, visible: false, snap: false },
      layers: state.doc.layers.map((layer) =>
        layer.id === chemLayer.id
          ? { ...layer, name: '化合物结构' }
          : layer.id === annotationLayer.id
            ? { ...layer, name: '名称标注' }
            : layer
      )
    },
    true
  );

  const sheet = new Sheet(chemLayer.id);
  const labels = [];
  const marginX = 80;
  const marginY = 80;
  const columns = 4;
  const rows = 5;
  const cellWidth = (page.width - marginX * 2) / columns;
  const cellHeight = (page.height - marginY * 2) / rows;
  const labelFont = 38;
  const labelGap = 26;
  const rowReserve = labelFont + labelGap + 18;
  const layout = [];
  const validation = [];

  const list = molecules();
  list.forEach((molecule, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = marginX + cellWidth * column;
    const cellY = marginY + cellHeight * row;
    const centerX = cellX + cellWidth / 2;

    const local = new Sheet(chemLayer.id);
    molecule.build(local);
    const bounds = contentBounds(local.objects);
    const formula = formulaOf(local.objects);

    // 结构垂直居中于“单元格减去名称区”的区域，再整体平移到该位置。
    const contentHeight = cellHeight - rowReserve;
    const offsetX = centerX - (bounds.x + bounds.width / 2);
    const offsetY = cellY + 12 + (contentHeight - bounds.height) / 2 - bounds.y;

    const before = sheet.objects.length;
    local.objects.forEach((object) => {
      if (object.type === 'bond') {
        object.start = { x: object.start.x + offsetX, y: object.start.y + offsetY };
        object.end = { x: object.end.x + offsetX, y: object.end.y + offsetY };
        object.x = Math.min(object.start.x, object.end.x) - 10;
        object.y = Math.min(object.start.y, object.end.y) - 10;
        object.width = Math.abs(object.end.x - object.start.x) + 20;
        object.height = Math.abs(object.end.y - object.start.y) + 20;
      } else if (object.type === 'atom') {
        object.position = { x: object.position.x + offsetX, y: object.position.y + offsetY };
        object.x = object.position.x - 20;
        object.y = object.position.y - 16;
      }
      sheet.objects.push(object);
    });
    sheet.bonds += local.bonds;
    sheet.atoms += local.atoms;

    const labelTop = cellY + cellHeight - rowReserve + labelGap;
    labels.push(nameLabel(molecule.name, centerX, labelTop, annotationLayer.id));

    const mismatches = [];
    if (formula !== molecule.formula) mismatches.push(`分子式 ${formula} ≠ ${molecule.formula}`);
    const carbonLabels = local.objects.filter(
      (object) => object.type === 'atom' && object.label.element === 'C'
    ).length;
    if (carbonLabels > 0) mismatches.push(`出现 ${carbonLabels} 个 C 标签`);
    for (const bond of local.objects.filter((object) => object.type === 'bond')) {
      const length = Math.hypot(bond.end.x - bond.start.x, bond.end.y - bond.start.y);
      if (Math.abs(length - CHEM_PARAMS.bondLength) > 0.05) {
        mismatches.push(`键长 ${length.toFixed(2)}`);
        break;
      }
    }

    validation.push({
      index: index + 1,
      name: molecule.name,
      expected: molecule.formula,
      formula,
      ok: mismatches.length === 0,
      problems: mismatches,
      bonds: local.bonds,
      atoms: local.atoms,
      bounds: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
      }
    });
    layout.push({
      index: index + 1,
      name: molecule.name,
      column,
      row,
      centerX: Math.round(centerX),
      labelTop: Math.round(labelTop),
      formula,
      objects: sheet.objects.length - before
    });
  });

  state = store.getState();
  state.addObjects(sheet.objects, chemLayer.id);
  state.addObjects(labels, annotationLayer.id);
  state.setSelection([]);
  state.closeProperties();
  state.setTool('select');
  state.setToolPanel(null);
  state.fitToCanvas();

  state = store.getState();
  return {
    params: CHEM_PARAMS,
    page,
    bonds: sheet.bonds,
    atoms: sheet.atoms,
    total: sheet.objects.length + labels.length,
    labels: labels.length,
    validation,
    layout,
    docId: state.doc.id,
    layers: state.doc.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      objects: layer.objects.length
    }))
  };
}

export function inspectSheet() {
  const state = useAppStore.getState();
  const all = state.doc.layers.flatMap((layer) => layer.objects);
  const bonds = all.filter((object) => object.type === 'bond');
  const atoms = all.filter((object) => object.type === 'atom');
  return {
    docName: state.doc.name,
    page: state.doc.page,
    layers: state.doc.layers.map((layer) => ({ name: layer.name, objects: layer.objects.length })),
    bonds: bonds.length,
    atoms: atoms.length,
    texts: all.filter((object) => object.type === 'text').length,
    bondTypes: bonds.reduce((acc, bond) => {
      acc[bond.bondType] = (acc[bond.bondType] ?? 0) + 1;
      return acc;
    }, {}),
    atomLabels: atoms.reduce((acc, atom) => {
      const key = atom.label.group ?? `${atom.label.element}${atom.label.charge ? (atom.label.charge > 0 ? '+' : '−') : ''}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    lengths: [...new Set(bonds.map((bond) => Math.round(Math.hypot(bond.end.x - bond.start.x, bond.end.y - bond.start.y) * 100) / 100))].sort((a, b) => a - b),
    widths: [...new Set(bonds.map((bond) => bond.style.stroke.width))],
    spacings: [...new Set(bonds.map((bond) => bond.spacing))],
    atomFonts: [...new Set(atoms.map((atom) => atom.label.fontSize))]
  };
}
