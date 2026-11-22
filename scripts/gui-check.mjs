#!/usr/bin/env node
/**
 * 对打包后的 Windows 应用做一次真实 GUI 检查（不依赖 Playwright）。
 *
 * 原理：用 --remote-debugging-port 启动 release/win-unpacked/VDraw Studio.exe，
 * 通过 Chrome DevTools Protocol 点击“新建画布”，检查编辑器 DOM，并用
 * Page.captureScreenshot 保存截图。这样即使 Agent 没有可交互桌面，也能验证
 * 安装包内的 main/preload/dist 是否真的能启动并完成一次桌面交互。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 允许用 VDRAW_GUI_EXE 指向其它输出目录（例如打包时自定义了 directories.output）。
const exe = process.env.VDRAW_GUI_EXE
  ? path.resolve(root, process.env.VDRAW_GUI_EXE)
  : path.join(root, 'release', 'win-unpacked', 'VDraw Studio.exe');
const outDir = path.join(root, 'artifacts');
const port = Number(process.env.VDRAW_GUI_PORT || 9333);
const saveDir = path.join(path.dirname(exe), 'VDraw保存');
fs.rmSync(saveDir, { recursive: true, force: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!fs.existsSync(exe)) {
  console.error(`[gui] 未找到打包产物：${exe}\n先运行 npm run pack。`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${path.join(outDir, 'gui-profile')}`,
  '--no-sandbox'
], {
  cwd: root,
  env,
  stdio: 'ignore',
  windowsHide: false
});

let ws = null;
let nextId = 0;
const pending = new Map();
const pageErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function connect() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        ws.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (message.method === 'Runtime.exceptionThrown') {
            pageErrors.push(
              message.params?.exceptionDetails?.exception?.description ||
                message.params?.exceptionDetails?.text ||
                'unknown exception'
            );
          }
          if (
            message.method === 'Runtime.consoleAPICalled' &&
            message.params?.type === 'error'
          ) {
            pageErrors.push(
              message.params.args
                ?.map((arg) => arg.value || arg.description || '')
                .filter(Boolean)
                .join(' ')
            );
          }
          if (!message.id || !pending.has(message.id)) return;
          const { resolve, reject } = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        await send('Runtime.enable');
        await send('Page.enable');
        return;
      }
    } catch {
      /* 应用还在启动 */
    }
    await sleep(300);
  }
  throw new Error('等待 Electron 调试端口超时');
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        '页面脚本执行失败'
    );
  }
  return result.result?.value;
}

