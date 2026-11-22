#!/usr/bin/env node
/**
 * 画笔"实时层 → 矢量层"交接一致性检查（打包产物）。
 *
 * 对硬笔 / 铅笔 / 硬圆 / 马克各画一条横线：
 *   1. 松手前截取实时 Canvas 的画面；
 *   2. 松手并淡出后截取矢量成品；
 *   3. 在页面内解码两张 PNG，比较墨迹面积、中段宽度、末端宽度与平均浓度。
 *
 * 目标：松手前后不应出现"变浅 / 变细"；末端渐隐在两侧都应存在。
 * 阈值刻意留宽，避免抗锯齿与截图缩放造成误报，但足以拦住旧版 30%–60% 的偏差。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.VDRAW_GUI_EXE
  ? path.resolve(root, process.env.VDRAW_GUI_EXE)
  : path.join(root, 'release', 'win-unpacked', 'VDraw Studio.exe');
const outDir = path.join(root, 'artifacts');
const port = Number(process.env.VDRAW_BRUSH_PORT || 9335);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!fs.existsSync(exe)) {
  console.error(`[brush-handoff] 未找到打包产物：${exe}\n先运行 npm run pack。`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  exe,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(outDir, 'brush-handoff-profile')}`,
    '--no-sandbox'
  ],
  { cwd: root, env, stdio: 'ignore', windowsHide: false }
);

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
  const deadline = Date.now() + 25000;
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

async function waitFor(selector, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return true;
    await sleep(250);
  }
  return false;
}

/**
 * 截图采样倍率固定为 1（1 图像像素 = 1 CSS 像素）。
 * 不要超采样：实时层是 1x 位图的上采样，SVG 是矢量重绘，
 * 放大取样会同时放大量化噪声与"位图 vs 矢量"的边缘差异。
 */
const SHOT_SCALE = 1;

async function clipShot(clip) {
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      scale: SHOT_SCALE
    },
    captureBeyondViewport: false
  });
  return `data:image/png;base64,${shot.data}`;
}

/** 在页面内解码 PNG，统计每列墨迹宽度、面积与浓度。 */
const ANALYZER = `
  async (dataUrl) => {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const widths = new Array(width).fill(0);
    let darkSum = 0;
    let darkCount = 0;
    for (let x = 0; x < width; x += 1) {
      let count = 0;
      for (let y = 0; y < height; y += 1) {
        const i = (y * width + x) * 4;
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (lum < 200) {
          count += 1;
          darkSum += 235 - lum;
          darkCount += 1;
        }
      }
      widths[x] = count;
    }
    const inkCols = [];
    for (let x = 0; x < width; x += 1) if (widths[x] > 0) inkCols.push(x);
    if (inkCols.length === 0) {
      return { empty: true, area: 0, mid: 0, end: 0, darkness: 0, columns: 0 };
    }
    const first = inkCols[0];
    const last = inkCols[inkCols.length - 1];
    const mid = widths[Math.round((first + last) / 2)] || 0;
    const tail = widths.slice(Math.max(0, last - 1), last + 1);
    const end = tail.reduce((sum, value) => sum + value, 0) / Math.max(1, tail.length);
    const area = widths.reduce((sum, value) => sum + value, 0);
    return {
      empty: false,
      area,
      mid,
      end,
      endRatio: mid > 0 ? end / mid : 0,
      darkness: darkCount > 0 ? darkSum / darkCount / 235 : 0,
      columns: inkCols.length
    };
  }
`;

const PRESETS = [
  { id: 'pen', label: '硬笔', y: 0.18 },
  { id: 'pencil', label: '铅笔', y: 0.38 },
  { id: 'round', label: '硬圆', y: 0.58 },
  { id: 'marker', label: '马克', y: 0.78 }
];

const report = { presets: {}, smoothing: {}, failures: [], pageErrors };
const ratio = (after, before) => (before > 0 ? after / before : 0);

