#!/usr/bin/env node
/**
 * 选中框 / 变换几何校验（不启动 GUI）。
 *
 * 针对「旋转后描边没跟着转」这类问题的不变量：
 *   1. 单对象的选中框必须是**未旋转的本地盒 + 旋转角**，不能是旋转后的轴对齐包围盒；
 *   2. 本地盒绕自身中心转 `rotation` 之后的轴对齐范围，必须与对象真实包围盒重合
 *      （这样选框描边、控制点、旋转手柄才会贴着图形走）；
 *   3. 旋转 90° 时同样成立（用户最容易发现偏差的角度）；
 *   4. 多选仍用轴对齐包围盒（不叠加旋转）；
 *   5. 旋转后按数值改宽高，改的是本地尺寸，中心不跑；
 *   6. 面板变换区读数与画布选框同源（同一份 SelectionFrame.bounds）。
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

const close = (a, b, tolerance = 0.001) => Math.abs(a - b) <= tolerance;

try {
  const { createDocument, DEFAULT_STYLE } = await server.ssrLoadModule('/src/core/document.ts');
  const factory = await server.ssrLoadModule('/src/core/factory.ts');
  const {
    frameLocalToWorld,
    getObjectBounds,
    objectLocalBounds,
    scaleDocumentObjectsInFrame,
    selectionBounds,
    selectionFrame
  } = await server.ssrLoadModule('/src/core/scene.ts');

  const style = {
    ...DEFAULT_STYLE,
    fill: { type: 'solid', color: '#cccccc' },
    stroke: { ...DEFAULT_STYLE.stroke, width: 14 }
  };

  const doc = createDocument('blank-landscape', '选框校验');
  const layerId = doc.layers[0].id;
  const rect = { ...factory.createRectObject(layerId, style, 360, 270, 340, 220), rotation: 30 };
  const ellipse = { ...factory.createEllipseObject(layerId, style, 120, 90, 200, 120), rotation: 30 };
  const text = {
    ...factory.createTextObject(layerId, style, { x: 200, y: 520 }, '选中框', 24),
    rotation: 30
  };
  doc.layers[0].objects.push(rect, ellipse, text);

  /** 把本地盒按 rotation 绕自身中心旋转，返回轴对齐范围。 */
  const rotatedFootprint = (box, rotation) => {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const corners = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height }
    ].map((point) => {
      const dx = point.x - cx;
      const dy = point.y - cy;
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    });
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    };
  };

  const cases = [
    ['矩形', rect, 340, 220],
    ['椭圆', ellipse, 200, 120],
    ['文本', text, text.width, text.height]
  ];

  for (const [name, object, width, height] of cases) {
    check(`${name}：选中框取未旋转本地盒`, () => {
      const frame = selectionFrame(doc, [object.id]);
      assert.ok(frame, '没有选中框');
      assert.equal(frame.rotation, 30);
      assert.ok(close(frame.bounds.x, object.x), '本地盒 x 不对');
      assert.ok(close(frame.bounds.y, object.y), '本地盒 y 不对');
      assert.ok(close(frame.bounds.width, width), `本地盒宽应为 ${width}，实际 ${frame.bounds.width}`);
      assert.ok(close(frame.bounds.height, height), `本地盒高应为 ${height}`);
      assert.ok(close(frame.center.x, object.x + width / 2), '中心不对');
    });

    check(`${name}：本地盒旋转 30° 后与真实包围盒重合`, () => {
      const frame = selectionFrame(doc, [object.id]);
      const footprint = rotatedFootprint(frame.bounds, frame.rotation);
      const bounds = getObjectBounds(object, doc);
      assert.ok(close(footprint.x, bounds.x, 0.01), `左边框偏移 ${footprint.x - bounds.x}`);
      assert.ok(close(footprint.y, bounds.y, 0.01), `上边框偏移 ${footprint.y - bounds.y}`);
      assert.ok(close(footprint.width, bounds.width, 0.01), '宽度不重合');
      assert.ok(close(footprint.height, bounds.height, 0.01), '高度不重合');
    });
  }

  check('旋转 90°：选框与包围盒仍然重合', () => {
    const rotated = { ...rect, rotation: 90 };
    doc.layers[0].objects = doc.layers[0].objects.map((obj) =>
      obj.id === rect.id ? rotated : obj
    );
    const frame = selectionFrame(doc, [rect.id]);
    const footprint = rotatedFootprint(frame.bounds, frame.rotation);
    const bounds = getObjectBounds(rotated, doc);
    assert.ok(close(footprint.x, bounds.x, 0.01));
    assert.ok(close(footprint.y, bounds.y, 0.01));
    assert.ok(close(footprint.width, bounds.width, 0.01));
    assert.ok(close(footprint.height, bounds.height, 0.01));
    // 90° 时宽度与高度互换，形状不会缩水成原方向的细条
    assert.ok(close(footprint.width, 220, 0.01), '90° 后宽度应为原高度');
    assert.ok(close(footprint.height, 340, 0.01), '90° 后高度应为原宽度');
    doc.layers[0].objects = doc.layers[0].objects.map((obj) =>
      obj.id === rect.id ? rect : obj
    );
  });

  check('多选：仍用轴对齐包围盒且不叠加旋转', () => {
    const frame = selectionFrame(doc, [rect.id, ellipse.id]);
    const union = selectionBounds(doc, [rect.id, ellipse.id]);
    assert.ok(frame && union);
    assert.equal(frame.rotation, 0);
    assert.ok(close(frame.bounds.x, union.x));
    assert.ok(close(frame.bounds.width, union.width));
  });

  check('旋转后改宽：改本地尺寸，锚点不动', () => {
    const before = selectionFrame(doc, [rect.id]);
    assert.ok(before);
    const next = scaleDocumentObjectsInFrame(
      doc,
      [rect.id],
      before,
      frameLocalToWorld(before, { x: before.bounds.x, y: before.bounds.y }),
      200 / before.bounds.width,
      1
    );
    const updated = next.layers[0].objects.find((obj) => obj.id === rect.id);
    assert.ok(updated);
    assert.ok(close(updated.width, 200, 0.01), `宽度应变为 200，实际 ${updated.width}`);
    assert.ok(close(updated.height, 220, 0.01), '高度不应被改动');
    assert.ok(close(updated.rotation, 30), '旋转角不应被改动');
    // 锚点在左上：左边（本地 x）不动，右侧收缩
    assert.ok(close(updated.x, rect.x, 0.01), `本地 x 应保持 ${rect.x}，实际 ${updated.x}`);
  });

  check('分组：rotation 字段不参与渲染，选框不得叠加旋转', () => {
    const childA = factory.createRectObject(layerId, style, 40, 40, 60, 40);
    const childB = factory.createRectObject(layerId, style, 140, 60, 80, 60);
    const group = factory.createGroupObject(
      layerId,
      '分组',
      { x: 40, y: 40, width: 180, height: 80 },
      [childA.id, childB.id]
    );
    // 镜像/环系可能在分组上留下 rotation，但渲染期并不变换分组
    group.rotation = 45;
    childA.parentId = group.id;
    childB.parentId = group.id;
    doc.layers[0].objects.push(childA, childB, group);

    const frame = selectionFrame(doc, [group.id]);
    assert.ok(frame);
    assert.equal(frame.rotation, 0, '分组不应继承 rotation');
    const union = getObjectBounds(group, doc);
    const footprint = rotatedFootprint(frame.bounds, frame.rotation);
    assert.ok(close(footprint.x, union.x, 0.01), '分组选框与子对象包围盒不重合');
    assert.ok(close(footprint.width, union.width, 0.01));
    assert.ok(close(footprint.height, union.height, 0.01));

    doc.layers[0].objects = doc.layers[0].objects.filter(
      (obj) => obj.id !== group.id && obj.id !== childA.id && obj.id !== childB.id
    );
  });

  check('objectLocalBounds 与渲染期旋转参数一致', () => {
    // 渲染期用 rotate(angle, x + w/2, y + h/2)，本地盒中心必须与之相同
    const local = objectLocalBounds(rect, doc);
    assert.ok(close(local.x + local.width / 2, rect.x + rect.width / 2));
    assert.ok(close(local.y + local.height / 2, rect.y + rect.height / 2));
    // 未旋转对象的两种盒应完全一致
    const plain = { ...rect, rotation: 0 };
    const plainLocal = objectLocalBounds(plain, doc);
    const plainBounds = getObjectBounds(plain, doc);
    assert.ok(close(plainLocal.x, plainBounds.x) && close(plainLocal.width, plainBounds.width));
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
    ? `[frame-check] ${results.length} 项选框/旋转变换不变量全部通过`
    : `[frame-check] ${failed.length}/${results.length} 项失败`
);
process.exit(failed.length === 0 ? 0 : 1);
