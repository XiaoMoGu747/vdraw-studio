import assert from 'node:assert/strict';
import test from 'node:test';
import { pressureScale, strokeWidths, taperLengthFor } from '../src/core/brush';
import { GRAIN_PATH_BUDGET, brushMaterialLayers } from '../src/core/brushMaterial';
import {
  bondAnchorScale,
  findBondAnchor,
  nextChainBond,
  prevBondOrderType
} from '../src/core/chemistry/chain';
import { cleanupStructure } from '../src/core/chemistry/cleanup';
import { chemistryPreviewIds } from '../src/core/chemistry/preview';
import { createDocument, DEFAULT_STYLE } from '../src/core/document';
import { eraseMaskDef, strokeEraseMaskDef } from '../src/core/eraseMask';
import {
  createEraserTargets,
  eraseAlongPath,
  findErasableAt,
  isEraserAllTargets,
  normalizeEraserTargets,
  toggleEraserTarget,
  type EraserTargets
} from '../src/core/eraser';
import {
  createAtomObject,
  createBondObject,
  createGroupObject,
  createImageObject,
  createLineObject,
  createPathObject,
  createRectObject,
  emptyAtomLabel,
  makeNode
} from '../src/core/factory';
import { grainBudgetIds } from '../src/core/grainBudget';
import { regionWidthForOutputWidth, safeRasterScale } from '../src/core/io/raster';
import { exportMol, exportSmiles } from '../src/core/io/chemExport';
import { chemBondShape } from '../src/core/chemistry/render';
import { buildBondGeometry } from '../src/core/chemistry/bonds';
import { ATOM_PRESETS } from '../src/core/chemistry/presets';
import { maxValenceFor } from '../src/core/chemistry/electronic';
import { acidicGroupAtomAt, planAcidicSalt } from '../src/core/chemistry/salts';
import { ATOM_LABEL_GAP, atomLabelLayout, atomParts, flipGroupText } from '../src/core/chemistry/labels';
import { ringBondInnerSide } from '../src/core/chemistry/benzene';
import {
  ImportError,
  detectImportFormat,
  documentImportToAppend,
  documentImportToNewDocument,
  documentImportToReplacement,
  imageImportToAppend,
  imageImportToNewDocument,
  imageImportToReplacement,
  importSourcesToDocument,
  validateImportContent
} from '../src/core/io/importFile';
import {
  detectRasterKind,
  imagePlacement,
  validateRasterHeader,
  type ImportedImageSource
} from '../src/core/io/imageImport';
import { serializeDocument } from '../src/core/io/serialize';
import { documentToSvgString } from '../src/core/io/svg';
import {
  getObjectBounds,
  hitTestObject,
  rotateObject,
  scaleDocumentObjects,
  scaleObject,
  translateDocumentObjects,
  translateObject
} from '../src/core/scene';
import { useAppStore } from '../src/store/useAppStore';
import type {
  EditorSnapshot,
  GroupObject,
  ImageObject,
  LineObject,
  PathObject,
  RectObject,
  SceneObject,
  Style,
  VDrawDocument
} from '../src/types/document';

test('压感曲线映射与边界', () => {
  assert.equal(pressureScale(0.5, 1, 0.35), 0.675);
  assert.ok(pressureScale(0.5, 2, 0.35) < pressureScale(0.5, 1, 0.35));
  assert.equal(pressureScale(-1, 1, 0.35), 0.35);
  assert.equal(pressureScale(2, 1, 0.35), 1);
});

test('收笔渐隐按绝对长度封顶，长线不会整条变细', () => {
  const samples = Array.from({ length: 1001 }, (_, index) => ({
    x: index,
    y: 0,
    pressure: 1,
    t: index * 8
  }));
  const projection = {
    smoothing: 0,
    pressure: false,
    taper: 0.5,
    width: 4,
    minRatio: 0.35
  };
  assert.equal(taperLengthFor(1000, 0.5), 36);
  assert.equal(taperLengthFor(40, 0.5), 20);
  const widths = strokeWidths(samples, projection);
  // 中段保持满宽：0.5 的比例渐隐不再吃掉半条线。
  assert.ok(Math.abs(widths[500] - 4) < 0.01);
  // 末端仍收锋到约 18%。
  assert.ok(widths[widths.length - 1] <= 4 * 0.2);
  // 渐隐只发生在最后 36px 内。
  assert.ok(widths[950] > 3.95);
});

test('flow 作用于 bodyOpacity，forceBuckets 退化为 3 桶', () => {
  const nodes = [
    { ...makeNode(0, 0), width: 10 },
    { ...makeNode(200, 0), width: 10 }
  ];
  const material = { hardness: 0.8, spacing: 0.5, texture: 0.6, seed: 7 };
  const normal = brushMaterialLayers(nodes, material, 10);
  const flow = brushMaterialLayers(nodes, { ...material, flow: 0.4 }, 10);
  assert.equal(flow.bodyOpacity, 0.4);
  assert.ok(flow.grain.every((layer, index) => layer.opacity < normal.grain[index].opacity));
  const forced = brushMaterialLayers(nodes, { ...material, blendMode: 'multiply' }, 10, {
    forceBuckets: true
  });
  assert.ok(forced.grain.length <= 3);
});

test('文档级 dab 预算按顺序截断', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const nodes = [
    { ...makeNode(0, 0), width: 10 },
    { ...makeNode(200, 0), width: 10 }
  ];
  const material = { hardness: 0.8, spacing: 0.5, texture: 0.6, seed: 7, blendMode: 'multiply' as const };
  const objects = Array.from({ length: 40 }, (_, index) => ({
    ...createPathObject(layer.id, DEFAULT_STYLE, nodes, false),
    id: `budget-${index}`,
    brushMaterial: material
  }));
  const allowed = grainBudgetIds({ ...doc, layers: [{ ...layer, objects }] });
  assert.ok(allowed.size > 0);
  assert.ok(allowed.size < objects.length);
  assert.equal(allowed.size, Math.floor(GRAIN_PATH_BUDGET / 40));
});

test('resize 预览只重算受影响的化学键/环', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const atom = createAtomObject(layer.id, DEFAULT_STYLE, { x: 100, y: 100 }, emptyAtomLabel('C'));
  const bond = createBondObject(
    layer.id,
    DEFAULT_STYLE,
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    'single'
  );
  const group = createGroupObject(
    layer.id,
    '环',
    { x: 80, y: 80, width: 140, height: 40 },
    [bond.id]
  );
  const rect = createRectObject(layer.id, DEFAULT_STYLE, 0, 0, 20, 20);
  const previewDoc = {
    ...doc,
    layers: [{ ...layer, objects: [atom, bond, group, rect] }]
  };
  const atomChanged = chemistryPreviewIds(previewDoc, new Set([atom.id]));
  const bondChanged = chemistryPreviewIds(previewDoc, new Set([bond.id]));
  const rectChanged = chemistryPreviewIds(previewDoc, new Set([rect.id]));
  assert.ok(atomChanged.has(bond.id));
  assert.ok(!atomChanged.has(group.id));
  assert.ok(bondChanged.has(bond.id));
  assert.ok(bondChanged.has(group.id));
  assert.equal(rectChanged.size, 0);
});

test('结构互操作：MOL 原子/键计数与 SMILES 环闭合', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const point = (x: number, y: number) => ({ x, y });
  // 环丙烷：三个碳顶点、三条单键。
  const bonds = [
    createBondObject(layer.id, DEFAULT_STYLE, point(0, 0), point(40, 0), 'single'),
    createBondObject(layer.id, DEFAULT_STYLE, point(40, 0), point(20, 34), 'single'),
    createBondObject(layer.id, DEFAULT_STYLE, point(20, 34), point(0, 0), 'single')
  ];
  const ringDoc = { ...doc, layers: [{ ...layer, objects: bonds }] };
  const mol = exportMol(ringDoc, 'cyclopropane');
  assert.match(mol, /V2000/);
  assert.match(mol, /M {2}END/);
  const counts = mol.split('\n')[3];
  assert.match(counts, /^ {2}3 {2}3/);
  const rows = mol.split('\n');
  const bondRows = rows.slice(4 + 3, 4 + 3 + 3);
  assert.equal(bondRows.length, 3);
  assert.ok(bondRows.every((line) => /^\s*\d+\s+\d+\s+\d+\s+\d+/.test(line)));

  const smiles = exportSmiles(ringDoc);
  assert.equal((smiles.match(/C/g) ?? []).length, 3);
  // 环闭合编号在两端各出现一次。
  assert.equal((smiles.match(/1/g) ?? []).length, 2);
});

test('结构互操作：MOL 电荷走 M CHG 行', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const label = { ...emptyAtomLabel('O'), charge: -1, hydrogens: 0 };
  const atom = createAtomObject(layer.id, DEFAULT_STYLE, { x: 100, y: 100 }, label);
  const chargedDoc = { ...doc, layers: [{ ...layer, objects: [atom] }] };
  const mol = exportMol(chargedDoc);
  assert.match(mol, /M {2}CHG {2}1\s+1\s+-1/);
  const smiles = exportSmiles(chargedDoc);
  assert.equal(smiles, '[O-]');
});

const FILLED_STYLE: Style = {
  fill: { type: 'solid', color: '#111111' },
  stroke: {
    paint: { type: 'solid', color: '#333333' },
    width: 2,
    cap: 'round',
    join: 'round',
    dash: []
  },
  opacity: 1
};

const NO_STROKE_STYLE: Style = {
  fill: { type: 'none' },
  stroke: {
    paint: { type: 'none' },
    width: 1,
    cap: 'round',
    join: 'round',
    dash: []
  },
  opacity: 1
};

function docOf(objects: SceneObject[]): VDrawDocument {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  return { ...doc, layers: [{ ...layer, objects }] };
}

/** 只打开指定目标，其余关闭；避免每个测试都手写四个布尔值。 */
function only(patch: Partial<EraserTargets>): EraserTargets {
  return { ...createEraserTargets(false), ...patch };
}

test('橡皮擦：三项可多选并存，“全部擦除”是三项目标的派生态', () => {
  const all = createEraserTargets(true);
  assert.ok(isEraserAllTargets(all));
  const partial = toggleEraserTarget(all, 'fill');
  assert.equal(partial.fill, false);
  assert.equal(partial.outline, true);
  assert.equal(partial.chemistry, true);
  assert.equal(isEraserAllTargets(partial), false);
  assert.ok(isEraserAllTargets(toggleEraserTarget(partial, 'fill')));

  const none = createEraserTargets(false);
  assert.equal(isEraserAllTargets(none), false);

  // 旧偏好迁移：仅化学 / 仅图形 / 全部。
  assert.deepEqual(normalizeEraserTargets(undefined, 'chemistry'), {
    outline: false,
    fill: false,
    chemistry: true
  });
  assert.deepEqual(normalizeEraserTargets(undefined, 'vector'), {
    outline: true,
    fill: true,
    chemistry: false
  });
  assert.ok(isEraserAllTargets(normalizeEraserTargets(undefined)));
  assert.ok(
    isEraserAllTargets(
      normalizeEraserTargets({ outline: true, fill: true, chemistry: true })
    )
  );

  // 旧版 line/stroke 偏好：任一开启即合并为 outline，两者都关则 outline 关闭。
  assert.deepEqual(normalizeEraserTargets({ line: false, stroke: false, fill: true }), {
    outline: false,
    fill: true,
    chemistry: true
  });
  assert.deepEqual(normalizeEraserTargets({ line: false, stroke: true, fill: false }), {
    outline: true,
    fill: false,
    chemistry: true
  });
});

