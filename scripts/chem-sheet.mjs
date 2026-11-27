/**
 * 化学结构总表：在真实 VDraw 渲染进程里执行 scripts/chem-sheet.draw.js，
 * 校验拓扑/参数，并导出 vdraw / svg / png 到 artifacts/。
 *
 * 用法：
 *   node scripts/chem-sheet.mjs            # 绘制 + 校验 + 导出
 *   node scripts/chem-sheet.mjs --keep     # 结束后保留窗口（调试）
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const root = process.cwd();
const keep = process.argv.includes('--keep');
const port = 9461;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log('[chem-sheet]', ...args);

log('starting vite...');
const server = await createServer({
  configFile: 'vite.config.ts',
  logLevel: 'warn'
});
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error('vite dev server 未启动');
log('vite', url);

const profileDir = path.resolve(os.tmpdir(), `vdraw-chem-profile-${Date.now()}`);
const env = { ...process.env, VITE_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
log('spawning electron', electronPath);
const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-sandbox'],
  { cwd: root, env, stdio: 'inherit', windowsHide: false }
);
child.on('error', (error) => console.error('[chem-sheet] electron spawn error', error));
child.on('exit', (code) => log('electron exited', code));

let ws = null;
let nextId = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    if (!ws) {
      reject(new Error('CDP 未连接'));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} 超时`));
    }, 60000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function connect() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`electron 已退出：${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === 'page' && String(target.url).includes('5173')
      );
      if (page?.webSocketDebuggerUrl) {
        log('target', page.url);
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        ws.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (!message.id || !pending.has(message.id)) return;
          const { resolve, reject } = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        ws.addEventListener('close', () => {
          for (const { reject } of pending.values()) reject(new Error('CDP 已关闭'));
          pending.clear();
        });
        await send('Runtime.enable');
        await send('Page.enable');
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('electron 已退出')) throw error;
      /* 等待 electron 就绪 */
    }
    await sleep(400);
  }
  throw new Error('CDP 连接超时');
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description || result.exceptionDetails.text
    );
  }
  return result.result?.value;
}

async function waitForApp() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(
        `Boolean(window.vdraw) && document.readyState === 'complete'`
      );
      if (ready) {
        log('app ready');
        return;
      }
    } catch {
      /* 页面尚未完成导航 */
    }
    await sleep(400);
  }
  throw new Error('应用未就绪');
}

try {
  await connect();
  await waitForApp();

  const result = await evaluate(`(async () => {
    const sheet = await import('/scripts/chem-sheet.draw.js?t=' + Date.now());
    const drawn = sheet.drawSheet();
    const report = sheet.inspectSheet();
    const topology = drawn.validation;
    const store = (await import('/src/store/useAppStore.ts')).useAppStore;
    const svgMod = await import('/src/core/io/svg.ts');
    const rasterMod = await import('/src/core/io/raster.ts');
    const serMod = await import('/src/core/io/serialize.ts');
    const doc = store.getState().doc;
    return {
      drawn,
      report,
      topology,
      svg: svgMod.documentToSvgString(doc),
      png: await rasterMod.documentToPngBase64(doc, 1, false),
      vdraw: serMod.serializeDocument(doc),
      viewport: store.getState().viewport
    };
  })()`);
  log('drawn');

  const outDir = path.resolve(root, 'artifacts');
  await fs.mkdir(outDir, { recursive: true });
  const stem = '19种化合物结构式';
  await fs.writeFile(path.join(outDir, `${stem}.svg`), result.svg, 'utf8');
  await fs.writeFile(path.join(outDir, `${stem}.png`), Buffer.from(result.png, 'base64'));
  await fs.writeFile(path.join(outDir, `${stem}.vdraw`), result.vdraw, 'utf8');
  await fs.writeFile(
    path.join(outDir, `${stem}.report.json`),
    JSON.stringify(
      { drawn: result.drawn, report: result.report, topology: result.topology },
      null,
      2
    ),
    'utf8'
  );

  console.log(JSON.stringify({ report: result.report, topology: result.topology }, null, 2));
  console.log(`[chem-sheet] 已导出 artifacts/${stem}.vdraw|svg|png`);
  console.log(`[chem-sheet] 窗口缩放 ${(result.viewport.zoom * 100).toFixed(1)}%`);

  if (keep) {
    console.log('[chem-sheet] --keep：保持窗口 120s');
    await sleep(120000);
  }
} catch (error) {
  console.error('[chem-sheet] 失败：', error);
  process.exitCode = 1;
} finally {
  try {
    await send('Browser.close');
  } catch {
    /* 忽略关闭失败 */
  }
  child.kill();
  if (process.platform === 'win32' && child.pid) {
    // Windows 下主进程退出后渲染进程可能残留，按进程树清理。
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  await Promise.race([server.close(), sleep(5000)]);
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
}
