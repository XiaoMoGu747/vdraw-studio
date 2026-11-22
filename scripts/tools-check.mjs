import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 其余工具的最小回归基线：区域填充的掩码/轮廓、闭合路径内部命中、镜像标记与重新生成。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const entry = `
import { floodRegionMask, maskToRegion, loopArea } from './src/core/regionFill.ts';
import { mirrorObject, regenerateMirrors } from './src/core/symmetry.ts';
import { findFillTarget, hitTestObject, scalePaintFactor, scaleDocumentObjects, scaleDocumentObjectsInFrame } from './src/core/scene.ts';
import { createDocument } from './src/core/document.ts';
import { createAtomObject, createBondObject, createGroupObject, createPathObject, createRectObject, createTextObject, emptyAtomLabel, makeNode } from './src/core/factory.ts';
import { DEFAULT_STYLE } from './src/core/document.ts';
import { nibFromTilt, stampAlpha } from './src/core/nib.ts';
import { brushOutlineData, flattenNodes, pressureScale } from './src/core/brush.ts';
import { brushMaterialLayers, clearBrushMaterialCache, brushMaterialCacheStats, hasBrushMaterial, GRAIN_PATH_BUDGET } from './src/core/brushMaterial.ts';
import { grainBudgetIds } from './src/core/grainBudget.ts';
import { chemistryPreviewIds } from './src/core/chemistry/preview.ts';
import { DAB_BUCKET_ALPHAS, generateStampDabs, dabBucket, dabPath } from './src/core/stamp.ts';
import { findStrokeSelfIntersection, findStrokeSelfIntersections, splitStrokeAtSelfIntersection } from './src/core/brushSplit.ts';
import { viewRectForViewport, objectInView } from './src/core/viewport.ts';
import { documentToSvgString } from './src/core/io/svg.ts';
import { parseDocumentFile, serializeDocument } from './src/core/io/serialize.ts';
import { mergeBrushPresets, parseBrushLibrary, serializeBrushLibrary } from './src/core/io/brushLibrary.ts';
import { guideRayDirections, equalGridOffsets } from './src/core/guideSnap.ts';
import { parseTextScripts } from './src/core/textRuns.ts';
import { solveHomography, applyHomography } from './src/core/homography.ts';
import { canClip, clipPathDef } from './src/core/clipShapes.ts';
import { quadOfBounds, perspectiveQuad, warpSelection } from './src/core/perspectiveWarp.ts';

const fail = (message) => {
  console.error('FAIL ' + message);
  process.exitCode = 1;
};
const ok = (message) => console.log('  ok ' + message);

// 1) 连通填充：30×30 中间一堵墙，点到左侧只能填左半区
const width = 30;
const height = 30;
const blocked = new Uint8Array(width * height);
for (let y = 0; y < height; y += 1) {
  blocked[y * width + 0] = 1;
  blocked[y * width + (width - 1)] = 1;
  blocked[y * width + 15] = 1;
}
for (let x = 0; x < width; x += 1) {
  blocked[x] = 1;
  blocked[(height - 1) * width + x] = 1;
}
const left = floodRegionMask(blocked, width, height, { x: 5, y: 5 });
const right = floodRegionMask(blocked, width, height, { x: 20, y: 5 });
if (!left || !right) {
  fail('floodRegionMask 返回 null');
} else {
  const count = (mask) => mask.reduce((sum, value) => sum + value, 0);
  const leftCount = count(left);
  const rightCount = count(right);
  // 左区 14×28=392、右区 13×28=364；允许 ±5 的边界误差。
  if (leftCount < 380 || leftCount > 400) fail('左侧区域面积异常: ' + leftCount);
  else ok('左侧连通区域面积 ' + leftCount);
  if (rightCount < 350 || rightCount > 375) fail('右侧区域面积异常: ' + rightCount);
  else ok('右侧连通区域面积 ' + rightCount);
}

// 2) 轮廓追踪 + 简化：整块矩形应得到 1 个环，面积接近掩码面积
const solid = new Uint8Array(width * height);
for (let y = 4; y < 24; y += 1) {
  for (let x = 4; x < 24; x += 1) solid[y * width + x] = 1;
}
const region = maskToRegion(solid, width, height, 1);
if (!region) fail('maskToRegion 未返回轮廓');
else {
  if (region.holes.length !== 0) fail('实心区域不应有孔洞');
  else ok('实心区域无孔洞');
  const area = Math.abs(loopArea(region.outline));
  if (area < 300 || area > 420) fail('轮廓面积异常: ' + area);
  else ok('轮廓面积 ' + Math.round(area));
}

// 3) 岛屿：中间挖空后应产生 1 个孔洞，且绕序与轮廓相反
const island = new Uint8Array(solid);
for (let y = 12; y < 18; y += 1) {
  for (let x = 12; x < 18; x += 1) island[y * width + x] = 0;
}
const withHole = maskToRegion(island, width, height, 1);
if (!withHole) fail('带岛屿的区域未返回轮廓');
else if (withHole.holes.length !== 1) fail('孔洞数量异常: ' + withHole.holes.length);
else {
  const outlineSign = Math.sign(loopArea(withHole.outline));
  const holeSign = Math.sign(loopArea(withHole.holes[0]));
  if (outlineSign === holeSign) fail('孔洞绕序未反转');
  else ok('孔洞绕序已反转（nonzero 可挖空）');
}

// 4) 未填充闭合路径：点击内部应命中（油漆桶）
const doc = createDocument('blank-landscape', 'check');
const layer = doc.layers[0];

// 4a) 统一缩放语义：几何按 sx/sy，笔画类尺寸按统一因子，描边宽保持不变
const scalePath = createPathObject(
  layer.id,
  DEFAULT_STYLE,
  [
    { ...makeNode(0, 0), width: 10 },
    { ...makeNode(100, 0), width: 10 }
  ],
  false
);
const scaleText = createTextObject(layer.id, DEFAULT_STYLE, { x: 0, y: 0 }, 'A', 20);
const scaleRect = createRectObject(layer.id, DEFAULT_STYLE, 0, 0, 40, 30);
const scaleDoc = {
  ...doc,
  layers: [{ ...layer, objects: [scalePath, scaleText, scaleRect] }]
};
const paintFactor = scalePaintFactor(2, 1);
if (Math.abs(paintFactor - 1.5) > 1e-9) fail('缩放因子口径异常: ' + paintFactor);
else ok('缩放因子 (|sx|+|sy|)/2 = ' + paintFactor);
const scaledIds = [scalePath.id, scaleText.id, scaleRect.id];
const plain = scaleDocumentObjects(scaleDoc, scaledIds, { x: 0, y: 0 }, 2, 1);
const plainPath = plain.layers[0].objects[0];
const plainText = plain.layers[0].objects[1];
const plainRect = plain.layers[0].objects[2];
if (plainPath.type !== 'path' || Math.abs(plainPath.nodes[0].width - 15) > 1e-6) {
  fail('无旋转框未缩放笔迹节点宽度');
} else if (plainText.type !== 'text' || Math.abs(plainText.fontSize - 30) > 1e-6) {
  fail('无旋转框未缩放字号');
} else if (plainRect.type !== 'rect' || Math.abs(plainRect.width - 80) > 1e-6) {
  fail('无旋转框未按 sx 缩放包围盒');
} else if (Math.abs(plainRect.style.stroke.width - scaleRect.style.stroke.width) > 1e-9) {
  fail('描边宽不应随缩放变化');
} else ok('无旋转框：几何/字号/笔迹宽/描边宽口径一致');
const rotatedFrame = {
  bounds: { x: 0, y: 0, width: 100, height: 20 },
  rotation: 30,
  center: { x: 50, y: 10 }
};
const framed = scaleDocumentObjectsInFrame(
  scaleDoc,
  [scalePath.id, scaleText.id],
  rotatedFrame,
  { x: 0, y: 0 },
  2,
  1
);
const framedPath = framed.layers[0].objects[0];
const framedText = framed.layers[0].objects[1];
if (framedPath.type !== 'path' || Math.abs(framedPath.nodes[0].width - 15) > 1e-6) {
  fail('旋转框未同步缩放笔迹节点宽度');
} else if (framedText.type !== 'text' || Math.abs(framedText.fontSize - 30) > 1e-6) {
  fail('旋转框未缩放字号');
} else ok('旋转框与无旋转框缩放口径一致');

// 4a-2) 压感曲线：0.5 @ gamma1 = 0.675，gamma2 应更细；边界安全
if (
  Math.abs(pressureScale(0.5, 1, 0.35) - 0.675) > 1e-9 ||
  !(pressureScale(0.5, 2, 0.35) < pressureScale(0.5, 1, 0.35)) ||
  Math.abs(pressureScale(-1, 1, 0.35) - 0.35) > 1e-9 ||
  Math.abs(pressureScale(2, 1, 0.35) - 1) > 1e-9
) {
  fail('压感曲线映射异常');
} else ok('压感曲线映射与边界');

// 4a-3) resize 预览只重算受影响的化学键/环
const previewAtom = createAtomObject(layer.id, DEFAULT_STYLE, { x: 100, y: 100 }, emptyAtomLabel('C'));
const previewBond = createBondObject(
  layer.id,
  DEFAULT_STYLE,
  { x: 100, y: 100 },
  { x: 200, y: 100 },
  'single'
);
const previewGroup = createGroupObject(
  layer.id,
  '预览环',
  { x: 80, y: 80, width: 140, height: 40 },
  [previewBond.id]
);
const previewRect = createRectObject(layer.id, DEFAULT_STYLE, 0, 0, 20, 20);
const previewDoc = {
  ...doc,
  layers: [
    {
      ...layer,
      objects: [previewAtom, previewBond, previewGroup, previewRect]
    }
  ]
};
const atomPreview = chemistryPreviewIds(previewDoc, new Set([previewAtom.id]));
const bondPreview = chemistryPreviewIds(previewDoc, new Set([previewBond.id]));
const rectPreview = chemistryPreviewIds(previewDoc, new Set([previewRect.id]));
if (
  !atomPreview.has(previewBond.id) ||
  atomPreview.has(previewGroup.id) ||
  !bondPreview.has(previewBond.id) ||
  !bondPreview.has(previewGroup.id) ||
  rectPreview.size !== 0
) {
  fail('resize 化学预览重算范围异常');
} else ok('resize 化学预览只重算受影响键/环');

const closed = createPathObject(
  layer.id,
  { ...DEFAULT_STYLE, fill: { type: 'none' } },
  [
    makeNode(100, 100),
    makeNode(300, 100),
    makeNode(300, 300),
    makeNode(100, 300)
  ],
  true
);
layer.objects.push(closed);
const inside = findFillTarget(doc, { x: 200, y: 200 }, 6);
if (!inside || inside.object.id !== closed.id) fail('闭合路径内部未命中');
else ok('闭合路径内部命中');

// 5) 锁定图层：命中应标记 locked
const lockedDoc = {
  ...doc,
  layers: [{ ...layer, locked: true }]
};
const lockedHit = findFillTarget(lockedDoc, { x: 200, y: 200 }, 6);
if (!lockedHit || !lockedHit.locked) fail('锁定图层未返回 locked 标记');
else ok('锁定图层返回 locked 标记');

// 6) 镜像标记与重新生成
const rect = createRectObject(layer.id, DEFAULT_STYLE, 40, 60, 80, 40);
const [mirror] = mirrorObject(rect, { x: 0.5, y: 0.5 }, 'vertical', 1123, 794);
if (!mirror || mirror.mirrorOf !== rect.id || mirror.mirrorKind !== 'x') {
  fail('镜像未写入 mirrorOf/mirrorKind');
} else ok('镜像已标记来源');

const mirroredDoc = {
  ...doc,
  layers: [{ ...doc.layers[0], objects: [rect, mirror] }]
};
const moved = { ...rect, x: rect.x + 100 };
const movedDoc = {
  ...mirroredDoc,
  layers: [{ ...mirroredDoc.layers[0], objects: [moved, mirror] }]
};
const regenerated = regenerateMirrors(movedDoc, { x: 0.5, y: 0.5 }, 'vertical', 1123, 794);
const nextMirror = regenerated.doc.layers[0].objects.find((item) => item.id === mirror.id);
if (!nextMirror || nextMirror.x === mirror.x) fail('同步镜像未跟随源对象');
else ok('同步镜像跟随源对象（x: ' + mirror.x + ' → ' + nextMirror.x + '）');

const orphanDoc = {
  ...mirroredDoc,
  layers: [{ ...mirroredDoc.layers[0], objects: [mirror] }]
};
const cleaned = regenerateMirrors(orphanDoc, { x: 0.5, y: 0.5 }, 'vertical', 1123, 794);
if (cleaned.doc.layers[0].objects.length !== 0) fail('孤立镜像未被清理');
else ok('孤立镜像已清理');

// 7) 倾斜笔尖：直立为圆，倾角越大越扁，方向跟随 tilt
const upright = nibFromTilt(0, 0);
if (Math.abs(upright.aspect - 1) > 0.001 || upright.angle !== 0) fail('直立笔尖不是圆');
else ok('直立笔尖 aspect=1');
const tilted45 = nibFromTilt(45, 0);
if (Math.abs(tilted45.aspect - Math.cos(Math.PI / 4)) > 0.01) fail('45° 笔尖 aspect 异常');
else ok('45° 笔尖 aspect=' + tilted45.aspect.toFixed(3));
const tiltedY = nibFromTilt(0, 60);
if (Math.abs(tiltedY.aspect - 0.5) > 0.02) fail('60° 笔尖 aspect 异常');
else if (Math.abs(tiltedY.angle - Math.PI / 2) > 0.01) fail('笔尖方向未跟随 tiltY');
else ok('笔尖方向跟随倾斜');

// 8) stamp 透明度：n 次叠加后应接近目标值
const perStamp = stampAlpha(0.5, 9);
const accumulated = 1 - Math.pow(1 - perStamp, 9);
if (Math.abs(accumulated - 0.5) > 0.01) fail('stamp 累积透明度偏差: ' + accumulated.toFixed(3));
else ok('stamp 累积透明度 ' + accumulated.toFixed(3));

// 9) 椭圆笔尖进入最终轮廓：长轴沿笔画方向更细，垂直笔画方向更粗
const outlineHeight = (angle) => {
  const nodes = [
    { ...makeNode(0, 0), width: 10, nibAngle: angle, nibAspect: 0.5 },
    { ...makeNode(120, 0), width: 10, nibAngle: angle, nibAspect: 0.5 }
  ];
  const d = brushOutlineData(nodes) || '';
  const numbers = (d.replace(/A[^A-Za-z]*/g, ' ').match(/[-0-9.]+/g) || []).map(Number);
  const ys = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) ys.push(numbers[index + 1]);
  return Math.max(...ys) - Math.min(...ys);
};
const flatHeight = outlineHeight(0);
const chiselHeight = outlineHeight(Math.PI / 2);
if (!(flatHeight < 9)) fail('椭圆笔尖未压扁轮廓: ' + flatHeight.toFixed(2));
else ok('扁笔沿长轴高度 ' + flatHeight.toFixed(2));
if (!(chiselHeight > 11)) fail('椭圆笔尖未加宽垂直方向: ' + chiselHeight.toFixed(2));
else ok('扁笔垂直长轴高度 ' + chiselHeight.toFixed(2));

// 9a) 材质派生层：软边 2 层 + 确定性颗粒，并写入 SVG
const materialNodes = [
  { ...makeNode(0, 0), width: 10 },
  { ...makeNode(100, 0), width: 10 },
  { ...makeNode(200, 0), width: 10 }
];
const material = { hardness: 0.2, spacing: 0.5, texture: 0.6, seed: 12345 };
const materialLayers = brushMaterialLayers(materialNodes, material, 10);
if (materialLayers.edges.length !== 2) {
  fail('软边层数量异常: ' + materialLayers.edges.length);
} else if (materialLayers.grain.length < 1) {
  fail('纹理颗粒未生成');
} else if (
  materialLayers.grain.some((layer) => !layer.d) ||
  materialLayers.edges.some((layer) => !layer.d)
) {
  fail('材质层存在空路径');
} else {
  const again = brushMaterialLayers(materialNodes, material, 10);
  if (JSON.stringify(again) !== JSON.stringify(materialLayers)) {
    fail('同一笔的材质颗粒不确定');
  } else {
    ok('材质层 2 软边 + ' + materialLayers.grain.length + ' 组颗粒');
  }
}

// 9a-1) 实时层与落笔层共用：材质阈值 + 墨量分桶系数
if (dabBucket(0) !== 0 || dabBucket(0.34) !== 1 || dabBucket(0.99) !== 2) {
  fail('dab 墨量分桶边界异常');
} else if (
  !hasBrushMaterial({ hardness: 0.55, texture: 0.12 }) ||
  hasBrushMaterial({ hardness: 0.85, texture: 0.04 }) ||
  hasBrushMaterial({ hardness: 0.9, texture: 0 }) ||
  !hasBrushMaterial({ hardness: 0.9, texture: 0, flow: 0.5 }) ||
  !hasBrushMaterial({ hardness: 0.9, texture: 0, blendMode: 'multiply' }) ||
  hasBrushMaterial({ hardness: 0.9, texture: 0, flow: 1, blendMode: 'normal' })
) {
  fail('材质入库阈值与 flow/blendMode 口径不一致');
} else ok('实时/落笔共用材质阈值与墨量分桶');
const expectedGrainAlphas = DAB_BUCKET_ALPHAS.map((alpha) => alpha * material.texture);
if (
  !materialLayers.grain.every((layer) =>
    expectedGrainAlphas.some((alpha) => Math.abs(alpha - layer.opacity) < 1e-9)
  )
) {
  fail('材质颗粒透明度未使用共享分桶系数');
} else ok('材质颗粒使用共享分桶透明度');
if (materialLayers.grain.length !== 3) {
  fail('墨量三桶未全部生效: ' + materialLayers.grain.length);
} else ok('墨量三桶全部生效');

// 9a-1b) flow 作用于每 dab 墨量；multiply 逐 dab 输出并写入 SVG
const flowLayers = brushMaterialLayers(materialNodes, { ...material, flow: 0.4 }, 10);
if (
  flowLayers.grain.length !== materialLayers.grain.length ||
  Math.abs(flowLayers.bodyOpacity - 0.4) > 1e-9 ||
  !flowLayers.grain.every(
    (layer, index) => Math.abs(layer.opacity - materialLayers.grain[index].opacity * 0.4) < 1e-9
  )
) {
  fail('flow 未按比例作用于主体与 dab 墨量');
} else ok('flow 作用于主体与 dab 墨量');
const multiplyLayers = brushMaterialLayers(
  materialNodes,
  { ...material, blendMode: 'multiply' },
  10
);
if (
  multiplyLayers.grain.length <= 3 ||
  multiplyLayers.blendMode !== 'multiply' ||
  multiplyLayers.grain.some((layer) => layer.blendMode !== 'multiply')
) {
  fail('multiply 未逐 dab 输出或未作用于主体');
} else ok('multiply 逐 dab 输出 ' + multiplyLayers.grain.length + ' 条');
const forcedBuckets = brushMaterialLayers(
  materialNodes,
  { ...material, blendMode: 'multiply' },
  10,
  { forceBuckets: true }
);
if (
  forcedBuckets.grain.length > 3 ||
  forcedBuckets.grain.some((layer) => layer.blendMode !== 'multiply')
) {
  fail('forceBuckets 未退化为 3 个 multiply 分桶');
} else ok('forceBuckets 退化为 ' + forcedBuckets.grain.length + ' 个分桶');
const budgetObjects = Array.from({ length: 40 }, (_, index) => ({
  ...createPathObject(layer.id, DEFAULT_STYLE, materialNodes, false),
  id: 'budget-' + index,
  brushMaterial: { ...material, blendMode: 'multiply' }
}));
const budgetAllowed = grainBudgetIds({
  ...doc,
  layers: [{ ...layer, objects: budgetObjects }]
});
if (budgetAllowed.size <= 0 || budgetAllowed.size >= budgetObjects.length) {
  fail('文档级 dab 预算未生效: ' + budgetAllowed.size);
} else ok('文档级 dab 预算 ' + budgetAllowed.size + ' / ' + budgetObjects.length + ' 条（预算 ' + GRAIN_PATH_BUDGET + '）');
const multiplySvg = documentToSvgString({
  ...doc,
  layers: [
    {
      ...layer,
      objects: [
        {
          ...createPathObject(layer.id, DEFAULT_STYLE, materialNodes, false),
          brushMaterial: { ...material, blendMode: 'multiply' }
        }
      ]
    }
  ]
});
if (!multiplySvg.includes('mix-blend-mode:multiply')) fail('SVG 未写入逐 dab 混合');
else ok('SVG 写入逐 dab 混合');
const bakedPath = {
  ...createPathObject(
    layer.id,
    {
      ...DEFAULT_STYLE,
      stroke: { ...DEFAULT_STYLE.stroke, paint: { type: 'solid', color: '#0000ff' } }
    },
    materialNodes,
    false
  ),
  brushMaterial: { ...material, blendMode: 'multiply' }
};
const bakedSvg = documentToSvgString(
  {
    ...doc,
    page: { ...doc.page, background: '#ffff00' },
    layers: [{ ...layer, objects: [bakedPath] }]
  },
  { bakeMultiply: true }
);
if (bakedSvg.includes('mix-blend-mode') || !bakedSvg.includes('fill="#000000"')) {
  fail('PDF 烘焙 multiply 失败');
} else ok('PDF 烘焙 multiply 为普通 fill');
const uniformNodes = [
  { ...makeNode(0, 0) },
  { ...makeNode(100, 0) }
];
const bakedUniformPath = {
  ...createPathObject(
    layer.id,
    {
      ...DEFAULT_STYLE,
      stroke: { ...DEFAULT_STYLE.stroke, paint: { type: 'solid', color: '#0000ff' } }
    },
    uniformNodes,
    false
  ),
  brushMaterial: { ...material, blendMode: 'multiply' }
};
const bakedUniformSvg = documentToSvgString(
  {
    ...doc,
    page: { ...doc.page, background: '#ffff00' },
    layers: [{ ...layer, objects: [bakedUniformPath] }]
  },
  { bakeMultiply: true }
);
if (
  bakedUniformSvg.includes('mix-blend-mode') ||
  !bakedUniformSvg.includes('stroke="#000000"')
) {
  fail('PDF 等宽笔迹烘焙 multiply 失败');
} else ok('PDF 等宽笔迹烘焙 multiply');

// 9a-1c) 笔刷库：往返、夹取、非法文件拒绝
const libraryJson = serializeBrushLibrary([
  {
    id: 'seed',
    name: '测试笔',
    width: 12,
    opacity: 0.8,
    hardness: 0.4,
    spacing: 0.6,
    texture: 0.3,
    pressure: false,
    taper: 0,
    smoothing: 10,
    flow: 0.6,
    blendMode: 'multiply'
  }
]);
const library = parseBrushLibrary(libraryJson);
if (
  library.brushes.length !== 1 ||
  Math.abs(library.brushes[0].flow - 0.6) > 1e-9 ||
  library.brushes[0].blendMode !== 'multiply'
) {
  fail('笔刷库往返丢失 flow/blendMode');
} else ok('笔刷库往返');
const clampedLibrary = parseBrushLibrary(
  JSON.stringify({
    kind: 'brush-library',
    brushes: [
      {
        name: '越界',
        width: 999,
        opacity: -1,
        hardness: 2,
        spacing: 0,
        texture: 2,
        flow: 0,
        blendMode: 'unknown'
      }
    ]
  })
);
if (
  clampedLibrary.brushes[0].width !== 80 ||
  clampedLibrary.brushes[0].opacity !== 0.05 ||
  clampedLibrary.brushes[0].flow !== 0.05 ||
  clampedLibrary.brushes[0].blendMode !== 'normal'
) {
  fail('笔刷库数值未夹取');
} else ok('笔刷库数值夹取');
let libraryRejected = false;
try {
  parseBrushLibrary('{"kind":"other"}');
} catch {
  libraryRejected = true;
}
if (!libraryRejected) fail('非法笔刷库未被拒绝');
else ok('非法笔刷库被拒绝');
let versionRejected = false;
try {
  parseBrushLibrary(
    JSON.stringify({
      kind: 'brush-library',
      app: 'VDraw Studio',
      schemaVersion: 2,
      brushes: [{ name: '未来版本' }]
    })
  );
} catch {
  versionRejected = true;
}
if (!versionRejected) fail('不受支持的笔刷库版本未被拒绝');
else ok('不受支持的笔刷库版本被拒绝');

// 9a-2) 材质层缓存：等价几何命中、几何/材质变化失效、容量可控
clearBrushMaterialCache();
const cachedFirst = brushMaterialLayers(materialNodes, material, 10);
const cachedSecond = brushMaterialLayers(materialNodes, material, 10);
const rebuiltNodes = materialNodes.map((node) => ({ ...node }));
const cachedRebuilt = brushMaterialLayers(rebuiltNodes, material, 10);
if (cachedFirst !== cachedSecond || cachedFirst !== cachedRebuilt) {
  fail('等价几何未命中材质层缓存');
} else if (brushMaterialCacheStats().hits < 2) {
  fail('材质层缓存命中未计数');
} else ok('材质层缓存命中 ' + brushMaterialCacheStats().hits + ' 次');
const movedNodes = materialNodes.map((node) => ({ ...node, x: node.x + 0.5 }));
if (brushMaterialLayers(movedNodes, material, 10) === cachedFirst) {
  fail('几何变化未使材质层缓存失效');
} else ok('几何变化使缓存失效');
const otherMaterial = { ...material, seed: 54321 };
if (brushMaterialLayers(materialNodes, otherMaterial, 10) === cachedFirst) {
  fail('材质变化未使材质层缓存失效');
} else ok('材质变化使缓存失效');
if (brushMaterialLayers(materialNodes, { ...material, flow: 0.5 }, 10) === cachedFirst) {
  fail('flow 变化未使材质层缓存失效');
} else ok('flow 变化使缓存失效');
if (
  brushMaterialLayers(materialNodes, { ...material, blendMode: 'multiply' }, 10) === cachedFirst
) {
  fail('blendMode 变化未使材质层缓存失效');
} else ok('blendMode 变化使缓存失效');
const cacheSize = brushMaterialCacheStats().size;
if (cacheSize > 6) fail('材质层缓存条目异常: ' + cacheSize);
else ok('材质层缓存容量可控 ' + cacheSize + ' 条');

// 9a-3) 矢量 stamp dab：间距 / 方向场 / 笔尖 / 确定性墨量 / 上限
// 独立块作用域，避免与后文 brush-check 的同名变量冲突。
{
const straightNodes = [
  { ...makeNode(0, 0), width: 10 },
  { ...makeNode(200, 0), width: 10 }
];
const dabBase = { hardness: 0.8, spacing: 0.5, texture: 0.6, seed: 777 };
const dabsHalf = generateStampDabs(straightNodes, dabBase, 10);
const dabsQuarter = generateStampDabs(straightNodes, { ...dabBase, spacing: 0.25 }, 10);
if (dabsHalf.length === 0) {
  fail('未生成 dab');
} else if (!(dabsQuarter.length > dabsHalf.length)) {
  fail('spacing 未控制 dab 间距');
} else ok('spacing 控制 dab 数量 ' + dabsHalf.length + ' → ' + dabsQuarter.length);
if (!dabsHalf.every((dab) => Math.abs(dab.rotation) < 1)) {
  fail('水平笔迹 dab 方向场不沿切线');
} else ok('水平笔迹 dab 方向场 ≈ 0°');
const diagonal = generateStampDabs(
  [
    { ...makeNode(0, 0), width: 10 },
    { ...makeNode(100, 100), width: 10 }
  ],
  dabBase,
  10
);
if (!diagonal.length || diagonal.some((dab) => Math.abs(dab.rotation - 45) > 1)) {
  fail('斜向笔迹 dab 未沿 45° 方向场');
} else ok('斜向笔迹 dab 方向场 ≈ 45°');
const nibDabs = generateStampDabs(
  [
    { ...makeNode(0, 0), width: 10, nibAngle: Math.PI / 4, nibAspect: 0.5 },
    { ...makeNode(100, 0), width: 10, nibAngle: Math.PI / 4, nibAspect: 0.5 }
  ],
  dabBase,
  10
);
if (!nibDabs.length || nibDabs.some((dab) => Math.abs(dab.rotation - 45) > 1)) {
  fail('笔尖角度未叠加到方向场');
} else if (nibDabs.some((dab) => dab.ry > dab.rx)) {
  fail('dab 长短轴顺序异常');
} else ok('笔尖角度 / 长宽比影响 dab');
if (JSON.stringify(generateStampDabs(straightNodes, dabBase, 10)) !== JSON.stringify(dabsHalf)) {
  fail('dab 墨量不确定');
} else ok('dab 固定 seed 确定性');
if (
  JSON.stringify(generateStampDabs(straightNodes, { ...dabBase, seed: 778 }, 10)) ===
  JSON.stringify(dabsHalf)
) {
  fail('不同 seed 未改变 dab 墨量');
} else ok('不同 seed 产生不同墨量');
const longNodes = [];
for (let index = 0; index <= 40; index += 1) {
  longNodes.push({ ...makeNode(index * 100, 0), width: 10 });
}
const capped = generateStampDabs(longNodes, { ...dabBase, spacing: 0.05 }, 10);
if (capped.length > 420) fail('dab 数量超出上限: ' + capped.length);
else ok('dab 上限 ' + capped.length + ' 个');
if (!dabPath(dabsHalf[0]).includes(' A ')) fail('dab 路径缺少椭圆弧');
else ok('dab 输出旋转椭圆弧');
const dabLayers = brushMaterialLayers(straightNodes, dabBase, 10);
if (!dabLayers.grain.some((layer) => layer.d.includes(' A '))) {
  fail('材质颗粒层未使用 dab');
} else ok('材质颗粒层由 dab 驱动');
}

const materialPath = {
  ...createPathObject(layer.id, DEFAULT_STYLE, materialNodes, false),
  brushMaterial: material
};
const materialSvg = documentToSvgString({
  ...doc,
  layers: [{ ...layer, objects: [materialPath] }]
});
const materialPaths = (materialSvg.match(/fill-rule="nonzero"/g) || []).length;
if (materialPaths < 3) fail('材质层未写入 SVG: ' + materialPaths);
else ok('材质层写入 SVG ' + materialPaths + ' 条');
if (!materialSvg.includes(' A ')) fail('SVG 未包含 dab 旋转椭圆弧');
else ok('SVG 包含 dab 旋转椭圆弧');
const reloadedMaterial = parseDocumentFile(
  serializeDocument({ ...doc, layers: [{ ...layer, objects: [materialPath] }] })
).doc.layers[0].objects[0];
if (
  reloadedMaterial.type !== 'path' ||
  !reloadedMaterial.brushMaterial ||
  Math.abs(reloadedMaterial.brushMaterial.texture - 0.6) > 1e-6
) {
  fail('材质未随文档保存');
} else ok('材质随文档保存');

// 9b) 镜像必须翻转笔尖长轴方向：左右镜像取补角
const nibPath = createPathObject(
  layer.id,
  DEFAULT_STYLE,
  [
    { ...makeNode(0, 0), width: 10, nibAngle: 0.4, nibAspect: 0.5 },
    { ...makeNode(40, 0), width: 10, nibAngle: 0.4, nibAspect: 0.5 }
  ],
  false
);
const [nibMirror] = mirrorObject(nibPath, { x: 0.5, y: 0.5 }, 'vertical', 100, 100);
const expectedAngle = Math.atan2(Math.sin(Math.PI - 0.4), Math.cos(Math.PI - 0.4));
if (!nibMirror || Math.abs(nibMirror.nodes[0].nibAngle - expectedAngle) > 1e-6) {
  fail('镜像未翻转笔尖方向: ' + (nibMirror ? nibMirror.nodes[0].nibAngle : 'null'));
} else ok('镜像翻转笔尖方向');

// 9c) 扁平化计入扁笔尖：长轴垂直于笔迹时，法线方向支撑宽度应大于标称宽度
const nibNodes = [
  { ...makeNode(0, 100), width: 10, nibAngle: Math.PI / 2, nibAspect: 0.5 },
  { ...makeNode(100, 100), width: 10, nibAngle: Math.PI / 2, nibAspect: 0.5 }
];
const plainFlat = flattenNodes(nibNodes, false, 1, 10, false);
const nibFlat = flattenNodes(nibNodes, false, 1, 10, true);
const middleWidth = (points) => points[Math.floor(points.length / 2)]?.width ?? 0;
if (!(middleWidth(nibFlat) > middleWidth(plainFlat) * 1.3)) {
  fail('扁平化未计入扁笔尖: ' + middleWidth(plainFlat).toFixed(2) + ' → ' + middleWidth(nibFlat).toFixed(2));
} else ok('扁平化计入扁笔尖宽度 ' + middleWidth(nibFlat).toFixed(2));

// 9d) 命中判定按最大支撑宽度：标称半宽 5px，扁笔长轴垂直于笔迹时半宽 7.07px
const nibObject = { ...nibPath, nodes: nibNodes };
const wideHit = hitTestObject(nibObject, { x: 50, y: 106.5 }, 0);
const wideMiss = hitTestObject(nibObject, { x: 50, y: 109 }, 0);
if (!wideHit || wideMiss) fail('扁笔尖命中宽度未生效');
else ok('扁笔尖命中覆盖短轴墨迹');

// 10) P6：X 形自交应被检出并切成多段；直线不应误判
const xNodes = [
  { ...makeNode(0, 0), width: 12 },
  { ...makeNode(100, 100), width: 12 },
  { ...makeNode(0, 100), width: 12 },
  { ...makeNode(100, 0), width: 12 }
];
const cross = findStrokeSelfIntersection(xNodes);
if (!cross) fail('X 形笔迹未检出自我交叉');
else if (Math.abs(cross.point.x - 50) > 2 || Math.abs(cross.point.y - 50) > 2) {
  fail('自交位置偏差: ' + cross.point.x + ',' + cross.point.y);
} else ok('自交位置 (' + cross.point.x + ', ' + cross.point.y + ')');
const parts = splitStrokeAtSelfIntersection(xNodes);
if (!parts || parts.length < 3) fail('自交笔迹切段数量异常: ' + (parts ? parts.length : 0));
else if (parts.some((part) => part.length < 2)) fail('切段后存在退化路径');
else ok('自交切段 ' + parts.length + ' 段');

const straightNodes = [
  { ...makeNode(0, 0), width: 12 },
  { ...makeNode(60, 0), width: 12 },
  { ...makeNode(120, 0), width: 12 }
];
if (findStrokeSelfIntersection(straightNodes)) fail('直线被误判为自交');
else ok('直线不触发切段');

// 10b) 多交点：应一次切成至少 4 段，而不是只处理第一处
const doubleX = [
  { ...makeNode(0, 0), width: 8 },
  { ...makeNode(40, 40), width: 8 },
  { ...makeNode(0, 40), width: 8 },
  { ...makeNode(40, 0), width: 8 },
  { ...makeNode(80, 80), width: 8 },
  { ...makeNode(40, 80), width: 8 },
  { ...makeNode(80, 40), width: 8 }
];
const doubleHits = findStrokeSelfIntersections(doubleX);
const doubleParts = splitStrokeAtSelfIntersection(doubleX);
if (doubleHits.length < 2) {
  fail('多交点未全部检出: ' + doubleHits.length);
} else if (!doubleParts || doubleParts.length < 4) {
  fail('多交点切段数量异常: ' + (doubleParts ? doubleParts.length : 0));
} else ok('多交点切段 ' + doubleParts.length + ' 段');

// 10c) 编辑器环境入档：对称/辅助线随文档保存，旧文件安全回落
const docBrush = {
  id: 'seed',
  name: '文档笔刷',
  width: 12,
  opacity: 0.8,
  hardness: 0.4,
  spacing: 0.6,
  texture: 0.3,
  pressure: false,
  taper: 0,
  smoothing: 10,
  flow: 0.6,
  blendMode: 'multiply'
};
const editorSnapshot = {
  symmetry: 'vertical',
  symmetryAxis: { x: 0.3, y: 0.7 },
  guideMode: 'two-point',
  guideSettings: { horizon: 0.5, vpX: 0.4, vpLeft: -0.2, vpRight: 1.2, vpBottom: 1.6 },
  guideAssist: true,
  guideDensity: 30,
  guideSpacing: 150,
  customBrushes: [docBrush, { name: '' }]
};
const savedFile = parseDocumentFile(serializeDocument(doc, editorSnapshot));
if (
  !savedFile.editor ||
  savedFile.editor.symmetry !== 'vertical' ||
  savedFile.editor.guideMode !== 'two-point' ||
  savedFile.editor.guideDensity !== 30 ||
  savedFile.editor.customBrushes?.length !== 1 ||
  savedFile.editor.customBrushes[0].name !== '文档笔刷' ||
  Math.abs((savedFile.editor.customBrushes[0].flow ?? 1) - 0.6) > 1e-9 ||
  savedFile.editor.customBrushes[0].blendMode !== 'multiply'
) {
  fail('编辑器环境/自定义笔刷未随文档保存');
} else ok('编辑器环境与自定义笔刷随文档保存');
const localBrush = { ...docBrush, id: 'local', name: '本地笔刷' };
const mergedBrushes = mergeBrushPresets(
  [localBrush],
  [savedFile.editor.customBrushes[0], savedFile.editor.customBrushes[0]],
  { idPrefix: 'test' }
);
if (
  mergedBrushes.added !== 1 ||
  mergedBrushes.brushes.length !== 2 ||
  mergedBrushes.brushes[1].id !== 'test-1'
) {
  fail('文档笔刷去重合并异常');
} else ok('文档笔刷去重合并');
const cappedBrushes = mergeBrushPresets(
  Array.from({ length: 200 }, (_, index) => ({ ...localBrush, name: '本地 ' + index })),
  [docBrush],
  { idPrefix: 'cap' }
);
if (cappedBrushes.added !== 0 || cappedBrushes.brushes.length !== 200) {
  fail('文档笔刷合并未遵守 200 上限');
} else ok('文档笔刷合并上限 200');
const legacyFile = parseDocumentFile(
  JSON.stringify({ schemaVersion: 1, app: 'VDraw Studio', savedAt: new Date().toISOString(), document: doc })
);
if (legacyFile.editor !== null) fail('旧文件不应凭空生成 editor');
else ok('旧文件无 editor 时安全回落');

// 10d) 文本软换行：原文不被改写，换行参与度量
const softText = createTextObject(layer.id, DEFAULT_STYLE, { x: 0, y: 0 }, 'abcdef', 10, {
  maxWidth: 12,
  fontWeight: 400,
  fontFamily: 'Arial',
  lineHeight: 2
});
if (softText.text !== 'abcdef') fail('软换行改写了原文: ' + JSON.stringify(softText.text));
else if (softText.height < 40) fail('软换行未参与度量: ' + softText.height);
else ok('文本软换行保留原文');

// 10e) 竖排导出行高必须跟随 lineHeight，而不是写死的 1.25
const verticalText = {
  ...softText,
  text: '汉字',
  maxWidth: 0,
  fontSize: 20,
  lineHeight: 2,
  direction: 'vertical',
  align: 'left',
  style: { ...DEFAULT_STYLE, fill: { type: 'solid', color: '#000000' } }
};
const verticalSvg = documentToSvgString({
  ...doc,
  layers: [{ ...layer, objects: [verticalText] }]
});
const tspans = [...verticalSvg.matchAll(/<tspan x="[^"]*" y="([0-9.]+)"/g)].map((match) =>
  Number(match[1])
);
const tspanGap = tspans.length >= 2 ? tspans[1] - tspans[0] : 0;
if (Math.abs(tspanGap - 40) > 0.1) fail('竖排导出行高未跟随 lineHeight: ' + tspanGap);
else ok('竖排导出行高 ' + tspanGap + 'px');

// 10f) 横排导出行高同样必须跟随 lineHeight
const horizontalText = {
  ...softText,
  text: 'A\\nB',
  maxWidth: 0,
  fontSize: 20,
  lineHeight: 2,
  direction: 'horizontal',
  align: 'left',
  style: { ...DEFAULT_STYLE, fill: { type: 'solid', color: '#000000' } }
};
const horizontalSvg = documentToSvgString({
  ...doc,
  layers: [{ ...layer, objects: [horizontalText] }]
});
const horizontalDy = [...horizontalSvg.matchAll(/<tspan[^>]*dy="([0-9.]+)"/g)].map((match) =>
  Number(match[1])
);
const horizontalGap = horizontalDy[1] ?? 0;
if (Math.abs(horizontalGap - 40) > 0.1) {
  fail('横排导出行高未跟随 lineHeight: ' + horizontalGap);
} else ok('横排导出行高 ' + horizontalGap + 'px');

// 11) 视口裁剪：视野矩形随 pan/zoom 正确换算，视野外对象被判定不可见
const viewRect = viewRectForViewport(
  { width: 800, height: 600 },
  { zoom: 2, pan: { x: -100, y: -50 } },
  50
);
if (
  Math.abs(viewRect.x - 0) > 0.01 ||
  Math.abs(viewRect.y + 25) > 0.01 ||
  Math.abs(viewRect.width - 500) > 0.01 ||
  Math.abs(viewRect.height - 400) > 0.01
) {
  fail('视口矩形换算异常: ' + JSON.stringify(viewRect));
} else ok('视口矩形 500×400 @ (0,-25)');

const insideRect = createRectObject(layer.id, DEFAULT_STYLE, 10, 10, 40, 40);
const outsideRect = createRectObject(layer.id, DEFAULT_STYLE, 2000, 2000, 10, 10);
if (!objectInView(insideRect, viewRect)) fail('视野内对象被误裁剪');
else ok('视野内对象保留');
if (objectInView(outsideRect, viewRect)) fail('视野外对象未被裁剪');
else ok('视野外对象裁剪');

// 12) 图层混合模式应写入 SVG 导出
const blendLayer = { ...doc.layers[0], blendMode: 'multiply' };
const blendDoc = {
  ...doc,
  layers: [{ ...blendLayer, objects: [createRectObject(blendLayer.id, DEFAULT_STYLE, 20, 20, 60, 40)] }]
};
const blendSvg = documentToSvgString(blendDoc);
if (!blendSvg.includes('mix-blend-mode:multiply')) fail('图层混合模式未写入导出');
else ok('图层混合模式写入导出');

// 13) 辅助线：射线方向量化与等大参考间距
const rays = guideRayDirections(12);
if (
  rays.length !== 12 ||
  Math.abs(rays[0].x - 1) > 0.01 ||
  Math.abs(rays[6].y - 1) > 0.01 ||
  rays.some((dir) => Math.abs(Math.hypot(dir.x, dir.y) - 1) > 0.001)
) {
  fail('射线方向量化异常');
} else ok('12 条量化射线含水平/垂直且均为单位向量');

const equal = equalGridOffsets(1000, 200);
if (equal.length !== 4 || !equal.includes(300) || !equal.includes(700)) {
  fail('等大参考网格间距异常: ' + JSON.stringify(equal));
} else ok('等大参考网格按 200px 从 500 中线展开');

// 14) 上下标：^{2} / _{2} 转 Unicode，普通文本不受影响
if (parseTextScripts('H_{2}O') !== 'H₂O') fail('下标转换失败: ' + parseTextScripts('H_{2}O'));
else ok('H_{2}O → H₂O');
if (parseTextScripts('x^{2}+y_{1}') !== 'x²+y₁') fail('混排上下标转换失败');
else ok('混排上下标转换');
if (parseTextScripts('普通文本') !== '普通文本') fail('普通文本被误改');
else ok('普通文本保持不变');
if (parseTextScripts('file_name^1') !== 'file_name^1') fail('普通下划线被误吃');
else ok('普通下划线/脱字符保持不变');

// 15) 透视单应：4 角精确映射，内部点落在目标四边形内
const guideSettings = {
  horizon: 0.42,
  vpX: 0.5,
  vpLeft: -0.18,
  vpRight: 1.18,
  vpBottom: 1.75
};
const square = { x: 0, y: 0, width: 100, height: 100 };
const srcQuad = quadOfBounds(square);
const dstQuad = perspectiveQuad(square, guideSettings, { width: 1123, height: 794 });
const H = solveHomography(srcQuad, dstQuad);
if (!H) fail('单应矩阵求解失败');
else {
  const error = Math.max(
    ...srcQuad.map((point, index) => {
      const mapped = applyHomography(H, point);
      return Math.hypot(mapped.x - dstQuad[index].x, mapped.y - dstQuad[index].y);
    })
  );
  if (error > 0.01) fail('四角映射偏差: ' + error.toFixed(4));
  else ok('单应四角精确映射（误差 ' + error.toFixed(5) + '）');
  const center = applyHomography(H, { x: 50, y: 50 });
  if (center.x < dstQuad[0].x - 0.01 || center.x > dstQuad[1].x + 0.01) {
    fail('内部点未落在透视四边形内');
  } else ok('内部点落在四边形内');
  const warped = warpSelection(
    blendDoc,
    [blendDoc.layers[0].objects[0].id],
    guideSettings,
    { width: 1123, height: 794 }
  );
  if (warped.changed !== 1) fail('透视变形未作用于选中对象');
  else ok('透视变形作用于选中对象');
}

// 16) 选区内绘制 / alpha 锁：clipPath 同时出现在定义与导出内容
const clipSource = createRectObject(layer.id, DEFAULT_STYLE, 10, 10, 100, 60);
const clipped = {
  ...createRectObject(layer.id, DEFAULT_STYLE, 20, 20, 200, 100),
  clipIds: [clipSource.id]
};
const clipDoc = {
  ...doc,
  layers: [{ ...doc.layers[0], objects: [clipSource, clipped] }]
};
const def = clipPathDef(clipDoc, clipped);
const clipId = 'clip-' + clipped.id;
if (!canClip(clipSource)) fail('矩形未被识别为可裁剪图形');
else ok('矩形可作为裁剪轮廓');
if (!def.includes('<clipPath id="' + clipId + '"') || !def.includes('<rect')) {
  fail('clipPath 定义缺失');
} else ok('clipPath 定义包含剪影图形');
const clipSvg = documentToSvgString(clipDoc);
if (
  !clipSvg.includes('<clipPath id="' + clipId + '"') ||
  !clipSvg.includes('clip-path="url(#' + clipId + ')"')
) {
  fail('导出缺少裁剪定义或引用');
} else ok('画布/导出共用裁剪定义');
`;

const dir = await mkdtemp(path.join(tmpdir(), 'vdraw-tools-'));
const outfile = path.join(dir, 'tools-check.mjs');
try {
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    logLevel: 'silent'
  });
  console.log('OK tools baseline');
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