test('橡皮擦：线条/描边目标只切断经过区段，不越权填充', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const outlineOnly = only({ outline: true });
  const nodes = [
    { ...makeNode(100, 100), width: 20 },
    { ...makeNode(300, 100), width: 20 }
  ];
  const brush = createPathObject(layer.id, NO_STROKE_STYLE, nodes, false);
  brush.style.stroke.paint = { type: 'solid', color: '#111111' };
  const brushDoc = docOf([brush]);

  // 点按：只写一条 2D mask，原对象和几何完整保留。
  const tapped = eraseAlongPath(brushDoc, [{ x: 200, y: 100 }], {
    targets: outlineOnly,
    radius: 16
  });
  const tappedBrush = tapped.layers[0].objects[0] as PathObject;
  assert.equal(tapped.layers[0].objects.length, 1, 'mask 擦除不能切段/加对象');
  assert.equal(tappedBrush.id, brush.id);
  assert.equal(tappedBrush.nodes.length, brush.nodes.length, '中心线几何不变');
  assert.deepEqual(
    tappedBrush.nodes.map((node) => node.x),
    brush.nodes.map((node) => node.x)
  );
  assert.equal(tappedBrush.strokeEraseStrokes?.length, 1);
  assert.equal(tappedBrush.strokeEraseStrokes?.[0].radius, 16);
  assert.deepEqual(tappedBrush.strokeEraseStrokes?.[0].points, [{ x: 200, y: 100 }]);
  assert.equal(tappedBrush.style.fill.type, 'none');
  assert.equal(tappedBrush.style.stroke.paint.type, 'solid');

  // 滑动：只追加轨迹，不切段。
  const slid = eraseAlongPath(
    brushDoc,
    [
      { x: 220, y: 100 },
      { x: 240, y: 100 }
    ],
    { targets: outlineOnly, radius: 8 }
  );
  const slidBrush = slid.layers[0].objects[0] as PathObject;
  assert.equal(slid.layers[0].objects.length, 1);
  assert.equal(slidBrush.strokeEraseStrokes?.length, 1);
  assert.equal(slidBrush.strokeEraseStrokes?.[0].points.length, 2);

  // 提前擦除回归：墨迹半宽 10 + 橡皮半径 16 = 26。
  // 离边缘还有 1px（中心距 27）时不能动手；真正接触（中心距 25）才写入 mask。
  assert.equal(
    eraseAlongPath(brushDoc, [{ x: 200, y: 127 }], {
      targets: outlineOnly,
      radius: 16
    }),
    brushDoc,
    '橡皮尚未接触墨迹边缘时不能提前擦除'
  );
  const contact = eraseAlongPath(brushDoc, [{ x: 200, y: 125 }], {
    targets: outlineOnly,
    radius: 16
  });
  assert.notEqual(contact, brushDoc, '橡皮接触墨迹边缘后应写入 mask');
  assert.equal(
    (contact.layers[0].objects[0] as PathObject).strokeEraseStrokes?.length,
    1
  );

  // 填充/化学目标不碰开放线条。
  assert.equal(
    eraseAlongPath(brushDoc, [{ x: 200, y: 100 }], {
      targets: only({ fill: true }),
      radius: 16
    }),
    brushDoc
  );
  assert.equal(
    eraseAlongPath(brushDoc, [{ x: 200, y: 100 }], {
      targets: only({ chemistry: true }),
      radius: 16
    }),
    brushDoc
  );

  // 有填充和描边的矩形：线条/描边目标只加 stroke mask，填充/描边/几何全部保留。
  const rect = createRectObject(layer.id, FILLED_STYLE, 100, 200, 200, 100);
  const rectDoc = docOf([rect]);
  assert.equal(
    eraseAlongPath(rectDoc, [{ x: 200, y: 250 }], { targets: outlineOnly, radius: 6 }),
    rectDoc,
    '矩形内部没有线条，线条/描边目标不应命中'
  );
  const rectErased = eraseAlongPath(rectDoc, [{ x: 100, y: 250 }], {
    targets: outlineOnly,
    radius: 3
  });
  const kept = rectErased.layers[0].objects[0] as RectObject;
  assert.equal(rectErased.layers[0].objects.length, 1, 'mask 擦除不能拆矩形');
  assert.equal(kept.id, rect.id);
  assert.equal(kept.type, 'rect');
  assert.equal(kept.style.fill.type, 'solid', '线条/描边擦除不能清除填充');
  assert.equal(kept.style.stroke.paint.type, 'solid', '描边颜色不能被改掉');
  assert.equal(kept.strokeEraseStrokes?.length, 1, '描边擦除应写入独立 stroke mask');
});

test('橡皮擦：填充目标只写擦除轨迹，描边与其余填充保持原样', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const rect = createRectObject(layer.id, FILLED_STYLE, 100, 100, 200, 100);
  const base = docOf([rect]);
  const fillOnly = only({ fill: true });

  const tapped = eraseAlongPath(base, [{ x: 200, y: 150 }], {
    targets: fillOnly,
    radius: 16
  });
  const dab = tapped.layers[0].objects[0] as PathObject;
  assert.equal(dab.type, 'path', '填充擦除需要转成可承载 mask 的路径');
  assert.equal(dab.id, rect.id, '填充擦除保留对象身份');
  assert.equal(dab.style.fill.type, 'solid', '其余填充必须保留');
  assert.equal(dab.style.stroke.paint.type, 'solid', '填充擦除不能动描边');
  assert.equal(dab.eraseStrokes?.length, 1, '点按应写一条擦除轨迹');
  assert.equal(dab.eraseStrokes?.[0].points.length, 1, '点按轨迹只有一个点');
  assert.equal(dab.eraseStrokes?.[0].radius, 16);
  assert.match(eraseMaskDef(dab), /<mask id="erase-/, '擦除轨迹应生成 mask');
  assert.match(eraseMaskDef(dab), /fill="#000"/);

  // 命中判定与 mask 一致：轨迹内部不再算填充，轨迹外仍能命中。
  assert.equal(
    findErasableAt(tapped, { x: 200, y: 150 }, { targets: fillOnly, radius: 1 }),
    null,
    '已擦区域不应再算可见填充'
  );
  assert.equal(
    findErasableAt(tapped, { x: 260, y: 150 }, { targets: fillOnly, radius: 1 })?.id,
    rect.id
  );

  const slid = eraseAlongPath(
    base,
    [
      { x: 150, y: 150 },
      { x: 200, y: 150 },
      { x: 250, y: 150 }
    ],
    { targets: fillOnly, radius: 12 }
  );
  const slidPath = slid.layers[0].objects[0] as PathObject;
  assert.equal(slidPath.type, 'path');
  assert.equal(slidPath.eraseStrokes?.length, 1, '连续 move 应合并成一条轨迹');
  assert.equal(slidPath.eraseStrokes?.[0].points.length, 3);
  assert.equal(slidPath.style.stroke.paint.type, 'solid');
  assert.match(eraseMaskDef(slidPath), /stroke="#000"/);
  assert.match(eraseMaskDef(slidPath), /stroke-width="24"/);

  // 轨迹随对象移动/缩放/旋转：孔洞不能留在原地。
  const moved = translateObject(slidPath, 10, 20) as PathObject;
  assert.deepEqual(moved.eraseStrokes?.[0].points[0], { x: 160, y: 170 });
  const scaled = scaleObject(slidPath, { x: 0, y: 0 }, 2, 2) as PathObject;
  assert.deepEqual(scaled.eraseStrokes?.[0].points[0], { x: 300, y: 300 });
  assert.equal(scaled.eraseStrokes?.[0].radius, 24);
  const rotated = rotateObject(slidPath, { x: 0, y: 0 }, 90) as PathObject;
  assert.ok(Math.abs((rotated.eraseStrokes?.[0].points[0].x ?? 0) + 150) < 0.01);
  assert.ok(Math.abs((rotated.eraseStrokes?.[0].points[0].y ?? 0) - 150) < 0.01);

  // 空心矩形没有填充：填充目标不应产生任何变化。
  const hollow = docOf([createRectObject(layer.id, DEFAULT_STYLE, 100, 100, 200, 100)]);
  assert.equal(
    eraseAlongPath(hollow, [{ x: 200, y: 150 }], { targets: fillOnly, radius: 8 }),
    hollow
  );
});

test('橡皮擦：线条/描边目标同时处理形状轮廓与开放笔迹，填充互不越权', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const outlineOnly = only({ outline: true });
  const rect = createRectObject(layer.id, FILLED_STYLE, 100, 100, 200, 100);
  const base = docOf([rect]);

  // 内部点离描边很远：线条/描边目标不应生效。
  assert.equal(
    eraseAlongPath(base, [{ x: 200, y: 150 }], { targets: outlineOnly, radius: 5 }),
    base
  );

  const border = eraseAlongPath(base, [{ x: 100, y: 150 }], {
    targets: outlineOnly,
    radius: 3
  });
  const kept = border.layers[0].objects[0] as RectObject;
  assert.equal(border.layers[0].objects.length, 1, 'mask 擦除不能拆矩形');
  assert.equal(kept.style.fill.type, 'solid', '线条/描边擦除不能动填充');
  assert.equal(kept.style.stroke.paint.type, 'solid', '描边颜色不能被改掉');
  assert.equal(kept.strokeEraseStrokes?.length, 1);

  // 合并后的目标也处理开放画笔线：几何保留，只加 stroke mask。
  const brush = createPathObject(
    layer.id,
    NO_STROKE_STYLE,
    [makeNode(100, 300), makeNode(300, 300)],
    false
  );
  brush.style.stroke.paint = { type: 'solid', color: '#111111' };
  const brushDoc = docOf([brush]);
  const brushErased = eraseAlongPath(brushDoc, [{ x: 200, y: 300 }], {
    targets: outlineOnly,
    radius: 10
  });
  assert.notEqual(brushErased, brushDoc, '线条/描边目标应写入 open line mask');
  assert.equal(brushErased.layers[0].objects.length, 1);
  assert.equal(
    (brushErased.layers[0].objects[0] as PathObject).strokeEraseStrokes?.length,
    1
  );
});

test('橡皮擦：20px 直线接触上沿只遮上沿，不会整段切掉下沿', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const line = createLineObject(
    layer.id,
    { ...FILLED_STYLE, fill: { type: 'none' }, stroke: { ...FILLED_STYLE.stroke, width: 20 } },
    { x: 100, y: 100 },
    { x: 300, y: 100 }
  );
  const base = docOf([line]);

  // 5px 橡皮（半径 2.5）中心在 y=87.5：底边刚好碰到 20px 直线的上沿 y=90。
  const erased = eraseAlongPath(base, [{ x: 200, y: 87.5 }], {
    targets: only({ outline: true }),
    radius: 2.5
  });
  const kept = erased.layers[0].objects[0] as LineObject;
  assert.equal(erased.layers[0].objects.length, 1, '不能切段/加对象');
  assert.equal(kept.type, 'line');
  assert.deepEqual(kept.start, line.start, '直线起点不变');
  assert.deepEqual(kept.end, line.end, '直线终点不变');
  assert.equal(kept.style.stroke.width, 20, '20px 描边宽度不变');
  assert.equal(kept.strokeEraseStrokes?.length, 1);
  assert.equal(kept.strokeEraseStrokes?.[0].radius, 2.5);
  assert.deepEqual(kept.strokeEraseStrokes?.[0].points, [{ x: 200, y: 87.5 }]);

  const mask = strokeEraseMaskDef(kept);
  assert.match(mask, /<circle[^>]*cy="87.5"[^>]*r="2.5"/, 'mask 只应覆盖上沿 5px 圆');
  assert.doesNotMatch(mask, /<path/, 'mask 不应包含整条中心线切割');

  // 描边 mask 也必须随对象移动/缩放。
  const moved = translateObject(kept, 10, 20) as LineObject;
  assert.deepEqual(moved.strokeEraseStrokes?.[0].points[0], { x: 210, y: 107.5 });
  const scaled = scaleObject(kept, { x: 0, y: 0 }, 2, 2) as LineObject;
  assert.deepEqual(scaled.strokeEraseStrokes?.[0].points[0], { x: 400, y: 175 });
  assert.equal(scaled.strokeEraseStrokes?.[0].radius, 5);

  const svg = documentToSvgString(erased, { includeBackground: false });
  assert.match(svg, /<mask id="stroke-erase-[^"]+"/, '导出必须包含描边擦除 mask');
  assert.match(svg, /<g mask="url\(#stroke-erase-[^)]+\)"/, '描边元素应引用该 mask');
  assert.match(svg, /<line[^>]*stroke-width="20"/, '20px 直线几何必须完整导出');
  assert.match(svg, /<circle[^>]*cy="87.5"[^>]*r="2.5"/, '导出 mask 只覆盖上沿');
});

test('导出：填充擦除走 mask，重叠轨迹不依赖孔洞绕序', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const rect = createRectObject(layer.id, FILLED_STYLE, 100, 100, 200, 100);
  const base = docOf([rect]);
  const erased = eraseAlongPath(
    base,
    [
      { x: 150, y: 150 },
      { x: 200, y: 150 },
      { x: 250, y: 150 }
    ],
    { targets: only({ fill: true }), radius: 12 }
  );
  const svg = documentToSvgString(erased, { includeBackground: false });
  assert.match(svg, /<mask id="erase-[^"]+"/, '导出必须包含填充擦除 mask');
  assert.match(svg, /mask="url\(#erase-[^)]+\)"/, '填充路径必须引用该 mask');
  assert.match(svg, /stroke="#000" stroke-width="24"/, '扫掠轨迹应写成 mask 黑色描边');
  const fillPath = svg.match(/<path d="([^"]*)"[^>]*mask="url\(#erase-[^)]+\)"/);
  assert.ok(fillPath, '应导出带 mask 的填充路径');
  assert.equal((fillPath[1].match(/M/g) || []).length, 1, '填充路径只保留外轮廓');
});

