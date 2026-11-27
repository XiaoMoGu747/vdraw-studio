/**
 * 交互式化学工具验证：91px 键长下插入苯环、点击键身并环、点击顶点挂环。
 * 用法：node scripts/chem-tool-check.mjs
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const root = process.cwd();
const port = 9462;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log('[chem-tool]', ...args);

const server = await createServer({ configFile: 'vite.config.ts', logLevel: 'warn' });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
const profileDir = path.resolve(os.tmpdir(), `vdraw-chem-tool-${Date.now()}`);
const env = { ...process.env, VITE_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-sandbox'],
  { cwd: root, env, stdio: 'inherit', windowsHide: false }
);

let ws = null;
let nextId = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    if (!ws) return reject(new Error('CDP 未连接'));
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
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find(
        (target) => target.type === 'page' && String(target.url).includes('5173')
      );
      if (page?.webSocketDebuggerUrl) {
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
      if (
        await evaluate(`Boolean(window.vdraw) && document.readyState === 'complete'`)
      ) {
        return;
      }
    } catch {
      /* 等待导航 */
    }
    await sleep(400);
  }
  throw new Error('应用未就绪');
}

/** 页面坐标 → 客户端坐标（用场景组真实屏幕矩阵）。 */
async function toClient(pagePoint) {
  return evaluate(`(() => {
    const g = document.querySelector('[data-testid="canvas-hit"] svg > g');
    if (!g) return null;
    const p = new DOMPoint(${pagePoint.x}, ${pagePoint.y}).matrixTransform(g.getScreenCTM());
    return { x: p.x, y: p.y };
  })()`);
}

async function click(screen) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: screen.x,
    y: screen.y,
    button: 'left',
    clickCount: 1
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: screen.x,
    y: screen.y,
    button: 'left',
    clickCount: 1
  });
  await sleep(250);
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  if (result.data) {
    await fs.writeFile(
      path.resolve(root, 'artifacts', name),
      Buffer.from(result.data, 'base64')
    );
  }
}

const summary = {};
try {
  await connect();
  await waitForApp();

  await evaluate(`(async () => {
    window.__chemTool = {
      store: (await import('/src/store/useAppStore.ts')).useAppStore,
      createDocument: (await import('/src/core/document.ts')).createDocument
    };
    return true;
  })()`);
  log('modules loaded');

  await evaluate(`(() => {
    const { store, createDocument } = window.__chemTool;
    store.getState().loadDocument(createDocument('chem-sheet', '化学工具验证'), null, false);
    const state = store.getState();
    state.setChemBondLength(91);
    state.setChemBondWidth(5);
    state.setChemBondSpacing(20);
    state.setChemRingBondSpacing(20);
    state.setChemAtomSize(55);
    state.setChem({ ringTemplateId: 'benzene', benzeneStyle: 'kekule' });
    state.setTool('ring');
    state.updateDoc({
      ...store.getState().doc,
      page: { ...store.getState().doc.page, width: 1200, height: 900 },
      grid: { ...store.getState().doc.grid, visible: false, snap: false }
    }, true);
    store.getState().fitToCanvas();
    return true;
  })()`);
  log('document ready');
  await sleep(500);

  const center = await toClient({ x: 420, y: 420 });
  log('insert ring at', center);
  await click(center);

  summary.afterInsert = await evaluate(`(() => {
    const { store } = window.__chemTool;
    const doc = store.getState().doc;
    const all = doc.layers.flatMap((layer) => layer.objects);
    const groups = all.filter((object) => object.type === 'group' && object.ringFrame);
    const bonds = all.filter((object) => object.type === 'bond');
    return {
      groups: groups.length,
      bonds: bonds.length,
      lengths: [...new Set(bonds.map((bond) => Math.round(Math.hypot(bond.end.x - bond.start.x, bond.end.y - bond.start.y) * 10) / 10))],
      group: groups[0] ? { id: groups[0].id, x: groups[0].x, y: groups[0].y, width: groups[0].width, height: groups[0].height, children: groups[0].childIds.length } : null,
      bondPoints: bonds.map((bond) => ({ id: bond.id, start: bond.start, end: bond.end, type: bond.bondType }))
    };
  })()`);
  log('after insert', summary.afterInsert.groups, summary.afterInsert.bonds, summary.afterInsert.lengths);
  await shot('chem-tool-1-ring.png');

  // 取最右侧竖直边的中点作为并环点击点。
  const rightEdge = summary.afterInsert.bondPoints
    .map((bond) => ({
      ...bond,
      mx: (bond.start.x + bond.end.x) / 2,
      my: (bond.start.y + bond.end.y) / 2
    }))
    .sort((a, b) => b.mx - a.mx)[0];
  const fusePoint = await toClient({ x: rightEdge.mx, y: rightEdge.my });
  log('fuse click at page', rightEdge.mx, rightEdge.my, 'client', fusePoint);
  await click(fusePoint);

  summary.afterFuse = await evaluate(`(() => {
    const { store } = window.__chemTool;
    const doc = store.getState().doc;
    const all = doc.layers.flatMap((layer) => layer.objects);
    return {
      groups: all.filter((object) => object.type === 'group' && object.ringFrame).map((group) => ({ name: group.name, children: group.childIds.length, ringCenters: group.ringCenters ?? null })),
      bonds: all.filter((object) => object.type === 'bond').length,
      doubles: all.filter((object) => object.type === 'bond' && object.bondType === 'double').length,
      toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent)
    };
  })()`);
  log('after fuse', JSON.stringify(summary.afterFuse));
  await shot('chem-tool-2-fused.png');

  await evaluate(`(() => {
    window.__chemTool.store.getState().setTool('select');
    return true;
  })()`);

  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error('[chem-tool] 失败：', error);
  process.exitCode = 1;
} finally {
  try {
    await send('Browser.close');
  } catch {
    /* 忽略 */
  }
  child.kill();
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  await Promise.race([server.close(), sleep(5000)]);
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
}
