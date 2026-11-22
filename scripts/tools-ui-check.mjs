#!/usr/bin/env node
/**
 * 工具入口可达性检查（打包产物）：验证 P0/P1 新增的面板与入口真的出现在 UI 里。
 *
 * 原理与 gui-check.mjs 一致：启动 release/win-unpacked 的可执行文件，
 * 通过 CDP 创建画布并点击工具入口，检查关键 data-testid 是否存在。
 * 不依赖 Playwright，可在无交互桌面的环境运行。
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
const port = Number(process.env.VDRAW_TOOLS_PORT || 9334);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!fs.existsSync(exe)) {
  console.error(`[tools-ui] 未找到打包产物：${exe}\n先运行 npm run pack。`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  exe,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(outDir, 'tools-ui-profile')}`,
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

const key = (value, extra = '') =>
  `window.dispatchEvent(new KeyboardEvent('keydown', { key: '${value}', bubbles: true ${extra} }))`;
const keyOn = (selector, value) =>
  `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: '${value}', bubbles: true }));
    return true;
  })()`;
const toolLabel = () =>
  `(document.querySelector('[data-testid="status-tool"]')?.textContent || '').trim()`;
const click = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
const exists = (selector) => `Boolean(document.querySelector(${JSON.stringify(selector)}))`;

const checks = {};
const check = (name, value) => {
  checks[name] = Boolean(value);
};

async function waitFor(selector, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(exists(selector))) return true;
    await sleep(250);
  }
  return false;
}

try {
  await connect();
  // 冷启动可能较慢：等到开始页或编辑器出现，再决定后续操作。
  const startReady = await waitFor('[data-testid="start-new"]', 12000);
  if (startReady) {
    await evaluate(`document.querySelector('[data-testid="start-new"]').click()`);
    await sleep(400);
    const createReady = await waitFor('[data-testid="create-canvas"]', 6000);
    if (!createReady) throw new Error('新建画布入口未出现');

    // 0) 启动页：自定义快捷模板可保存 / 套用 / 删除
    check('customPresetEntry', await evaluate(exists('[data-testid="custom-template-add"]')));
    await evaluate(click('[data-testid="custom-template-add"]'));
    await sleep(240);
    check('customPresetForm', await evaluate(exists('[data-testid="custom-template-form"]')));
    // 平滑滚动是异步的：轮询到表单进入可视区再断言，避免固定等待偶发失败。
    const readPresetFormMetrics = () => evaluate(`(() => {
      const form = document.querySelector('[data-testid="custom-template-form"]');
      const body = document.querySelector('.modal__body');
      if (!form || !body) return null;
      const f = form.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      const name = document.querySelector('[data-testid="custom-template-name"]').getBoundingClientRect();
      const w = document.querySelector('[data-testid="custom-template-width"]').getBoundingClientRect();
      const save = document.querySelector('[data-testid="custom-template-save"]').getBoundingClientRect();
      const inside = (r) => r.left >= f.left - 1 && r.right <= f.right + 1 && r.top >= f.top - 1 && r.bottom <= f.bottom + 1;
      return {
        inside: inside(name) && inside(w) && inside(save),
        nameAboveSize: name.bottom <= w.top + 1,
        visible: f.top >= b.top - 1 && f.bottom <= b.bottom + 1,
        formTop: Math.round(f.top),
        formBottom: Math.round(f.bottom),
        bodyTop: Math.round(b.top),
        bodyBottom: Math.round(b.bottom),
        bodyScrollTop: Math.round(body.scrollTop),
        bodyScrollHeight: Math.round(body.scrollHeight),
        bodyClientHeight: Math.round(body.clientHeight)
      };
    })()`);
    for (let attempt = 0; attempt < 14; attempt += 1) {
      checks.presetFormMetrics = await readPresetFormMetrics();
      if (checks.presetFormMetrics?.visible) break;
      await sleep(140);
    }
    check(
      'presetFormLayout',
      Boolean(
        checks.presetFormMetrics &&
          checks.presetFormMetrics.inside &&
          checks.presetFormMetrics.nameAboveSize
      )
    );
    check(
      'presetFormAutoScroll',
      Boolean(checks.presetFormMetrics && checks.presetFormMetrics.visible)
    );
    // 表单展开时也不能出现第二个高亮：＋自定义模板只是开合按钮，不参与选中。
    checks.formOpenActive = await evaluate(
      `document.querySelectorAll('.template-grid .template-chip.is-active').length`
    );
    check('formOpenSingleSelection', checks.formOpenActive === 1);
    const presetFormShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      path.join(outDir, 'ui-check-preset-form.png'),
      Buffer.from(presetFormShot.data, 'base64')
    );
    await evaluate(`(() => {
      const set = (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      set('[data-testid="custom-template-name"]', '检查模板');
      set('[data-testid="custom-template-width"]', '900');
      set('[data-testid="custom-template-height"]', '600');
      return true;
    })()`);
    await sleep(220);
    await evaluate(click('[data-testid="custom-template-save"]'));
    await sleep(320);
    checks.customPresetText = await evaluate(
      `(() => {
        const chip = [...document.querySelectorAll('[data-custom-template]')].find((el) => el.textContent.includes('检查模板'));
        return chip ? chip.textContent.replace(/\\s+/g, ' ').trim() : null;
      })()`
    );
    check(
      'customPresetSaved',
      Boolean(checks.customPresetText && checks.customPresetText.includes('900'))
    );
    const presetShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      path.join(outDir, 'ui-check-presets.png'),
      Buffer.from(presetShot.data, 'base64')
    );
    await evaluate(`(() => {
      const chip = [...document.querySelectorAll('[data-custom-template]')].find((el) => el.textContent.includes('检查模板'));
      chip?.click();
      return Boolean(chip);
    })()`);
    await sleep(260);
    checks.presetApplied = await evaluate(
      `(document.querySelector('[data-testid="canvas-width"]')?.value || '') + 'x' + (document.querySelector('[data-testid="canvas-height"]')?.value || '')`
    );
    check('customPresetApplied', checks.presetApplied === '900x600');
    // 互斥单选：套用自定义模板后，全网格只有它一个高亮
    checks.presetSelection = await evaluate(`(() => {
      const active = [...document.querySelectorAll('.template-grid .template-chip.is-active')];
      return { count: active.length, custom: active[0]?.hasAttribute('data-custom-template') ?? false };
    })()`);
    check(
      'presetSingleSelection',
      Boolean(
        checks.presetSelection &&
          checks.presetSelection.count === 1 &&
          checks.presetSelection.custom
      )
    );
    // 点回内置模板：仍然只有一个高亮，且换成内置模板
    await evaluate(click('[data-template="a4-portrait"]'));
    await sleep(280);
    checks.templateSelection = await evaluate(`(() => {
      const active = [...document.querySelectorAll('.template-grid .template-chip.is-active')];
      return { count: active.length, id: active[0]?.getAttribute('data-template') || null };
    })()`);
    check(
      'templateSingleSelection',
      Boolean(
        checks.templateSelection &&
          checks.templateSelection.count === 1 &&
          checks.templateSelection.id === 'a4-portrait'
      )
    );
    // 删除测试模板，避免污染后续运行
    await evaluate(`(() => {
      const chip = [...document.querySelectorAll('[data-custom-template]')].find((el) => el.textContent.includes('检查模板'));
      const id = chip?.getAttribute('data-custom-template');
      if (!id) return false;
      document.querySelector('[data-testid="custom-template-remove-' + id + '"]')?.click();
      return true;
    })()`);
    await sleep(280);
    check(
      'customPresetRemoved',
      await evaluate(
        `![...document.querySelectorAll('[data-custom-template]')].some((el) => el.textContent.includes('检查模板'))`
      )
    );

    await evaluate(`document.querySelector('[data-testid="create-canvas"]').click()`);
  }
  const editorReady = await waitFor('.editor-shell', 12000);
  if (!editorReady) throw new Error('编辑器未加载');
  await sleep(700);

  // 0) 调色板：左上角展开按钮 + 填充/描边分行标注
  check('paletteFillRow', await evaluate(exists('[data-testid="palette-row-fill"]')));
  check('paletteStrokeRow', await evaluate(exists('[data-testid="palette-row-stroke"]')));
  checks.paletteRowNames = await evaluate(
    `[...document.querySelectorAll('.palette-row__name')].map((el) => el.textContent.trim()).join('/')`
  );
  check(
    'paletteHexSplit',
    await evaluate(
      `Boolean(document.querySelector('[data-testid="palette-fill-hex"]')) && Boolean(document.querySelector('[data-testid="palette-stroke-hex"]'))`
    )
  );
  check(
    'paletteExpandTopLeft',
    await evaluate(`(() => {
      const btn = document.querySelector('[data-testid="color-expand"]');
      const panel = document.querySelector('[data-testid="color-panel"]');
      if (!btn || !panel) return false;
      const b = btn.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return b.left - p.left <= 8 && b.top - p.top <= 10;
    })()`)
  );
  // 最近颜色：三个色块必须在默认视图内并排完整显示，不需要横向滑动。
  await evaluate(click('[data-testid="color-entry"]'));
  await sleep(340);
  await evaluate(click('[data-color-mode="palette"]'));
  await sleep(220);
  await evaluate(`(() => {
    const swatches = [...document.querySelectorAll('.color-grid .swatch')];
    [0, 2, 4].forEach((index) => swatches[index]?.click());
    return true;
  })()`);
  await sleep(320);
  // 用面板自带的关闭按钮收起：Esc 由焦点陷阱监听，合成事件不一定能送达。
  await evaluate(click('.color-popover__close'));
  await sleep(340);
  checks.recentSwatches = await evaluate(`(() => {
    const row = document.querySelector('.palette-recent');
    const panel = document.querySelector('[data-testid="color-panel"]');
    if (!row || !panel) return null;
    const pr = panel.getBoundingClientRect();
    const items = [...row.querySelectorAll('.swatch--quick')];
    return {
      count: items.length,
      overflow: Math.round(row.scrollWidth - row.clientWidth),
      fits: items.every((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 16 && r.right <= pr.right + 0.5 && r.left >= pr.left - 0.5;
      })
    };
  })()`);
  check(
    'recentSwatchesFit',
    Boolean(
      checks.recentSwatches &&
        checks.recentSwatches.count === 3 &&
        checks.recentSwatches.fits &&
        checks.recentSwatches.overflow <= 1
    )
  );
  const paletteShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    path.join(outDir, 'ui-check-palette.png'),
    Buffer.from(paletteShot.data, 'base64')
  );

  // 1) Ctrl+K 命令面板：可搜索、可关闭
  await evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`
  );
  await sleep(250);
  check('paletteOpened', await evaluate(exists('[data-testid="command-input"]')));
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="command-input"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '导出');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(220);
  check(
    'paletteFiltered',
    (await evaluate(`document.querySelectorAll('.command-palette__item').length`)) > 0
  );
  await evaluate(keyOn('[data-testid="command-input"]', 'Escape'));
  await sleep(250);
  check('paletteClosed', !(await evaluate(exists('[data-testid="command-input"]'))));

  // 2) ? 快捷键一览：覆盖全部工具（>= 24 行）
  await evaluate(key('?'));
  await sleep(280);
  const shortcutRows = await evaluate(`document.querySelectorAll('.shortcut-list li').length`);
  check('shortcutOverlay', shortcutRows >= 24);
  await evaluate(keyOn('.modal', 'Escape'));
  await sleep(320);
  checks.shortcutClosed = !(await evaluate(exists('.shortcut-sheet')));

  // 3) 辅助线高级设置（P0：线密度/参考长度/透视变形必须可达）
  check('guidesTool', await evaluate(click('[data-tool="guides"]')));
  await sleep(320);
  check('guideMoreButton', await evaluate(exists('[data-testid="guide-more"]')));
  await evaluate(click('[data-testid="guide-more"]'));
  await sleep(260);
  check('guideDensity', await evaluate(exists('[data-testid="guide-density"]')));
  check('guideSpacing', await evaluate(exists('[data-testid="guide-spacing"]')));
  check('guideWarp', await evaluate(exists('[data-testid="guide-perspective-apply"]')));

  // 4) 化学：元素 / 官能团模板网格（二级面板只保留模板，不再挂原子属性列）
  check('chemTool', await evaluate(click('[data-tool="chemistry"]')));
  await sleep(320);
  check('chemDock', await evaluate(exists('[data-testid="chem-dock"]')));
  await evaluate(click('[data-chem-category="bond"]'));
  await sleep(280);
  check('bondFixedLength', await evaluate(exists('[data-testid="bond-fixed-length"]')));
  check('bondWidthLock', await evaluate(exists('[data-testid="bond-width-lock"]')));
  // 锁定状态会随偏好持久化：先归一到「锁定」，保证本段断言可重复运行。
  const bondWidthLockedAtStart = await evaluate(
    `document.querySelector('[data-testid="bond-width-lock"]')?.getAttribute('aria-pressed') === 'true'`
  );
  if (!bondWidthLockedAtStart) {
    await evaluate(click('[data-testid="bond-width-lock"]'));
    await sleep(280);
  }
  check(
    'bondParamGlyphs',
    await evaluate(`document.querySelectorAll('.chem-param__glyph').length === 2`)
  );
  checks.bondLengthValue = (
    await evaluate(`(document.querySelector('[data-testid="bond-length-value"]')?.textContent || '').trim()`)
  );
  checks.bondWidthValue = (
    await evaluate(
      `(document.querySelector('[data-testid="bond-width-value"]')?.textContent || '').trim()`
    )
  );
  check('bondLengthShowsSetting', checks.bondLengthValue === '40px');
  // 键粗的「设置值」会随偏好保留（用户可能改过），这里校验格式与「锁回后回到同一个值」。
  const lockedBondWidth = checks.bondWidthValue;
  check('bondWidthShowsSetting', /^\d+(\.\d+)?px$/.test(String(lockedBondWidth)));
  // 解锁键粗后跟随左侧「大小」，再锁回设置值。
  await evaluate(`(() => {
    const el = document.querySelector('.dock-slider__head .input');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '5');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(240);
  await evaluate(click('[data-testid="bond-width-lock"]'));
  await sleep(280);
  checks.bondWidthUnlocked = (
    await evaluate(`(document.querySelector('[data-testid="bond-width-value"]')?.textContent || '').trim()`)
  );
  check('bondWidthFollowsSize', checks.bondWidthUnlocked === '5.0px');
  await evaluate(click('[data-testid="bond-width-lock"]'));
  await sleep(280);
  check(
    'bondWidthBackToSetting',
    (await evaluate(
      `(document.querySelector('[data-testid="bond-width-value"]')?.textContent || '').trim()`
    )) === lockedBondWidth
  );
  const bondBarShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    path.join(outDir, 'ui-check-bond-bar.png'),
    Buffer.from(bondBarShot.data, 'base64')
  );
  await evaluate(click('[data-chem-category="element"]'));
  await sleep(260);
  check('atomPresetGrid', await evaluate(exists('[data-testid="atom-preset-grid"]')));
  checks.elementPresets = await evaluate(
    `document.querySelectorAll('[data-chem-panel="element"] [data-atom]').length`
  );
  check('atomLabelCardRemoved', !(await evaluate(exists('[data-testid="atom-label-card"]'))));
  await evaluate(click('[data-chem-category="group"]'));
  await sleep(260);
  checks.groupPresets = await evaluate(
    `document.querySelectorAll('[data-chem-panel="group"] [data-atom]').length`
  );

  // 5) 环大小
  await evaluate(click('[data-chem-category="ring"]'));
  await sleep(260);
  check('ringScale', await evaluate(exists('[data-testid="ring-scale"]')));
  check('benzeneInsert', await evaluate(exists('[data-testid="benzene-insert"]')));

  // 6) 形状：多边形边数/星形、直线箭头、从中心
  await evaluate(key('g'));
  await sleep(320);
  checks.shapeToolLabel = (await evaluate(toolLabel())) === '多边形';
  check('polygonSides', await evaluate(exists('[data-testid="polygon-sides"]')));
  check('polygonStar', await evaluate(exists('[data-testid="polygon-star"]')));
  check('shapeFromCenter', await evaluate(exists('[data-testid="shape-from-center"]')));
  await evaluate(key('l'));
  await sleep(320);
  checks.lineToolLabel = (await evaluate(toolLabel())) === '直线';
  check('lineArrow', await evaluate(exists('[data-testid="line-arrow-end"]')));

  // 7) 文本：斜体/上下标/项目符号/对齐
  await evaluate(key('t'));
  await sleep(360);
  checks.textToolLabel = (await evaluate(toolLabel())) === '文本';
  // 文字工具现在弹出画布下方的"输入 + 工具"双面板，控件都在合成器里。
  check('textComposer', await evaluate(exists('[data-testid="text-composer"]')));
  check('textComposerInput', await evaluate(exists('[data-testid="text-composer-input"]')));
  check('textItalic', await evaluate(exists('[data-testid="text-italic-toggle"]')));
  check('textSuper', await evaluate(exists('[data-testid="text-superscript"]')));
  check('textSub', await evaluate(exists('[data-testid="text-subscript"]')));
  check('textBullet', await evaluate(exists('[data-testid="text-bullet"]')));
  check('textAlign', await evaluate(exists('[data-testid="text-align"]')));
  check('textConfirm', await evaluate(exists('[data-testid="text-composer-confirm"]')));
  // 收起合成器，避免面板挡住后续的属性面板操作。
  await evaluate(click('[data-testid="text-composer-cancel"]'));
  await sleep(200);

  // 8) 属性面板：描边样式与变换快捷操作（画一个矩形并选中）
  await evaluate(key('r'));
  await sleep(240);
  await evaluate(`(() => {
    const hit = document.querySelector('[data-testid="canvas-hit"]');
    const page = document.querySelector('[data-testid="canvas-page"]');
    if (!hit || !page) return false;
    const r = page.getBoundingClientRect();
    const opts = (x, y, buttons) => ({
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons, pointerId: 9, pointerType: 'mouse', isPrimary: true
    });
    const sx1 = r.left + r.width * 0.45;
    const sy1 = r.top + r.height * 0.45;
    const sx2 = r.left + r.width * 0.65;
    const sy2 = r.top + r.height * 0.65;
    hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx1, sy1, 1)));
    hit.dispatchEvent(new PointerEvent('pointermove', opts(sx2, sy2, 1)));
    hit.dispatchEvent(new PointerEvent('pointerup', opts(sx2, sy2, 0)));
    return true;
  })()`);
  await sleep(500);
  await evaluate(click('[data-testid="sidebar-tab-properties"]'));
  await sleep(320);
  check('strokeDash', await evaluate(exists('[data-testid="stroke-dash"]')));
  check('strokeCap', await evaluate(exists('[data-testid="stroke-cap"]')));
  check('strokeJoin', await evaluate(exists('[data-testid="stroke-join"]')));

  // 9) 设置 → 化学：默认键长 / 默认键粗细滑杆
  await evaluate(click('[data-testid="settings-button"]'));
  await sleep(360);
  await evaluate(click('[data-testid="settings-tab-chemistry"]'));
  await sleep(300);
  check('bondLengthSetting', await evaluate(exists('[data-testid="settings-bond-length"]')));
  check('bondWidthSetting', await evaluate(exists('[data-testid="settings-bond-width"]')));
  // 改成非推荐值后「推荐」按钮可点，点一下回到推荐值。
  const setRange = (selector, value) => `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
  await evaluate(setRange('[data-testid="settings-bond-length"]', '72'));
  await evaluate(setRange('[data-testid="settings-bond-width"]', '5.5'));
  await sleep(240);
  check(
    'bondResetEnabled',
    await evaluate(`(() => {
      const lengthBtn = document.querySelector('[data-testid="settings-bond-length-reset"]');
      const widthBtn = document.querySelector('[data-testid="settings-bond-width-reset"]');
      return Boolean(lengthBtn && widthBtn) && !lengthBtn.disabled && !widthBtn.disabled;
    })()`)
  );
  // 两次「推荐」要分别落库：偏好写入是 200ms 防抖，连点会互相覆盖。
  await evaluate(click('[data-testid="settings-bond-length-reset"]'));
  await sleep(320);
  await evaluate(click('[data-testid="settings-bond-width-reset"]'));
  await sleep(320);
  checks.bondRestored = await evaluate(`(() => {
    const length = document.querySelector('[data-testid="settings-bond-length"]');
    const width = document.querySelector('[data-testid="settings-bond-width"]');
    return Boolean(length && width) && length.value === '40' && width.value === '2.2';
  })()`);
  check('bondResetRestoresRecommended', checks.bondRestored);
  const settingsShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    path.join(outDir, 'ui-check-chem-settings.png'),
    Buffer.from(settingsShot.data, 'base64')
  );
  await evaluate(keyOn('.modal', 'Escape'));
  await sleep(360);
  check('settingsClosed', !(await evaluate(exists('[data-testid="settings-panel-chemistry"]'))));

  // 10) 对象列表：右键复制 / 删除（先切回图层面板，属性页签会卸载对象列表）
  await evaluate(click('[data-testid="sidebar-tab-layers"]'));
  await sleep(360);
  const objectRowsBefore = await evaluate(`document.querySelectorAll('.object-row').length`);
  const openObjectMenu = (selector = '.object-row') => `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    if (!row) return false;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + Math.min(24, r.width / 2),
      clientY: r.top + r.height / 2
    }));
    return true;
  })()`;
  await evaluate(openObjectMenu());
  await sleep(280);
  check('objectContextMenu', await evaluate(exists('[data-testid="object-context-menu"]')));
  check('objectMenuDuplicate', await evaluate(exists('[data-testid="object-menu-duplicate"]')));
  check('objectMenuDelete', await evaluate(exists('[data-testid="object-menu-delete"]')));
  const menuShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    path.join(outDir, 'ui-check-object-menu.png'),
    Buffer.from(menuShot.data, 'base64')
  );
  await evaluate(click('[data-testid="object-menu-duplicate"]'));
  await sleep(460);
  checks.objectDuplicated =
    (await evaluate(`document.querySelectorAll('.object-row').length`)) === objectRowsBefore + 1;
  // 副本必须紧贴原对象下方（列表第二行）并被选中，而不是跑到列表最上方。
  checks.duplicateBelowOriginal = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.object-row')];
    if (rows.length < 2) return false;
    return rows[1].classList.contains('is-active');
  })()`);
  await evaluate(openObjectMenu('.object-row.is-active'));
  await sleep(280);
  await evaluate(click('[data-testid="object-menu-delete"]'));
  await sleep(460);
  checks.objectDeleted =
    (await evaluate(`document.querySelectorAll('.object-row').length`)) === objectRowsBefore;

  // 11) 导出：直接填「输出宽」，自动反算选区宽度（PNG 2×）
  await evaluate(click('[data-testid="export-menu-button"]'));
  await sleep(260);
  await evaluate(click('[data-testid="export-region-entry"]'));
  await waitFor('[data-testid="export-panel"]', 6000);
  await evaluate(click('[data-testid="export-format-png"]'));
  await sleep(200);
  await evaluate(click('[data-testid="export-scope-region"]'));
  await sleep(260);
  await evaluate(`(() => {
    const el = document.querySelector('[data-testid="export-output-width"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '800');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(340);
  checks.exportRegionWidth = await evaluate(
    `document.querySelector('[data-testid="export-region-width"]')?.value`
  );
  check('exportOutputBackCalc', checks.exportRegionWidth === '400');
  checks.exportOutputText = await evaluate(
    `document.querySelector('[data-testid="export-output-size"]')?.textContent?.trim()`
  );
  check(
    'exportOutputSizeText',
    Boolean(checks.exportOutputText && checks.exportOutputText.includes('800 × '))
  );
  const exportShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    path.join(outDir, 'ui-check-export.png'),
    Buffer.from(exportShot.data, 'base64')
  );
  await evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  );
  await sleep(320);
  check('exportPanelClosed', !(await evaluate(exists('[data-testid="export-panel"]'))));

  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    path.join(outDir, 'tools-ui-check.png'),
    Buffer.from(screenshot.data, 'base64')
  );

  const failed = Object.entries(checks).filter(([, value]) => !value);
  const report = {
    exe,
    checks,
    failed: failed.map(([name]) => name),
    pageErrors
  };
  fs.writeFileSync(
    path.join(outDir, 'tools-ui-check.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );
  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0 || pageErrors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error('[tools-ui] 失败：', error);
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