test('橡皮擦：填充+线条/描边同时擦除时使用两份独立 mask', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const rect = createRectObject(layer.id, FILLED_STYLE, 100, 100, 200, 100);
  const base = docOf([rect]);
  const erased = eraseAlongPath(base, [{ x: 100, y: 150 }], {
    targets: createEraserTargets(true),
    radius: 3
  });
  const object = erased.layers[0].objects[0] as PathObject;
  assert.equal(object.type, 'path');
  assert.equal(object.eraseStrokes?.length, 1, '填充擦除轨迹');
  assert.equal(object.strokeEraseStrokes?.length, 1, '描边擦除轨迹');
  assert.equal(object.style.fill.type, 'solid');
  assert.equal(object.style.stroke.paint.type, 'solid');
  assert.match(eraseMaskDef(object), /<mask id="erase-/);
  assert.match(strokeEraseMaskDef(object), /<mask id="stroke-erase-/);
});

test('橡皮擦：同一对象的二次描边擦除只累加 mask，不切段', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const outlineOnly = only({ outline: true });
  const rect = createRectObject(layer.id, FILLED_STYLE, 100, 100, 200, 100);
  const base = docOf([rect]);
  const first = eraseAlongPath(base, [{ x: 100, y: 150 }], {
    targets: outlineOnly,
    radius: 3
  });
  const firstRect = first.layers[0].objects[0] as RectObject;
  assert.equal(firstRect.type, 'rect');
  assert.equal(firstRect.strokeEraseStrokes?.length, 1);
  const second = eraseAlongPath(first, [{ x: 200, y: 100 }], {
    targets: outlineOnly,
    radius: 3
  });
  const after = second.layers[0].objects[0] as RectObject;
  assert.equal(second.layers[0].objects.length, 1, '二次擦除不能把对象切碎');
  assert.equal(after.type, 'rect');
  assert.equal(after.strokeEraseStrokes?.length, 2, '两次手势应各留一条轨迹');
});

test('橡皮擦：线条/描边目标也遮普通直线，填充目标不越权', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const line = createLineObject(layer.id, FILLED_STYLE, { x: 100, y: 100 }, { x: 300, y: 100 });
  const base = docOf([line]);

  const cut = eraseAlongPath(base, [{ x: 200, y: 100 }], {
    targets: only({ outline: true }),
    radius: 12
  });
  const kept = cut.layers[0].objects[0] as LineObject;
  assert.equal(cut.layers[0].objects.length, 1);
  assert.equal(kept.type, 'line');
  assert.deepEqual(kept.start, line.start);
  assert.deepEqual(kept.end, line.end);
  assert.equal(kept.style.stroke.paint.type, 'solid');
  assert.equal(kept.strokeEraseStrokes?.length, 1);

  assert.equal(
    eraseAlongPath(base, [{ x: 200, y: 100 }], {
      targets: only({ fill: true }),
      radius: 12
    }),
    base
  );
});

test('橡皮擦：画笔笔迹按逐节点墨迹宽度命中', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const nodes = [
    { ...makeNode(100, 100), width: 20 },
    { ...makeNode(200, 100), width: 20 }
  ];
  const path = createPathObject(layer.id, NO_STROKE_STYLE, nodes, false);
  path.style.stroke.paint = { type: 'solid', color: '#111111' };
  const base = docOf([path]);
  const outlineOnly = only({ outline: true });

  // 半宽 10 + 半径 6 = 16：中心线下 15px 仍应命中。
  assert.equal(findErasableAt(base, { x: 150, y: 115 }, { targets: outlineOnly, radius: 6 })?.id, path.id);
  // 中心线下 20px 已经离开墨迹包络。
  assert.equal(findErasableAt(base, { x: 150, y: 120 }, { targets: outlineOnly, radius: 6 }), null);
  // 合并后的线条/描边目标能命中开放笔迹；填充/化学目标不能。
  assert.equal(findErasableAt(base, { x: 150, y: 100 }, { targets: outlineOnly, radius: 6 })?.id, path.id);
  assert.equal(findErasableAt(base, { x: 150, y: 100 }, { targets: only({ fill: true }), radius: 6 }), null);
  assert.equal(findErasableAt(base, { x: 150, y: 100 }, { targets: only({ chemistry: true }), radius: 6 }), null);

  // 宽度边界也参与命中：点在外缘仍能写入 mask。
  const cut = eraseAlongPath(base, [{ x: 150, y: 115 }], {
    targets: outlineOnly,
    radius: 6
  });
  const masked = cut.layers[0].objects[0] as PathObject;
  assert.equal(cut.layers[0].objects.length, 1);
  assert.equal(masked.id, path.id);
  assert.equal(masked.strokeEraseStrokes?.length, 1);
});

test('橡皮擦：化学键目标擦键，擦原子连带删除相连键', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const bond = createBondObject(layer.id, DEFAULT_STYLE, { x: 100, y: 100 }, { x: 140, y: 100 }, 'single');
  const atom = createAtomObject(layer.id, DEFAULT_STYLE, { x: 140, y: 100 }, emptyAtomLabel('O'));
  const base = docOf([bond, atom]);
  const chemOnly = only({ chemistry: true });

  // 线条/描边目标不能擦化学对象。
  assert.equal(
    eraseAlongPath(base, [{ x: 115, y: 100 }], { targets: only({ outline: true }), radius: 8 }),
    base
  );

  const bondErased = eraseAlongPath(base, [{ x: 115, y: 100 }], {
    targets: chemOnly,
    radius: 5
  });
  assert.deepEqual(
    bondErased.layers[0].objects.map((item) => item.id),
    [atom.id]
  );

  const atomErased = eraseAlongPath(base, [{ x: 140, y: 100 }], {
    targets: chemOnly,
    radius: 5
  });
  assert.equal(atomErased.layers[0].objects.length, 0, '擦原子必须连带删除成键');
});

test('橡皮擦：擦断环键后芳香内圈解除，环编组不会整组消失', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const center = { x: 200, y: 200 };
  const radius = 40;
  const vertices = Array.from({ length: 6 }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / 3;
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
  const bonds = vertices.map((vertex, index) =>
    createBondObject(layer.id, DEFAULT_STYLE, vertex, vertices[(index + 1) % 6], 'aromatic')
  );
  const group = createGroupObject(
    layer.id,
    '苯环',
    { x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2 },
    bonds.map((bond) => bond.id)
  );
  group.ringStyle = 'pauling';
  for (const bond of bonds) bond.parentId = group.id;

  const mid = {
    x: (vertices[0].x + vertices[1].x) / 2,
    y: (vertices[0].y + vertices[1].y) / 2
  };
  const next = eraseAlongPath(docOf([group, ...bonds]), [mid], {
    targets: only({ chemistry: true }),
    radius: 4
  });
  const objects = next.layers[0].objects;
  assert.equal(objects.filter((item) => item.type === 'bond').length, 5);
  const ring = objects.find((item) => item.type === 'group') as GroupObject;
  assert.ok(ring, '环编组应保留');
  assert.equal(ring.ringStyle, undefined, '断开环键后芳香内圈必须解除');
});

test('橡皮擦：只擦当前图层，隐藏/锁定对象不受影响', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const rectA = createRectObject(layer.id, FILLED_STYLE, 0, 0, 50, 50);
  const rectB = createRectObject(layer.id, FILLED_STYLE, 200, 0, 50, 50);
  const layerA = { ...layer, id: 'layer-a', objects: [rectA] };
  const layerB = { ...layer, id: 'layer-b', objects: [rectB] };
  const base = { ...doc, layers: [layerA, layerB] };
  const outlineOnly = only({ outline: true });

  // 左边界在 A 层，但只允许擦 B 层。
  assert.equal(
    eraseAlongPath(base, [{ x: 0, y: 25 }], { targets: outlineOnly, radius: 4, layerId: 'layer-b' }),
    base
  );

  const hidden = { ...base, layers: [{ ...layerA, visible: false }, layerB] };
  assert.equal(eraseAlongPath(hidden, [{ x: 0, y: 25 }], { targets: outlineOnly, radius: 4 }), hidden);

  const locked = { ...base, layers: [{ ...layerA, locked: true }, layerB] };
  assert.equal(eraseAlongPath(locked, [{ x: 0, y: 25 }], { targets: outlineOnly, radius: 4 }), locked);

  // A 层正常：只切 A 的轮廓，填充对象保留，B 层不动。
  const erased = eraseAlongPath(base, [{ x: 0, y: 25 }], {
    targets: outlineOnly,
    radius: 4,
    layerId: 'layer-a'
  });
  assert.notEqual(erased, base);
  assert.equal(
    erased.layers[0].objects.filter((item) => item.type === 'rect').length,
    1,
    '线条/描边擦除不能删掉填充对象'
  );
  assert.deepEqual(erased.layers[1], base.layers[1]);
});

test('橡皮擦：悬停预览与实际擦除共用同一套命中判定', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const hollow = createRectObject(layer.id, DEFAULT_STYLE, 100, 100, 200, 100);
  const hollowDoc = docOf([hollow]);
  const outlineOnly = only({ outline: true });

  assert.equal(findErasableAt(hollowDoc, { x: 200, y: 150 }, { targets: outlineOnly, radius: 5 }), null);
  assert.equal(
    findErasableAt(hollowDoc, { x: 100, y: 150 }, { targets: outlineOnly, radius: 3 })?.id,
    hollow.id
  );
  // 描边宽 1.5（半宽 0.75）+ 半径 3 = 3.75：中心距 4 时不能提前命中。
  assert.equal(
    findErasableAt(hollowDoc, { x: 104, y: 150 }, { targets: outlineOnly, radius: 3 }),
    null,
    '橡皮尚未接触描边时不能提前命中'
  );
  assert.equal(
    findErasableAt(hollowDoc, { x: 103.5, y: 150 }, { targets: outlineOnly, radius: 3 })?.id,
    hollow.id,
    '接触描边后应正常命中'
  );

  const filled = createRectObject(layer.id, FILLED_STYLE, 100, 100, 200, 100);
  const filledDoc = docOf([filled]);
  assert.equal(findErasableAt(filledDoc, { x: 200, y: 150 }, { targets: only({ fill: true }), radius: 3 })?.id, filled.id);
  // 线条/描边目标只看轮廓带：内部不命中，边界命中。
  assert.equal(findErasableAt(filledDoc, { x: 200, y: 150 }, { targets: outlineOnly, radius: 3 }), null);
  assert.equal(
    findErasableAt(filledDoc, { x: 100, y: 150 }, { targets: outlineOnly, radius: 3 })?.id,
    filled.id
  );
});

test('橡皮擦：全部关闭时任何目标都不生效', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const rect = createRectObject(layer.id, FILLED_STYLE, 100, 100, 200, 100);
  const base = docOf([rect]);
  assert.equal(
    eraseAlongPath(base, [{ x: 200, y: 150 }], { targets: createEraserTargets(false), radius: 20 }),
    base
  );
});

test('橡皮擦：双键/三键按 三→双→单→删除 逐级降键', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const bond = createBondObject(
    layer.id,
    DEFAULT_STYLE,
    { x: 100, y: 100 },
    { x: 140, y: 100 },
    'triple'
  );
  const chem = only({ chemistry: true });
  const hit = (source: VDrawDocument) =>
    eraseAlongPath(source, [{ x: 120, y: 100 }], { targets: chem, radius: 6 });

  const first = hit(docOf([bond]));
  assert.equal(first.layers[0].objects.length, 1, '第一次擦除只降键，不删对象');
  assert.equal((first.layers[0].objects[0] as { bondType: string }).bondType, 'double');

  const second = hit(docOf([{ ...bond, bondType: 'double' }]));
  assert.equal(second.layers[0].objects.length, 1, '第二次擦除继续降键');
  assert.equal((second.layers[0].objects[0] as { bondType: string }).bondType, 'single');

  const third = hit(docOf([{ ...bond, bondType: 'single' }]));
  assert.equal(third.layers[0].objects.length, 0, '单键被擦除');
});

test('橡皮擦：同一手势内同一条键只降一级', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const bond = createBondObject(
    layer.id,
    DEFAULT_STYLE,
    { x: 100, y: 100 },
    { x: 140, y: 100 },
    'triple'
  );
  const base = docOf([bond]);
  const chem = only({ chemistry: true });
  const degraded = new Set<string>();

  const once = eraseAlongPath(base, [{ x: 120, y: 100 }], {
    targets: chem,
    radius: 6,
    degradedBondIds: degraded
  });
  assert.equal((once.layers[0].objects[0] as { bondType: string }).bondType, 'double');
  // 同一次按下→抬起内继续划过同一条键：保持双键，不再降级。
  const twice = eraseAlongPath(once, [{ x: 130, y: 100 }], {
    targets: chem,
    radius: 6,
    degradedBondIds: degraded
  });
  assert.equal(twice, once, '同一手势不重复降键');
  // 新手势（新的集合）才继续降级。
  const nextGesture = eraseAlongPath(twice, [{ x: 130, y: 100 }], {
    targets: chem,
    radius: 6,
    degradedBondIds: new Set<string>()
  });
  assert.equal((nextGesture.layers[0].objects[0] as { bondType: string }).bondType, 'single');
});