try {
  await connect();
  const startReady = await waitFor('[data-testid="start-new"]', 12000);
  if (startReady) {
    await evaluate(`document.querySelector('[data-testid="start-new"]').click()`);
    await sleep(400);
    await waitFor('[data-testid="create-canvas"]', 6000);
    await evaluate(`document.querySelector('[data-testid="create-canvas"]').click()`);
  }
  await waitFor('.editor-shell', 12000);
  await sleep(800);

  // 关网格，避免浅色网格被算成墨迹。
  await evaluate(`(() => {
    const grid = [...document.querySelectorAll('.statusbar__toggle')].find(
      (el) => (el.getAttribute('title') || '').includes('网格')
    );
    if (grid && grid.getAttribute('aria-pressed') === 'true') grid.click();
    return true;
  })()`);

  // 左侧停靠栏在 1080 窗口默认折叠，先展开才能点到笔刷预设卡。
  await evaluate(`(() => {
    const dock = document.querySelector('.left-dock');
    if (dock?.getAttribute('data-collapsed') === 'true') {
      document.querySelector('[data-testid="left-dock-expand"]')?.click();
    }
    return true;
  })()`);
  await sleep(300);
  await evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))`
  );
  await waitFor('[data-brush="marker"]', 6000);
  await sleep(300);

  for (const preset of PRESETS) {
    await evaluate(`document.querySelector('[data-brush="${preset.id}"]').click()`);
    await sleep(220);
    if (preset.id === 'round') {
      report.smoothing.round = await evaluate(
        `document.querySelector('[data-testid="brush-smoothing"]')?.value || null`
      );
    }

    const countStrokes = () =>
      evaluate(`document.querySelectorAll('.scene-layer path[data-brush-main]').length`);
    const before = await countStrokes();
    let attempt = 0;
    let live = null;
    let committed = null;
    let scene = null;
    // 合成指针事件在冷启动时偶尔会整笔丢失（没落笔，不是渲染差异）：重画一次再测。
    while (attempt < 3) {
      attempt += 1;
      const geometry = await evaluate(`(() => {
        const page = document.querySelector('[data-testid="canvas-page"]');
        const r = page.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      })()`);
      const y = geometry.top + geometry.height * preset.y;
      const x1 = geometry.left + geometry.width * 0.35;
      const x2 = geometry.left + geometry.width * 0.65;
      const clip = {
        x: Math.max(0, x1 - 28),
        y: Math.max(0, y - 32),
        width: x2 - x1 + 56,
        height: 64
      };

      await evaluate(`(() => {
        const hit = document.querySelector('[data-testid="canvas-hit"]');
        const opts = (x, y, buttons) => ({
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          button: 0, buttons, pointerId: 11, pointerType: 'mouse', isPrimary: true
        });
        hit.dispatchEvent(new PointerEvent('pointerdown', opts(${x1}, ${y}, 1)));
        for (let step = 1; step <= 24; step += 1) {
          const t = step / 24;
          hit.dispatchEvent(
            new PointerEvent('pointermove', opts(${x1} + (${x2} - ${x1}) * t, ${y}, 1))
          );
        }
        return true;
      })()`);
      await evaluate(
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
      );

      live = await clipShot(clip);
      await evaluate(`(() => {
        const hit = document.querySelector('[data-testid="canvas-hit"]');
        hit.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, clientX: ${x2}, clientY: ${y},
          button: 0, buttons: 0, pointerId: 11, pointerType: 'mouse', isPrimary: true
        }));
        return true;
      })()`);
      await sleep(500);
      committed = await clipShot(clip);

      // 诊断：松手后场景里的对象数/笔迹数（用来区分"没提交"与"截图时机太早"）。
      scene = await evaluate(`(() => ({
        objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
        main: document.querySelectorAll('.scene-layer path[data-brush-main]').length,
        inkOpacity: document.querySelector('[data-testid="brush-ink"]')?.style.opacity || null
      }))()`);
      if (scene.main > before) break;
      await sleep(160);
    }
    const liveMetrics = await evaluate(`(${ANALYZER})(${JSON.stringify(live)})`);
    const committedMetrics = await evaluate(`(${ANALYZER})(${JSON.stringify(committed)})`);
    const liveMass = liveMetrics.area * liveMetrics.darkness;
    const committedMass = committedMetrics.area * committedMetrics.darkness;
    const entry = {
      attempts: attempt,
      scene,
      live: liveMetrics,
      committed: committedMetrics,
      areaRatio: ratio(committedMetrics.area, liveMetrics.area),
      midRatio: ratio(committedMetrics.mid, liveMetrics.mid),
      darknessRatio: ratio(committedMetrics.darkness, liveMetrics.darkness),
      massRatio: ratio(committedMass, liveMass),
      endRatioDelta: Math.abs(committedMetrics.endRatio - liveMetrics.endRatio)
    };
    report.presets[preset.id] = entry;

    const fail = [];
    if (liveMetrics.empty || committedMetrics.empty) fail.push('empty');
    // 细线（铅笔 2.4px）在 64% 缩放下只有 1–2 个屏幕像素，
    // 宽度阈值会被抗锯齿放大；以"面积×浓度"的墨量为主，宽度只做粗筛。
    // 细线的抗锯齿落点会带来 ±15% 的墨量波动；旧版逐段叠色的偏差在 40% 以上。
    if (entry.massRatio < 0.82 || entry.massRatio > 1.25) fail.push('mass');
    // 2–3 个屏幕像素宽的细线，SVG 与 Canvas 的抗锯齿落点不同，
    // 宽度/面积会差 1px；这类笔刷只看墨量与末端比例。
    // 指标都以截图采样像素为单位（SHOT_SCALE 倍），阈值同步换算。
    const thin = liveMetrics.mid <= 3 * SHOT_SCALE;
    if (!thin) {
      if (entry.areaRatio < 0.85 || entry.areaRatio > 1.2) fail.push('area');
      if (entry.midRatio < 0.85 || entry.midRatio > 1.2) fail.push('width');
    }
    // 末端判定统一用绝对像素差：末端只统计最后两列，细线上 1px 抗锯齿
    // 就会把"末端/中段"比例放大到 0.5 以上（2→3px 得 0.667，2.5→2px 得 1.25），
    // 用比例判会稳定误报。容差取中段宽度的 25%，且不小于 1px。
    const endTolerance = Math.max(1, liveMetrics.mid * 0.25);
    if (Math.abs(committedMetrics.end - liveMetrics.end) > endTolerance) fail.push('end');
    if (entry.darknessRatio < 0.75 || entry.darknessRatio > 1.3) fail.push('darkness');
    if (fail.length > 0) report.failures.push({ preset: preset.id, fail });
  }

  // 硬圆预设不应再带全局平滑。
  if (report.smoothing.round !== '0') report.failures.push({ preset: 'round', fail: ['smoothing'] });

  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    path.join(outDir, 'brush-handoff.png'),
    Buffer.from(screenshot.data, 'base64')
  );
  fs.writeFileSync(
    path.join(outDir, 'brush-handoff.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length > 0 || pageErrors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error('[brush-handoff] 失败：', error);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  child.kill();
  await sleep(400);
}