try {
  await connect();
  await sleep(800);
  const start = await evaluate(
    `(() => ({
      title: document.title,
      start: Boolean(document.querySelector('.start-page')),
      newButton: Boolean(document.querySelector('[data-testid="start-new"]'))
    }))()`
  );
  await evaluate(`document.querySelector('[data-testid="start-new"]').click()`);
  await sleep(400);
  await evaluate(`document.querySelector('[data-testid="create-canvas"]').click()`);
  await sleep(1200);
  const editor = await evaluate(
    `(() => ({
      shell: Boolean(document.querySelector('.editor-shell')),
      page: Boolean(document.querySelector('[data-testid="canvas-page"]')),
      title: document.querySelector('.titlebar__doc')?.textContent || null,
      tools: document.querySelectorAll('[data-tool]').length,
      errors: ${JSON.stringify(pageErrors)}
    }))()`
  );
  // 画一个偏右下角的矩形并选中它，用于验证「选中对象」预览是否完整居中。
  const dragOnPage = (x1, y1, x2, y2) =>
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      if (!hit || !page) return false;
      const r = page.getBoundingClientRect();
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 9, pointerType: 'mouse', isPrimary: true
      });
      const sx1 = r.left + r.width * ${x1};
      const sy1 = r.top + r.height * ${y1};
      const sx2 = r.left + r.width * ${x2};
      const sy2 = r.top + r.height * ${y2};
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx1, sy1, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts((sx1 + sx2) / 2, (sy1 + sy2) / 2, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(sx2, sy2, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(sx2, sy2, 0)));
      return true;
    })()`;
  // 工具导轨里形状是复合项（data-tool="shape"），用快捷键 R 切到矩形最稳。
  await evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))`
  );
  await sleep(200);
  await evaluate(dragOnPage(0.55, 0.52, 0.78, 0.78));
  await sleep(360);
  const drawnSelection = await evaluate(
    `(() => ({
      selected: document.querySelectorAll('.selection-layer [class*="handle"]').length > 0,
      objects: document.querySelectorAll('.scene-layer rect').length,
      sceneRects: document.querySelectorAll('.scene-layer > svg').length
    }))()`
  );

  // 旋转 30°：选框描边必须与图形同步旋转（曾经用旋转后的包围盒当选框，导致多转一次、
  // 30° 时残留原方向的矩形，只有 90° 才碰巧对齐）。
  await evaluate(`(() => {
    const tab = document.querySelector('[data-testid="sidebar-tab-properties"]');
    if (tab) tab.click();
    return Boolean(tab);
  })()`);
  await sleep(400);
  const setRotation = (deg) => `(() => {
    const field = [...document.querySelectorAll('.props-inline .field')].find(
      (el) => (el.querySelector('span')?.textContent || '').trim().startsWith('旋转')
    );
    if (!field) return 'no-rotation-field';
    const input = field.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, '${deg}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
    return 'ok';
  })()`;
  const applyRotation = await evaluate(setRotation(30));
  await sleep(420);
  const rotation = await evaluate(
    `(() => {
      const shape = document.querySelector('.scene-layer rect');
      const overlay = document.querySelector('.selection-overlay');
      const frameGroup = overlay ? overlay.querySelector('g[transform]') : null;
      const frameRect = overlay ? overlay.querySelector('rect') : null;
      if (!shape || !frameRect) return { shape: null, frame: null, match: false };
      const shapeBox = shape.getBoundingClientRect();
      const frameBox = frameRect.getBoundingClientRect();
      return {
        applyRotation: ${JSON.stringify(applyRotation)},
        shape: shape.getAttribute('transform'),
        frame: frameGroup ? frameGroup.getAttribute('transform') : null,
        delta: {
          x: Math.round(frameBox.x - shapeBox.x),
          y: Math.round(frameBox.y - shapeBox.y),
          w: Math.round(frameBox.width - shapeBox.width),
          h: Math.round(frameBox.height - shapeBox.height)
        },
        match: true
      };
    })()`
  );
  const rotationShot = await send('Page.captureScreenshot', { format: 'png' });
  const rotationShotPath = path.join(outDir, 'gui-packaged-rotate.png');
  fs.writeFileSync(rotationShotPath, Buffer.from(rotationShot.data, 'base64'));
  // 还原角度，后续导出预览断言仍按未旋转对象校验
  await evaluate(setRotation(0));
  await sleep(360);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(outDir, 'gui-packaged-editor.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  // 导出面板：确认打包版里三种导出范围都在，且面板没有溢出窗口。
  await evaluate(`document.querySelector('[data-testid="export-menu-button"]').click()`);
  await sleep(220);
  await evaluate(`document.querySelector('[data-testid="export-region-entry"]').click()`);
  await sleep(420);
  await evaluate(`document.querySelector('[data-testid="export-scope-selection"]').click()`);
  await sleep(360);
  const exportPanel = await evaluate(
    `(() => {
      const panel = document.querySelector('[data-testid="export-panel"]');
      const scopes = [...document.querySelectorAll('[data-testid^="export-scope-"]')]
        .filter((el) => el.tagName === 'BUTTON')
        .map((el) => el.textContent.trim());
      const formats = [...document.querySelectorAll('[data-testid^="export-format-"]')].map((el) => el.textContent.trim());
      if (!panel) return { panel: false, scopes, formats, fits: false };
      const rect = panel.getBoundingClientRect();
      const previewBox = panel.querySelector('.export-panel__preview');
      const previewImg = panel.querySelector('.export-panel__preview img');
      const boxRect = previewBox ? previewBox.getBoundingClientRect() : null;
      const imgRect = previewImg ? previewImg.getBoundingClientRect() : null;
      return {
        panel: true,
        scopes,
        formats,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scopeHint: panel.querySelector('[data-testid="export-scope-hint"]')?.textContent || '',
        outputSize: panel.querySelector('[data-testid="export-output-size"]')?.textContent || '',
        previewInside:
          Boolean(boxRect && imgRect) &&
          imgRect.left >= boxRect.left - 0.5 &&
          imgRect.top >= boxRect.top - 0.5 &&
          imgRect.right <= boxRect.right + 0.5 &&
          imgRect.bottom <= boxRect.bottom + 0.5,
        previewObjectFit: previewImg ? getComputedStyle(previewImg).objectFit : null,
        previewImg: imgRect
          ? { width: Math.round(imgRect.width), height: Math.round(imgRect.height) }
          : null,
        previewBoxSize: boxRect
          ? { width: Math.round(boxRect.width), height: Math.round(boxRect.height) }
          : null,
        fits: rect.bottom <= window.innerHeight && rect.right <= window.innerWidth && rect.top >= 0
      };
    })()`
  );
  // 单个矩形的预览必须严格居中且不贴边：按导出尺寸重量化，量四边留白。
  const previewInk = await evaluate(
    `(async () => {
      const img = document.querySelector('.export-panel__preview img');
      if (!img) return null;
      const hint = document.querySelector('[data-testid="export-scope-hint"]')?.textContent || '';
      const size = /(\\d+)\\s*×\\s*(\\d+)/.exec(hint);
      const width = size ? Number(size[1]) : 276;
      const height = size ? Number(size[2]) : 226;
      const source = new Image();
      source.src = img.getAttribute('src');
      await source.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(source, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 4;
          if (data[index] < 210 || data[index + 1] < 210 || data[index + 2] < 210) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return { empty: true, width, height };
      return {
        empty: false,
        width,
        height,
        left: minX,
        top: minY,
        right: width - 1 - maxX,
        bottom: height - 1 - maxY
      };
    })()`
  );

  const exportShot = await send('Page.captureScreenshot', { format: 'png' });
  const exportShotPath = path.join(outDir, 'gui-packaged-export.png');
  fs.writeFileSync(exportShotPath, Buffer.from(exportShot.data, 'base64'));

  // 预览框放大截图：人工核对「对象完整、居中、不裁切」。
  const previewRect = await evaluate(
    `(() => {
      const el = document.querySelector('.export-panel__preview');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`
  );
  if (previewRect && previewRect.width > 8 && previewRect.height > 8) {
    const previewShot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...previewRect, scale: 3 }
    });
    fs.writeFileSync(
      path.join(outDir, 'gui-packaged-export-preview.png'),
      Buffer.from(previewShot.data, 'base64')
    );
  }
  await evaluate(`document.querySelector('[aria-label="关闭导出面板"]').click()`);
  await sleep(220);

  // 默认保存位置：点击画布页保存按钮，应直接写入 exe 同级的“VDraw保存”，不再弹选择框。
  await evaluate(`document.querySelector('[data-testid="save-button"]').click()`);
  await sleep(1200);
  const save = await evaluate(
    `(() => ({
      button: Boolean(document.querySelector('[data-testid="save-button"]')),
      chip: document.querySelector('.titlebar__unsaved')?.textContent || null,
      path: document.querySelector('.titlebar__unsaved')?.title || null
    }))()`
  );
  const savedFiles = fs.existsSync(saveDir)
    ? fs.readdirSync(saveDir).filter((name) => name.endsWith('.vdraw'))
    : [];

  // 返回启动页：保存后点击左上返回按钮，应回到启动页而不是退出应用。
  await evaluate(`document.querySelector('[data-testid="back-to-start"]').click()`);
  await sleep(500);
  const navigation = await evaluate(
    `(() => ({
      start: Boolean(document.querySelector('.start-page')),
      editor: Boolean(document.querySelector('.editor-shell'))
    }))()`
  );

  const report = {
    start,
    editor,
    rotation,
    exportPanel: { ...exportPanel, previewInk },
    save: { ...save, directory: saveDir, files: savedFiles },
    navigation,
    screenshots: { editor: shotPath, rotate: rotationShotPath, exportPanel: exportShotPath },
    exe,
    port
  };
  fs.writeFileSync(path.join(outDir, 'gui-packaged-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (
    !start.start ||
    !start.newButton ||
    !editor.shell ||
    !editor.page ||
    editor.tools < 10 ||
    pageErrors.length > 0 ||
    rotation.applyRotation !== 'ok' ||
    !rotation.match ||
    rotation.shape !== rotation.frame ||
    rotation.delta.x !== 0 ||
    rotation.delta.y !== 0 ||
    rotation.delta.w !== 0 ||
    rotation.delta.h !== 0 ||
    !exportPanel.panel ||
    exportPanel.scopes.length !== 3 ||
    exportPanel.formats.length !== 4 ||
    !exportPanel.fits ||
    !exportPanel.previewInside ||
    exportPanel.previewObjectFit !== 'contain' ||
    !exportPanel.scopeHint.includes('选中 1 个对象') ||
    !previewInk ||
    previewInk.empty ||
    previewInk.left < 4 ||
    previewInk.top < 4 ||
    previewInk.right < 4 ||
    previewInk.bottom < 4 ||
    Math.abs(previewInk.left - previewInk.right) > 2 ||
    Math.abs(previewInk.top - previewInk.bottom) > 2 ||
    !save.button ||
    save.chip !== '已保存' ||
    savedFiles.length !== 1 ||
    !navigation.start ||
    navigation.editor
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error('[gui] failed:', error);
  process.exitCode = 1;
} finally {
  try {
    if (ws) ws.close();
  } catch {
    /* ignore */
  }
  child.kill();
  await sleep(500);
}