test('橡皮擦：双键降为单键时清掉环内侧标记', () => {
  const doc = createDocument('blank-landscape', 'unit');
  const layer = doc.layers[0];
  const bond = {
    ...createBondObject(
      layer.id,
      DEFAULT_STYLE,
      { x: 100, y: 100 },
      { x: 140, y: 100 },
      'double'
    ),
    ringInnerSide: 1 as const
  };
  const next = eraseAlongPath(docOf([bond]), [{ x: 120, y: 100 }], {
    targets: only({ chemistry: true }),
    radius: 6
  });
  const erased = next.layers[0].objects[0] as { bondType: string; ringInnerSide?: number };
  assert.equal(erased.bondType, 'single');
  assert.equal(erased.ringInnerSide, undefined);
});

test('化学键级：prevBondOrderType 只降级三键与双键', () => {
  assert.equal(prevBondOrderType('triple'), 'double');
  assert.equal(prevBondOrderType('double'), 'single');
  assert.equal(prevBondOrderType('single'), null);
  assert.equal(prevBondOrderType('aromatic'), null);
});

test('导出：输出像素宽可反算选区宽度（省掉手算 ÷2）', () => {
  // 常规 2× 场景：输出 800 → 选区 400。
  assert.equal(regionWidthForOutputWidth(800, 600), 400);
  assert.equal(regionWidthForOutputWidth(2000, 1000), 1000);
  // 反算结果再乘回安全倍率应命中目标输出宽。
  const width = regionWidthForOutputWidth(3000, 4000);
  assert.equal(Math.round(width * safeRasterScale(width, 4000, 2)), 3000);
  // 超大尺寸会触发安全降倍率：仍要给出可用的正整数宽度。
  const huge = regionWidthForOutputWidth(15000, 15000);
  assert.ok(Number.isFinite(huge) && huge >= 1);
});

test('启动页：自定义快捷模板可增删，同名只更新尺寸', () => {
  const host = globalThis as unknown as { window?: unknown };
  const previousWindow = host.window;
  host.window = { setTimeout, clearTimeout, innerWidth: 1200, innerHeight: 800 };

  try {
    useAppStore.setState({ customTemplates: [] });
    useAppStore.getState().addCanvasPreset('实验图', 900, 600);
    assert.deepEqual(
      useAppStore.getState().customTemplates.map((item) => [item.name, item.width, item.height]),
      [['实验图', 900, 600]]
    );
    // 同名再次保存 = 修改尺寸，不会堆出第二个模板。
    useAppStore.getState().addCanvasPreset('实验图', 1000, 700);
    const list = useAppStore.getState().customTemplates;
    assert.equal(list.length, 1);
    assert.equal(list[0].width, 1000);
    assert.equal(list[0].height, 700);
    // 空名字回落到尺寸名。
    useAppStore.getState().addCanvasPreset('  ', 400, 300);
    assert.ok(useAppStore.getState().customTemplates.some((item) => item.name === '400 × 300'));
    const target = useAppStore.getState().customTemplates[0];
    useAppStore.getState().removeCanvasPreset(target.id);
    assert.ok(!useAppStore.getState().customTemplates.some((item) => item.id === target.id));
  } finally {
    useAppStore.setState({ customTemplates: [] });
    if (previousWindow === undefined) delete host.window;
    else host.window = previousWindow;
  }
});

test('重命名：文档标题与最近文件记录互相同步', () => {
  const doc = createDocument('blank-landscape', '旧标题');
  const recent = [
    {
      id: doc.id,
      name: '旧标题',
      path: 'C:/tmp/old.vdraw',
      templateId: doc.templateId,
      templateName: '空白',
      sizeLabel: 'A4',
      openedAt: new Date().toISOString()
    }
  ];
  useAppStore.setState({ doc, isDirty: false, recent });
  useAppStore.getState().renameDocument('  新 标题  ');
  assert.equal(useAppStore.getState().doc.name, '新 标题');
  assert.equal(useAppStore.getState().isDirty, true);
  assert.equal(useAppStore.getState().recent[0].name, '新 标题');

  useAppStore.getState().renameRecent(doc.id, '最近记录名');
  assert.equal(useAppStore.getState().recent[0].name, '最近记录名');
  assert.equal(useAppStore.getState().doc.name, '最近记录名');

  // 最近记录 id 与文档 id 不一致时，仍按文件路径双向同步。
  const linkedDoc = { ...doc, filePath: 'C:/tmp/linked.vdraw' };
  const linkedRecent = [
    {
      ...recent[0],
      id: 'recent-path-id',
      name: '路径旧名',
      path: 'C:/tmp/linked.vdraw'
    }
  ];
  useAppStore.setState({ doc: linkedDoc, recent: linkedRecent, isDirty: false });
  useAppStore.getState().renameDocument('画布新名');
  assert.equal(useAppStore.getState().recent[0].name, '画布新名');
  useAppStore.getState().renameRecent('recent-path-id', '列表新名');
  assert.equal(useAppStore.getState().doc.name, '列表新名');
});

test('对象图层：复制、删除与拖动层级（越靠后越在上层）', () => {
  // store 的 notify 依赖 window.setTimeout；Node 环境下补一个最小 shim。
  const host = globalThis as unknown as { window?: unknown };
  const previousWindow = host.window;
  host.window = { setTimeout, clearTimeout, innerWidth: 1200, innerHeight: 800 };

  try {
    const doc = createDocument('blank-landscape', 'unit');
    const layer = doc.layers[0];
    const first = createRectObject(layer.id, FILLED_STYLE, 0, 0, 40, 40);
    const second = createRectObject(layer.id, FILLED_STYLE, 100, 0, 40, 40);
    const third = createRectObject(layer.id, FILLED_STYLE, 200, 0, 40, 40);
    useAppStore.setState({
      doc: { ...doc, layers: [{ ...layer, objects: [first, second, third] }] },
      activeLayerId: layer.id,
      selection: [],
      past: [],
      future: [],
      pendingSnapshot: null,
      isDirty: false
    });
    const order = () =>
      useAppStore.getState().doc.layers[0].objects.map((obj) => obj.id);

    // 拖到目标上方 → 数组更靠后 → 绘制在更上层。
    useAppStore.getState().moveObjectTo(first.id, third.id, 'above');
    assert.deepEqual(order(), [second.id, third.id, first.id]);
    // 拖到目标下方 → 数组更靠前 → 被目标覆盖。
    useAppStore.getState().moveObjectTo(first.id, second.id, 'below');
    assert.deepEqual(order(), [first.id, second.id, third.id]);

    // 复制：副本紧贴源对象下方（数组更靠前 = 层级更低），并选中新对象。
    useAppStore.getState().duplicateObject(second.id);
    const duplicated = useAppStore.getState().doc.layers[0].objects;
    assert.equal(duplicated.length, 4);
    const sourceIndex = duplicated.findIndex((obj) => obj.id === second.id);
    const copy = duplicated[sourceIndex - 1];
    assert.notEqual(copy.id, second.id);
    assert.equal(copy.layerId, layer.id);
    assert.deepEqual(
      duplicated.map((obj) => obj.id),
      [first.id, copy.id, second.id, third.id],
      '复制件应插在原对象正下方，而不是整个列表最上方'
    );
    assert.deepEqual(useAppStore.getState().selection, [copy.id]);

    // 删除：只移除目标对象。
    useAppStore.getState().deleteObject(copy.id);
    assert.deepEqual(order(), [first.id, second.id, third.id]);
  } finally {
    if (previousWindow === undefined) delete host.window;
    else host.window = previousWindow;
  }
});

function expectImportError(run: () => unknown, code: ImportError['code']): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ImportError, '应抛出带错误码的 ImportError');
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0, '错误信息不能为空');
    return true;
  });
}

function importSampleDocument(): VDrawDocument {
  const doc = createDocument('blank-landscape', '导入测试');
  const layer = doc.layers[0];
  const rect = createRectObject(layer.id, DEFAULT_STYLE, 10, 20, 100, 60);
  const path = createPathObject(
    layer.id,
    { ...DEFAULT_STYLE, stroke: { ...DEFAULT_STYLE.stroke, width: 3 } },
    [makeNode(0, 0), makeNode(40, 40)],
    false
  );
  return { ...doc, layers: [{ ...layer, objects: [rect, path] }] };
}

const IMPORT_EDITOR: EditorSnapshot = {
  symmetry: 'vertical',
  symmetryAxis: { x: 0.5, y: 0.4 },
  guideMode: 'grid',
  guideSettings: { horizon: 0.42, vpX: 0.5, vpLeft: -0.18, vpRight: 1.18, vpBottom: 1.75 },
  guideAssist: true,
  guideDensity: 24,
  guideSpacing: 120
};

test('导入：.vdraw 完整还原页面、图层、样式与编辑器环境', () => {
  const doc = importSampleDocument();
  const source = validateImportContent({
    fileName: '设计稿.vdraw',
    content: serializeDocument(doc, IMPORT_EDITOR)
  });
  assert.equal(source.kind, 'document');
  if (source.kind !== 'document') return;
  assert.equal(source.stats.version, 1);
  assert.equal(source.stats.layers, 1);
  assert.equal(source.stats.objects, 2);
  assert.equal(source.stats.pageWidth, doc.page.width);
  assert.equal(source.stats.pageHeight, doc.page.height);
  assert.equal(source.editor?.symmetry, 'vertical');
  assert.equal(source.editor?.guideMode, 'grid');
  assert.equal(source.suggestedName, '设计稿');
  assert.deepEqual(source.warnings, []);
  // 样式与贝塞尔几何原样保留，不做"重新猜测"。
  assert.deepEqual(source.doc.layers[0].objects[0].style, doc.layers[0].objects[0].style);
  const path = source.doc.layers[0].objects[1] as PathObject;
  assert.equal(path.nodes.length, 2);
  assert.equal(path.nodes[1].x, 40);
});

