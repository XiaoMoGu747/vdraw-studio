import assert from 'node:assert/strict';
import test from 'node:test';
import { pressureScale, strokeWidths, taperLengthFor } from '../src/core/brush';
import { GRAIN_PATH_BUDGET, brushMaterialLayers } from '../src/core/brushMaterial';
import { prevBondOrderType } from '../src/core/chemistry/chain';
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
  createLineObject,
  createPathObject,
  createRectObject,
  emptyAtomLabel,
  makeNode
} from '../src/core/factory';
import { grainBudgetIds } from '../src/core/grainBudget';
import { regionWidthForOutputWidth, safeRasterScale } from '../src/core/io/raster';
import { exportMol, exportSmiles } from '../src/core/io/chemExport';
import { documentToSvgString } from '../src/core/io/svg';
import { rotateObject, scaleObject, translateObject } from '../src/core/scene';
import { useAppStore } from '../src/store/useAppStore';
import type {
  GroupObject,
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
