#!/usr/bin/env node
/**
 * 导出管线纯函数校验（不启动 Electron / 浏览器）。
 *
 * 网页端与 PC 端共用同一份 `documentToSvgString` / `selectionExportRegion`，
 * 所以这里直接把「导出内容 = 导出范围」这条不变量钉死：
 *   1. 选中对象导出只包含被选中的对象（不混入未选中对象）；
 *   2. 选中分组会带上后代对象，不会导出空图；
 *   3. 贴纸边 / 越出纸边的对象不被裁剪（不会丢内容）；
 *   4. 粗描边有足够留白，不被切边；
 *   5. 背景色块与 viewBox 严格跟随导出框，预览与落盘同源。
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn'
});

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
};

try {
  const { documentToSvgString, resolveExportBox } = await server.ssrLoadModule('/src/core/io/svg.ts');
  const { selectionExportRegion } = await server.ssrLoadModule('/src/core/io/region.ts');
  const { createDocument, DEFAULT_STYLE } = await server.ssrLoadModule('/src/core/document.ts');
  const factory = await server.ssrLoadModule('/src/core/factory.ts');
  const { getObjectBounds } = await server.ssrLoadModule('/src/core/scene.ts');

  const style = (fill, strokeWidth = 2) => ({
    ...DEFAULT_STYLE,
    fill: fill ? { type: 'solid', color: fill } : { type: 'none' },
    stroke: { ...DEFAULT_STYLE.stroke, width: strokeWidth }
  });

  const doc = createDocument('blank-landscape', '导出校验');
  const layerId = doc.layers[0].id;
  const red = factory.createRectObject(layerId, style('#ff0000'), 100, 100, 100, 80);
  const green = factory.createRectObject(layerId, style('#00ff00'), 500, 400, 120, 90);
  doc.layers[0].objects.push(red, green);

  const countRects = (svg) => (svg.match(/<rect/g) ?? []).length;

  check('选中对象：只出现被选中的对象', () => {
    const region = selectionExportRegion(doc, [red.id]);
    const svg = documentToSvgString(doc, { region, includeIds: [red.id] });
    assert.ok(svg.includes('#ff0000'), '缺少选中对象的填充色');
    assert.ok(!svg.includes('#00ff00'), '混入了未选中对象');
    assert.equal(countRects(svg), 2, '应当只有背景色块 + 1 个对象');
  });

  check('选中对象：导出框完整包住对象并留出 8px', () => {
    const region = selectionExportRegion(doc, [red.id]);
    const box = resolveExportBox(doc, region);
    const bounds = getObjectBounds(red, doc);
    assert.ok(box.x <= bounds.x - 8 + 0.001, '左侧留白不足');
    assert.ok(box.y <= bounds.y - 8 + 0.001, '顶部留白不足');
    assert.ok(
      box.x + box.width >= bounds.x + bounds.width + 8 - 0.001,
      '右侧留白不足，对象会被裁切'
    );
    assert.ok(
      box.y + box.height >= bounds.y + bounds.height + 8 - 0.001,
      '底部留白不足，对象会被裁切'
    );
  });

  check('预览与落盘同源：viewBox 与背景色块跟随导出框', () => {
    const region = selectionExportRegion(doc, [red.id]);
    const box = resolveExportBox(doc, region);
    const svg = documentToSvgString(doc, { region });
    assert.ok(
      svg.includes(`viewBox="${box.x} ${box.y} ${box.width} ${box.height}"`),
      'viewBox 与导出框不一致'
    );
    assert.ok(
      svg.includes(`<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"`),
      '背景色块没有铺满导出框'
    );
  });

  check('越出纸边的对象不被裁剪', () => {
    const page = doc.page;
    const over = factory.createRectObject(layerId, style('#0000ff'), page.width - 30, 40, 120, 60);
    doc.layers[0].objects.push(over);
    const region = selectionExportRegion(doc, [over.id]);
    assert.ok(region.x + region.width > page.width, '导出框被纸张边界裁掉了');
    const box = resolveExportBox(doc, region);
    assert.equal(box.width, region.width, 'resolveExportBox 二次裁剪了宽度');
    assert.ok(
      box.x + box.width >= page.width - 30 + 120,
      '对象右半部分落在导出框外'
    );
    doc.layers[0].objects.pop();
  });

  check('粗描边对象有额外留白', () => {
    const thick = factory.createRectObject(layerId, style('#123456', 30), 200, 200, 80, 80);
    doc.layers[0].objects.push(thick);
    const region = selectionExportRegion(doc, [thick.id]);
    const box = resolveExportBox(doc, region);
    const bounds = getObjectBounds(thick, doc);
    const margin = bounds.x - box.x;
    assert.ok(margin >= 15, `描边留白不足（${margin}px），30px 描边会被切边`);
    doc.layers[0].objects.pop();
  });

  check('选中分组：自动带上后代对象', () => {
    // 与编组动作一致：分组记 childIds，子对象记 parentId。
    const group = factory.createGroupObject(layerId, '分组', { x: 100, y: 100, width: 520, height: 390 }, [
      red.id,
      green.id
    ]);
    red.parentId = group.id;
    green.parentId = group.id;
    doc.layers[0].objects.push(group);
    const svg = documentToSvgString(doc, {
      region: selectionExportRegion(doc, [group.id]),
      includeIds: [group.id]
    });
    assert.ok(svg.includes('#ff0000') && svg.includes('#00ff00'), '分组只导出了部分后代');
    assert.equal(countRects(svg), 3, '应当只有背景 + 两个后代对象');
    doc.layers[0].objects.pop();
    red.parentId = null;
    green.parentId = null;
  });

  check('水平线条（极扁包围盒）仍可导出', () => {
    const line = factory.createLineObject(layerId, style(null, 4), { x: 60, y: 300 }, { x: 260, y: 300 });
    doc.layers[0].objects.push(line);
    const region = selectionExportRegion(doc, [line.id]);
    assert.ok(region, '零高度对象被判定为空选区');
    assert.ok(region.height > 0 && region.width > 0, '零高度对象导出框尺寸无效');
    doc.layers[0].objects.pop();
  });

  check('整页导出不受本次改动影响', () => {
    const svg = documentToSvgString(doc);
    assert.ok(
      svg.includes(`viewBox="0 0 ${doc.page.width} ${doc.page.height}"`),
      '整页 viewBox 不再从原点开始'
    );
    assert.ok(svg.includes('#ff0000') && svg.includes('#00ff00'), '整页导出缺少对象');
  });

  check('未指定 includeIds 时导出全部可见对象', () => {
    const svg = documentToSvgString(doc, { region: selectionExportRegion(doc, [red.id]) });
    assert.ok(svg.includes('#00ff00'), '区域导出丢失了范围外的可见对象（应保留并由 viewBox 裁剪）');
  });
} finally {
  await server.close();
}

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? '  ✓' : '  ✗'} ${item.name}${item.ok ? '' : ` —— ${item.error}`}`);
}
console.log(
  failed.length === 0
    ? `[export-check] ${results.length} 项导出不变量全部通过`
    : `[export-check] ${failed.length}/${results.length} 项失败`
);
process.exit(failed.length === 0 ? 0 : 1);