test('导入：旧版裸文档 JSON（无信封/无版本号）与 SVG 内容识别', () => {
  const doc = importSampleDocument();
  const envelope = JSON.parse(serializeDocument(doc)) as { document: VDrawDocument };
  const source = validateImportContent({
    fileName: '旧版.json',
    content: JSON.stringify(envelope.document)
  });
  assert.equal(source.kind, 'document');
  if (source.kind !== 'document') return;
  assert.equal(source.stats.version, 1);
  assert.equal(source.stats.objects, 2);
  assert.equal(source.suggestedName, '旧版');
  assert.equal(
    detectImportFormat('图形.svg', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
    'svg'
  );
});

test('导入：非 JSON、非工程 JSON 与高版本文件给出明确错误码', () => {
  expectImportError(
    () => validateImportContent({ fileName: '坏文件.vdraw', content: '{oops' }),
    'invalid-json'
  );
  expectImportError(
    () => validateImportContent({ fileName: '随机.json', content: '{"hello":1}' }),
    'invalid-document'
  );
  const payload = JSON.parse(serializeDocument(importSampleDocument())) as Record<string, unknown>;
  payload.schemaVersion = 99;
  expectImportError(
    () => validateImportContent({ fileName: '未来.vdraw', content: JSON.stringify(payload) }),
    'unsupported-version'
  );
});

test('导入：重复 ID、空路径节点与非法页面尺寸均被拒绝', () => {
  const doc = importSampleDocument();
  const layer = doc.layers[0];
  const rect = layer.objects[0];
  expectImportError(
    () =>
      validateImportContent({
        fileName: '重复.vdraw',
        content: serializeDocument({
          ...doc,
          layers: [{ ...layer, objects: [rect, { ...layer.objects[1], id: rect.id }] }]
        })
      }),
    'duplicate-ids'
  );

  const emptyPath = {
    ...createPathObject(layer.id, DEFAULT_STYLE, [makeNode(0, 0)], false),
    nodes: []
  };
  expectImportError(
    () =>
      validateImportContent({
        fileName: '空路径.vdraw',
        content: serializeDocument({ ...doc, layers: [{ ...layer, objects: [emptyPath] }] })
      }),
    'invalid-layers'
  );

  expectImportError(
    () =>
      validateImportContent({
        fileName: '超大.vdraw',
        content: serializeDocument({ ...doc, page: { ...doc.page, width: 40000 } })
      }),
    'invalid-page'
  );
});

test('导入：位图 / PDF / 二进制与未知扩展名给出可操作的提示', () => {
  expectImportError(
    () => validateImportContent({ fileName: '截图.png', content: 'not really png' }),
    'unsupported-type'
  );
  expectImportError(
    () => validateImportContent({ fileName: '导出.pdf', content: '%PDF-1.7 body' }),
    'unsupported-type'
  );
  expectImportError(
    () => validateImportContent({ fileName: '未知.bin', content: 'plain text' }),
    'unsupported-type'
  );
  expectImportError(
    () => validateImportContent({ fileName: '二进制.vdraw', content: '\u0000\u0001PNG' }),
    'binary-content'
  );
  // 扩展名与内容不符：按内容给出更准确的解释，避免"JSON 解析失败"的误导。
  expectImportError(
    () =>
      validateImportContent({
        fileName: '伪装.vdraw',
        content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
      }),
    'unsupported-type'
  );
});

test('导入：悬空引用与失效编组会自动修复并记录提示', () => {
  const doc = importSampleDocument();
  const layer = doc.layers[0];
  const orphan = { ...layer.objects[0], parentId: 'missing-group' };
  const group = createGroupObject(layer.id, '编组', { x: 0, y: 0, width: 40, height: 40 }, [
    'missing-child'
  ]);
  const source = validateImportContent({
    fileName: '损坏引用.vdraw',
    content: serializeDocument({ ...doc, layers: [{ ...layer, objects: [orphan, group] }] })
  });
  assert.equal(source.kind, 'document');
  if (source.kind !== 'document') return;
  assert.equal(source.doc.layers[0].objects[0].parentId, null);
  const repairedGroup = source.doc.layers[0].objects[1] as GroupObject;
  assert.deepEqual(repairedGroup.childIds, []);
  assert.ok(source.warnings.some((warning) => warning.includes('编组父级')));
  assert.ok(source.warnings.some((warning) => warning.includes('编组子对象')));
});

test('导入：损坏样式下沉为默认值，非法路径节点直接拒绝', () => {
  const doc = importSampleDocument();
  const layer = doc.layers[0];
  const brokenStyle = {
    ...layer.objects[0],
    style: { fill: { type: 'solid', color: 42 }, stroke: {}, opacity: 'x' }
  } as unknown as SceneObject;
  const source = validateImportContent({
    fileName: '损坏样式.vdraw',
    content: serializeDocument({ ...doc, layers: [{ ...layer, objects: [brokenStyle] }] })
  });
  assert.equal(source.kind, 'document');
  if (source.kind !== 'document') return;
  assert.ok(source.warnings.some((warning) => warning.includes('样式')));
  const fixed = source.doc.layers[0].objects[0];
  assert.equal(fixed.style.opacity, 1);
  assert.equal(fixed.style.stroke.width, 1.5);
  assert.deepEqual(fixed.style.fill, { type: 'none' });

  const brokenPath = {
    ...createPathObject(layer.id, DEFAULT_STYLE, [makeNode(0, 0)], false),
    nodes: [{ id: 'n1', x: 'oops', y: 0, handleIn: null, handleOut: null, type: 'corner' }]
  } as unknown as SceneObject;
  expectImportError(
    () =>
      validateImportContent({
        fileName: '坏节点.vdraw',
        content: serializeDocument({ ...doc, layers: [{ ...layer, objects: [brokenPath] }] })
      }),
    'invalid-layers'
  );
});

test('导入落点：新建使用新身份，覆盖保留当前文件身份，合并重映射 ID', () => {
  const current = createDocument('blank-landscape', '当前画布');
  const source = validateImportContent({
    fileName: '素材.vdraw',
    content: serializeDocument(importSampleDocument())
  });
  assert.equal(source.kind, 'document');
  if (source.kind !== 'document') return;

  const created = documentImportToNewDocument(source, '兜底名');
  assert.notEqual(created.id, source.doc.id);
  assert.equal(created.filePath, null);
  assert.equal(created.name, '素材');

  const replaced = documentImportToReplacement(current, source);
  assert.equal(replaced.id, current.id);
  assert.equal(replaced.name, current.name);
  assert.equal(replaced.filePath, current.filePath);
  assert.equal(replaced.layers.length, source.doc.layers.length);
  assert.deepEqual(replaced.page, source.doc.page);
  // 必须深拷贝：撤销快照不能与源数据共享引用。
  assert.notEqual(replaced.layers, source.doc.layers);

  const appended = documentImportToAppend(current, source);
  assert.equal(appended.layersAdded, 1);
  assert.equal(appended.objectsAdded, 2);
  assert.equal(appended.doc.layers.length, 2);
  const importedLayer = appended.doc.layers[1];
  assert.notEqual(importedLayer.id, source.doc.layers[0].id);
  const ids = appended.doc.layers.flatMap((layer) => layer.objects.map((object) => object.id));
  assert.equal(new Set(ids).size, ids.length, '合并后对象 ID 必须唯一');
  assert.equal(appended.doc.name, current.name);
});

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageSource(overrides: Partial<ImportedImageSource> = {}): ImportedImageSource {
  return {
    kind: 'image',
    format: 'png',
    fileName: 'logo.png',
    suggestedName: 'logo',
    dataUrl: PNG_DATA_URL,
    mime: 'image/png',
    warnings: [],
    stats: { width: 400, height: 200, bytes: 2048, format: 'png', mime: 'image/png' },
    ...overrides
  };
}

test('位图：按文件头识别格式，不信任扩展名', () => {
  assert.equal(
    detectRasterKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'png'
  );
  assert.equal(detectRasterKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(detectRasterKind(Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)))), 'gif');
  assert.equal(
    detectRasterKind(
      Uint8Array.from([
        ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
        0,
        0,
        0,
        0,
        ...'WEBP'.split('').map((c) => c.charCodeAt(0))
      ])
    ),
    'webp'
  );
  assert.equal(
    detectRasterKind(Uint8Array.from([...'BM'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    'bmp'
  );
  assert.equal(detectRasterKind(Uint8Array.from([0x49, 0x49, 0x2a, 0x00])), 'tiff');
  assert.equal(
    detectRasterKind(
      Uint8Array.from([
        0,
        0,
        0,
        0x20,
        ...'ftyp'.split('').map((c) => c.charCodeAt(0)),
        ...'avif'.split('').map((c) => c.charCodeAt(0))
      ])
    ),
    'avif'
  );
  assert.equal(detectRasterKind(Uint8Array.from([1, 2, 3, 4, 5])), null);
});

test('位图：头校验区分正常 / 扩展名不符 / 损坏 / 暂不支持', () => {
  const header = validateRasterHeader({
    fileName: 'logo.png',
    dataUrl: PNG_DATA_URL,
    bytes: 4096
  });
  assert.equal(header.format, 'png');
  assert.equal(header.mime, 'image/png');
  assert.equal(header.bytes, 4096);
  assert.equal(header.width, 1);
  assert.equal(header.height, 1);
  assert.deepEqual(header.warnings, []);

  // 声明 20000×20000 的 PNG 只有文件头也必须提前拒绝，不能等解码把内存打满。
  const hugeHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0x4e, 0x20, 0, 0, 0x4e, 0x20, 8, 8, 0, 0, 0, 0
  ]).toString('base64');
  expectImportError(
    () =>
      validateRasterHeader({
        fileName: '巨图.png',
        dataUrl: `data:image/png;base64,${hugeHeader}`
      }),
    'file-too-large'
  );

  const mismatch = validateRasterHeader({ fileName: 'logo.jpg', dataUrl: PNG_DATA_URL });
  assert.ok(mismatch.warnings.some((warning) => warning.includes('不一致')));

  expectImportError(
    () =>
      validateRasterHeader({
        fileName: '损坏.png',
        dataUrl: 'data:image/png;base64,aGVsbG8='
      }),
    'invalid-image'
  );
  expectImportError(
    () =>
      validateRasterHeader({
        fileName: '扫描件.tiff',
        dataUrl: 'data:image/tiff;base64,SUkqAA=='
      }),
    'unsupported-type'
  );
  expectImportError(
    () => validateRasterHeader({ fileName: '空.png', dataUrl: 'data:image/png;base64,' }),
    'empty-file'
  );
});

test('位图：保持原始尺寸居中，超出页面不缩放、不裁剪', () => {
  const natural = imagePlacement(400, 200, 1000, 1000);
  assert.equal(natural.scale, 1);
  assert.equal(natural.width, 400);
  assert.equal(natural.height, 200);
  assert.equal(natural.x, 300);
  assert.equal(natural.y, 400);
  assert.equal(natural.exceedsPage, false);

  const larger = imagePlacement(2000, 1000, 1000, 1000);
  assert.equal(larger.scale, 1);
  assert.equal(larger.width, 2000);
  assert.equal(larger.height, 1000);
  assert.equal(larger.x, -500);
  assert.equal(larger.y, 0);
  assert.equal(larger.exceedsPage, true);

  const offset = imagePlacement(400, 200, 1000, 1000, { x: 28, y: 28 });
  assert.equal(offset.x, 328);
  assert.equal(offset.y, 428);
});

test('位图：新建画布按像素尺寸建页，对象可选中并进入 SVG 导出', () => {
  const result = imageImportToNewDocument(imageSource(), '兜底');
  assert.equal(result.doc.page.width, 400);
  assert.equal(result.doc.page.height, 200);
  assert.equal(result.doc.name, 'logo');
  const image = result.objects[0] as ImageObject;
  assert.equal(image.type, 'image');
  assert.equal(image.width, 400);
  assert.equal(image.height, 200);
  assert.equal(image.naturalWidth, 400);
  assert.equal(image.imageFormat, 'png');
  assert.ok(hitTestObject(image, { x: 20, y: 20 }, 0));
  assert.ok(!hitTestObject(image, { x: 500, y: 20 }, 0));

  const svg = documentToSvgString(result.doc);
  assert.ok(svg.includes('<image'));
  assert.ok(svg.includes(PNG_DATA_URL));
});

test('位图：覆盖清空现有对象并居中，合并保留现有对象，锁定层拒绝写入', () => {
  const current = createDocument('blank-landscape', '当前');
  const layer = current.layers[0];
  const rect = createRectObject(layer.id, DEFAULT_STYLE, 0, 0, 10, 10);
  const withRect: VDrawDocument = {
    ...current,
    layers: [{ ...layer, objects: [rect] }]
  };

  const replaced = imageImportToReplacement(withRect, imageSource());
  assert.equal(replaced.doc.layers[0].objects.length, 1);
  const placed = replaced.objects[0] as ImageObject;
  assert.equal(placed.width, 400);
  assert.ok(Math.abs(placed.x - (current.page.width - 400) / 2) < 0.01);

  const appended = imageImportToAppend(withRect, imageSource());
  assert.equal(appended.doc.layers[0].objects.length, 2);
  assert.equal(appended.objects.length, 1);

  const locked: VDrawDocument = {
    ...withRect,
    layers: [{ ...layer, locked: true, objects: [rect] }]
  };
  expectImportError(() => imageImportToReplacement(locked, imageSource()), 'locked-layer');
});

test('位图：平移 / 缩放 / 旋转沿用通用变换', () => {
  const image = createImageObject(
    'layer',
    PNG_DATA_URL,
    400,
    200,
    { x: 10, y: 20, width: 200, height: 100 },
    'logo',
    'png'
  );
  const moved = translateObject(image, 5, -5);
  assert.equal(moved.x, 15);
  assert.equal(moved.y, 15);
  const scaled = scaleObject(image, { x: 0, y: 0 }, 2, 0.5);
  assert.equal(scaled.width, 400);
  assert.equal(scaled.height, 50);
  const rotated = rotateObject(image, { x: 110, y: 70 }, 90) as ImageObject;
  assert.equal(rotated.rotation, 90);
});

test('位图：.vdraw 保存后可完整还原，外部链接图片被拒绝', () => {
  const doc = imageImportToNewDocument(imageSource(), '兜底').doc;
  const imported = validateImportContent({
    fileName: '位图工程.vdraw',
    content: serializeDocument(doc)
  });
  assert.equal(imported.kind, 'document');
  if (imported.kind !== 'document') return;
  const image = imported.doc.layers[0].objects[0] as ImageObject;
  assert.equal(image.type, 'image');
  assert.equal(image.src, PNG_DATA_URL);
  assert.equal(image.naturalWidth, 400);

  const external = {
    ...doc,
    layers: [
      {
        ...doc.layers[0],
        objects: [{ ...image, src: 'https://example.com/logo.png' }]
      }
    ]
  } as VDrawDocument;
  expectImportError(
    () =>
      validateImportContent({
        fileName: '外链.vdraw',
        content: serializeDocument(external)
      }),
    'invalid-layers'
  );
});

test('批量导入：多文件写入新建图层，保持原始尺寸并可直接选中', () => {
  const current = createDocument('blank-landscape', '当前');
  const layer = current.layers[0];
  const rect = createRectObject(layer.id, DEFAULT_STYLE, 0, 0, 10, 10);
  const withRect: VDrawDocument = { ...current, layers: [{ ...layer, objects: [rect] }] };
  const first = imageSource({ fileName: 'a.png', suggestedName: 'a' });
  const second = imageSource({
    fileName: 'b.png',
    suggestedName: 'b',
    stats: { width: 200, height: 100, bytes: 1024, format: 'png', mime: 'image/png' }
  });

  const result = importSourcesToDocument(withRect, [first, second], 'layer');
  assert.equal(result.layersAdded, 2);
  assert.equal(result.objectsAdded, 2);
  assert.equal(result.doc.layers.length, withRect.layers.length + 2);
  assert.equal(result.doc.layers[0].objects.length, 1, '原有图层不受影响');
  const layerA = result.doc.layers[result.doc.layers.length - 2];
  const layerB = result.doc.layers[result.doc.layers.length - 1];
  assert.deepEqual([layerA.name, layerB.name], ['a', 'b']);
  const imageA = layerA.objects[0] as ImageObject;
  const imageB = layerB.objects[0] as ImageObject;
  assert.equal(imageA.width, 400);
  assert.equal(imageA.height, 200);
  assert.equal(imageB.width, 200);
  assert.equal(imageB.x, (withRect.page.width - 200) / 2 + 28);
  assert.equal(imageB.y, (withRect.page.height - 100) / 2 + 28);
  assert.equal(result.doc.activeLayerId, layerB.id);
  assert.deepEqual(result.selection, [imageA.id, imageB.id]);

  // 批量导入后可直接整体移动/缩放（选区跨两个新图层）。
  const moved = translateDocumentObjects(result.doc, result.selection, 10, 20);
  const movedA = moved.layers[moved.layers.length - 2].objects[0] as ImageObject;
  assert.equal(movedA.x, imageA.x + 10);
  assert.equal(movedA.y, imageA.y + 20);
  const scaled = scaleDocumentObjects(moved, result.selection, { x: 0, y: 0 }, 1.5, 1.5);
  const scaledA = scaled.layers[scaled.layers.length - 2].objects[0] as ImageObject;
  assert.equal(scaledA.width, 600);
  assert.equal(scaledA.height, 300);
});

test('批量导入：多文件写入当前图层，不新增图层；空批次与锁定层给出错误', () => {
  const current = createDocument('blank-landscape', '当前');
  const layer = current.layers[0];
  const rect = createRectObject(layer.id, DEFAULT_STYLE, 0, 0, 10, 10);
  const withRect: VDrawDocument = { ...current, layers: [{ ...layer, objects: [rect] }] };
  const sources = [
    imageSource({ fileName: 'a.png', suggestedName: 'a' }),
    imageSource({ fileName: 'b.png', suggestedName: 'b' })
  ];

  const result = importSourcesToDocument(withRect, sources, 'append');
  assert.equal(result.layersAdded, 0);
  assert.equal(result.doc.layers.length, withRect.layers.length);
  assert.equal(result.doc.layers[0].objects.length, 3);
  assert.equal(result.doc.activeLayerId, layer.id);
  assert.equal(result.selection.length, 2);

  expectImportError(() => importSourcesToDocument(withRect, [], 'layer'), 'empty-file');

  const locked: VDrawDocument = {
    ...withRect,
    layers: [{ ...layer, locked: true, objects: [rect] }]
  };
  expectImportError(() => importSourcesToDocument(locked, sources, 'append'), 'locked-layer');
  // 新建图层不依赖当前绘图层是否锁定。
  const toNewLayer = importSourcesToDocument(locked, [sources[0]], 'layer');
  assert.equal(toNewLayer.layersAdded, 1);
});

test('批量导入：工程文件摊平到单一新图层并重映射 ID', () => {
  const current = createDocument('blank-landscape', '当前');
  const source = validateImportContent({
    fileName: '素材.vdraw',
    content: serializeDocument(importSampleDocument())
  });
  assert.equal(source.kind, 'document');
  if (source.kind !== 'document') return;

  const result = importSourcesToDocument(current, [source], 'layer');
  assert.equal(result.layersAdded, 1);
  assert.equal(result.objectsAdded, source.stats.objects);
  const created = result.doc.layers[result.doc.layers.length - 1];
  assert.equal(created.name, '素材');
  assert.equal(created.objects.length, source.stats.objects);
  const sourceIds = new Set(source.doc.layers.flatMap((item) => item.objects.map((obj) => obj.id)));
  assert.ok(created.objects.every((object) => !sourceIds.has(object.id)));
  assert.ok(created.objects.every((object) => object.layerId === created.id));
  assert.equal(result.selection.length, 2, '两个顶层对象都应被选中');
});

test('批量导入：超大位图保持原始尺寸，不被自动缩小或裁剪', () => {
  const current = createDocument('blank-landscape', '当前');
  const huge = imageSource({
    fileName: '海报.png',
    suggestedName: '海报',
    stats: { width: 2000, height: 1200, bytes: 4096, format: 'png', mime: 'image/png' }
  });
  const result = importSourcesToDocument(current, [huge], 'append');
  const image = result.doc.layers[0].objects[0] as ImageObject;
  assert.equal(image.width, 2000);
  assert.equal(image.height, 1200);
  assert.equal(image.x, (current.page.width - 2000) / 2);
  assert.ok(result.warnings.some((warning) => warning.includes('不会自动裁剪')));
});

test('缩放：双键/三键间距与苯环内圈随缩放比例同步', () => {
  const doc = createDocument('blank-landscape', '缩放');
  const layer = doc.layers[0];

  const doubleBond = createBondObject(
    layer.id,
    DEFAULT_STYLE,
    { x: 100, y: 100 },
    { x: 140, y: 100 },
    'double'
  );
  const scaledDouble = scaleObject(doubleBond, { x: 120, y: 100 }, 2, 2) as typeof doubleBond;
  assert.equal(scaledDouble.scale, 2);
  const doubleDoc = { ...doc, layers: [{ ...layer, objects: [scaledDouble] }] };
  const doubleShape = chemBondShape(doubleDoc, scaledDouble);
  const doubleOffsets = doubleShape.geometry.segments.map((segment) => segment.y1 - 100);
  assert.equal(doubleOffsets.length, 2);
  // 单独双键：两条线对称分布，各自距键轴半个键距。
  assert.ok(doubleOffsets.some((offset) => Math.abs(offset - 4.2) < 0.01));
  assert.ok(doubleOffsets.some((offset) => Math.abs(offset + 4.2) < 0.01));

  const tripleBond = createBondObject(
    layer.id,
    DEFAULT_STYLE,
    { x: 200, y: 100 },
    { x: 240, y: 100 },
    'triple'
  );
  const scaledTriple = scaleObject(tripleBond, { x: 220, y: 100 }, 1.5, 1.5) as typeof tripleBond;
  const tripleDoc = { ...doc, layers: [{ ...layer, objects: [scaledTriple] }] };
  const tripleShape = chemBondShape(tripleDoc, scaledTriple);
  const tripleOffsets = tripleShape.geometry.segments
    .map((segment) => segment.y1 - 100)
    .sort((a, b) => a - b);
  // 单独三键：三条等长线，中间一条在键轴上。
  assert.equal(tripleOffsets.length, 3);
  assert.ok(Math.abs(tripleOffsets[0] + 6.3) < 0.01);
  assert.ok(Math.abs(tripleOffsets[1]) < 0.01);
  assert.ok(Math.abs(tripleOffsets[2] - 6.3) < 0.01);

  // 苯环编组：内圈半径与子键间距都跟随整体缩放。
  const ringGroup = {
    ...createGroupObject(layer.id, '苯环', { x: 300, y: 80, width: 80, height: 80 }, []),
    ringStyle: 'pauling' as const,
    ringScale: 1
  };
  const scaledGroup = scaleObject(ringGroup, { x: 340, y: 120 }, 2, 2) as GroupObject;
  assert.equal(scaledGroup.ringScale, 2);

  const childBond = createBondObject(
    layer.id,
    DEFAULT_STYLE,
    { x: 300, y: 120 },
    { x: 340, y: 120 },
    'double'
  );
  const parent = {
    ...createGroupObject(layer.id, '苯环', { x: 300, y: 100, width: 40, height: 40 }, [
      childBond.id
    ]),
    ringStyle: 'pauling' as const
  };
  const child = { ...childBond, parentId: parent.id, ringInnerSide: 1 as const };
  const groupedDoc = {
    ...doc,
    layers: [{ ...layer, objects: [parent, child] }]
  };
  const scaledGrouped = scaleDocumentObjects(
    groupedDoc,
    [parent.id],
    { x: 320, y: 120 },
    2,
    2
  );
  const scaledChild = scaledGrouped.layers[0].objects.find(
    (object) => object.id === childBond.id
  ) as typeof childBond;
  assert.equal(scaledChild.scale, 2);
  const childShape = chemBondShape(scaledGrouped, scaledChild);
  const childOffsets = childShape.geometry.segments
    .slice(1)
    .map((segment) => Math.abs(segment.y1 - 120));
  assert.ok(childOffsets.every((offset) => Math.abs(offset - 8.4) < 0.01));
});

test('拖拽成键：指针只决定规范键角侧别，落点不再随意摆放', () => {
  const layerId = 'layer';
  const doc = docOf([
    createBondObject(
      layerId,
      DEFAULT_STYLE,
      { x: 100, y: 200 },
      { x: 140, y: 200 },
      'single'
    )
  ]);
  const anchor = findBondAnchor(doc, { x: 140, y: 200 }, 3);
  assert.ok(anchor);
  if (!anchor) return;

  const up = nextChainBond(doc, anchor, { x: 30, y: 9 }, 1, 40);
  const down = nextChainBond(doc, anchor, { x: 30, y: -9 }, 1, 40);
  assert.ok(up && down);
  if (!up || !down) return;
  assert.ok(Math.abs(up.length - 40) < 0.001);
  // sp3 末端按 109.5° 键角展开，方向角即 180° - 109.5° = 70.5°。
  assert.ok(Math.abs(up.angle - 70.53) < 0.5, `下方分支方向应为 70.5°，实际 ${up.angle}`);
  assert.ok(
    Math.abs(down.angle - 289.47) < 0.5 || Math.abs(down.angle + 70.53) < 0.5,
    `上方分支方向应为 -70.5°，实际 ${down.angle}`
  );
  assert.ok(up.end.y > 200 && down.end.y < 200, '分支方向应贴合指针意图');
});

test('结构整理：规范环/链保持不变，歪斜结构按标准键长与键角重排', () => {
  const layerId = 'layer';
  const center = { x: 200, y: 200 };
  const ringPoints = Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index;
    return {
      x: center.x + Math.cos(angle) * 40,
      y: center.y + Math.sin(angle) * 40
    };
  });
  const regularRingBonds = ringPoints.map((point, index) =>
    createBondObject(layerId, DEFAULT_STYLE, point, ringPoints[(index + 1) % 6], 'single')
  );
  const regularRing = docOf(regularRingBonds);
  const regularRingResult = cleanupStructure(regularRing);
  assert.equal(regularRingResult.structures, 1);
  assert.equal(regularRingResult.moved, 0);
  assert.equal(regularRingResult.changed, 0);
  assert.equal(regularRingResult.doc, regularRing, '规范苯环不应被改写');

  const zigzag = [
    { x: 100, y: 400 },
    { x: 134.64, y: 420 },
    { x: 169.28, y: 400 },
    { x: 203.92, y: 420 }
  ];
  const regularChainBonds = zigzag
    .slice(0, -1)
    .map((point, index) =>
      createBondObject(layerId, DEFAULT_STYLE, point, zigzag[index + 1], 'single')
    );
  const regularChainResult = cleanupStructure(docOf(regularChainBonds));
  assert.equal(regularChainResult.moved, 0);
  assert.equal(regularChainResult.changed, 0);

  const distortedRingPoints = ringPoints.map((point, index) =>
    index === 0 ? { x: point.x + 18, y: point.y - 9 } : point
  );
  const distortedRingBonds = distortedRingPoints.map((point, index) =>
    createBondObject(
      layerId,
      DEFAULT_STYLE,
      point,
      distortedRingPoints[(index + 1) % 6],
      'single'
    )
  );
  const distortedRingResult = cleanupStructure(docOf(distortedRingBonds));
  assert.equal(distortedRingResult.structures, 1);
  assert.equal(distortedRingResult.changed, 1);
  assert.ok(distortedRingResult.moved >= 4);
  const fixedRing = distortedRingResult.doc.layers[0].objects.filter(
    (object): object is BondObject => object.type === 'bond'
  );
  for (const bond of fixedRing) {
    const length = Math.hypot(bond.end.x - bond.start.x, bond.end.y - bond.start.y);
    assert.ok(Math.abs(length - 40) < 0.6, `环键应回到 40px，实际 ${length}`);
  }
  const fixedCenter = fixedRing.reduce(
    (acc, bond) => ({
      x: acc.x + (bond.start.x + bond.end.x) / 12,
      y: acc.y + (bond.start.y + bond.end.y) / 12
    }),
    { x: 0, y: 0 }
  );
  const originalCenter = distortedRingPoints.reduce(
    (acc, point) => ({ x: acc.x + point.x / 6, y: acc.y + point.y / 6 }),
    { x: 0, y: 0 }
  );
  assert.ok(
    Math.hypot(fixedCenter.x - originalCenter.x, fixedCenter.y - originalCenter.y) < 0.8,
    `center=${fixedCenter.x},${fixedCenter.y} original=${originalCenter.x},${originalCenter.y}`
  );

  const distortedChain = [
    { x: 300, y: 400 },
    { x: 340, y: 405 },
    { x: 378, y: 428 },
    { x: 416, y: 430 }
  ];
  const chainBonds = distortedChain
    .slice(0, -1)
    .map((point, index) =>
      createBondObject(layerId, DEFAULT_STYLE, point, distortedChain[index + 1], 'single')
    );
  const chainResult = cleanupStructure(docOf(chainBonds));
  assert.equal(chainResult.changed, 1);
  const fixedChain = chainResult.doc.layers[0].objects.filter(
    (object): object is BondObject => object.type === 'bond'
  );
  const lengths = fixedChain.map((bond) =>
    Math.hypot(bond.end.x - bond.start.x, bond.end.y - bond.start.y)
  );
  lengths.forEach((length) => assert.ok(Math.abs(length - 40) < 0.6));
  // 中间节点键角应为 120°，链端方向与整体位置保持。
  for (const index of [1, 2]) {
    const previous = fixedChain[index - 1];
    const next = fixedChain[index];
    const vertex = next.start;
    const first = previous.start.x === vertex.x && previous.start.y === vertex.y
      ? previous.end
      : previous.start;
    const second = next.end;
    const a = { x: first.x - vertex.x, y: first.y - vertex.y };
    const b = { x: second.x - vertex.x, y: second.y - vertex.y };
    const angle =
      Math.acos(
        Math.max(
          -1,
          Math.min(1, (a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)))
        )
      ) *
      (180 / Math.PI);
    assert.ok(Math.abs(angle - 120) < 1.5, `链键角应接近 120°，实际 ${angle}`);
  }
});

test('结构整理：多个独立结构不冲突，规范结构全部保持原样', () => {
  const layerId = 'layer';
  const first = createBondObject(layerId, DEFAULT_STYLE, { x: 100, y: 100 }, { x: 140, y: 100 }, 'single');
  const second = createBondObject(layerId, DEFAULT_STYLE, { x: 300, y: 100 }, { x: 340, y: 120 }, 'single');
  const doc = docOf([first, second]);
  const result = cleanupStructure(doc);
  assert.equal(result.structures, 2);
  assert.equal(result.moved, 0);
  assert.equal(result.doc, doc);
});

test('结构整理：锁定图层不参与，稠环内圈圆心随骨架同步', () => {
  const doc = createDocument('blank-landscape', '锁定');
  const layer = doc.layers[0];
  const center = { x: 200, y: 200 };
  const points = Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * (index + 0.35);
    return {
      x: center.x + Math.cos(angle) * (index === 0 ? 52 : 40),
      y: center.y + Math.sin(angle) * (index === 0 ? 52 : 40)
    };
  });
  const bonds = points.map((point, index) =>
    createBondObject(layer.id, DEFAULT_STYLE, point, points[(index + 1) % 6], 'single')
  );
  const ringCenter = points.reduce(
    (acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }),
    { x: 0, y: 0 }
  );
  const group = {
    ...createGroupObject(layer.id, '苯环', { x: 0, y: 0, width: 100, height: 100 }, bonds.map((bond) => bond.id)),
    ringCenters: [ringCenter],
    ringCircleStyle: 'pauling' as const
  };
  const grouped = { ...doc, layers: [{ ...layer, objects: [group, ...bonds] }] };
  const result = cleanupStructure(grouped);
  assert.equal(result.changed, 1);
  const fixedGroup = result.doc.layers[0].objects.find(
    (object): object is GroupObject => object.type === 'group'
  );
  assert.ok(fixedGroup?.ringCenters && fixedGroup.ringCenters.length === 1);
  const fixedCenter = fixedGroup!.ringCenters![0];
  const fixedBonds = result.doc.layers[0].objects.filter(
    (object): object is BondObject => object.type === 'bond'
  );
  const expectedCenter = fixedBonds.reduce(
    (acc, bond) => ({
      x: acc.x + (bond.start.x + bond.end.x) / (fixedBonds.length * 2),
      y: acc.y + (bond.start.y + bond.end.y) / (fixedBonds.length * 2)
    }),
    { x: 0, y: 0 }
  );
  assert.ok(Math.hypot(fixedCenter.x - expectedCenter.x, fixedCenter.y - expectedCenter.y) < 1);

  const locked = {
    ...grouped,
    layers: [{ ...grouped.layers[0], locked: true }]
  };
  const lockedResult = cleanupStructure(locked);
  assert.equal(lockedResult.structures, 0);
  assert.equal(lockedResult.moved, 0);
  assert.equal(lockedResult.doc, locked);
});

test('化学参数：自定义键距进入渲染，缩放后的结构可推导继承比例', () => {
  const doc = createDocument('blank-landscape', '化学参数');
  const layer = doc.layers[0];
  const bond = {
    ...createBondObject(
      layer.id,
      DEFAULT_STYLE,
      { x: 100, y: 100 },
      { x: 180, y: 100 },
      'double'
    ),
    scale: 2,
    spacing: 6
  };
  const bondDoc = { ...doc, layers: [{ ...layer, objects: [bond] }] };
  const shape = chemBondShape(bondDoc, bond);
  const offsets = shape.geometry.segments.map((segment) => segment.y1 - 100);
  assert.equal(offsets.length, 2);
  assert.ok(offsets.some((offset) => Math.abs(offset - 6) < 0.01));
  assert.ok(offsets.some((offset) => Math.abs(offset + 6) < 0.01));

  // 已缩放链：相连键的 scale 与原子字号都能告诉新增对象该继承多少。
  const atom = {
    ...createAtomObject(layer.id, DEFAULT_STYLE, { x: 180, y: 100 }, {
      ...emptyAtomLabel('C'),
      fontSize: 32
    })
  };
  const chainDoc = { ...doc, layers: [{ ...layer, objects: [bond, atom] }] };
  const anchor = findBondAnchor(chainDoc, { x: 180, y: 100 }, 3);
  assert.ok(anchor);
  if (!anchor) return;
  assert.equal(bondAnchorScale(anchor), 2);

  const scaledBondOnly = { ...bond, parentId: null };
  const group = {
    ...createGroupObject(layer.id, '苯环', { x: 0, y: 0, width: 80, height: 40 }, [
      scaledBondOnly.id
    ]),
    ringStyle: 'pauling' as const,
    ringScale: 2
  };
  const bondInGroup = { ...scaledBondOnly, parentId: group.id };
  const groupDoc = {
    ...doc,
    layers: [{ ...layer, objects: [group, bondInGroup] }]
  };
  const groupAnchor = findBondAnchor(groupDoc, { x: 100, y: 100 }, 3);
  assert.ok(groupAnchor);
  if (!groupAnchor) return;
  assert.equal(groupAnchor.group?.id, group.id);
  assert.equal(bondAnchorScale(groupAnchor), 2);

  // 孤立原子按字号推导比例；显式传入当前默认字号时，不把默认值变化误判成缩放。
  const atomOnly = {
    ...createAtomObject(layer.id, DEFAULT_STYLE, { x: 260, y: 100 }, {
      ...emptyAtomLabel('C'),
      fontSize: 32
    })
  };
  const atomOnlyDoc = { ...doc, layers: [{ ...layer, objects: [atomOnly] }] };
  const atomOnlyAnchor = findBondAnchor(atomOnlyDoc, { x: 260, y: 100 }, 3);
  assert.ok(atomOnlyAnchor);
  if (!atomOnlyAnchor) return;
  assert.equal(bondAnchorScale(atomOnlyAnchor), 2);
  assert.equal(bondAnchorScale(atomOnlyAnchor, 32), 1);

  // SVG 导出必须使用原子实际字号，而不是写死默认字号。
  const atomSvg = documentToSvgString(atomOnlyDoc, { includeBackground: false });
  assert.match(atomSvg, /font-size="32"/);
});

test('键型几何：单独双键/三键等长，环内双键保留内缩线', () => {
  const double = buildBondGeometry('double', { x: 0, y: 0 }, { x: 100, y: 0 }, { spacing: 8 });
  assert.equal(double.segments.length, 2);
  const doubleLengths = double.segments.map((segment) =>
    Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
  );
  assert.ok(doubleLengths.every((length) => Math.abs(length - 100) < 0.01));
  const doubleOffsets = double.segments.map((segment) => segment.y1).sort((a, b) => a - b);
  assert.ok(Math.abs(doubleOffsets[0] + 4) < 0.01);
  assert.ok(Math.abs(doubleOffsets[1] - 4) < 0.01);

  const triple = buildBondGeometry('triple', { x: 0, y: 0 }, { x: 100, y: 0 }, { spacing: 8 });
  assert.equal(triple.segments.length, 3);
  const tripleLengths = triple.segments.map((segment) =>
    Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
  );
  assert.ok(tripleLengths.every((length) => Math.abs(length - 100) < 0.01));
  const tripleOffsets = triple.segments.map((segment) => segment.y1).sort((a, b) => a - b);
  assert.ok(Math.abs(tripleOffsets[0] + 8) < 0.01);
  assert.ok(Math.abs(tripleOffsets[1]) < 0.01);
  assert.ok(Math.abs(tripleOffsets[2] - 8) < 0.01);

  // 环内双键必须保留“完整外线 + 内缩内线”，不能套用单独双键的对称等长线。
  const ring = buildBondGeometry(
    'double',
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { spacing: 8, innerSide: 1 }
  );
  assert.equal(ring.segments.length, 2);
  const outerLength = Math.hypot(
    ring.segments[0].x2 - ring.segments[0].x1,
    ring.segments[0].y2 - ring.segments[0].y1
  );
  const innerLength = Math.hypot(
    ring.segments[1].x2 - ring.segments[1].x1,
    ring.segments[1].y2 - ring.segments[1].y1
  );
  assert.ok(innerLength < outerLength - 1);
  assert.ok(Math.abs(Math.abs(ring.segments[1].y1) - 8) < 0.01);
});

test('键型几何：平行线遇到元素标签时逐线止于标签边缘', () => {
  const doc = createDocument('blank-landscape', '标签裁切');
  const layer = doc.layers[0];
  const oxygen = createAtomObject(layer.id, DEFAULT_STYLE, { x: 100, y: 0 }, {
    ...emptyAtomLabel('O'),
    fontSize: 20
  });

  for (const type of ['double', 'triple'] as const) {
    const bond = createBondObject(
      layer.id,
      DEFAULT_STYLE,
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      type
    );
    const layout = atomLabelLayout(oxygen, [bond]);
    assert.equal(layout.terminal, true);
    assert.ok(layout.dx > 0, '端基标签应沿键轴向外展开');
    const bondDoc = { ...doc, layers: [{ ...layer, objects: [bond, oxygen] }] };
    const shape = chemBondShape(bondDoc, bond);
    assert.equal(shape.geometry.segments.length, type === 'double' ? 2 : 3);
    for (const segment of shape.geometry.segments) {
      // 起点无标签，应严格落在键端；终点应停在标签近端固定间隙处。
      assert.ok(Math.abs(segment.x1) < 0.01, `${type} 起点偏移 ${segment.x1}`);
      const distanceToO = Math.hypot(segment.x2 - 100, segment.y2);
      assert.ok(
        Math.abs(distanceToO - ATOM_LABEL_GAP) < 0.05,
        `${type} 终点距 O ${distanceToO.toFixed(3)}，应让出 ${ATOM_LABEL_GAP}px`
      );
    }
  }
});

test('成盐：Na/Ca 替换羟基氢，阳离子沿原 H 方向对齐', () => {
  const doc = createDocument('blank-landscape', '成盐');
  const layer = doc.layers[0];
  const oxygen = createAtomObject(layer.id, DEFAULT_STYLE, { x: 0, y: 0 }, {
    ...emptyAtomLabel('O'),
    group: 'OH',
    fontSize: 20
  });

  const sodium = planAcidicSalt(oxygen, 'Na', { x: 0, y: 100 }, 40, 'axial', 80);
  assert.ok(sodium);
  if (!sodium) return;
  assert.equal(sodium.acidLabel.element, 'O');
  assert.equal(sodium.acidLabel.group, null);
  assert.equal(sodium.acidLabel.charge, -1);
  assert.equal(sodium.cation.element, 'Na');
  assert.equal(sodium.cation.charge, 1);
  assert.ok(Math.abs(sodium.cation.position.x) < 0.001, '阳离子不能横向错位');
  assert.ok(sodium.cation.position.y < 0, '阳离子应落在原 H 方向');
  assert.ok(
    Math.hypot(sodium.cation.position.x, sodium.cation.position.y) >= 40 - 0.001,
    '阳离子与 O 至少相隔一个键长'
  );

  const calcium = planAcidicSalt(oxygen, 'Ca', { x: 0, y: 100 }, 40, 'axial', 80);
  assert.ok(calcium);
  if (!calcium) return;
  assert.equal(calcium.cation.charge, 2);

  assert.equal(planAcidicSalt(oxygen, 'Al', { x: 0, y: 100 }, 40), null, '铝不按碱金属成盐');
  const ketone = { ...oxygen, label: { ...oxygen.label, group: null } };
  assert.equal(planAcidicSalt(ketone, 'Na', { x: 0, y: 100 }, 40), null);

  const hit = acidicGroupAtomAt([oxygen], [], { x: 12, y: 0 });
  assert.equal(hit?.id, oxygen.id);
});

test('元素库：钠/钙可选，金属价态按阳离子计', () => {
  for (const element of ['Li', 'Na', 'K', 'Mg', 'Ca', 'Al']) {
    assert.ok(
      ATOM_PRESETS.some((preset) => preset.kind === 'element' && preset.element === element),
      `元素库缺少 ${element}`
    );
  }
  assert.equal(maxValenceFor('Na', 0), 1);
  assert.equal(maxValenceFor('Na', 1), 0);
  assert.equal(maxValenceFor('K', 1), 0);
  assert.equal(maxValenceFor('Ca', 0), 2);
  assert.equal(maxValenceFor('Ca', 2), 0);
  assert.equal(maxValenceFor('Mg', 2), 0);
});

test('环内键级切换：只有 ringFrame 编组内的键才带朝心侧别', () => {
  const doc = createDocument('blank-landscape', '环内键');
  const layer = doc.layers[0];
  const ringGroup = {
    ...createGroupObject(layer.id, '环', { x: 0, y: 0, width: 160, height: 160 }, []),
    ringFrame: true
  };
  const ringBond = {
    ...createBondObject(
      layer.id,
      DEFAULT_STYLE,
      { x: 40, y: 40 },
      { x: 120, y: 40 },
      'double'
    ),
    parentId: ringGroup.id
  };
  const ringDoc = { ...doc, layers: [{ ...layer, objects: [ringGroup, ringBond] }] };
  const side = ringBondInnerSide(ringDoc, ringBond);
  assert.ok(side === 1 || side === -1);

  const standalone = createBondObject(
    layer.id,
    DEFAULT_STYLE,
    { x: 40, y: 200 },
    { x: 120, y: 200 },
    'double'
  );
  assert.equal(ringBondInnerSide(ringDoc, standalone), null);
});

test('选中框：原子/官能团的包围盒完整覆盖字号与电荷上标', () => {
  const doc = createDocument('blank-landscape', '选中框');
  const layer = doc.layers[0];
  const hydroxyl = createAtomObject(layer.id, DEFAULT_STYLE, { x: 100, y: 100 }, {
    ...emptyAtomLabel('O'),
    group: 'OH',
    fontSize: 55
  });
  const bounds = getObjectBounds(hydroxyl);
  assert.ok(bounds.height >= 55, `高度 ${bounds.height} 未覆盖55px字号`);
  assert.ok(bounds.width >= 72, `宽度 ${bounds.width} 未覆盖 OH 标签`);

  const anion = createAtomObject(layer.id, DEFAULT_STYLE, { x: 200, y: 100 }, {
    ...emptyAtomLabel('O'),
    charge: -1,
    fontSize: 55
  });
  const plain = { ...anion, label: { ...anion.label, charge: 0 } };
  assert.ok(
    getObjectBounds(anion).width > getObjectBounds(plain).width,
    '电荷上标应计入选中框宽度'
  );
});

test('隐藏电荷：SVG 导出与画布设置一致', () => {
  const doc = createDocument('blank-landscape', '隐藏电荷');
  const layer = doc.layers[0];
  const anion = createAtomObject(layer.id, DEFAULT_STYLE, { x: 100, y: 100 }, {
    ...emptyAtomLabel('O'),
    charge: -1,
    fontSize: 20
  });
  const docWith = { ...doc, layers: [{ ...layer, objects: [anion] }] };
  const visible = documentToSvgString(docWith, { includeBackground: false });
  const hidden = documentToSvgString(docWith, {
    includeBackground: false,
    hideCharges: true
  });
  assert.ok(visible.includes('−'), '默认应输出负电荷');
  assert.ok(!hidden.includes('−'), '隐藏后不应输出负电荷');
});

test('成盐摆位：右侧模式让金属与 O 水平对齐', () => {
  const doc = createDocument('blank-landscape', '成盐摆位');
  const layer = doc.layers[0];
  const oxygen = createAtomObject(layer.id, DEFAULT_STYLE, { x: 0, y: 0 }, {
    ...emptyAtomLabel('O'),
    group: 'OH',
    fontSize: 20
  });
  const axial = planAcidicSalt(oxygen, 'Na', { x: 0, y: 100 }, 40, 'axial', 80);
  assert.ok(axial);
  if (!axial) return;
  assert.ok(Math.abs(axial.cation.position.x) < 0.001);
  assert.ok(axial.cation.position.y < 0);

  const right = planAcidicSalt(oxygen, 'Na', { x: 0, y: 100 }, 40, 'right', 80);
  assert.ok(right);
  if (!right) return;
  assert.ok(right.cation.position.x > right.attach.x, '右侧模式应在 O 的右边');
  assert.ok(
    Math.abs(right.cation.position.y - right.attach.y) < 0.001,
    '右侧模式应与 O 字形中心水平对齐'
  );
});

test('成盐摆位：左侧羟基自动把侧向金属放到左边', () => {
  const doc = createDocument('blank-landscape', '左侧成盐');
  const layer = doc.layers[0];
  const oxygen = createAtomObject(layer.id, DEFAULT_STYLE, { x: 0, y: 0 }, {
    ...emptyAtomLabel('O'),
    group: 'OH',
    fontSize: 20
  });
  // 邻居在右侧 = 羟基在苯环左侧。
  const left = planAcidicSalt(oxygen, 'Na', { x: 100, y: 0 }, 40, 'right', 80);
  assert.ok(left);
  if (!left) return;
  assert.ok(left.cation.position.x < 0, '左侧羟基的金属应放在左边');
  assert.ok(Math.abs(left.cation.position.y) < 0.001);

  // 邻居在下方 = 羟基在上侧，金属仍在右边。
  const top = planAcidicSalt(oxygen, 'Na', { x: 0, y: 100 }, 40, 'right', 80);
  assert.ok(top);
  if (!top) return;
  assert.ok(top.cation.position.x > 0);
});

test('成盐距离：可手动放大金属与酸根的最小距离', () => {
  const doc = createDocument('blank-landscape', '成盐距离');
  const layer = doc.layers[0];
  const oxygen = createAtomObject(layer.id, DEFAULT_STYLE, { x: 0, y: 0 }, {
    ...emptyAtomLabel('O'),
    group: 'OH',
    fontSize: 20
  });
  const plan = planAcidicSalt(oxygen, 'Na', { x: 0, y: 100 }, 40, 'axial', 140);
  assert.ok(plan);
  if (!plan) return;
  const distance = Math.hypot(
    plan.cation.position.x - plan.attach.x,
    plan.cation.position.y - plan.attach.y
  );
  assert.ok(Math.abs(distance - 140) < 0.01, `实际距离 ${distance}`);
});

test('成盐：COOH / SO₃H 也能脱氢上钠', () => {
  const doc = createDocument('blank-landscape', '酸性官能团');
  const layer = doc.layers[0];
  const carboxyl = createAtomObject(layer.id, DEFAULT_STYLE, { x: 0, y: 0 }, {
    ...emptyAtomLabel('C'),
    group: 'COOH',
    fontSize: 20
  });
  const carboxylPlan = planAcidicSalt(carboxyl, 'Na', { x: -40, y: 0 }, 40, 'right');
  assert.ok(carboxylPlan);
  if (!carboxylPlan) return;
  assert.equal(carboxylPlan.acidLabel.group, 'COO');
  assert.equal(carboxylPlan.acidLabel.charge, -1);

  const sulfonic = createAtomObject(layer.id, DEFAULT_STYLE, { x: 200, y: 0 }, {
    ...emptyAtomLabel('S'),
    group: 'SO₃H',
    fontSize: 20
  });
  const sulfonicPlan = planAcidicSalt(sulfonic, 'Ca', { x: 160, y: 0 }, 40, 'right');
  assert.ok(sulfonicPlan);
  if (!sulfonicPlan) return;
  assert.equal(sulfonicPlan.acidLabel.group, 'SO₃');
  assert.equal(sulfonicPlan.cation.charge, 2);
});

test('官能团键长：宽标签端基按固定间隙裁键，不再被压得过短', () => {
  const doc = createDocument('blank-landscape', '官能团键长');
  const layer = doc.layers[0];
  const carboxyl = createAtomObject(layer.id, DEFAULT_STYLE, { x: 100, y: 0 }, {
    ...emptyAtomLabel('C'),
    group: 'COOH',
    fontSize: 20
  });
  const bond = createBondObject(
    layer.id,
    DEFAULT_STYLE,
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    'single'
  );
  const layout = atomLabelLayout(carboxyl, [bond]);
  assert.equal(layout.terminal, true);
  assert.ok(layout.dx > 20, 'COOH 标签应沿键轴向外展开');
  const bondDoc = { ...doc, layers: [{ ...layer, objects: [bond, carboxyl] }] };
  const shape = chemBondShape(bondDoc, bond);
  const visible = Math.hypot(
    shape.geometry.segments[0].x2 - shape.geometry.segments[0].x1,
    shape.geometry.segments[0].y2 - shape.geometry.segments[0].y1
  );
  assert.ok(
    visible > 90,
    `COOH 端基键可见长度 ${visible.toFixed(2)}，不应被标签宽度压短`
  );
});

test('成盐距离为 0：Na 与连接 O 的字形中心重叠', () => {
  const doc = createDocument('blank-landscape', '重叠成盐');
  const layer = doc.layers[0];
  const oxygen = createAtomObject(layer.id, DEFAULT_STYLE, { x: 0, y: 0 }, {
    ...emptyAtomLabel('O'),
    group: 'OH',
    fontSize: 20
  });
  const plan = planAcidicSalt(oxygen, 'Na', { x: 0, y: 100 }, 40, 'right', 0);
  assert.ok(plan);
  if (!plan) return;
  assert.equal(plan.cation.position.x, plan.attach.x);
  assert.equal(plan.cation.position.y, plan.attach.y);
});

test('KingDraw 式标签锚点：左置官能团翻转且连接原子贴近键', () => {
  assert.equal(flipGroupText('COOH'), 'HOOC');
  assert.equal(flipGroupText('OH'), 'HO');
  assert.equal(flipGroupText('SO₃H'), 'HO₃S');

  const doc = createDocument('blank-landscape', '标签锚点');
  const layer = doc.layers[0];
  const carboxyl = createAtomObject(layer.id, DEFAULT_STYLE, { x: 0, y: 0 }, {
    ...emptyAtomLabel('C'),
    group: 'COOH',
    fontSize: 20
  });
  const layout = atomLabelLayout(carboxyl, [
    {
      ...createBondObject(layer.id, DEFAULT_STYLE, { x: 100, y: 0 }, { x: 0, y: 0 }, 'single')
    }
  ]);
  assert.equal(layout.flip, true);
  assert.ok(layout.dx < 0, '左置标签应整体位于键的左侧');
  assert.equal(atomParts(carboxyl, false, layout.flip).main, 'HOOC');
  assert.ok(layout.attach.x < 0, '连接原子 C 应在原子位置左侧靠近键');
});
