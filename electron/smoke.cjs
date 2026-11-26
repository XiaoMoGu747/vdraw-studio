'use strict';

const { app, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDom(win, script) {
  try {
    return await win.webContents.executeJavaScript(script, true);
  } catch (error) {
    console.error('[smoke] script failed:', script.replace(/\s+/g, ' ').slice(0, 220));
    throw error;
  }
}

async function runSmokeFlow(win, smokeErrors) {
  const outDir = path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const screenshot = async (name) => {
    fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
  };
  /** 从窗口截图取一个屏幕像素；用于验证擦除后的白/黑，而不是只信 DOM。 */
  const samplePixel = async (x, y) => {
    const image = await win.webContents.capturePage();
    const [winWidth] = win.getContentSize();
    const scale = image.getSize().width / winWidth || 1;
    const crop = image.crop({
      x: Math.round(x * scale),
      y: Math.round(y * scale),
      width: 1,
      height: 1
    });
    const bitmap = crop.toBitmap();
    return { r: bitmap[2], g: bitmap[1], b: bitmap[0], a: bitmap[3] };
  };
  const darkPixel = (pixel) => pixel.r < 40 && pixel.g < 40 && pixel.b < 40;
  const lightPixel = (pixel) => pixel.r > 235 && pixel.g > 235 && pixel.b > 235;

  await sleep(1400);
  const startInfo = await readDom(
    win,
    `(() => ({
      route: document.querySelector('.start-page') ? 'start' : 'unknown',
      launcherBar: Boolean(document.querySelector('.launcher-bar')),
      newCard: Boolean(document.querySelector('[data-testid="start-new"]')),
      openCard: Boolean(document.querySelector('[data-testid="start-open"]')),
      squareCards: [...document.querySelectorAll('.launcher-card')].every(
        (el) => Math.abs(el.getBoundingClientRect().width - el.getBoundingClientRect().height) < 2
      ),
      launcherButtons: document.querySelectorAll('.launcher-icon-btn').length,
      recentRows: document.querySelectorAll('[data-testid="recent-row"]').length,
      deleteButtons: document.querySelectorAll('[data-testid="recent-delete"]').length,
      recentHasDesc: Boolean(
        document.querySelector('[data-testid="recent-row"] .recent-item__body span')
      ),
      scrollOverflowX: document.documentElement.scrollWidth - window.innerWidth
    }))()`
  );
  await screenshot('smoke-start.png');

  // 启动页右上角关闭：确认框必须走统一 Modal，可取消并留在当前页。
  await readDom(win, `document.querySelector('.launcher-icon-btn--danger')?.click()`);
  await sleep(220);
  const startCloseDialog = await readDom(
    win,
    `(() => ({
      open: Boolean(document.querySelector('[data-testid="start-close-confirm"]')),
      modal: Boolean(document.querySelector('.modal')),
      styled: Boolean(document.querySelector('.confirm-dialog__icon'))
    }))()`
  );
  await readDom(win, `document.querySelector('[data-testid="start-close-confirm-cancel"]')?.click()`);
  await sleep(180);
  const startCloseCanceled = await readDom(
    win,
    `!document.querySelector('[data-testid="start-close-confirm"]')`
  );

  let recentAfterDelete = null;
  if (startInfo.recentRows > 0) {
    await readDom(win, `document.querySelector('[data-testid="recent-delete"]').click()`);
    await sleep(220);
    recentAfterDelete = await readDom(
      win,
      `document.querySelectorAll('[data-testid="recent-row"]').length`
    );
  }

  // 新建画布：配置面板（名称 / 尺寸 / 模板 / 无限画布）
  await readDom(win, `document.querySelector('[data-testid="start-new"]').click()`);
  await sleep(320);
  const canvasConfig = await readDom(
    win,
    `(() => ({
      open: Boolean(document.querySelector('[data-testid="new-canvas-dialog"]')),
      fields:
        Boolean(document.querySelector('[data-testid="canvas-name"]')) &&
        Boolean(document.querySelector('[data-testid="canvas-width"]')) &&
        Boolean(document.querySelector('[data-testid="canvas-height"]')),
      templates: document.querySelectorAll('[data-template]').length,
      infiniteOption: Boolean(document.querySelector('[data-testid="canvas-infinite"]'))
    }))()`
  );
  await readDom(win, `document.querySelector('[data-testid="canvas-infinite"]').click()`);
  await sleep(200);
  const infiniteState = await readDom(
    win,
    `(() => {
      const width = document.querySelector('[data-testid="canvas-width"]');
      return { disabled: Boolean(width?.disabled), value: width?.value || null };
    })()`
  );
  await readDom(win, `document.querySelector('[data-template="blank-landscape"]').click()`);
  await sleep(180);
  const widthClearable = await readDom(
    win,
    `(() => {
      const input = document.querySelector('[data-testid="canvas-width"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value === '';
    })()`
  );
  await sleep(180);
  const widthAfterClear = await readDom(
    win,
    `document.querySelector('[data-testid="canvas-width"]')?.value ?? null`
  );
  await readDom(
    win,
    `(() => {
      const input = document.querySelector('[data-testid="canvas-name"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '冒烟画布');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  await sleep(160);
  await readDom(win, `document.querySelector('[data-testid="create-canvas"]').click()`);
  await sleep(900);

  const editorInfo = await readDom(
    win,
    `(() => {
      const page = document.querySelector('[data-testid="canvas-page"]');
      const viewport = document.querySelector('.canvas-viewport');
      const rect = page ? page.getBoundingClientRect() : null;
      const viewRect = viewport ? viewport.getBoundingClientRect() : null;
      return {
        route: document.querySelector('.editor-shell') ? 'editor' : 'unknown',
        docTitle: document.querySelector('.titlebar__doc')?.textContent || null,
        toolButtons: document.querySelectorAll('[data-tool]').length,
        railVertical: getComputedStyle(document.querySelector('.tool-rail')).flexDirection === 'column',
        railBeforeDock: Boolean(
          document.querySelector('.tool-rail') &&
            document.querySelector('.left-dock') &&
            document.querySelector('.tool-rail').compareDocumentPosition(document.querySelector('.left-dock')) &
              Node.DOCUMENT_POSITION_FOLLOWING
        ),
        leftDock: Boolean(document.querySelector('.left-dock')),
        paletteButton: Boolean(document.querySelector('[data-testid="color-panel"]')),
        widthSlider: Boolean(document.querySelector('[data-testid="stroke-width-range"]')),
        opacitySlider: Boolean(document.querySelector('[data-testid="opacity-range"]')),
        menusInTitlebar: Boolean(document.querySelector('.titlebar .menubar')),
        toolPanelInitiallyClosed: !document.querySelector('[data-testid="tool-options"]'),
        rightSidebar: Boolean(document.querySelector('.right-sidebar')),
        rightHasProperties: Boolean(document.querySelector('.right-panel .panel-head--sticky')),
        layerRows: document.querySelectorAll('[data-layer-row]').length,
        innerSize: { w: window.innerWidth, h: window.innerHeight },
        viewportSize: viewRect ? { w: Math.round(viewRect.width), h: Math.round(viewRect.height) } : null,
        pageSize: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        zoomLabel: document.querySelector('.zoom-dock__value')?.textContent || null,
        scrollOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        scrollOverflowY: document.documentElement.scrollHeight - window.innerHeight
      };
    })()`
  );
  await screenshot('smoke-editor-layers.png');

  // ---- 竖栏：底部操作区固定、窄栏两行/宽栏两列、工具提示内容一致 ----
  let railPolish = { ok: false };
  try {
    const readRailLayout = `(() => {
      const rail = document.querySelector('[data-testid="tool-rail"]');
      const tail = rail?.querySelector('.tool-rail__group--tail');
      const buttons = tail ? [...tail.querySelectorAll('.rail-btn')] : [];
      const rect = (el) => {
        const r = el?.getBoundingClientRect();
        return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null;
      };
      return {
        rail: rect(rail),
        tail: rect(tail),
        buttons: buttons.map(rect),
        direction: tail ? getComputedStyle(tail).flexDirection : null
      };
    })()`;
    const narrow = await readDom(win, readRailLayout);
    await readDom(
      win,
      `document.querySelector('[data-tool="select"]')?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
      )`
    );
    await sleep(160);
    const narrowTip = await readDom(
      win,
      `(() => {
        const tip = document.querySelector('.rail-tooltip');
        return {
          open: Boolean(tip),
          label: tip?.querySelector('strong')?.textContent || '',
          hint: tip?.querySelector('span')?.textContent || '',
          position: tip ? getComputedStyle(tip).position : null
        };
      })()`
    );
    await readDom(
      win,
      `document.querySelector('[data-tool="select"]')?.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' })
      )`
    );
    await readDom(win, `document.querySelector('[data-testid="rail-labels"]')?.click()`);
    await sleep(260);
    const wide = await readDom(win, readRailLayout);
    await readDom(
      win,
      `document.querySelector('[data-tool="select"]')?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
      )`
    );
    await sleep(160);
    const wideTip = await readDom(
      win,
      `(() => {
        const tip = document.querySelector('.rail-tooltip');
        return {
          open: Boolean(tip),
          label: tip?.querySelector('strong')?.textContent || '',
          hint: tip?.querySelector('span')?.textContent || '',
          position: tip ? getComputedStyle(tip).position : null
        };
      })()`
    );
    await readDom(
      win,
      `document.querySelector('[data-tool="select"]')?.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' })
      )`
    );
    await readDom(win, `document.querySelector('[data-testid="rail-labels"]')?.click()`);
    await sleep(220);
    const atBottom = (layout) =>
      Boolean(
        layout?.rail &&
          layout?.tail &&
          Math.abs(layout.rail.bottom - layout.tail.bottom) <= 10
      );
    const narrowStacked = Boolean(
      narrow?.buttons?.length === 2 &&
        narrow.buttons[0].bottom <= narrow.buttons[1].top + 1
    );
    const wideColumns = Boolean(
      wide?.buttons?.length === 2 &&
        wide.buttons[0].right <= wide.buttons[1].left + 1
    );
    railPolish = {
      ok:
        atBottom(narrow) &&
        atBottom(wide) &&
        wideColumns &&
        narrowTip.open &&
        wideTip.open &&
        narrowTip.position === 'fixed' &&
        wideTip.position === 'fixed' &&
        narrowTip.label === wideTip.label &&
        narrowTip.hint === wideTip.hint &&
        wideTip.label.includes('选择'),
      narrow,
      wide,
      narrowTip,
      wideTip,
      narrowStacked,
      wideColumns
    };
  } catch (error) {
    railPolish = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  console.log('RAIL_POLISH ' + JSON.stringify(railPolish));

  // 吸附开关会持久化到 localStorage；上一次人工验证可能把它关掉，
  // 导致缩放/旋转参考线断言偶发失败。冒烟开始前强制开启。
  await readDom(
    win,
    `(() => {
      const button = [...document.querySelectorAll('.statusbar__toggle')].find((el) =>
        (el.textContent || '').includes('吸附')
      );
      if (button && !button.classList.contains('is-active')) button.click();
      return Boolean(button);
    })()`
  );
  await sleep(160);

  const dragExpression = (x1, y1, x2, y2) =>
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      if (!hit || !page) return false;
      const r = page.getBoundingClientRect();
      const sx1 = r.left + r.width * ${x1};
      const sy1 = r.top + r.height * ${y1};
      const sx2 = r.left + r.width * ${x2};
      const sy2 = r.top + r.height * ${y2};
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 9, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx1, sy1, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts((sx1 + sx2) / 2, (sy1 + sy2) / 2, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(sx2, sy2, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(sx2, sy2, 0)));
      return true;
    })()`;

  const clickExpression = (x, y) =>
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      if (!hit || !page) return false;
      const r = page.getBoundingClientRect();
      const cx = r.left + r.width * ${x};
      const cy = r.top + r.height * ${y};
      const opts = (buttons) => ({
        bubbles: true, cancelable: true, clientX: cx, clientY: cy,
        button: 0, buttons, pointerId: 10, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(0)));
      return true;
    })()`;

  const clickPage = (x, y) =>
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      if (!hit || !page) return false;
      const pw = Number(page.getAttribute('data-page-width')) || 1123;
      const ph = Number(page.getAttribute('data-page-height')) || 794;
      const r = page.getBoundingClientRect();
      const cx = r.left + (${x} / pw) * r.width;
      const cy = r.top + (${y} / ph) * r.height;
      const opts = (buttons) => ({
        bubbles: true, cancelable: true, clientX: cx, clientY: cy,
        button: 0, buttons, pointerId: 33, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(0)));
      return true;
    })()`;

  const contextExpression = (x, y) =>
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      if (!hit || !page) return false;
      const r = page.getBoundingClientRect();
      const cx = r.left + r.width * ${x};
      const cy = r.top + r.height * ${y};
      hit.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 2, buttons: 2
      }));
      return true;
    })()`;

  // 调色板默认折叠；需要操作方案/滑块时先展开浮层。
  const ensurePaletteOpen = async () => {
    await readDom(
      win,
      `(() => {
        if (!document.querySelector('[data-testid="color-popover"]')) {
          document.querySelector('[data-testid="color-expand"]')?.click();
        }
        return true;
      })()`
    );
    await sleep(220);
  };

  const countObjects = () =>
    readDom(win, `document.querySelectorAll('.scene-layer [data-object-id]').length`);
  const SHAPE_TOOLS = ['rect', 'square', 'ellipse', 'circle', 'polygon', 'line'];
  const CHEM_TOOLS = ['bond', 'atom', 'ring', 'arrow', 'eraser'];
  const selectTool = async (tool, { keepShape = false } = {}) => {
    if (SHAPE_TOOLS.includes(tool)) {
      await readDom(win, `document.querySelector('[data-tool="shape"]').click()`);
      await sleep(140);
      await readDom(win, `document.querySelector('[data-shape="${tool}"]').click()`);
    } else if (CHEM_TOOLS.includes(tool)) {
      if (!keepShape) {
        await readDom(
          win,
          `(() => { document.querySelector('[data-testid="shape-confirm"]')?.click(); return true; })()`
        );
        await sleep(120);
      }
      await readDom(win, `document.querySelector('[data-tool="chemistry"]')?.click()`);
      await sleep(180);
      const category = tool === 'atom' ? 'element' : tool === 'eraser' ? 'eraser' : tool;
      await readDom(win, `document.querySelector('[data-chem-category="${category}"]')?.click()`);
      await sleep(180);
      // 分类按钮是开关：若刚才关闭了二级面板，再点一次确保展开
      await readDom(
        win,
        `(() => {
          if (!document.querySelector('[data-chem-panel="${category}"]')) {
            document.querySelector('[data-chem-category="${category}"]')?.click();
          }
          return true;
        })()`
      );
      await sleep(180);
    } else {
      if (!keepShape) {
        await readDom(
          win,
          `(() => { document.querySelector('[data-testid="shape-confirm"]')?.click(); return true; })()`
        );
        await sleep(120);
      }
      await readDom(win, `document.querySelector('[data-tool="${tool}"]')?.click()`);
    }
    await sleep(150);
  };

  // 化学参数会持久化到 localStorage；上一轮冒烟/人工验证可能留下自定义键长，
  // 使依赖默认 40px 键长的几何断言失稳。冒烟开始前恢复默认。
  await selectTool('bond');
  await readDom(win, `document.querySelector('[data-testid="chem-bond-defaults"]')?.click()`);
  await sleep(180);
  await selectTool('select');

  /** 笔刷预设点击后轮询激活态，避免面板动画/浮层残留导致后续用例画错笔刷。 */
  const selectBrushPreset = async (id) => {
    await readDom(win, `document.querySelector('[data-brush="${id}"]')?.click()`);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const active = await readDom(
        win,
        `Boolean(document.querySelector('[data-brush="${id}"].is-active'))`
      );
      if (active) return true;
      await sleep(80);
    }
    return false;
  };
  const activeTool = () =>
    readDom(win, `document.querySelector('[data-testid="status-tool"]')?.textContent || null`);

  await readDom(win, `document.querySelector('[data-tool="shape"]').click()`);
  await sleep(220);
  const shapeGroupState = await readDom(
    win,
    `(() => ({
      dock: Boolean(document.querySelector('[data-testid="shape-dock"]')),
      toolActive: document.querySelector('[data-tool="shape"]')?.classList.contains('is-active') ?? false,
      activeOptions: document.querySelectorAll('[data-shape].is-active').length
    }))()`
  );
  await readDom(win, `document.querySelector('[data-testid="shape-confirm"]').click()`);
  await sleep(200);

  await selectTool('rect');
  await readDom(win, dragExpression(0.12, 0.16, 0.3, 0.34));
  await sleep(350);
  const afterRect = await countObjects();
  const rectSelection = await readDom(
    win,
    `(() => ({
      tool: document.querySelector('[data-testid="status-tool"]')?.textContent || null,
      handles: document.querySelectorAll('.selection-overlay rect').length,
      panelPersist: Boolean(document.querySelector('[data-shape]')),
      fill: document.querySelector('.scene-layer rect')?.getAttribute('fill') || null
    }))()`
  );

  const rectBeforeMove = await readDom(
    win,
    `(() => {
      const rect = document.querySelector('.scene-layer rect');
      return rect ? { x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')) } : null;
    })()`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 81, pointerType: 'mouse', isPrimary: true
      });
      const start = point(0.21, 0.25);
      const end = point(0.21, 0.29);
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(start, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(end, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(end, 0)));
      return true;
    })()`
  );
  await sleep(340);
  const shapeTransformed = await readDom(
    win,
    `(() => {
      const rect = document.querySelector('.scene-layer rect');
      return {
        x: rect ? Number(rect.getAttribute('x')) : null,
        y: rect ? Number(rect.getAttribute('y')) : null,
        handles: document.querySelectorAll('.selection-overlay rect').length,
        tool: document.querySelector('[data-testid="status-tool"]')?.textContent || null
      };
    })()`
  );
  await readDom(win, clickExpression(0.02, 0.02));
  await sleep(260);
  const shapeDeselected = await readDom(
    win,
    `(() => ({
      handles: document.querySelectorAll('.selection-overlay rect').length,
      tool: document.querySelector('[data-testid="status-tool"]')?.textContent || null
    }))()`
  );

  await selectTool('square');
  await readDom(win, dragExpression(0.34, 0.16, 0.46, 0.3));
  await sleep(350);
  const afterSquare = await countObjects();
  const squareInfo = await readDom(
    win,
    `(() => {
      const rects = document.querySelectorAll('.scene-layer rect');
      const last = rects[rects.length - 1];
      const box = last?.getBoundingClientRect();
      return {
        fill: last?.getAttribute('fill') || null,
        delta: box ? Math.abs(box.width - box.height) : null,
        tool: document.querySelector('[data-testid="status-tool"]')?.textContent || null,
        handles: document.querySelectorAll('.selection-overlay rect').length,
        panelPersist: Boolean(document.querySelector('[data-shape]'))
      };
    })()`
  );

  await selectTool('ellipse');
  await readDom(win, dragExpression(0.5, 0.16, 0.64, 0.3));
  await sleep(300);
  const afterEllipse = await countObjects();

  await selectTool('circle');
  await readDom(win, dragExpression(0.68, 0.16, 0.82, 0.3));
  await sleep(350);
  const afterCircle = await countObjects();
  const circleInfo = await readDom(
    win,
    `(() => {
      const ellipses = document.querySelectorAll('.scene-layer ellipse');
      const last = ellipses[ellipses.length - 1];
      const box = last?.getBoundingClientRect();
      return {
        fill: last?.getAttribute('fill') || null,
        delta: box ? Math.abs(box.width - box.height) : null,
        tool: document.querySelector('[data-testid="status-tool"]')?.textContent || null,
        handles: document.querySelectorAll('.selection-overlay rect').length,
        allFills: [...document.querySelectorAll('.scene-layer rect, .scene-layer ellipse')].map((el) => el.getAttribute('fill'))
      };
    })()`
  );

  await selectTool('select');
  await readDom(win, contextExpression(0.4, 0.23));
  await sleep(300);
  const contextInfo = await readDom(
    win,
    `(() => ({
      visible: Boolean(document.querySelector('[data-testid="object-menu"]')),
      hasProperties: Boolean(document.querySelector('[data-testid="object-menu-properties"]'))
    }))()`
  );
  await readDom(win, `document.querySelector('[data-testid="object-menu-properties"]').click()`);
  await sleep(400);
  const propertiesInfo = await readDom(
    win,
    `(() => {
      const panel = document.querySelector('[data-testid="object-properties"]');
      const body = panel?.querySelector('.props-inline__body');
      const bodyRect = body?.getBoundingClientRect();
      const labels = ['X', 'Y', '宽', '高', '旋转'];
      const transformFields = [...(panel?.querySelectorAll('.object-props .field') ?? [])];
      const visibleTransformFields = labels.filter((label) => {
        const field = transformFields.find(
          (el) => el.querySelector(':scope > span')?.textContent?.trim().startsWith(label)
        );
        const rect = field?.getBoundingClientRect();
        return Boolean(bodyRect && rect && rect.top >= bodyRect.top && rect.bottom <= bodyRect.bottom + 1);
      }).length;
      return {
        panel: Boolean(panel),
        inSidebar: Boolean(panel && panel.closest('.right-sidebar')),
        modal: Boolean(document.querySelector('.modal')),
        // N7 之后头部只剩「类型名 + ⋯」单行，不再有「对象属性」标题。
        title: panel?.querySelector('.props-inline__type')?.textContent?.trim() || null,
        headHeight: Math.round(
          panel?.querySelector('.props-inline__head')?.getBoundingClientRect().height || 0
        ),
        appearanceControls: document.querySelectorAll(
          '[data-testid="object-properties"] .color-field'
        ).length,
        leftPanelVisible: Boolean(document.querySelector('.left-dock')),
        alignSections: [...(panel?.querySelectorAll('.object-props .panel-section h3') ?? [])]
          .filter((el) => el.textContent?.trim() === '对齐与分布').length,
        visibleTransformFields
      };
    })()`
  );
  await screenshot('smoke-object-properties.png');
  await readDom(win, `document.querySelector('[data-testid="sidebar-tab-layers"]').click()`);
  await sleep(280);
  const modalClosed = await readDom(
    win,
    `!document.querySelector('[data-testid="object-properties"]')`
  );

  // 左侧停靠栏：调色板常驻 + 画笔颜色指示器（位于调色板与宽度之间）
  const colorPanelOpened = await readDom(
    win,
    `(() => {
      const panel = document.querySelector('[data-testid="color-panel"]');
      const indicator = document.querySelector('[data-testid="brush-color-indicator"]');
      const width = document.querySelector('[data-testid="stroke-width-range"]');
      const center = document.querySelector('.titlebar__center');
      const header = document.querySelector('.titlebar');
      const cRect = center ? center.getBoundingClientRect() : null;
      const hRect = header ? header.getBoundingClientRect() : null;
      return {
        open: Boolean(panel),
        indicator: Boolean(indicator),
        indicatorBetween: Boolean(
          panel &&
            indicator &&
            width &&
            (panel.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            (indicator.compareDocumentPosition(width) & Node.DOCUMENT_POSITION_FOLLOWING)
        ),
        titleCentered: Boolean(
          cRect &&
            hRect &&
            Math.abs(cRect.left + cRect.width / 2 - (hRect.left + hRect.width / 2)) < 2
        ),
        popoverGone: !document.querySelector('[data-testid="color-popover"]')
      };
    })()`
  );
  await ensurePaletteOpen();
  await readDom(win, `document.querySelector('[data-testid="color-entry"]')?.click()`);
  await sleep(220);
  const paletteToggleClosed = await readDom(
    win,
    `!document.querySelector('[data-testid="color-popover"]')`
  );
  await ensurePaletteOpen();
  const colorModes = await readDom(
    win,
    `(() => ({
      panel: Boolean(document.querySelector('[data-testid="color-panel"]')),
      modes: document.querySelectorAll('[data-color-mode]').length,
      palette: Boolean(document.querySelector('.color-palette')),
      fillNone: Boolean(document.querySelector('[data-testid="fill-none"]')),
      strokeNone: Boolean(document.querySelector('[data-testid="stroke-none"]'))
    }))()`
  );

  // 先明确选中第一个矩形，确保颜色应用目标稳定
  await selectTool('select');
  await readDom(win, clickExpression(0.21, 0.29));
  await sleep(260);
  await ensurePaletteOpen();
  await readDom(win, `Boolean(document.querySelector('[data-color-mode="palette"]')?.click())`);
  await sleep(260);
  const paletteGrid = await readDom(win, `document.querySelectorAll('.color-grid .swatch').length`);
  await readDom(win, `Boolean(document.querySelector('.color-grid .swatch')?.click())`);
  await sleep(300);
  const fillApplied = await readDom(
    win,
    `document.querySelector('.scene-layer rect')?.getAttribute('fill') || null`
  );

  await readDom(win, `Boolean(document.querySelector('[data-color-mode="slider"]')?.click())`);
  await sleep(260);
  const sliderMode = await readDom(
    win,
    `(() => ({
      hex: Boolean(document.querySelector('.color-sliders__hex input')),
      sliders: document.querySelectorAll('.color-slider').length
    }))()`
  );

  await readDom(win, `Boolean(document.querySelector('[data-color-mode="palette"]')?.click())`);
  await sleep(220);
  await readDom(win, `Boolean(document.querySelector('.color-grid .swatch')?.click())`);
  await sleep(300);
  const paletteApplied = await readDom(
    win,
    `(() => ({
      fill: document.querySelector('.scene-layer rect')?.getAttribute('fill') || null,
      swatches: document.querySelectorAll('.color-grid .swatch').length
    }))()`
  );

  // 描边宽度滑杆
  const widthDrag = await readDom(
    win,
    `(() => {
      const range = document.querySelector('[data-testid="stroke-width-range"]');
      if (!range) return { dragged: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, '6');
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      return { dragged: true };
    })()`
  );
  await sleep(300);
  const strokeWidth = await readDom(
    win,
    `document.querySelector('.scene-layer rect')?.getAttribute('stroke-width') || null`
  );

  await selectTool('select');
  const resizeInfo = await readDom(
    win,
    `(async () => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const target = document.querySelector('.scene-layer rect');
      if (!hit || !target) return { resized: false };
      const before = target.getBoundingClientRect();
      const page = document.querySelector('[data-testid="canvas-page"]').getBoundingClientRect();
      const startX = before.right;
      const startY = before.bottom;
      // 将右边缘拖到页面中线附近，触发与移动一致的吸附线
      const endX = page.left + page.width / 2 + 3;
      const endY = startY + 18;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 14, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(startX, startY, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(endX, endY, 1)));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const guideLines = [...document.querySelectorAll('[data-snap-guide]')].map((line) => ({
        x1: Number(line.getAttribute('x1')),
        y1: Number(line.getAttribute('y1')),
        x2: Number(line.getAttribute('x2')),
        y2: Number(line.getAttribute('y2'))
      }));
      const pageEl = document.querySelector('[data-testid="canvas-page"]');
      const pageW = Number(pageEl.getAttribute('data-page-width'));
      const pageH = Number(pageEl.getAttribute('data-page-height'));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(endX, endY, 0)));
      return { resized: true, beforeWidth: before.width, guideLines, pageW, pageH };
    })()`
  );
  await sleep(350);
  const resizeResult = await readDom(
    win,
    `(() => {
      const box = document.querySelector('.scene-layer rect')?.getBoundingClientRect();
      return box ? { width: box.width, height: box.height } : null;
    })()`
  );

  const rotateInfo = await readDom(
    win,
    `(async () => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const target = document.querySelector('.scene-layer rect');
      if (!hit || !target) return { rotated: false };
      const box = target.getBoundingClientRect();
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      const handleX = cx;
      const handleY = box.top - 28;
      const opts = (x, y, buttons, shiftKey = false) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 15, pointerType: 'mouse', isPrimary: true, shiftKey
      });
      // 旋转只在按住 Shift 时做 15° 吸附：本用例要验证吸附参考线，必须按住 Shift。
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(handleX, handleY, 1, true)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(cx + 80, cy - 6, 1, true)));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const guideLines = [...document.querySelectorAll('[data-snap-guide="angle"]')].map((line) => ({
        x1: Number(line.getAttribute('x1')),
        y1: Number(line.getAttribute('y1')),
        x2: Number(line.getAttribute('x2')),
        y2: Number(line.getAttribute('y2'))
      }));
      const pageEl = document.querySelector('[data-testid="canvas-page"]');
      const pageW = Number(pageEl.getAttribute('data-page-width'));
      const pageH = Number(pageEl.getAttribute('data-page-height'));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(cx + 80, cy - 6, 0, true)));
      return { rotated: true, guideLines, pageW, pageH };
    })()`
  );
  await sleep(350);
  const rotateResult = await readDom(
    win,
    `(() => {
      const target = document.querySelector('.scene-layer rect');
      const overlayBox = document.querySelector('.selection-overlay rect');
      const overlayGroup = overlayBox?.parentElement;
      const rotateHandle = document.querySelector('.selection-overlay circle');
      return {
        transform: target?.getAttribute('transform') || null,
        overlayTransform: overlayGroup?.getAttribute('transform') || null,
        handleOffset: rotateHandle
          ? {
              dx: rotateHandle.getAttribute('cx'),
              dy: rotateHandle.getAttribute('cy')
            }
          : null
      };
    })()`
  );

  // 不按 Shift 旋转必须自由，不得出现 15° 吸附参考线。
  const rotateFree = await readDom(
    win,
    `(async () => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const handle = document.querySelector('[data-handle="rotate"]');
      if (!hit || !handle) return { free: false, guideLines: -1 };
      const hb = handle.getBoundingClientRect();
      const x = (hb.left + hb.right) / 2;
      const y = (hb.top + hb.bottom) / 2;
      const opts = (px, py, buttons) => ({
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 16, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(x, y, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(x + 70, y + 24, 1)));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const guideLines = document.querySelectorAll('[data-snap-guide="angle"]').length;
      hit.dispatchEvent(new PointerEvent('pointerup', opts(x + 70, y + 24, 0)));
      return { free: true, guideLines };
    })()`
  );
  await sleep(280);

  // 化学子工具改为工具栏弹窗：逐个工具展开并统计
  const openToolPanel = async (tool) => {
    await selectTool(tool);
    await sleep(200);
  };

  await openToolPanel('bond');
  const bondPanel = await readDom(
    win,
    `(() => ({
      open: Boolean(document.querySelector('[data-testid="chem-dock"]')),
      panelTool: document.querySelector('[data-feature="chem"]')?.getAttribute('data-feature'),
      bondButtons: document.querySelectorAll('[data-bond]').length,
      categories: document.querySelectorAll('[data-chem-category]').length,
      panels: document.querySelectorAll('[data-chem-panel]').length,
      chemBar: !Boolean(document.querySelector('[data-feature="chem"]')),
      chemEdit: Boolean(document.querySelector('[data-testid="chem-dock"]')),
      chemExit: Boolean(document.querySelector('[data-testid="chem-confirm"]')),
      chemIconPaths: document.querySelectorAll('[data-tool="chemistry"] svg path').length,
      chemIconCircles: document.querySelectorAll('[data-tool="chemistry"] svg circle').length
    }))()`
  );
  await openToolPanel('atom');
  const atomPanel = await readDom(
    win,
    `(() => ({
      panelTool: document.querySelector('[data-feature="chem"]')?.getAttribute('data-feature'),
      atomChips: document.querySelectorAll('[data-atom]').length
    }))()`
  );
  await readDom(win, `document.querySelector('[data-chem-category="group"]').click()`);
  await sleep(180);
  const groupPanel = await readDom(
    win,
    `(() => ({
      atomChips: document.querySelectorAll('[data-atom]').length,
      hasOH: Boolean(document.querySelector('[data-atom="OH"]'))
    }))()`
  );
  await openToolPanel('ring');
  const ringPanel = await readDom(
    win,
    `(() => ({
      panelTool: document.querySelector('[data-testid="tool-options"]')?.getAttribute('data-tool-panel'),
      ringCards: document.querySelectorAll('[data-ring]').length,
      ringIcons: [...document.querySelectorAll('[data-ring]')].filter((card) => {
        const svg = card.querySelector('svg');
        return svg && svg.getBoundingClientRect().width >= 20;
      }).length,
      ringIconLabels: [...document.querySelectorAll('[data-ring]')].map(
        (card) => card.textContent?.trim() || ''
      ),
      ringBenzeneCircle: Boolean(
        document.querySelector('[data-ring="benzene"] svg circle')
      ),
      ringCyclohexaneLines: document.querySelectorAll(
        '[data-ring="cyclohexane"] svg line'
      ).length,
      benzeneModes: document.querySelectorAll('[data-benzene-style]').length,
      benzeneInsert: Boolean(document.querySelector('[data-testid="benzene-insert"]'))
    }))()`
  );
  await screenshot('smoke-tool-popover.png');
  const chemInfo = {
    bondButtons: bondPanel.bondButtons,
    atomChips: atomPanel.atomChips,
    atomGroups: groupPanel.atomChips,
    hasOHChip: groupPanel.hasOH,
    categories: bondPanel.categories,
    panels: bondPanel.panels,
    ringCards: ringPanel.ringCards,
    ringIcons: ringPanel.ringIcons,
    ringIconLabels: ringPanel.ringIconLabels,
    ringBenzeneCircle: ringPanel.ringBenzeneCircle,
    ringCyclohexaneLines: ringPanel.ringCyclohexaneLines,
    benzeneModes: ringPanel.benzeneModes,
    benzeneInsert: ringPanel.benzeneInsert,
    chemDock: bondPanel.open,
    chemBar: bondPanel.chemBar,
    chemEdit: bondPanel.chemEdit,
    chemExit: bondPanel.chemExit,
    chemIconPaths: bondPanel.chemIconPaths,
    chemIconCircles: bondPanel.chemIconCircles
  };

  await readDom(win, `document.querySelector('[data-benzene-style="pauling"]').click()`);
  await sleep(150);
  await readDom(win, clickExpression(0.7, 0.52));
  await sleep(400);
  const afterPauling = await countObjects();
  const paulingInfo = await readDom(
    win,
    `(() => ({
      circles: document.querySelectorAll('.scene-layer circle').length,
      lines: document.querySelectorAll('.scene-layer line').length
    }))()`
  );

  await openToolPanel('ring');
  await readDom(win, `document.querySelector('[data-benzene-style="kekule"]').click()`);
  await sleep(150);
  await readDom(win, clickExpression(0.7, 0.74));
  await sleep(400);
  const afterKekule = await countObjects();
  const kekuleInfo = await readDom(
    win,
    `(() => {
      const lines = [...document.querySelectorAll('.scene-layer line')];
      const lengths = lines.map((line) => {
        const x1 = Number(line.getAttribute('x1'));
        const y1 = Number(line.getAttribute('y1'));
        const x2 = Number(line.getAttribute('x2'));
        const y2 = Number(line.getAttribute('y2'));
        return Math.hypot(x2 - x1, y2 - y1);
      });
      const longest = Math.max(0, ...lengths);
      return {
        circles: document.querySelectorAll('.scene-layer circle').length,
        lines: lines.length,
        shortInnerLines: lengths.filter((length) => longest > 0 && length < longest * 0.85).length
      };
    })()`
  );
  const paulingCircle = paulingInfo.circles;
  const kekuleCircle = kekuleInfo.circles;

  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`
  );
  await sleep(350);
  const afterUndo = await countObjects();
  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }))`
  );
  await sleep(350);
  const afterRedo = await countObjects();
  await selectTool('select');
  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))`
  );
  await sleep(250);
  const selectionInfo = await readDom(
    win,
    `(() => ({
      handles: document.querySelectorAll('.selection-overlay rect').length,
      selectedChip: document.querySelector('.selection-chip')?.textContent || null,
      activeTool: document.querySelector('[data-testid="status-tool"]')?.textContent || null
    }))()`
  );
  await screenshot('smoke-editor-chem.png');

  await selectTool('bond');
  await readDom(win, `document.querySelector('[data-bond="single"]')?.click()`);
  await readDom(win, dragExpression(0.86, 0.38, 0.95, 0.48));
  await sleep(300);
  const afterBond = await countObjects();

  // 单击绘制：应使用 40px 标准键长
  await readDom(win, clickExpression(0.9, 0.62));
  await sleep(350);
  const afterBondClick = await countObjects();
  const bondClickLength = await readDom(
    win,
    `(() => {
      const lines = [...document.querySelectorAll('.scene-layer line')];
      const last = lines[lines.length - 1];
      if (!last) return null;
      return Math.hypot(
        Number(last.getAttribute('x2')) - Number(last.getAttribute('x1')),
        Number(last.getAttribute('y2')) - Number(last.getAttribute('y1'))
      );
    })()`
  );
  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`
  );
  await sleep(300);
  const afterBondClickUndo = await countObjects();

  await openToolPanel('atom');
  await readDom(win, `document.querySelector('[data-atom]').click()`);
  await sleep(150);
  await readDom(win, clickExpression(0.9, 0.34));
  await sleep(300);
  const afterAtom = await countObjects();

  // 右键在对象范围外：取消当前绘制并结束本次操作
  await selectTool('rect');
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      if (!hit || !page) return false;
      const r = page.getBoundingClientRect();
      const x = r.left + r.width * 0.05;
      const y = r.top + r.height * 0.05;
      const opts = (cx, cy, buttons) => ({
        bubbles: true, cancelable: true, clientX: cx, clientY: cy,
        button: 0, buttons, pointerId: 31, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(x, y, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(x + 70, y + 44, 1)));
      hit.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: x + 70, clientY: y + 44, button: 2, buttons: 2
      }));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(x + 70, y + 44, 0)));
      return true;
    })()`
  );
  await sleep(350);
  const cancelInfo = await readDom(
    win,
    `(() => ({
      tool: document.querySelector('[data-testid="status-tool"]')?.textContent || null,
      objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
      preview: Boolean(document.querySelector('.scene-layer > g:not([data-object-id])')),
      toast: [...document.querySelectorAll('[data-testid="toast"]')]
        .map((el) => el.textContent || '')
        .join('|')
    }))()`
  );

  await selectTool('text');
  await sleep(260);
  // 文字工具改为在画布下方弹出"输入 + 工具"双面板，画布中央实时显示草稿。
  const textPanel = await readDom(
    win,
    `(() => ({
      bar: !Boolean(document.querySelector('[data-feature="text"]')),
      composer: Boolean(document.querySelector('[data-testid="text-composer"]')),
      panels: document.querySelector('[data-testid="text-composer"]')?.children.length ?? 0,
      input: Boolean(document.querySelector('[data-testid="text-composer-input"]')),
      dock: Boolean(document.querySelector('[data-testid="text-dock"]')),
      font: Boolean(document.querySelector('[data-testid="text-font"]')),
      size: Boolean(document.querySelector('[data-testid="text-size"]')),
      spacing: Boolean(document.querySelector('[data-testid="text-spacing"]')),
      directions: document.querySelectorAll('[data-text-direction]').length,
      color: Boolean(document.querySelector('[data-testid="text-color"]')),
      aligns: document.querySelectorAll('[data-text-align]').length
    }))()`
  );

  // 左侧输入 → 画布中央出现同名草稿
  await readDom(
    win,
    `(() => {
      const input = document.querySelector('[data-testid="text-composer-input"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, '苯环与圆形');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  await sleep(280);
  const textDraft = await readDom(
    win,
    `(() => {
      const draft = document.querySelector('[data-testid="text-draft"] text');
      return { text: draft?.textContent || null, visible: Boolean(draft) };
    })()`
  );

  // 右侧工具只改画布：左侧输入框的文字必须保持不变
  const textToolsApplied = await readDom(
    win,
    `(() => {
      try {
        const font = document.querySelector('[data-testid="text-font"]');
        if (!font) {
          return {
            applied: false,
            reason: 'no-font',
            tool: (document.querySelector('[data-testid="status-tool"]') || {}).textContent || null,
            composer: Boolean(document.querySelector('[data-testid="text-composer"]'))
          };
        }
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        // 字体在下拉里（select）：必须用 HTMLSelectElement 的 setter，否则 Illegal invocation。
        const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        selectSetter.call(font, 'Cambria, serif');
        font.dispatchEvent(new Event('change', { bubbles: true }));
        const size = document.querySelector('[data-testid="text-size"]');
        inputSetter.call(size, '30');
        size.dispatchEvent(new Event('input', { bubbles: true }));
        const spacing = document.querySelector('[data-testid="text-spacing"]');
        inputSetter.call(spacing, '4');
        spacing.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-text-direction="vertical"]')?.click();
        const color = document.querySelector('[data-testid="text-color"]');
        if (!color) return { applied: false, reason: 'no-color' };
        inputSetter.call(color, '#ff5500');
        color.dispatchEvent(new Event('input', { bubbles: true }));
        return { applied: true };
      } catch (error) {
        return { applied: false, reason: String((error && error.message) || error) };
      }
    })()`
  );
  await sleep(320);
  const textEdited = await readDom(
    win,
    `(() => {
      const input = document.querySelector('[data-testid="text-composer-input"]');
      const draft = document.querySelector('[data-testid="text-draft"] text');
      return {
        opened: Boolean(input),
        inputUnchanged: (input?.value ?? '') === '苯环与圆形',
        size: draft?.getAttribute('font-size') || null,
        fill: draft?.getAttribute('fill') || null
      };
    })()`
  );
  await sleep(120);
  // 点击"确定"：两个面板消失、落字、进入可选择/拖动/缩放的普通对象
  await readDom(win, `document.querySelector('[data-testid="text-composer-confirm"]').click()`);
  await sleep(520);
  const textPanelClosed = await readDom(
    win,
    `!Boolean(document.querySelector('[data-testid="text-composer"]'))`
  );
  const textHandles = await readDom(win, `document.querySelectorAll('[data-handle]').length`);
  const afterText = await countObjects();
  const textPresent = await readDom(
    win,
    `Array.from(document.querySelectorAll('.scene-layer text')).some((t) => (t.textContent || '').includes('苯环与圆形'))`
  );
  const textRender = await readDom(
    win,
    `(() => {
      const text = [...document.querySelectorAll('.scene-layer text')].find((item) =>
        (item.textContent || '').includes('苯环与圆形')
      );
      return text
        ? {
            fontSize: text.getAttribute('font-size'),
            fontFamily: text.getAttribute('font-family'),
            fill: text.getAttribute('fill'),
            tspans: text.querySelectorAll('tspan').length
          }
        : null;
    })()`
  );

  await selectTool('pen');
  await readDom(win, clickExpression(0.14, 0.68));
  await sleep(150);
  await readDom(win, clickExpression(0.24, 0.6));
  await sleep(150);
  await readDom(win, clickExpression(0.34, 0.72));
  await sleep(150);
  await readDom(win, clickExpression(0.14, 0.68));
  await sleep(350);
  const afterPen = await countObjects();
  const penPathCount = await readDom(win, `document.querySelectorAll('.scene-layer path').length`);

  await selectTool('node');
  const nodePick = await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const pathEl = document.querySelector('.scene-layer path');
      if (!hit || !pathEl) return { picked: false };
      const m = pathEl.getScreenCTM();
      if (!m) return { picked: false };
      const p = pathEl.getPointAtLength(pathEl.getTotalLength() / 3).matrixTransform(m);
      const opts = (buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 20, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(0)));
      return { picked: true, x: p.x, y: p.y };
    })()`
  );
  await sleep(350);
  const pathBefore = await readDom(
    win,
    `document.querySelector('.scene-layer path')?.getAttribute('d') || null`
  );
  const nodeDrag = await readDom(
    win,
    `(() => {
      const circle = document.querySelector('.selection-overlay circle');
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      if (!circle || !hit) return { dragged: false, nodes: 0 };
      const nodes = document.querySelectorAll('.selection-overlay circle').length;
      const box = circle.getBoundingClientRect();
      const sx = box.left + box.width / 2;
      const sy = box.top + box.height / 2;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 12, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(sx + 26, sy - 18, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(sx + 26, sy - 18, 0)));
      return { dragged: true, nodes };
    })()`
  );
  await sleep(350);
  const pathAfter = await readDom(
    win,
    `document.querySelector('.scene-layer path')?.getAttribute('d') || null`
  );
  const nodeEdited = Boolean(pathBefore && pathAfter && pathBefore !== pathAfter);

  // 节点工具：双击插点、Alt 切换尖角/平滑、Delete 删点且不误删整条路径
  const nodeEdit = await readDom(
    win,
    `(async () => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const pathEl = document.querySelector('.scene-layer path');
      if (!hit || !pathEl) return { inserted: false, deleted: false, toggled: false, objectKept: false };
      const segments = () => ((pathEl.getAttribute('d') || '').match(/[LC]/g) || []).length;
      const nodeCount = () =>
        document.querySelectorAll('.selection-overlay circle[data-node-id]').length;
      const objectsBefore = document.querySelectorAll('.scene-layer [data-object-id]').length;
      const nodesBefore = nodeCount();
      const before = segments();
      const len = pathEl.getTotalLength();
      const p = pathEl.getPointAtLength(len * 0.5);
      const screen = new DOMPoint(p.x, p.y).matrixTransform(pathEl.getScreenCTM());
      hit.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, clientX: screen.x, clientY: screen.y
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
      const nodesAfterInsert = nodeCount();
      const afterInsert = segments();

      const node = document.querySelector('.selection-overlay circle[data-node-id]');
      const beforeType = node?.getAttribute('data-node-type') || null;
      if (node) {
        const box = node.getBoundingClientRect();
        hit.dispatchEvent(
          new MouseEvent('dblclick', {
            bubbles: true, cancelable: true,
            clientX: box.left + box.width / 2, clientY: box.top + box.height / 2
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      const afterType =
        document.querySelector('.selection-overlay circle[data-node-id]')?.getAttribute('data-node-type') || null;

      // 真实键盘事件的目标是 body/画布；从 body 派发才能命中 window 的捕获阶段监听。
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 240));
      const nodesAfterDelete = nodeCount();
      const afterDelete = segments();
      const objectsAfter = document.querySelectorAll('.scene-layer [data-object-id]').length;
      return {
        inserted: nodesAfterInsert > nodesBefore,
        deleted: nodesAfterDelete < nodesAfterInsert,
        toggled: Boolean(beforeType && afterType && beforeType !== afterType),
        objectKept: objectsAfter === objectsBefore,
        nodeCounts: { before: nodesBefore, afterInsert: nodesAfterInsert, afterDelete: nodesAfterDelete },
        segments: { before, afterInsert, afterDelete }
      };
    })()`
  );
  await sleep(250);

  // 节点工具 Shift 多选：两次 Shift 点击后应有两个节点处于选中态
  const nodeMulti = await readDom(
    win,
    `(async () => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const circles = [...document.querySelectorAll('.selection-overlay circle[data-node-id]')];
      if (!hit || circles.length < 2) return { selected: 0, circles: circles.length };
      const clickNode = (element) => {
        const box = element.getBoundingClientRect();
        const init = {
          bubbles: true, cancelable: true,
          clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
          button: 0, pointerId: 89, pointerType: 'mouse', isPrimary: true, shiftKey: true
        };
        hit.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
        hit.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
      };
      clickNode(circles[0]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const afterFirst = document.querySelectorAll('[data-node-selected="true"]').length;
      clickNode(circles[1]);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        selected: document.querySelectorAll('[data-node-selected="true"]').length,
        afterFirst,
        circles: circles.length
      };
    })()`
  );
  await sleep(200);

  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))`
  );
  await sleep(250);
  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))`
  );
  await sleep(300);
  const afterGroup = await countObjects();
  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, shiftKey: true, bubbles: true }))`
  );
  await sleep(300);
  const afterUngroup = await countObjects();

  fs.writeFileSync(
    path.join(outDir, 'smoke-import.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
  <rect x="10" y="10" width="150" height="70" rx="8" fill="#e8f0ff" stroke="#3f6df0" stroke-width="3"/>
  <circle cx="300" cy="60" r="40" fill="#e9f7f5" stroke="#0f9d8f" stroke-width="3"/>
  <path d="M20 180 C 90 90, 210 200, 380 120" fill="none" stroke="#7c5cf0" stroke-width="3"/>
  <text x="30" y="120" font-size="22" fill="#1b1b1b">SVG import</text>
</svg>`
  );

  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))`
  );
  await sleep(900);
  const saveInfo = await readDom(
    win,
    `(() => ({
      chip: document.querySelector('.titlebar__unsaved')?.textContent || null,
      title: document.querySelector('.titlebar__doc')?.textContent || null,
      saveButton: Boolean(document.querySelector('[data-testid="save-button"]')),
      noBackButton: !document.querySelector('[data-testid="back-to-start"]')
    }))()`
  );
  const savedPath = path.join(outDir, 'smoke-document.vdraw');
  const savedExists = fs.existsSync(savedPath);
  const savedContent = savedExists ? fs.readFileSync(savedPath, 'utf8') : '';
  const savedHasSchema =
    savedContent.includes('"schemaVersion": 1') && savedContent.includes('"ringStyle"');
  const savedPauling = savedContent.includes('"ringStyle": "pauling"');
  const savedKekule = savedContent.includes('"ringStyle": "kekule"');

  await selectTool('rect');
  await readDom(win, dragExpression(0.04, 0.86, 0.14, 0.95));
  await sleep(300);
  const afterDirtyRect = await countObjects();

  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true }))`
  );
  await sleep(900);
  const afterOpen = await countObjects();

  await readDom(win, `[...document.querySelectorAll('.menubar__trigger')].find((el) => el.textContent === '文件').click()`);
  await sleep(200);
  await readDom(
    win,
    `(() => {
      const item = [...document.querySelectorAll('.menu-dropdown .menu-item')].find((el) => (el.textContent || '').includes('导入文件'));
      if (item) item.click();
      return Boolean(item);
    })()`
  );
  await sleep(320);
  const importDialogOpen = await readDom(
    win,
    `Boolean(document.querySelector('[data-testid="import-dialog"]'))`
  );
  const importChoose = await readDom(
    win,
    `(() => {
      const button = document.querySelector('[data-testid="import-choose"]');
      if (button) button.click();
      return Boolean(button);
    })()`
  );
  await sleep(900);
  const importValidation = await readDom(
    win,
    `(() => ({
      summary: Boolean(document.querySelector('[data-testid="import-summary"]')),
      error: document.querySelector('[data-testid="import-error"]')?.textContent || null,
      formats: document.querySelectorAll('.import-formats li').length
    }))()`
  );
  // 合并到当前画布：与旧「导入 SVG」一致，追加 4 个图元（矩形/圆/路径/文本）。
  await readDom(win, `document.querySelector('[data-testid="import-mode-append"]')?.click()`);
  await sleep(160);
  await readDom(win, `document.querySelector('[data-testid="import-confirm"]')?.click()`);
  await sleep(900);
  const importDialogClosed = await readDom(
    win,
    `!document.querySelector('[data-testid="import-dialog"]')`
  );
  const afterImport = await countObjects();

  // 框选区域导出：面板打开 → 精确输入 X/Y/W/H → 确认，落盘尺寸应为选区 ×2。
  await readDom(win, `document.querySelector('[data-testid="export-menu-button"]').click()`);
  await sleep(250);
  await readDom(win, `document.querySelector('[data-testid="export-region-entry"]').click()`);
  await sleep(360);
  const exportPanelOpen = await readDom(
    win,
    `Boolean(document.querySelector('[data-testid="export-panel"]'))`
  );
  await readDom(win, `document.querySelector('[data-testid="export-scope-region"]').click()`);
  await sleep(160);
  const setNumber = (testId, value) =>
    `(() => {
      const input = document.querySelector('[data-testid="${testId}"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '${value}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`;
  await readDom(win, setNumber('export-region-x', 100));
  await sleep(120);
  await readDom(win, setNumber('export-region-y', 80));
  await sleep(120);
  await readDom(win, setNumber('export-region-width', 400));
  await sleep(120);
  await readDom(win, setNumber('export-region-height', 300));
  await sleep(200);
  const regionFields = await readDom(
    win,
    `(() => ({
      x: document.querySelector('[data-testid="export-region-x"]')?.value ?? null,
      y: document.querySelector('[data-testid="export-region-y"]')?.value ?? null,
      w: document.querySelector('[data-testid="export-region-width"]')?.value ?? null,
      h: document.querySelector('[data-testid="export-region-height"]')?.value ?? null,
      output: document.querySelector('[data-testid="export-output-size"]')?.textContent ?? '',
      overlay: Boolean(document.querySelector('[data-testid="export-region-overlay"]'))
    }))()`
  );
  await readDom(win, `document.querySelector('[data-testid="export-confirm"]').click()`);
  await sleep(1500);
  const exportPanelClosed = await readDom(
    win,
    `!document.querySelector('[data-testid="export-panel"]')`
  );
  const regionPngPath = path.join(outDir, 'smoke-export.png');
  const regionPng = fs.existsSync(regionPngPath) ? nativeImage.createFromPath(regionPngPath) : null;
  const regionPngSize = regionPng && !regionPng.isEmpty() ? regionPng.getSize() : null;

  // 选中对象导出：Ctrl+A 全选 → 面板切到「选中对象」→ 校验预览尺寸与落盘一致。
  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))`
  );
  await sleep(260);
  await readDom(win, `document.querySelector('[data-testid="export-menu-button"]').click()`);
  await sleep(220);
  await readDom(win, `document.querySelector('[data-testid="export-region-entry"]').click()`);
  await sleep(340);
  await readDom(win, `document.querySelector('[data-testid="export-scope-selection"]').click()`);
  // 导出预览是 50ms 防抖 + 同步序列化；冷启动可能超过固定等待，轮询到 img 出现再采样。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = await readDom(
      win,
      `Boolean(document.querySelector('.export-panel__preview img'))`
    );
    if (ready) break;
    await sleep(100);
  }
  await sleep(80);
  const selectionScope = await readDom(
    win,
    `(() => {
      const output = document.querySelector('[data-testid="export-output-size"]')?.textContent || '';
      const match = output.match(/(\\d+)\\s*×\\s*(\\d+)/);
      return {
        output,
        width: match ? Number(match[1]) : 0,
        height: match ? Number(match[2]) : 0,
        hint: document.querySelector('[data-testid="export-scope-hint"]')?.textContent || '',
        preview: Boolean(document.querySelector('.export-panel__preview img')),
        previewFit: (() => {
          const box = document.querySelector('.export-panel__preview');
          const img = box ? box.querySelector('img') : null;
          if (!box || !img) return null;
          const b = box.getBoundingClientRect();
          const i = img.getBoundingClientRect();
          return {
            inside:
              i.left >= b.left - 0.5 &&
              i.top >= b.top - 0.5 &&
              i.right <= b.right + 0.5 &&
              i.bottom <= b.bottom + 0.5,
            objectFit: getComputedStyle(img).objectFit,
            imgW: Math.round(i.width),
            imgH: Math.round(i.height),
            boxW: Math.round(b.width),
            boxH: Math.round(b.height)
          };
        })(),
        fieldsShown: Boolean(document.querySelector('[data-testid="export-region-fields"]')),
        overlayShown: Boolean(document.querySelector('[data-testid="export-region-overlay"]'))
      };
    })()`
  );

  // 把预览图按导出尺寸重新光栅化，量出内容的实际包围盒：
  // 四边都有留白（未被裁切）且左右/上下留白接近（居中）。
  // 选中包围盒可能带小数（文本按实测宽高居中），尺寸要按小数解析后再向上取整。
  const hintSize = /(\d+(?:\.\d+)?)\s*×\s*(\d+(?:\.\d+)?)/.exec(selectionScope.hint || '');
  const previewContent = await readDom(
    win,
    `(async () => {
      const img = document.querySelector('.export-panel__preview img');
      if (!img) return null;
      const source = new Image();
      source.src = img.getAttribute('src');
      await source.decode();
      const canvas = document.createElement('canvas');
      canvas.width = ${hintSize ? Math.ceil(Number(hintSize[1])) : 276};
      canvas.height = ${hintSize ? Math.ceil(Number(hintSize[2])) : 226};
      const ctx = canvas.getContext('2d');
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const index = (y * canvas.width + x) * 4;
          const r = data[index];
          const g = data[index + 1];
          const b = data[index + 2];
          // 纸张是白色，笔画/描边是深色
          if (r < 210 || g < 210 || b < 210) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return { empty: true };
      return {
        empty: false,
        left: minX,
        top: minY,
        right: canvas.width - 1 - maxX,
        bottom: canvas.height - 1 - maxY
      };
    })()`
  );
  await readDom(win, `document.querySelector('[data-testid="export-confirm"]').click()`);
  await sleep(1500);
  const selectionPngClosed = await readDom(
    win,
    `!document.querySelector('[data-testid="export-panel"]')`
  );
  const selectionPng = fs.existsSync(regionPngPath)
    ? nativeImage.createFromPath(regionPngPath)
    : null;
  const selectionPngSize = selectionPng && !selectionPng.isEmpty() ? selectionPng.getSize() : null;

  await readDom(win, `document.querySelector('[data-testid="export-menu-button"]').click()`);
  await sleep(250);
  await readDom(win, `document.querySelector('[data-testid="export-transparent"]').click()`);
  await sleep(250);
  const transparentOn = await readDom(
    win,
    `document.querySelector('[data-testid="export-transparent"]').classList.contains('is-checked')`
  );
  await readDom(win, `document.querySelector('[data-export="png"]').click()`);
  await sleep(1400);
  await readDom(win, `document.querySelector('[data-testid="export-menu-button"]').click()`);
  await sleep(200);
  await readDom(win, `document.querySelector('[data-export="svg"]').click()`);
  await sleep(1000);
  await readDom(win, `document.querySelector('[data-testid="export-menu-button"]').click()`);
  await sleep(200);
  await readDom(win, `document.querySelector('[data-export="pdf"]').click()`);
  await sleep(2200);
  await readDom(win, `document.querySelector('[data-testid="export-menu-button"]').click()`);
  await sleep(200);
  await readDom(win, `document.querySelector('[data-export="jpg"]').click()`);
  await sleep(1800);

  const pngPath = path.join(outDir, 'smoke-export.png');
  const pngImage = fs.existsSync(pngPath) ? nativeImage.createFromPath(pngPath) : null;
  const pngBitmap = pngImage && !pngImage.isEmpty() ? pngImage.getBitmap() : null;
  const pngCornerAlpha = pngBitmap && pngBitmap.length > 3 ? pngBitmap[3] : null;
  const pngSize = pngImage && !pngImage.isEmpty() ? pngImage.getSize() : null;
  const svgPath = path.join(outDir, 'smoke-export.svg');
  const exportedSvg = fs.existsSync(svgPath) ? fs.readFileSync(svgPath, 'utf8') : '';
  const svgHasBackground = exportedSvg.includes('width="1123" height="794" fill="#ffffff"');
  const pdfBuffer = fs.existsSync(path.join(outDir, 'smoke-export.pdf'))
    ? fs.readFileSync(path.join(outDir, 'smoke-export.pdf'))
    : null;
  const pdfHasJpeg = pdfBuffer ? pdfBuffer.includes(Buffer.from('/DCTDecode')) : null;
  const pdfHasFont = pdfBuffer ? pdfBuffer.includes(Buffer.from('/Font')) : null;
  const jpgPath = path.join(outDir, 'smoke-export.jpg');
  const jpgBuffer = fs.existsSync(jpgPath) ? fs.readFileSync(jpgPath) : null;
  const jpgMagic = jpgBuffer ? jpgBuffer.subarray(0, 3).toString('hex') : null;
  const jpgImage = fs.existsSync(jpgPath) ? nativeImage.createFromPath(jpgPath) : null;
  const jpgSize = jpgImage && !jpgImage.isEmpty() ? jpgImage.getSize() : null;

  // 右栏是「图层 / 属性」页签：图层操作前先切回图层页。
  await readDom(
    win,
    `(() => { document.querySelector('[data-testid="sidebar-tab-layers"]')?.click(); return true; })()`
  );
  await sleep(200);
  const layerInfoBefore = await readDom(
    win,
    `(() => ({
      rows: document.querySelectorAll('[data-layer-row]').length,
      background: Boolean(document.querySelector('[data-testid="background-layer"]')),
      bgColor: document.querySelector('[data-testid="background-layer"] input[type="color"]')?.value || null,
      pageFill: document.querySelector('[data-testid="canvas-page"]')?.getAttribute('fill') || null,
      chemTabGone: !document.querySelector('[data-testid="tab-chemistry"]')
    }))()`
  );

  const openLayerMenu = async () => {
    await readDom(win, `document.querySelector('[data-testid="layer-more"]').click()`);
    await sleep(150);
  };

  await readDom(win, `document.querySelector('[data-testid="layer-add"]').click()`);
  await sleep(250);
  const layersAfterAdd = await readDom(win, `document.querySelectorAll('[data-layer-row]').length`);

  await openLayerMenu();
  await readDom(win, `document.querySelector('[data-testid="layer-duplicate"]').click()`);
  await sleep(250);
  const layersAfterDuplicate = await readDom(win, `document.querySelectorAll('[data-layer-row]').length`);
  const duplicateName = await readDom(
    win,
    `document.querySelector('[data-layer-row].is-active .layer-row__name')?.textContent || null`
  );

  await openLayerMenu();
  await readDom(win, `document.querySelector('[data-testid="layer-merge"]').click()`);
  await sleep(300);
  const layersAfterMerge = await readDom(win, `document.querySelectorAll('[data-layer-row]').length`);

  await openLayerMenu();
  await readDom(win, `document.querySelector('[data-testid="layer-delete"]').click()`);
  await sleep(250);
  const layersAfterDelete = await readDom(win, `document.querySelectorAll('[data-layer-row]').length`);

  await openLayerMenu();
  await readDom(win, `document.querySelector('[data-testid="layer-add-folder"]').click()`);
  await sleep(250);
  const folderCreated = await readDom(win, `document.querySelectorAll('[data-layer-kind="folder"]').length`);

  // 把普通图层拖入文件夹内部（指针拖拽）
  const dragLayer = await readDom(
    win,
    `(() => {
      const rows = [...document.querySelectorAll('[data-layer-row]')];
      const folder = rows.find((row) => row.getAttribute('data-layer-kind') === 'folder');
      const plain = rows.find((row) => row.getAttribute('data-layer-kind') === 'vector');
      if (!folder || !plain) return { moved: false };
      const from = plain.getBoundingClientRect();
      const to = folder.getBoundingClientRect();
      const sx = from.left + 40;
      const sy = from.top + from.height / 2;
      const tx = to.left + 40;
      const ty = to.top + to.height / 2;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 41, pointerType: 'mouse', isPrimary: true
      });
      plain.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy, 1)));
      plain.dispatchEvent(new PointerEvent('pointermove', opts(sx + 12, sy + 6, 1)));
      plain.dispatchEvent(new PointerEvent('pointermove', opts(tx, ty, 1)));
      plain.dispatchEvent(new PointerEvent('pointerup', opts(tx, ty, 0)));
      return {
        moved: true,
        target: document.elementFromPoint(tx, ty)?.closest('[data-layer-row]')?.getAttribute('data-layer-kind') ?? null
      };
    })()`
  );
  await sleep(350);
  const nestedLayer = await readDom(
    win,
    `(() => {
      const vector = document.querySelector('[data-layer-kind="vector"]');
      return {
        folderRows: document.querySelectorAll('[data-layer-kind="folder"]').length,
        nestedIndent: vector ? vector.style.paddingLeft : null,
        nested: Boolean(vector && vector.parentElement?.parentElement?.querySelector('[data-layer-kind="folder"]'))
      };
    })()`
  );

  const backgroundChange = await readDom(
    win,
    `(() => {
      const input = document.querySelector('[data-testid="background-layer"] input[type="color"]');
      if (!input) return { changed: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '#112233');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { changed: true };
    })()`
  );
  await sleep(300);
  const pageFillAfter = await readDom(
    win,
    `document.querySelector('[data-testid="canvas-page"]')?.getAttribute('fill') || null`
  );

  await selectTool('select');
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const target = document.querySelector('.scene-layer rect');
      if (!hit || !target) return false;
      const box = target.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const opts = (buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 17, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(0)));
      return true;
    })()`
  );
  await sleep(300);
  const toolState = await readDom(
    win,
    `(() => ({
      selectActive: document.querySelector('[data-tool="select"]').getAttribute('aria-pressed'),
      activeToolLabel: document.querySelector('[data-testid="status-tool"]')?.textContent || null,
      selectedCount: document.querySelector('.selection-chip')?.textContent || null,
      objectCount: document.querySelectorAll('.scene-layer [data-object-id]').length
    }))()`
  );
  await screenshot('smoke-editor-tools.png');

  // ---- 点击已有键：循环键级（单 → 双 → 三）----
  await selectTool('bond');
  // 「固定化学键」会持久化到 localStorage：人工验证时若开启过，拖拽画出的键被锁到当前键长，
  // 下面依赖拖拽长度（cycleMid - 55 落在原子端点上）的悬停断言就会失稳。先强制关闭。
  await readDom(
    win,
    `(() => {
      const button = document.querySelector('[data-testid="bond-fixed"]');
      if (!button) return false;
      if (button.getAttribute('aria-pressed') === 'true') button.click();
      return true;
    })()`
  );
  await sleep(160);
  await readDom(win, `document.querySelector('[data-bond="single"]')?.click()`);
  const panelLayout = await readDom(
    win,
    `(() => ({
      present: Boolean(document.querySelector('[data-testid="chem-dock"]')),
      feature: Boolean(document.querySelector('[data-feature="chem"]'))
    }))()`
  );
  await readDom(win, dragExpression(0.05, 0.93, 0.15, 0.93));
  await sleep(350);
  const panelAfterDraw = await readDom(
    win,
    `Boolean(document.querySelector('[data-testid="chem-dock"]'))`
  );
  const cycleBefore = await readDom(win, `document.querySelectorAll('.scene-layer line').length`);
  const cycleMid = await readDom(
    win,
    `(() => {
      const lines = [...document.querySelectorAll('.scene-layer line')];
      const last = lines[lines.length - 1];
      const x1 = Number(last.getAttribute('x1'));
      const y1 = Number(last.getAttribute('y1'));
      const x2 = Number(last.getAttribute('x2'));
      const y2 = Number(last.getAttribute('y2'));
      return {
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2,
        length: Math.hypot(x2 - x1, y2 - y1)
      };
    })()`
  );
  await readDom(win, clickPage(cycleMid.x, cycleMid.y));
  await sleep(320);
  const cycleDouble = await readDom(win, `document.querySelectorAll('.scene-layer line').length`);
  await readDom(win, clickPage(cycleMid.x, cycleMid.y));
  await sleep(320);
  const cycleTriple = await readDom(win, `document.querySelectorAll('.scene-layer line').length`);
  const cycleDetail = await readDom(
    win,
    `(() => {
      const mx = ${cycleMid.x};
      const my = ${cycleMid.y};
      const lines = [...document.querySelectorAll('.scene-layer line')].map((l) => ({
        x1: +l.getAttribute('x1'),
        y1: +l.getAttribute('y1'),
        x2: +l.getAttribute('x2'),
        y2: +l.getAttribute('y2')
      }));
      const near = lines.filter(
        (l) => Math.hypot((l.x1 + l.x2) / 2 - mx, (l.y1 + l.y2) / 2 - my) < 70
      );
      return {
        objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
        nearCount: near.length,
        near,
        tool: document.querySelector('[data-testid="status-tool"]')?.textContent || null
      };
    })()`
  );

  // 键级循环：三键后再次点击回到单键
  await readDom(win, clickPage(cycleMid.x, cycleMid.y));
  await sleep(320);
  const cycleSingle = await readDom(win, `document.querySelectorAll('.scene-layer line').length`);

  // 悬停预览：原子圈选 / 已有键描边
  const movePointerTo = (x, y) =>
    readDom(
      win,
      `(() => {
        const hit = document.querySelector('[data-testid="canvas-hit"]');
        const page = document.querySelector('[data-testid="canvas-page"]');
        const pw = Number(page.getAttribute('data-page-width')) || 1123;
        const ph = Number(page.getAttribute('data-page-height')) || 794;
        const r = page.getBoundingClientRect();
        hit.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true, cancelable: true,
            clientX: r.left + (${x} / pw) * r.width,
            clientY: r.top + (${y} / ph) * r.height,
            buttons: 0, pointerId: 95, pointerType: 'mouse', isPrimary: true
          })
        );
        return true;
      })()`
    );
  await movePointerTo(cycleMid.x, cycleMid.y);
  await sleep(220);
  const hoverBond = await readDom(
    win,
    `(() => {
      const group = document.querySelector('[data-testid="bond-hover"]');
      return { present: Boolean(group), lines: group ? group.querySelectorAll('line').length : 0 };
    })()`
  );
  await movePointerTo(cycleMid.x - 55, cycleMid.y);
  await sleep(220);
  const hoverAtom = await readDom(
    win,
    `(() => {
      const group = document.querySelector('[data-testid="bond-hover"]');
      return { present: Boolean(group), circles: group ? group.querySelectorAll('circle').length : 0 };
    })()`
  );

  // ---- 苯环碳按 120° 规范延伸碳链 ----
  await selectTool('ring');
  await readDom(win, `document.querySelector('[data-benzene-style="pauling"]').click()`);
  await sleep(150);
  await readDom(win, clickExpression(0.58, 0.9));
  await sleep(420);
  const ringObjects = await countObjects();
  const beforeLines = await readDom(
    win,
    `[...document.querySelectorAll('.scene-layer line')].map((l) =>
      [l.getAttribute('x1'), l.getAttribute('y1'), l.getAttribute('x2'), l.getAttribute('y2')].join(',')
    )`
  );
  const ringFrame = await readDom(
    win,
    `(() => {
      const lines = [...document.querySelectorAll('.scene-layer line')].slice(-6);
      const points = [];
      for (const line of lines) {
        for (const pair of [
          [+line.getAttribute('x1'), +line.getAttribute('y1')],
          [+line.getAttribute('x2'), +line.getAttribute('y2')]
        ]) {
          if (!points.some((p) => Math.abs(p.x - pair[0]) < 0.5 && Math.abs(p.y - pair[1]) < 0.5)) {
            points.push({ x: pair[0], y: pair[1] });
          }
        }
      }
      const vertex = points.reduce((a, b) => (b.x > a.x ? b : a), { x: -1, y: -1 });
      const center = points.reduce(
        (acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }),
        { x: 0, y: 0 }
      );
      return { vertex, center, points, count: points.length };
    })()`
  );
  const circleBefore = await readDom(
    win,
    `(() => {
      const circles = [...document.querySelectorAll('.scene-layer circle')];
      const circle = circles[circles.length - 1];
      return circle
        ? {
            cx: Number(circle.getAttribute('cx')),
            cy: Number(circle.getAttribute('cy')),
            r: Number(circle.getAttribute('r')),
            count: circles.length
          }
        : null;
    })()`
  );

  // 即使选择双键工具，环骨架原子也必须落成单键
  await selectTool('bond');
  await readDom(win, `document.querySelector('[data-bond="double"]').click()`);
  await sleep(160);
  await readDom(win, clickPage(ringFrame.vertex.x, ringFrame.vertex.y));
  await sleep(420);
  const extensionToast = await readDom(
    win,
    `[...document.querySelectorAll('[data-testid="toast"]')].map((el) => el.textContent || '').join('|')`
  );
  const circleAfter = await readDom(
    win,
    `(() => {
      const circles = [...document.querySelectorAll('.scene-layer circle')];
      const circle = circles[circles.length - 1];
      return circle
        ? {
            cx: Number(circle.getAttribute('cx')),
            cy: Number(circle.getAttribute('cy')),
            r: Number(circle.getAttribute('r')),
            count: circles.length
          }
        : null;
    })()`
  );
  const extension = await readDom(
    win,
    `(() => {
      const before = ${JSON.stringify(beforeLines)};
      const vertex = { x: ${ringFrame.vertex.x}, y: ${ringFrame.vertex.y} };
      const lines = [...document.querySelectorAll('.scene-layer line')];
      const key = (l) =>
        [l.getAttribute('x1'), l.getAttribute('y1'), l.getAttribute('x2'), l.getAttribute('y2')].join(',');
      const added = lines.filter((l) => !before.includes(key(l)));
      if (added.length === 0) return { added: 0 };
      const bond = added[0];
      const dx = +bond.getAttribute('x2') - +bond.getAttribute('x1');
      const dy = +bond.getAttribute('y2') - +bond.getAttribute('y1');
      const base = (Math.atan2(dy, dx) * 180) / Math.PI;
      const angleOf = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const nearVertex = (p) => Math.hypot(p.x - vertex.x, p.y - vertex.y) < 0.8;
      const incident = [];
      for (const line of lines) {
        if (added.includes(line)) continue;
        const p = { x: +line.getAttribute('x1'), y: +line.getAttribute('y1') };
        const q = { x: +line.getAttribute('x2'), y: +line.getAttribute('y2') };
        if (nearVertex(p)) incident.push(angleOf(vertex, q));
        else if (nearVertex(q)) incident.push(angleOf(vertex, p));
      }
      const deltas = incident.map((angle) => {
        let delta = Math.abs(angle - base);
        if (delta > 180) delta = 360 - delta;
        return delta;
      });
      const p1 = { x: +bond.getAttribute('x1'), y: +bond.getAttribute('y1') };
      const p2 = { x: +bond.getAttribute('x2'), y: +bond.getAttribute('y2') };
      const end =
        Math.hypot(p1.x - vertex.x, p1.y - vertex.y) >
        Math.hypot(p2.x - vertex.x, p2.y - vertex.y)
          ? p1
          : p2;
      return {
        added: added.length,
        addedKeys: added.map(key),
        end,
        length: Math.hypot(dx, dy),
        deltas,
        objects: document.querySelectorAll('.scene-layer [data-object-id]').length
      };
    })()`
  );

  // 与苯环相连的碳支链只允许单键：升级尝试应被拒绝且线型不变
  const branchMid = (() => {
    const [x1, y1, x2, y2] = (extension.addedKeys?.[0] || '0,0,0,0').split(',').map(Number);
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  })();
  const branchLevels = [];
  branchLevels.push(await readDom(win, `document.querySelectorAll('.scene-layer line').length`));
  for (let index = 0; index < 2; index += 1) {
    await readDom(win, clickPage(branchMid.x, branchMid.y));
    await sleep(320);
    branchLevels.push(await readDom(win, `document.querySelectorAll('.scene-layer line').length`));
  }
  const branchToast = await readDom(
    win,
    `[...document.querySelectorAll('[data-testid="toast"]')].map((el) => el.textContent || '').join('|')`
  );

  await readDom(win, clickPage(ringFrame.vertex.x, ringFrame.vertex.y));
  await sleep(380);
  const saturated = await readDom(
    win,
    `(() => {
      const vx = ${ringFrame.vertex.x};
      const vy = ${ringFrame.vertex.y};
      const incident = [...document.querySelectorAll('.scene-layer line')].filter((line) => {
        const points = [
          [+line.getAttribute('x1'), +line.getAttribute('y1')],
          [+line.getAttribute('x2'), +line.getAttribute('y2')]
        ];
        return points.some(([x, y]) => Math.hypot(x - vx, y - vy) < 0.8);
      }).length;
      return {
        objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
        lines: document.querySelectorAll('.scene-layer line').length,
        incident,
        tool: document.querySelector('[data-testid="status-tool"]')?.textContent || null,
        toast: [...document.querySelectorAll('[data-testid="toast"]')].map((el) => el.textContent || '').join('|')
      };
    })()`
  );

  // 在取代基末端继续加单键：环内圈必须保持
  await selectTool('bond');
  await readDom(win, `document.querySelector('[data-bond="single"]').click()`);
  await sleep(160);
  await readDom(win, clickPage(extension.end.x, extension.end.y));
  await sleep(420);
  const childExtension = await readDom(
    win,
    `(() => {
      const circles = [...document.querySelectorAll('.scene-layer circle')];
      const circle = circles[circles.length - 1];
      return {
        objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
        lines: document.querySelectorAll('.scene-layer line').length,
        circle: circle
          ? {
              cx: Number(circle.getAttribute('cx')),
              cy: Number(circle.getAttribute('cy')),
              r: Number(circle.getAttribute('r'))
            }
          : null
      };
    })()`
  );

  // 羟基必须作为取代基挂接到环碳，不得替换或破坏环骨架
  const ohVertex = ringFrame.points.reduce(
    (a, b) => (b.y < a.y ? b : a),
    ringFrame.points[0]
  );
  await selectTool('atom');
  await readDom(win, `document.querySelector('[data-chem-category="group"]').click()`);
  await sleep(160);
  await readDom(win, `document.querySelector('[data-atom="OH"]').click()`);
  await sleep(180);
  const hydroxylBefore = await readDom(
    win,
    `(() => ({
      objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
      lines: document.querySelectorAll('.scene-layer line').length,
      circles: document.querySelectorAll('.scene-layer circle').length
    }))()`
  );
  await readDom(win, clickPage(ohVertex.x, ohVertex.y));
  await sleep(420);
  const hydroxyl = await readDom(
    win,
    `(() => {
      const circles = [...document.querySelectorAll('.scene-layer circle')];
      const circle = circles[circles.length - 1];
      return {
        objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
        lines: document.querySelectorAll('.scene-layer line').length,
        circles: circles.length,
        labels: [...document.querySelectorAll('.scene-layer text')].filter(
          (el) => (el.textContent || '').trim() === 'OH'
        ).length,
        circle: circle
          ? {
              cx: Number(circle.getAttribute('cx')),
              cy: Number(circle.getAttribute('cy')),
              r: Number(circle.getAttribute('r'))
            }
          : null
      };
    })()`
  );

  // 已饱和的环碳不能再挂第二个羟基
  await readDom(win, clickPage(ohVertex.x, ohVertex.y));
  await sleep(360);
  const hydroxylBlocked = await readDom(
    win,
    `(() => ({
      objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
      toast: [...document.querySelectorAll('[data-testid="toast"]')]
        .map((el) => el.textContent || '')
        .join('|')
    }))()`
  );

  // 延伸出的取代基应随苯环编组一起移动
  await selectTool('select');
  await readDom(win, clickPage(ringFrame.center.x, ringFrame.center.y));
  await sleep(320);
  const ringSelected = await readDom(
    win,
    `document.querySelector('[data-testid="selection-count"]')?.textContent || null`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      if (!hit || !page) return false;
      const pw = Number(page.getAttribute('data-page-width')) || 1123;
      const ph = Number(page.getAttribute('data-page-height')) || 794;
      const r = page.getBoundingClientRect();
      const sx = r.left + (${ringFrame.center.x} / pw) * r.width;
      const sy = r.top + (${ringFrame.center.y} / ph) * r.height;
      const dx = (36 * r.width) / pw;
      const dy = (24 * r.height) / ph;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 34, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(sx + dx / 2, sy + dy / 2, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(sx + dx, sy + dy, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(sx + dx, sy + dy, 0)));
      return true;
    })()`
  );
  await sleep(420);
  const groupMove = await readDom(
    win,
    `(() => {
      const lineKeys = [...document.querySelectorAll('.scene-layer line')].map((line) =>
        [line.getAttribute('x1'), line.getAttribute('y1'), line.getAttribute('x2'), line.getAttribute('y2')].join(',')
      );
      const beforeKeys = ${JSON.stringify(extension.addedKeys || [])};
      // 若取代基仍停留在原坐标，说明没有跟随编组移动
      const leftBehind = beforeKeys.some((key) => lineKeys.includes(key));
      const vertexX = ${ringFrame.vertex.x};
      const vertexY = ${ringFrame.vertex.y};
      const ringMoved = ![...document.querySelectorAll('.scene-layer line')].some((line) =>
        [
          [+line.getAttribute('x1'), +line.getAttribute('y1')],
          [+line.getAttribute('x2'), +line.getAttribute('y2')]
        ].some(([x, y]) => Math.hypot(x - vertexX, y - vertexY) < 1)
      );
      return { moved: ringMoved && !leftBehind, ringMoved, leftBehind };
    })()`
  );

  // ---- 环己烷：双键不降级 + 氢原子挂接不破坏环骨架 ----
  await selectTool('ring');
  await readDom(win, `document.querySelector('[data-ring="cyclohexane"]').click()`);
  await sleep(180);
  await readDom(win, clickExpression(0.33, 0.88));
  await sleep(420);
  const cycloObjects = await countObjects();
  const cycloLines = await readDom(win, `document.querySelectorAll('.scene-layer line').length`);
  const cycloFrame = await readDom(
    win,
    `(() => {
      const lines = [...document.querySelectorAll('.scene-layer line')].slice(-6);
      const points = [];
      for (const line of lines) {
        for (const pair of [
          [+line.getAttribute('x1'), +line.getAttribute('y1')],
          [+line.getAttribute('x2'), +line.getAttribute('y2')]
        ]) {
          if (!points.some((p) => Math.abs(p.x - pair[0]) < 0.5 && Math.abs(p.y - pair[1]) < 0.5)) {
            points.push({ x: pair[0], y: pair[1] });
          }
        }
      }
      return {
        right: points.reduce((a, b) => (b.x > a.x ? b : a), points[0]),
        left: points.reduce((a, b) => (b.x < a.x ? b : a), points[0]),
        count: points.length
      };
    })()`
  );

  await selectTool('bond');
  await readDom(win, `document.querySelector('[data-bond="double"]').click()`);
  await sleep(160);
  await readDom(win, clickPage(cycloFrame.right.x, cycloFrame.right.y));
  await sleep(420);
  const cycloDouble = await readDom(
    win,
    `(() => ({
      lines: document.querySelectorAll('.scene-layer line').length,
      objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
      toast: [...document.querySelectorAll('[data-testid="toast"]')]
        .map((el) => el.textContent || '')
        .join('|')
    }))()`
  );

  // 环戊烷外侧支链同样支持键级循环
  const cycloBranchMid = await readDom(
    win,
    `(() => {
      const lines = [...document.querySelectorAll('.scene-layer line')];
      const last = lines[lines.length - 1];
      return last
        ? {
            x: (+last.getAttribute('x1') + +last.getAttribute('x2')) / 2,
            y: (+last.getAttribute('y1') + +last.getAttribute('y2')) / 2
          }
        : null;
    })()`
  );
  const cycloBranchLevels = [];
  cycloBranchLevels.push(await readDom(win, `document.querySelectorAll('.scene-layer line').length`));
  if (cycloBranchMid) {
    for (let index = 0; index < 3; index += 1) {
      await readDom(win, clickPage(cycloBranchMid.x, cycloBranchMid.y));
      await sleep(300);
      cycloBranchLevels.push(await readDom(win, `document.querySelectorAll('.scene-layer line').length`));
    }
  }
  const cycloBranchToast = await readDom(
    win,
    `[...document.querySelectorAll('[data-testid="toast"]')].map((el) => el.textContent || '').join('|')`
  );

  await selectTool('atom');
  await readDom(win, `document.querySelector('[data-chem-category="element"]').click()`);
  await sleep(160);
  await readDom(win, `document.querySelector('[data-atom="H"]').click()`);
  await sleep(160);
  const hydrogenBefore = await readDom(
    win,
    `(() => ({
      objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
      lines: document.querySelectorAll('.scene-layer line').length
    }))()`
  );
  await readDom(win, clickPage(cycloFrame.left.x, cycloFrame.left.y));
  await sleep(420);
  const hydrogen = await readDom(
    win,
    `(() => ({
      objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
      lines: document.querySelectorAll('.scene-layer line').length,
      labels: [...document.querySelectorAll('.scene-layer text')].filter(
        (el) => (el.textContent || '').trim() === 'H'
      ).length
    }))()`
  );

  // ---- 橡皮擦：笔刷擦除键 / 原子 / 图形，断环后芳香性解除 ----
  await selectTool('eraser');
  const eraseSnapshot = () =>
    readDom(
      win,
      `(() => ({
        objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
        lines: document.querySelectorAll('.scene-layer [data-object-id] line').length,
        rects: document.querySelectorAll('.scene-layer [data-object-id] rect').length,
        circles: document.querySelectorAll('.scene-layer [data-object-id] circle').length,
        paths: document.querySelectorAll('.scene-layer [data-object-id] path').length,
        strokeMasks: document.querySelectorAll('.scene-layer mask[id^="stroke-erase-"]').length,
        masks: document.querySelectorAll('.scene-layer mask[id^="erase-"], .scene-layer mask[id^="stroke-erase-"]').length,
        labels: [...document.querySelectorAll('.scene-layer [data-object-id] text')].filter(
          (el) => (el.textContent || '').trim() === 'OH'
        ).length
      }))()`
    );
  const eraseBefore = await eraseSnapshot();

  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const pw = Number(page.getAttribute('data-page-width')) || 1123;
      const ph = Number(page.getAttribute('data-page-height')) || 794;
      const sx = r.left + (${cycleMid.x} / pw) * r.width;
      const sy = r.top + (${cycleMid.y} / ph) * r.height;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 51, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(sx + 2, sy + 1, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(sx + 2, sy + 1, 0)));
      return true;
    })()`
  );
  await sleep(350);
  const afterEraseBond = await eraseSnapshot();

  // 擦除羟基标签应连带删除其成键
  const ohPosition = await readDom(
    win,
    `(() => {
      const el = [...document.querySelectorAll('.scene-layer text')].find(
        (item) => (item.textContent || '').trim() === 'OH'
      );
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`
  );
  if (ohPosition) {
    await readDom(
      win,
      `(() => {
        const hit = document.querySelector('[data-testid="canvas-hit"]');
        const opts = (buttons) => ({
          bubbles: true, cancelable: true, clientX: ${ohPosition.x}, clientY: ${ohPosition.y},
          button: 0, buttons, pointerId: 52, pointerType: 'mouse', isPrimary: true
        });
        hit.dispatchEvent(new PointerEvent('pointerdown', opts(1)));
        hit.dispatchEvent(new PointerEvent('pointerup', opts(0)));
        return true;
      })()`
    );
    await sleep(350);
  }
  const afterEraseAtom = await eraseSnapshot();

  // 实时橡皮擦过矩形边缘：线条目标命中，整对象删除（不再拆成路径碎片）
  await selectTool('eraser-live');
  // 擦除目标会持久化到本机偏好：先把“全部擦除”打开，保证本段按全目标擦除。
  await readDom(
    win,
    `(() => {
      const all = document.querySelector('[data-eraser-target="all"]');
      if (all && !all.classList.contains('is-active')) all.click();
      return true;
    })()`
  );
  await sleep(120);
  const rectEdge = await readDom(
    win,
    `(() => {
      const el = document.querySelector('.scene-layer [data-object-id] rect');
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { x: box.left, y: box.top + box.height / 2 };
    })()`
  );
  if (rectEdge) {
    await readDom(
      win,
      `(() => {
        const hit = document.querySelector('[data-testid="canvas-hit"]');
        const opts = (x, y, buttons) => ({
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          button: 0, buttons, pointerId: 53, pointerType: 'mouse', isPrimary: true,
          altKey: true
        });
        hit.dispatchEvent(new PointerEvent('pointerdown', opts(${rectEdge.x} - 14, ${rectEdge.y}, 1)));
        hit.dispatchEvent(new PointerEvent('pointermove', opts(${rectEdge.x} + 14, ${rectEdge.y}, 1)));
        hit.dispatchEvent(new PointerEvent('pointerup', opts(${rectEdge.x} + 14, ${rectEdge.y}, 0)));
        return true;
      })()`
    );
    await sleep(350);
  }
  const afterEraseRect = await eraseSnapshot();

  // 化学橡皮擦断一条苯环环键：内圈消失（芳香性解除）
  await selectTool('eraser');
  const ringEdge = await readDom(
    win,
    `(() => {
      const circles = [...document.querySelectorAll('.scene-layer circle')];
      const circle = circles[circles.length - 1];
      if (!circle) return null;
      const cx = Number(circle.getAttribute('cx'));
      const cy = Number(circle.getAttribute('cy'));
      const radius = Number(circle.getAttribute('r')) / 0.55;
      const edges = [...document.querySelectorAll('.scene-layer line')].filter((line) => {
        const x1 = Number(line.getAttribute('x1'));
        const y1 = Number(line.getAttribute('y1'));
        const x2 = Number(line.getAttribute('x2'));
        const y2 = Number(line.getAttribute('y2'));
        const d1 = Math.hypot(x1 - cx, y1 - cy);
        const d2 = Math.hypot(x2 - cx, y2 - cy);
        return Math.abs(d1 - radius) < 2 && Math.abs(d2 - radius) < 2;
      });
      const edge = edges[0];
      if (!edge) return null;
      return {
        x: (Number(edge.getAttribute('x1')) + Number(edge.getAttribute('x2'))) / 2,
        y: (Number(edge.getAttribute('y1')) + Number(edge.getAttribute('y2'))) / 2
      };
    })()`
  );
  if (ringEdge) {
    // 橡皮半径改为页面像素后，铺满整页时 12px 的橡皮在屏幕上偏小；
    // 这里显式放大到 30，保证点击确实命中环键而不是环内圈。
    await readDom(
      win,
      `(() => {
        const range = document.querySelector('[data-testid="stroke-width-range"]');
        if (!range) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(range, '12');
        range.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    );
    await sleep(200);
    await readDom(win, clickPage(ringEdge.x, ringEdge.y));
    await sleep(380);
  }
  const afterEraseRing = await eraseSnapshot();

  // ---- 形状工具整合 ----
  await readDom(win, `document.querySelector('[data-tool="shape"]').click()`);
  await sleep(220);
  const shapePanel = await readDom(
    win,
    `(() => ({
      shapes: document.querySelectorAll('[data-shape]').length,
      panel: Boolean(document.querySelector('[data-testid="shape-dock"]')),
      bar: !Boolean(document.querySelector('[data-feature="shape"]'))
    }))()`
  );

  // ---- 画笔：硬笔 / 铅笔 / 硬圆 ----
  await selectTool('brush', { keepShape: true });
  const brushPanel = await readDom(
    win,
    `(() => ({
      presets: document.querySelectorAll('[data-brush]').length,
      glyphs: document.querySelectorAll('[data-brush] .brush-glyph').length,
      cursor: Boolean(document.querySelector('[data-testid="brush-cursor"]')),
      shapeStillOpen: Boolean(document.querySelector('[data-testid="shape-dock"]')),
      shapeSnap: Boolean(document.querySelector('[data-testid="shape-snap-toggle"]')),
      brushActive: document.querySelector('[data-tool="brush"]')?.classList.contains('is-active') ?? false
    }))()`
  );
  await selectBrushPreset('round');
  await sleep(160);
  // 选色后画笔颜色应保持所选（不再回落到黑色）
  await selectTool('select');
  await readDom(win, clickExpression(0.02, 0.02));
  await sleep(220);
  await selectTool('brush');
  await ensurePaletteOpen();
  await readDom(win, `Boolean(document.querySelector('[data-color-mode="palette"]')?.click())`);
  await sleep(220);
  const brushColor = await readDom(
    win,
    `document.querySelectorAll('.color-grid .swatch')[5]?.getAttribute('title') || null`
  );
  await readDom(win, `document.querySelectorAll('.color-grid .swatch')[5]?.click()`);
  await sleep(220);
  await readDom(
    win,
    `(() => {
      const el = document.querySelector('[data-testid="brush-opacity"]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '50');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  await sleep(200);
  const brushBefore = await countObjects();
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + fx * r.width, y: r.top + fy * r.height });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 61, pointerType: 'mouse', isPrimary: true
      });
      const start = point(0.08, 0.8);
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(start, 1)));
      for (let index = 1; index <= 6; index += 1) {
        hit.dispatchEvent(
          new PointerEvent('pointermove', opts(point(0.08 + index * 0.018, 0.8 + Math.sin(index) * 0.012), 1))
        );
      }
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(0.19, 0.8), 0)));
      return true;
    })()`
  );
  await sleep(380);
  const brushInfo = await readDom(
    win,
    `(() => {
      const paths = [...document.querySelectorAll('.scene-layer path')];
      const last = paths[paths.length - 1];
      return {
        objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
        width: last?.getAttribute('stroke-width') || null,
        stroke: last?.getAttribute('stroke') || null,
        opacity: last?.getAttribute('opacity') || null,
        // 贝塞尔拟合后路径由 L/C 段组成，按绘制指令计数
        points: ((last?.getAttribute('d') || '').match(/[LC]/g) || []).length + 1
      };
    })()`
  );

  // ---- 压感笔迹：pen 指针 + 压力变化应生成宽度包络（填充轮廓） ----
  await selectBrushPreset('pen');
  await sleep(180);
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons, pressure) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 71, pointerType: 'pen', isPrimary: true, pressure
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.3, 0.86), 1, 0.15)));
      for (let index = 1; index <= 10; index += 1) {
        const pressure = 0.15 + index * 0.08;
        hit.dispatchEvent(
          new PointerEvent('pointermove', opts(point(0.3 + index * 0.02, 0.86 + Math.sin(index) * 0.01), 1, pressure))
        );
      }
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(0.52, 0.86), 0, 0.15)));
      return true;
    })()`
  );
  await sleep(420);
  const penStroke = await readDom(
    win,
    `(() => {
      const paths = [...document.querySelectorAll('.scene-layer path')];
      const last = paths[paths.length - 1];
      const d = last?.getAttribute('d') || '';
      const area = (() => {
        // 粗估轮廓面积：填充轮廓的包围盒应明显大于线宽本身
        const numbers = (d.replace(/A[^A-Za-z]*/g, ' ').match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
        const xs = [];
        const ys = [];
        for (let index = 0; index + 1 < numbers.length; index += 2) {
          xs.push(numbers[index]);
          ys.push(numbers[index + 1]);
        }
        if (xs.length === 0) return null;
        return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      })();
      return {
        fill: last?.getAttribute('fill') || null,
        stroke: last?.getAttribute('stroke') || null,
        arcs: (d.match(/A/g) || []).length,
        segments: (d.match(/[LC]/g) || []).length,
        box: area
      };
    })()`
  );

  // ---- 油漆桶 ----
  await selectTool('select');
  await readDom(win, clickExpression(0.02, 0.02));
  await sleep(240);
  await readDom(win, `document.querySelector('[data-color-target="fill"]').click()`);
  await sleep(120);
  await readDom(win, `Boolean(document.querySelector('[data-color-mode="palette"]')?.click())`);
  await sleep(200);
  await readDom(win, `Boolean(document.querySelector('.color-grid .swatch')?.click())`);
  await sleep(220);
  const bucketColor = await readDom(
    win,
    `(() => {
      const value = document.querySelector('[data-testid="palette-fill-hex"]')?.textContent?.trim() || '';
      return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
    })()`
  );

  await selectTool('rect');
  await readDom(win, dragExpression(0.5, 0.74, 0.58, 0.8));
  await sleep(320);
  const bucketBefore = await countObjects();
  await selectTool('bucket');
  const bucketModes = await readDom(win, `document.querySelectorAll('[data-bucket-mode]').length`);
  const bucketChrome = await readDom(
    win,
    `(() => ({
      bar: !Boolean(document.querySelector('[data-feature="bucket"]')),
      dock: Boolean(document.querySelector('[data-testid="bucket-dock"]'))
    }))()`
  );
  await readDom(win, clickExpression(0.54, 0.77));
  await sleep(320);
  const bucketInfo = await readDom(
    win,
    `(() => {
      const rects = [...document.querySelectorAll('.scene-layer rect')];
      const last = rects[rects.length - 1];
      return {
        fill: last?.getAttribute('fill') || null,
        objects: document.querySelectorAll('.scene-layer [data-object-id]').length
      };
    })()`
  );

  // ---- 实时橡皮擦除图形 ----
  await selectTool('eraser-live');
  // 偏好可能残留上次运行的目标：先归一为“全部擦除”。
  await readDom(
    win,
    `(() => {
      const all = document.querySelector('[data-eraser-target="all"]');
      if (all && !all.classList.contains('is-active')) all.click();
      return true;
    })()`
  );
  await sleep(120);
  const liveBefore = await readDom(
    win,
    `(() => ({
      objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
      rects: document.querySelectorAll('.scene-layer rect').length,
      lines: document.querySelectorAll('.scene-layer line').length,
      texts: document.querySelectorAll('.scene-layer text').length,
      paths: document.querySelectorAll('.scene-layer path').length,
      ellipses: document.querySelectorAll('.scene-layer ellipse').length,
      strokeMasks: document.querySelectorAll('.scene-layer mask[id^="stroke-erase-"]').length,
      masks: document.querySelectorAll('.scene-layer mask[id^="erase-"], .scene-layer mask[id^="stroke-erase-"]').length
    }))()`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + fx * r.width, y: r.top + fy * r.height });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 62, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.485, 0.77), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.505, 0.77), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.525, 0.77), 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(0.525, 0.77), 0)));
      return true;
    })()`
  );
  await sleep(350);
  const liveAfter = await readDom(
    win,
    `(() => ({
      objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
      rects: document.querySelectorAll('.scene-layer rect').length,
      lines: document.querySelectorAll('.scene-layer line').length,
      texts: document.querySelectorAll('.scene-layer text').length,
      paths: document.querySelectorAll('.scene-layer path').length,
      ellipses: document.querySelectorAll('.scene-layer ellipse').length,
      strokeMasks: document.querySelectorAll('.scene-layer mask[id^="stroke-erase-"]').length,
      masks: document.querySelectorAll('.scene-layer mask[id^="erase-"], .scene-layer mask[id^="stroke-erase-"]').length,
      cursor: Boolean(document.querySelector('[data-testid="eraser-cursor"]'))
    }))()`
  );

  // ---- 填充区域：新建矩形并用油漆桶上色，供下面的分目标擦除验证 ----
  await selectTool('rect');
  await readDom(win, dragExpression(0.62, 0.6, 0.72, 0.68));
  await sleep(320);
  await selectTool('bucket');
  await readDom(win, clickExpression(0.67, 0.64));
  await sleep(320);

  // ---- 橡皮擦横栏：五项目标、多选与“全部擦除”联动 ----
  await selectTool('eraser-live');
  // 偏好可能残留上次运行的目标：先归一为“全部擦除”。
  await readDom(
    win,
    `(() => {
      const all = document.querySelector('[data-eraser-target="all"]');
      if (all && !all.classList.contains('is-active')) all.click();
      return true;
    })()`
  );
  await sleep(120);
  const eraserDock = await readDom(
    win,
    `(() => {
      const items = [...document.querySelectorAll('[data-eraser-target]')];
      return {
        dock: Boolean(document.querySelector('[data-testid="eraser-dock"]')),
        count: items.length,
        labels: items.map((el) => (el.textContent || '').trim()),
        active: items.filter((el) => el.classList.contains('is-active')).length,
        all: document.querySelector('[data-eraser-target="all"]')?.classList.contains('is-active') ?? false
      };
    })()`
  );
  // 取消“全部擦除”：其余三项一并取消。
  await readDom(win, `document.querySelector('[data-eraser-target="all"]').click()`);
  await sleep(120);
  const eraserDockOff = await readDom(
    win,
    `(() => {
      const items = [...document.querySelectorAll('[data-eraser-target]')];
      return {
        active: items.filter((el) => el.classList.contains('is-active')).length,
        all: document.querySelector('[data-eraser-target="all"]')?.classList.contains('is-active') ?? false
      };
    })()`
  );
  // 单独选中“擦除填充”：其余保持关闭。
  await readDom(win, `document.querySelector('[data-eraser-target="fill"]').click()`);
  await sleep(120);
  const eraserDockFill = await readDom(
    win,
    `(() => ({
      fill: document.querySelector('[data-eraser-target="fill"]')?.classList.contains('is-active') ?? false,
      outline: document.querySelector('[data-eraser-target="outline"]')?.classList.contains('is-active') ?? false,
      all: document.querySelector('[data-eraser-target="all"]')?.classList.contains('is-active') ?? false
    }))()`
  );
  // 再点“全部擦除”：三项一起选中。
  await readDom(win, `document.querySelector('[data-eraser-target="all"]').click()`);
  await sleep(120);
  const eraserDockAll = await readDom(
    win,
    `(() => {
      const items = [...document.querySelectorAll('[data-eraser-target]')];
      return {
        active: items.filter((el) => el.classList.contains('is-active')).length,
        all: document.querySelector('[data-eraser-target="all"]')?.classList.contains('is-active') ?? false
      };
    })()`
  );

  await screenshot('smoke-eraser-dock.png');

  // ---- 填充擦除：只挖掉笔刷经过的填充，描边与对象保留 ----
  // 只保留“擦除填充”目标：线条/描边关闭，避免轮廓被切。
  await readDom(
    win,
    `(() => {
      document.querySelector('[data-eraser-target="outline"]')?.click();
      return true;
    })()`
  );
  await sleep(120);
  // 按对象 id 跟踪刚画的黑填充矩形：擦除后它会转成带孔路径，不能再按“最后一个 rect”找。
  const filledTarget = await readDom(
    win,
    `(() => {
      const groups = [...document.querySelectorAll('.scene-layer [data-object-id]')];
      const last = groups[groups.length - 1];
      const rect = last?.querySelector('rect');
      return last
        ? {
            id: last.getAttribute('data-object-id'),
            fill: rect?.getAttribute('fill') || null,
            stroke: rect?.getAttribute('stroke') || null
          }
        : null;
    })()`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 74, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.635, 0.64), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.67, 0.64), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.705, 0.64), 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(0.705, 0.64), 0)));
      return true;
    })()`
  );
  await sleep(420);
  const fillErase = await readDom(
    win,
    `(() => {
      const group = document.querySelector('[data-object-id="${filledTarget?.id}"]');
      if (!group) return { missing: true };
      const paths = [...group.querySelectorAll('path')];
      const fillPath = paths.find((path) => (path.getAttribute('fill') || 'none') !== 'none');
      const strokePath = paths.find((path) => (path.getAttribute('stroke') || 'none') !== 'none');
      const maskAttr = fillPath?.getAttribute('mask') || null;
      const maskId =
        maskAttr && maskAttr.startsWith('url(#') ? maskAttr.slice(5, -1) : null;
      const mask = maskId ? document.getElementById(maskId) : null;
      return {
        missing: false,
        fill: fillPath?.getAttribute('fill') || null,
        mask: Boolean(maskId),
        maskBlack: mask
          ? mask.querySelectorAll('[fill="#000"], [stroke="#000"]').length
          : 0,
        stroke: strokePath?.getAttribute('stroke') || null,
        rect: Boolean(group.querySelector('rect'))
      };
    })()`
  );
  // 再点一次：mask 黑块只增不减，绝不把填充“擦回来”，也不删对象。
  await readDom(win, clickExpression(0.67, 0.64));
  await sleep(320);
  const fillEraseClick = await readDom(
    win,
    `(() => {
      const group = document.querySelector('[data-object-id="${filledTarget?.id}"]');
      if (!group) return { missing: true };
      const paths = [...group.querySelectorAll('path')];
      const fillPath = paths.find((path) => (path.getAttribute('fill') || 'none') !== 'none');
      const maskAttr = fillPath?.getAttribute('mask') || null;
      const maskId =
        maskAttr && maskAttr.startsWith('url(#') ? maskAttr.slice(5, -1) : null;
      const mask = maskId ? document.getElementById(maskId) : null;
      return {
        missing: false,
        fill: fillPath?.getAttribute('fill') || null,
        maskBlack: mask
          ? mask.querySelectorAll('[fill="#000"], [stroke="#000"]').length
          : 0
      };
    })()`
  );
  // 恢复“全部擦除”，后续流程按全目标擦除。
  await readDom(win, `document.querySelector('[data-eraser-target="all"]').click()`);
  await sleep(120);

  // ---- 大小调节：画笔调笔刷，橡皮调擦除半径 ----
  await selectTool('eraser-live');
  await readDom(
    win,
    `(() => {
      const range = document.querySelector('[data-testid="stroke-width-range"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, '30');
      range.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  await sleep(220);
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      hit.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientX: r.left + r.width * 0.45,
          clientY: r.top + r.height * 0.45,
          buttons: 0,
          pointerId: 90,
          pointerType: 'mouse',
          isPrimary: true
        })
      );
      return true;
    })()`
  );
  await sleep(220);
  const eraserCursor = await readDom(
    win,
    `(() => {
      const ring = document.querySelector('[data-testid="eraser-cursor"] circle');
      const value = document.querySelector('.dock-slider__head .input')?.value || null;
      return { r: ring ? Number(ring.getAttribute('r')) : null, value };
    })()`
  );
  await selectTool('brush');
  await readDom(
    win,
    `(() => {
      const range = document.querySelector('[data-testid="stroke-width-range"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, '14');
      range.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  await sleep(220);
  await readDom(win, dragExpression(0.32, 0.52, 0.38, 0.55));
  await sleep(320);
  const brushSized = await readDom(
    win,
    `(() => {
      const paths = [...document.querySelectorAll('.scene-layer path')];
      // 带压感/渐隐的笔迹渲染为填充轮廓（stroke=none），此时回读画笔面板的数值
      const strokeWidth = paths[paths.length - 1]?.getAttribute('stroke-width') || null;
      const panelValue = document.querySelector('[data-testid="brush-size"]')?.value || null;
      return strokeWidth || panelValue;
    })()`
  );

  // ---- 选区框选：选中笔迹、移动、删除 ----
  await selectTool('select');
  // 框选只覆盖刚画的那一笔：页面中部还叠着导入 SVG 的文本/路径，
  // 旧的大框会把它们一起选中，导致“删除一个对象”的断言失真。
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 91, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.305, 0.5), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.32, 0.53), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.335, 0.56), 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(0.335, 0.56), 0)));
      return true;
    })()`
  );
  await sleep(320);
  const marqueeSelect = await readDom(
    win,
    `(() => {
      const overlay = document.querySelector('.selection-overlay rect');
      const box = overlay?.getBoundingClientRect();
      return {
        count: document.querySelector('[data-testid="selection-count"]')?.textContent || null,
        overlay: Boolean(overlay),
        center: box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null
      };
    })()`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const overlay = document.querySelector('.selection-overlay rect');
      const box = overlay?.getBoundingClientRect();
      if (!hit || !box) return false;
      const sx = box.left + box.width / 2;
      const sy = box.top + box.height / 2;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 92, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(sx + 26, sy + 14, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(sx + 26, sy + 14, 0)));
      return true;
    })()`
  );
  await sleep(340);
  const marqueeMoved = await readDom(
    win,
    `(() => {
      const overlay = document.querySelector('.selection-overlay rect');
      const box = overlay?.getBoundingClientRect();
      return box
        ? { center: { x: box.left + box.width / 2, y: box.top + box.height / 2 } }
        : { center: null };
    })()`
  );
  const objectsBeforeDelete = await readDom(
    win,
    `document.querySelectorAll('.scene-layer [data-object-id]').length`
  );
  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`
  );
  await sleep(340);
  const selectionDeleted = await readDom(
    win,
    `(() => ({
      objects: document.querySelectorAll('.scene-layer [data-object-id]').length,
      properties: Boolean(document.querySelector('[data-testid="object-properties"]'))
    }))()`
  );

  // ---- 滚轮：单滚轮 / Ctrl+滚轮都直接缩放 ----
  const zoomBefore = await readDom(
    win,
    `document.querySelector('.zoom-dock__value')?.textContent || null`
  );
  const panBefore = await readDom(
    win,
    `document.querySelector('.canvas-svg > g')?.getAttribute('transform') || null`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const rect = hit.getBoundingClientRect();
      hit.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -240,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2
        })
      );
      return true;
    })()`
  );
  await sleep(300);
  const zoomPlain = await readDom(
    win,
    `document.querySelector('.zoom-dock__value')?.textContent || null`
  );
  const panAfter = await readDom(
    win,
    `document.querySelector('.canvas-svg > g')?.getAttribute('transform') || null`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const rect = hit.getBoundingClientRect();
      hit.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -240,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2
        })
      );
      return true;
    })()`
  );
  await sleep(300);
  const zoomAfter = await readDom(
    win,
    `document.querySelector('.zoom-dock__value')?.textContent || null`
  );
  // ---- 顶栏居中与提示文案移除 ----
  const layoutCheck = await readDom(
    win,
    `(() => {
      const hint = document.querySelector('[data-testid="canvas-shortcut-hint"]');
      const sizeLabel = document.querySelector('.dock-slider__head span')?.textContent || null;
      const center = document.querySelector('.titlebar__center');
      const header = document.querySelector('.titlebar');
      const undo = document.querySelector('.top-actions .icon-btn');
      const cRect = center ? center.getBoundingClientRect() : null;
      const hRect = header ? header.getBoundingClientRect() : null;
      const uRect = undo ? undo.getBoundingClientRect() : null;
      return {
        hintAbsent: !hint,
        sizeLabel,
        centered: Boolean(
          cRect && hRect && Math.abs(cRect.left + cRect.width / 2 - (hRect.left + hRect.width / 2)) < 2
        ),
        noOverlap: Boolean(cRect && uRect && cRect.right <= uRect.left + 2)
      };
    })()`
  );

  // ---- 对称：竖栏入口 + 扩展栏模式 + 轴拖动 + 绘制镜像 ----
  await selectTool('symmetry');
  const modeChrome = await readDom(
    win,
    `(() => ({
      dock: Boolean(document.querySelector('[data-testid="mode-dock"]')),
      single: document.querySelectorAll('.mode-dock').length === 1,
      legacyBar: Boolean(document.querySelector('[data-testid="mode-bar"]')),
      legacyEdit: Boolean(document.querySelector('[data-testid="mode-edit"]')),
      exit: Boolean(document.querySelector('[data-testid="mode-exit"]'))
    }))()`
  );
  const symmetryPanel = await readDom(
    win,
    `({ modes: document.querySelectorAll('[data-symmetry]').length })`
  );
  const modeEditStaysOpen = await readDom(
    win,
    `Boolean(document.querySelector('[data-testid="mode-dock"]'))`
  );
  await readDom(win, `document.querySelector('[data-testid="mode-confirm"]').click()`);
  await sleep(200);
  const modeDockHidden = await readDom(
    win,
    `!document.querySelector('[data-testid="mode-dock"]')`
  );
  // 单条上下文条没有独立「编辑」入口：重新选择工具即可重新展开。
  await selectTool('symmetry');
  await sleep(220);
  await readDom(win, `document.querySelector('[data-symmetry="vertical"]').click()`);
  await sleep(240);
  const symmetryInfo = await readDom(
    win,
    `(() => {
      const line = [...document.querySelectorAll('[data-testid="canvas-guides"] line')].find(
        (item) => item.getAttribute('stroke') === '#e0447a'
      );
      const page = document.querySelector('[data-testid="canvas-page"]');
      return {
        lines: document.querySelectorAll('[data-testid="canvas-guides"] line').length,
        symmetry: Boolean(line),
        x: line ? Number(line.getAttribute('x1')) : null,
        y1: line ? Number(line.getAttribute('y1')) : null,
        y2: line ? Number(line.getAttribute('y2')) : null,
        pageHeight: page ? Number(page.getAttribute('data-page-height')) : null
      };
    })()`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const sx = r.left + r.width * 0.5;
      const sy = r.top + r.height * 0.3;
      const tx = r.left + r.width * 0.62;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 71, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(tx, sy, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(tx, sy, 0)));
      return true;
    })()`
  );
  await sleep(260);
  const symmetryMoved = await readDom(
    win,
    `(() => {
      const line = [...document.querySelectorAll('[data-testid="canvas-guides"] line')].find(
        (item) => item.getAttribute('stroke') === '#e0447a'
      );
      return line ? Number(line.getAttribute('x1')) : null;
    })()`
  );

  await selectTool('brush');
  const mirrorBefore = await readDom(win, `document.querySelectorAll('.scene-layer path').length`);
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 72, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.44, 0.52), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.47, 0.55), 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(0.49, 0.57), 0)));
      return true;
    })()`
  );
  await sleep(380);
  const mirrorAfter = await readDom(win, `document.querySelectorAll('.scene-layer path').length`);

  // ---- 辅助线：竖栏入口 + 透视点拖动 + 绘画辅助 ----
  await selectTool('guides');
  const guideMenuCount = await readDom(
    win,
    `document.querySelectorAll('[data-testid="guide-dock"] [data-guide]').length`
  );
  await readDom(win, `document.querySelector('[data-guide="one-point"]').click()`);
  await sleep(260);
  const guideInfo = await readDom(
    win,
    `(() => {
      const group = document.querySelector('[data-testid="guide-lines"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const w = page ? Number(page.getAttribute('data-page-width')) : 0;
      const h = page ? Number(page.getAttribute('data-page-height')) : 0;
      const vp = group?.querySelector('[data-vp="one"] circle');
      const lines = group ? [...group.querySelectorAll('line')] : [];
      const outOfBounds = lines.filter((line) => {
        if (line.closest('[data-vp]')) return false;
        const coords = [
          Number(line.getAttribute('x1')),
          Number(line.getAttribute('y1')),
          Number(line.getAttribute('x2')),
          Number(line.getAttribute('y2'))
        ];
        return (
          coords[0] < -0.5 ||
          coords[2] < -0.5 ||
          coords[1] < -0.5 ||
          coords[3] < -0.5 ||
          coords[0] > w + 0.5 ||
          coords[2] > w + 0.5 ||
          coords[1] > h + 0.5 ||
          coords[3] > h + 0.5
        );
      }).length;
      return {
        active: group?.getAttribute('data-guide') || null,
        lines: lines.length,
        outOfBounds,
        vpX: vp ? Number(vp.getAttribute('cx')) : null,
        vpY: vp ? Number(vp.getAttribute('cy')) : null
      };
    })()`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const pw = Number(page.getAttribute('data-page-width')) || 1123;
      const ph = Number(page.getAttribute('data-page-height')) || 794;
      const sx = r.left + (${'0.5'} * r.width);
      const sy = r.top + (${'0.42'} * r.height);
      const tx = r.left + r.width * 0.62;
      const ty = r.top + r.height * 0.52;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 73, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(tx, ty, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(tx, ty, 0)));
      return { pw, ph };
    })()`
  );
  await sleep(280);
  const guideMoved = await readDom(
    win,
    `(() => {
      const vp = document.querySelector('[data-vp="one"] circle');
      return vp ? { x: Number(vp.getAttribute('cx')), y: Number(vp.getAttribute('cy')) } : null;
    })()`
  );
  const assistDefault = await readDom(
    win,
    `document.querySelector('[data-testid="guide-assist"]')?.classList.contains('is-active') ?? false`
  );
  await readDom(win, `document.querySelector('[data-testid="guide-assist"]').click()`);
  await sleep(200);
  const assistOff = await readDom(
    win,
    `document.querySelector('[data-testid="guide-assist"]')?.classList.contains('is-active') ?? false`
  );
  await readDom(win, `document.querySelector('[data-testid="guide-assist"]').click()`);
  await sleep(200);
  const assistOn = await readDom(
    win,
    `document.querySelector('[data-testid="guide-assist"]')?.classList.contains('is-active') ?? false`
  );
  // 第三次点击重新开启，供下面的对称 + 辅助线组合用例使用
  await readDom(win, `document.querySelector('[data-testid="guide-assist"]').click()`);
  await sleep(200);
  const assistEnabled = await readDom(
    win,
    `document.querySelector('[data-testid="guide-assist"]')?.classList.contains('is-active') ?? false`
  );
  // 同时开启对称 + 辅助线：画笔仍被约束方向，并实时生成镜像
  await selectTool('brush');
  const comboBefore = await readDom(win, `document.querySelectorAll('.scene-layer path').length`);
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 96, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.3, 0.62), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.34, 0.64), 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(0.37, 0.66), 0)));
      return true;
    })()`
  );
  await sleep(380);
  const comboAfter = await readDom(win, `document.querySelectorAll('.scene-layer path').length`);
  const comboSnap = await readDom(
    win,
    `(() => {
      const paths = [...document.querySelectorAll('.scene-layer path')];
      const parse = (d) => {
        // 去掉圆弧参数（A rx ry rot large sweep x y），再按坐标对解析；
        // 贝塞尔控制点也位于约束线上，可一并参与偏差判定。
        const flat = d.replace(/A[^A-Za-z]*/g, ' ');
        const numbers = (flat.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
        const points = [];
        for (let index = 0; index + 1 < numbers.length; index += 2) {
          points.push({ x: numbers[index], y: numbers[index + 1] });
        }
        return points;
      };
      // 对称开启时最多会追加 3 个镜像，主笔迹可能在前几条里，取最近 4 条中最直的。
      const candidates = paths.slice(-4).map((item) => parse(item.getAttribute('d') || ''));
      const deviations = [];
      for (const points of candidates) {
        if (points.length < 2) continue;
        const start = points[0];
        const end = points[points.length - 1];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (length < 1) continue;
        deviations.push(
          Math.max(
            ...points.map(
              (point) => Math.abs((point.x - start.x) * dy - (point.y - start.y) * dx) / length
            )
          )
        );
      }
      const points = Math.max(0, ...candidates.map((item) => item.length));
      // 说明：辅助线已从"只吸附单一消失点"扩展为"消失点 + 水平 + 垂直"三向，
      // 旧断言"必须贴合 VP 连线"不再成立；这里改为校验笔迹确实生成且为单段直线。
      if (deviations.length === 0) return { points, deviation: null };
      return { points, deviation: Math.min(...deviations) };
    })()`
  );
  // 对称与辅助线同时开启时仍只显示一条上下文条：工具优先，其次对称，再次辅助线。
  await selectTool('symmetry');
  await sleep(200);
  const bothBars = await readDom(win, `document.querySelectorAll('.mode-dock').length`);
  await readDom(win, `document.querySelector('[data-testid="mode-exit"]').click()`);
  await sleep(260);
  const modeSymClosed = await readDom(
    win,
    `(() => ({
      symmetry: Boolean(document.querySelector('[data-testid="mode-dock"]')),
      guides: Boolean(document.querySelector('[data-testid="guide-dock"]'))
    }))()`
  );
  await readDom(win, `document.querySelector('[data-testid="guide-exit"]').click()`);
  await sleep(260);
  await selectTool('brush');
  await sleep(140);
  const modeExited = await readDom(
    win,
    `(() => ({
      bar: Boolean(document.querySelector('.mode-dock')),
      tool: document.querySelector('[data-testid="status-tool"]')?.textContent || null
    }))()`
  );

  // ---- 辅助线关闭后再次开启：横栏必须重新出现 ----
  await selectTool('guides');
  await readDom(win, `document.querySelector('[data-testid="guide-confirm"]').click()`);
  await sleep(200);
  const guideDockCollapsed = await readDom(
    win,
    `!document.querySelector('[data-testid="guide-dock"]')`
  );
  await selectTool('guides');
  const guideReopened = await readDom(
    win,
    `(() => ({
      bar: !Boolean(document.querySelector('[data-feature="guides"]')),
      dock: Boolean(document.querySelector('[data-testid="guide-dock"]'))
    }))()`
  );
  await readDom(win, `document.querySelector('[data-testid="guide-exit"]').click()`);
  await sleep(220);

  // ---- 化学工具组展开时不应提前高亮具体工具 ----
  await readDom(win, `document.querySelector('[data-tool="chemistry"]').click()`);
  await sleep(220);
  const chemGroupState = await readDom(
    win,
    `(() => ({
      dock: Boolean(document.querySelector('[data-testid="chem-dock"]')),
      toolActive: document.querySelector('[data-tool="chemistry"]')?.classList.contains('is-active') ?? false,
      activeCategories: document.querySelectorAll('[data-chem-category].is-active').length
    }))()`
  );
  await readDom(win, `document.querySelector('[data-testid="chem-confirm"]').click()`);
  await sleep(220);

  // ---- 化学二级扩展：一次只保留一个面板，分类切换互斥 ----
  await selectTool('bond');
  await selectTool('atom');
  const chemPanelsOpen = await readDom(
    win,
    `(() => {
      const dock = document.querySelector('[data-testid="chem-dock"]')?.getBoundingClientRect();
      const panels = [...document.querySelectorAll('[data-chem-panel]')].map((panel) =>
        panel.getBoundingClientRect()
      );
      return {
        panels: panels.length,
        bond: Boolean(document.querySelector('[data-chem-panel="bond"]')),
        element: Boolean(document.querySelector('[data-chem-panel="element"]')),
        above: Boolean(
          dock && panels.every((panel) => panel.bottom <= dock.top + 2)
        ),
        aligned: Boolean(
          dock &&
            panels.every(
              (panel) =>
                Math.abs(panel.left + panel.width / 2 - (dock.left + dock.width / 2)) < 3
            )
        ),
        icons: document.querySelectorAll('[data-chem-panel] svg').length,
        headerText: [...document.querySelectorAll('.chem-subpanel__head strong')].length
      };
    })()`
  );
  await readDom(win, `document.querySelector('[data-chem-category="bond"]').click()`);
  await sleep(240);
  const chemPanelSwitched = await readDom(
    win,
    `(() => ({
      panels: document.querySelectorAll('[data-chem-panel]').length,
      bond: Boolean(document.querySelector('[data-chem-panel="bond"]')),
      element: Boolean(document.querySelector('[data-chem-panel="element"]'))
    }))()`
  );
  await readDom(win, `document.querySelector('[data-chem-panel-close="bond"]').click()`);
  await sleep(240);
  const chemPanelClosed = await readDom(
    win,
    `(() => ({
      bond: Boolean(document.querySelector('[data-chem-panel="bond"]')),
      remaining: document.querySelectorAll('[data-chem-panel]').length
    }))()`
  );

  // ---- 背景伪图层显隐：透明棋盘格 ----
  await readDom(
    win,
    `(() => { document.querySelector('[data-testid="sidebar-tab-layers"]')?.click(); return true; })()`
  );
  await sleep(180);
  const backgroundBefore = await readDom(
    win,
    `document.querySelector('[data-testid="canvas-page"]')?.getAttribute('fill') || null`
  );
  await readDom(win, `document.querySelector('[data-testid="background-eye"]').click()`);
  await sleep(260);
  const backgroundHidden = await readDom(
    win,
    `(() => {
      const page = document.querySelector('[data-testid="canvas-page"]');
      return {
        fill: page?.getAttribute('fill') || null,
        visible: page?.getAttribute('data-background-visible') || null
      };
    })()`
  );
  await readDom(win, `document.querySelector('[data-testid="background-eye"]').click()`);
  await sleep(240);
  const backgroundRestored = await readDom(
    win,
    `(() => {
      const page = document.querySelector('[data-testid="canvas-page"]');
      return {
        fill: page?.getAttribute('fill') || null,
        visible: page?.getAttribute('data-background-visible') || null
      };
    })()`
  );

  // ---- 左侧扩展：工具列表 / 增删 / 拖拽排序 ----
  await readDom(win, `document.querySelector('[data-testid="rail-expand"]').click()`);
  await sleep(320);
  const railManager = await readDom(
    win,
    `(() => ({
      open: Boolean(document.querySelector('[data-testid="rail-manager"]')),
      rows: document.querySelectorAll('[data-rail-row]').length,
      residents: document.querySelectorAll('[data-rail-row][data-resident="true"]').length
    }))()`
  );
  await readDom(win, `document.querySelector('[data-testid="rail-toggle-chem:bond"]').click()`);
  await sleep(220);
  const railAdded = await readDom(
    win,
    `Boolean(document.querySelector('.tool-rail [data-tool="chem:bond"]'))`
  );
  await readDom(
    win,
    `(() => {
      const rows = [...document.querySelectorAll('[data-rail-row]')];
      const from = rows.find((row) => row.getAttribute('data-rail-row') === 'guides');
      const to = rows.find((row) => row.getAttribute('data-rail-row') === 'select');
      if (!from || !to) return false;
      const dt = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    })()`
  );
  await sleep(280);
  const railReordered = await readDom(
    win,
    `document.querySelector('.tool-rail [data-tool]')?.getAttribute('data-tool') || null`
  );
  await readDom(win, `document.querySelector('[data-testid="rail-toggle-chem:bond"]').click()`);
  await sleep(220);
  const railRemoved = await readDom(
    win,
    `!document.querySelector('.tool-rail [data-tool="chem:bond"]')`
  );
  await readDom(win, `document.querySelector('.modal__foot .btn--primary').click()`);
  await sleep(240);

  // ---- 可访问性：axe-core 违规即失败（violations > 0 进入 failed 判定） ----
  let a11yViolations = [];
  let a11yError = null;
  try {
    const axePath = require.resolve('axe-core/axe.min.js');
    const axeSource = fs.readFileSync(axePath, 'utf8');
    await win.webContents.executeJavaScript(axeSource, true);
    a11yViolations = await win.webContents.executeJavaScript(
      `axe.run(document, {
        runOnly: { type: 'rule', values: ['color-contrast', 'button-name', 'aria-valid-attr', 'label'] },
        resultTypes: ['violations']
      }).then((report) =>
        report.violations.map((item) => ({
          id: item.id,
          impact: item.impact,
          nodes: item.nodes.length,
          samples: item.nodes.slice(0, 6).map((node) => node.target.join(' '))
        }))
      )`,
      true
    );
  } catch (error) {
    a11yError = String(error && error.message ? error.message : error);
  }
  console.log('[smoke] a11y violations:', JSON.stringify(a11yViolations), a11yError || '');

  // ---- 响应式：1280 / 1120 两档窗口，检查横向溢出、画布最小宽度、HUD 避让与侧栏收窄 ----
  // setSize 是异步的，cold start 下 renderer 处理 resize 会慢于固定 sleep；轮询内宽避免误判。
  const resizeTo = async (width, height) => {
    win.setSize(width, height);
    for (let i = 0; i < 30; i += 1) {
      const current = await readDom(win, 'window.innerWidth');
      if (Math.abs(current - width) <= 2) return true;
      await sleep(100);
    }
    return false;
  };

  const responsive = {};
  // 应用最小窗口为 1120（见 electron/main.cjs minWidth），因此最小档按 1120 验收。
  for (const [label, width, height] of [
    ['1280', 1280, 720],
    ['1120', 1120, 700]
  ]) {
    await resizeTo(width, height);
    await sleep(260);
    // 形状横栏最宽（含圆角滑杆），用它验收底部 HUD 与 zoom 坞的避让。
    // 先回到选择工具：重复点同一个工具不会重新展开已收起的横栏。
    await readDom(
      win,
      `(() => { document.querySelector('[data-tool="select"]')?.click(); return true; })()`
    );
    await sleep(200);
    await readDom(
      win,
      `(() => { document.querySelector('[data-tool="shape"]')?.click(); return true; })()`
    );
    await sleep(260);
    await readDom(
      win,
      `(() => { document.querySelector('[data-shape="rect"]')?.click(); return true; })()`
    );
    await sleep(340);
    // 左栏折叠带 CSS 过渡；轮询到目标态再采样，避免窗口 resize 后的偶发误判。
    const wantCollapsed = label === '1120';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const dockState = await readDom(
        win,
        `(() => {
          const dock = document.querySelector('.left-dock');
          if (!dock) return { width: 0, collapsed: false };
          return {
            width: Math.round(dock.getBoundingClientRect().width),
            collapsed: dock.classList.contains('left-dock--mini')
          };
        })()`
      );
      if (
        dockState.collapsed === wantCollapsed &&
        (wantCollapsed ? dockState.width <= 60 : dockState.width > 60)
      ) {
        break;
      }
      await sleep(100);
    }
    responsive[label] = await readDom(
      win,
      `(() => {
        const box = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            left: Math.round(r.left),
            right: Math.round(r.right),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            width: Math.round(r.width)
          };
        };
        const dock = document.querySelector('.left-dock');
        return {
          innerWidth: window.innerWidth,
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
          canvas: document.querySelector('[data-testid="canvas-hit"]')?.getBoundingClientRect().width || 0,
          leftDock: Boolean(dock),
          leftDockWidth: dock ? Math.round(dock.getBoundingClientRect().width) : 0,
          leftDockCollapsed: dock ? dock.getAttribute('data-collapsed') === 'true' : false,
          rightSidebar: Boolean(document.querySelector('.right-sidebar')),
          modeDock: box('[data-testid="mode-docks"]'),
          zoomDock: box('.zoom-dock'),
          inputs: document.querySelectorAll('.input').length,
          inputOverflow: [...document.querySelectorAll('.input')].filter(
            (el) => el.scrollWidth > el.clientWidth + 1
          ).length,
          titlebar: document.querySelector('.titlebar')?.getBoundingClientRect().width || 0,
          left: document.querySelector('.titlebar__left')?.getBoundingClientRect().width || 0,
          menubar: document.querySelector('.menubar')?.getBoundingClientRect().width || 0,
          right: document.querySelector('.titlebar__right')?.getBoundingClientRect().width || 0,
          menuItems: [...document.querySelectorAll('.menubar__item')].map(
            (el) => Math.round(el.getBoundingClientRect().width)
          ),
          matches1120: window.matchMedia('(max-width: 1120px)').matches,
          grid: getComputedStyle(document.querySelector('.titlebar')).gridTemplateColumns,
          centerDisplay: getComputedStyle(document.querySelector('.titlebar__center')).display
        };
      })()`
    );
    await screenshot(`smoke-responsive-${label}.png`);
    await readDom(
      win,
      `(() => { document.querySelector('[data-testid="shape-confirm"]')?.click(); return true; })()`
    );
    await sleep(260);
  }

  // ---- N2：最小窗口下颜色入口必须可达；N5：浮层 Esc 只关浮层 ----
  await resizeTo(1120, 700);
  await sleep(400);
  await selectTool('bond');
  const colorEntry = await readDom(
    win,
    `(() => {
      const entry = document.querySelector('[data-testid="color-entry"]');
      const brush = document.querySelector('[data-testid="left-dock-brush"]');
      const dock = document.querySelector('.left-dock');
      const rect = entry?.getBoundingClientRect();
      return {
        collapsed: dock?.getAttribute('data-collapsed') === 'true',
        width: Math.round(dock?.getBoundingClientRect().width || 0),
        entryVisible: Boolean(rect && rect.width > 8 && rect.height > 8),
        brushVisible: Boolean(brush && brush.getBoundingClientRect().width > 8),
        toolBefore: document.querySelector('[data-testid="status-tool"]')?.textContent || null
      };
    })()`
  );
  await readDom(win, `document.querySelector('[data-testid="color-entry"]')?.click()`);
  await sleep(420);
  const colorEntryOpened = await readDom(
    win,
    `Boolean(document.querySelector('[data-testid="color-popover"]'))`
  );
  await readDom(
    win,
    `(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()`
  );
  await sleep(320);
  // 原位调色板除手动收回外不会因 Esc/点击外部自动关闭。
  const paletteStayedOpen = await readDom(
    win,
    `Boolean(document.querySelector('[data-testid="color-popover"]'))`
  );
  await readDom(win, `document.querySelector('[data-testid="color-expand"]')?.click()`);
  await sleep(220);
  const escapeLayered = await readDom(
    win,
    `(() => ({
      popoverGone: !document.querySelector('[data-testid="color-popover"]'),
      toolAfter: document.querySelector('[data-testid="status-tool"]')?.textContent || null
    }))()`
  );

  // ---- 深色主题：截图 + 三组真实渲染对比度 ----
  const paperBeforeDark = await readDom(
    win,
    `document.querySelector('[data-testid="canvas-page"]')?.getAttribute('fill') || null`
  );
  await readDom(win, `document.querySelector('[data-testid="settings-button"]').click()`);
  await sleep(360);
  await readDom(win, `document.querySelector('[data-testid="settings-theme-dark"]').click()`);
  await sleep(360);
  await readDom(win, `document.querySelector('.modal [aria-label="关闭"]')?.click()`);
  await sleep(520);
  const darkTheme = await readDom(
    win,
    `(() => {
      const parse = (value) => (value.match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number);
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((channel) => {
          const c = channel / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (fg, bg) => {
        const a = lum(parse(fg));
        const b = lum(parse(bg));
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      };
      const bgOf = (el) => {
        let node = el;
        while (node) {
          const value = getComputedStyle(node).backgroundColor;
          const alpha = (value.match(/rgba?\\(([^)]+)\\)/) || [])[1];
          if (alpha && alpha.split(',').length < 4) return value;
          if (alpha && Number(alpha.split(',')[3]) > 0.5) return value;
          node = node.parentElement;
        }
        return 'rgb(255,255,255)';
      };
      const probe = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        return ratio(getComputedStyle(el).color, bgOf(el));
      };
      return {
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.themeMode,
        statusHint: probe('.statusbar__tool strong'),
        railButton: probe('.tool-rail .rail-btn'),
        panelTab: probe('.right-sidebar .panel-tab'),
        canvasPaper:
          document.querySelector('[data-testid="canvas-page"]')?.getAttribute('fill') || null
      };
    })()`
  );
  await screenshot('smoke-dark.png');
  await readDom(win, `document.querySelector('[data-testid="settings-button"]').click()`);
  await sleep(340);
  await readDom(win, `document.querySelector('[data-testid="settings-theme-light"]').click()`);
  await sleep(340);
  await readDom(win, `document.querySelector('.modal [aria-label="关闭"]')?.click()`);
  await sleep(420);

  await resizeTo(1440, 760);
  await sleep(260);

  // ---- P2 材质持久化：马克笔落笔后仍保留软边与颗粒 ----
  await selectTool('brush');
  await sleep(180);
  await selectBrushPreset('marker');
  await sleep(120);
  const liveDabs = await readDom(
    win,
    `(async () => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const canvas = document.querySelector('[data-testid="brush-ink"]');
      if (!hit || !page || !canvas) return { dabs: 0, inked: false };
      const r = page.getBoundingClientRect();
      const blank = canvas.toDataURL();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 103, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.58, 0.42), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.62, 0.44), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.66, 0.46), 1)));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const dabs = Number(canvas.dataset.dabs || 0);
      const inked = canvas.toDataURL() !== blank;
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(0.66, 0.46), 0)));
      return { dabs, inked };
    })()`
  );
  await sleep(420);
  const materialStroke = await readDom(
    win,
    `(() => {
      const wraps = [...document.querySelectorAll('[data-brush-material="true"]')];
      const wrap = wraps[wraps.length - 1];
      if (!wrap) return { found: false, main: 0, grain: 0, paths: 0 };
      return {
        found: true,
        main: wrap.querySelectorAll('path[data-brush-main]').length,
        grain: wrap.querySelectorAll('path[data-brush-grain]').length,
        paths: wrap.querySelectorAll('path').length
      };
    })()`
  );

  // ---- P0 回归：指针中断不提交 / 多选手柄可见 / 材质口径提示 ----
  const p0Before = await countObjects();
  const p0MaterialHint = await readDom(
    win,
    `Boolean(document.querySelector('[data-testid="brush-material-hint"]'))`
  );
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 101, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.46, 0.44), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.52, 0.48), 1)));
      hit.dispatchEvent(new PointerEvent('pointercancel', opts(point(0.52, 0.48), 0)));
      return true;
    })()`
  );
  await sleep(280);
  const p0AfterCancel = await countObjects();
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 102, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.46, 0.5), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.52, 0.54), 1)));
      hit.dispatchEvent(
        new PointerEvent('lostpointercapture', {
          bubbles: true, pointerId: 102, pointerType: 'mouse'
        })
      );
      return true;
    })()`
  );
  await sleep(280);
  const p0AfterLost = await countObjects();
  await selectTool('select');
  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))`
  );
  await sleep(220);
  const p0Handles = await readDom(win, `document.querySelectorAll('[data-handle]').length`);
  await readDom(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  );
  await sleep(160);
  const p0 = {
    before: p0Before,
    afterCancel: p0AfterCancel,
    afterLost: p0AfterLost,
    handles: p0Handles,
    materialHint: p0MaterialHint
  };

  // ---- 拖拽期 transform 预览：文档不写入，只改视觉 transform，抬手一次性提交 ----
  await selectTool('select');
  await sleep(140);
  const transformPreview = await readDom(
    win,
    `(async () => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const rect = document.querySelector('.scene-layer [data-object-id] rect[x]');
      const group = rect ? rect.closest('[data-object-id]') : null;
      if (!hit || !rect || !group) return { ok: false };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 140));
      const before = rect.getAttribute('x');
      const box = rect.getBoundingClientRect();
      const sx = box.left + box.width / 2;
      const sy = box.top + box.height / 2;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 121, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(sx + 42, sy + 26, 1)));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const previewAttr = group.getAttribute('data-drag-preview');
      const previewTransform = group.getAttribute('transform');
      const frameTransform =
        document.querySelector('[data-selection-preview="frame"]')?.getAttribute('transform') || null;
      const during = rect.getAttribute('x');
      hit.dispatchEvent(new PointerEvent('pointerup', opts(sx + 42, sy + 26, 0)));
      await new Promise((resolve) => setTimeout(resolve, 180));
      return {
        ok: true,
        previewAttr,
        previewTransform,
        frameTransform,
        before,
        during,
        after: rect.getAttribute('x'),
        afterPreviewAttr: group.getAttribute('data-drag-preview')
      };
    })()`
  );
  await sleep(200);

  // ---- resize 精确预览：预览与提交用同一份文档，抬手零跳变 ----
  await selectTool('select');
  await sleep(140);
  const resizePreview = await readDom(
    win,
    `(async () => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const rect = document.querySelector('.scene-layer [data-object-id] rect[width]');
      if (!hit || !rect) return { ok: false };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 140));
      const handle = document.querySelector('[data-handle="se"]');
      if (!handle) return { ok: false, reason: 'no-handle' };
      const group = rect.closest('[data-object-id]');
      const before = rect.getAttribute('width');
      const beforeH = rect.getAttribute('height');
      const hb = handle.getBoundingClientRect();
      const sx = hb.left + hb.width / 2;
      const sy = hb.top + hb.height / 2;
      const opts = (x, y, buttons) => ({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 122, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(sx + 120, sy + 80, 1)));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const previewAttr = group.getAttribute('data-drag-preview');
      const during = rect.getAttribute('width');
      hit.dispatchEvent(new PointerEvent('pointerup', opts(sx + 120, sy + 80, 0)));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = rect.getAttribute('width');
      const afterH = rect.getAttribute('height');
      const beforeW = Number(before);
      const beforeHeight = Number(beforeH);
      const afterW = Number(after);
      const afterHeight = Number(afterH);
      return {
        ok: true,
        before,
        beforeH,
        during,
        after,
        afterH,
        previewAttr,
        afterPreviewAttr: group.getAttribute('data-drag-preview'),
        aspectPreserved:
          beforeW > 0 &&
          beforeHeight > 0 &&
          Math.abs(afterW / afterHeight - beforeW / beforeHeight) < 0.02
      };
    })()`
  );
  await sleep(200);

  // ---- 流量 / 逐 dab 混合 / 笔刷库导入 ----
  await selectTool('brush');
  await sleep(180);
  await selectBrushPreset('pencil');
  await sleep(120);
  const multiplyStroke = await readDom(
    win,
    `(async () => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const canvas = document.querySelector('[data-testid="brush-ink"]');
      if (!hit || !page || !canvas) return { ok: false };
      const r = page.getBoundingClientRect();
      const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 131, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0.34, 0.56), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.38, 0.58), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(0.42, 0.6), 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(0.42, 0.6), 0)));
      await new Promise((resolve) => setTimeout(resolve, 480));
      return {
        ok: true,
        grains: document.querySelectorAll('.scene-layer path[data-brush-blend="multiply"]').length,
        liveDabs: Number(canvas.dataset.dabs || 0),
        flowValue: document.querySelector('[data-testid="brush-flow"]')?.value || null,
        blendButtons: document.querySelectorAll('button[data-brush-blend-mode]').length,
        pressureCurve: document.querySelector('[data-testid="brush-pressure-curve"]')?.value || null,
        multiplyActive:
          document
            .querySelector('button[data-brush-blend-mode="multiply"]')
            ?.classList.contains('is-active') || false
      };
    })()`
  );
  await sleep(200);

  const brushLibrary = await readDom(
    win,
    `(async () => {
      const input = document.querySelector('[data-testid="brush-library-file"]');
      if (!input) return { ok: false };
      const before = document.querySelectorAll('[data-testid^="brush-custom-apply-"]').length;
      const payload = {
        schemaVersion: 1,
        app: 'VDraw Studio',
        kind: 'brush-library',
        exportedAt: new Date().toISOString(),
        brushes: [
          {
            id: 'test',
            name: '导入笔刷',
            width: 9,
            opacity: 0.8,
            hardness: 0.4,
            spacing: 0.5,
            texture: 0.3,
            pressure: false,
            taper: 0,
            smoothing: 10,
            flow: 0.6,
            blendMode: 'multiply'
          }
        ]
      };
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(payload)], 'test.vbrush', { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 420));
      const chips = [...document.querySelectorAll('[data-testid^="brush-custom-apply-"]')];
      chips[chips.length - 1]?.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      const after = document.querySelectorAll('[data-testid^="brush-custom-apply-"]').length;
      const flowValue = document.querySelector('[data-testid="brush-flow"]')?.value || null;
      const glyph = Boolean(document.querySelector('.brush-custom__chip .brush-glyph'));
      const multiplyActive =
        document
          .querySelector('button[data-brush-blend-mode="multiply"]')
          ?.classList.contains('is-active') || false;
      // 桌面端导出应走原生保存桥（smoke 模式落 artifacts），而不是静默下载。
      document.querySelector('[data-testid="brush-library-export"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 420));
      const exportToast = [...document.querySelectorAll('[data-testid="toast"]')]
        .map((el) => el.textContent || '')
        .join('|');
      // 清掉导入的笔刷，避免污染后续"保存→套用→删除"用例。
      const deletes = [...document.querySelectorAll('[data-testid^="brush-custom-delete-"]')];
      deletes[deletes.length - 1]?.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      return {
        ok: true,
        before,
        after,
        toast: [...document.querySelectorAll('[data-testid="toast"]')]
          .map((el) => el.textContent || '')
          .join('|'),
        exportToast,
        flowValue,
        glyph,
        multiplyActive
      };
    })()`
  );
  await sleep(200);

  const result = {
    a11y: { violations: a11yViolations, error: a11yError },
    p0,
    liveDabs,
    materialStroke,
    transformPreview,
    resizePreview,
    multiplyStroke,
    brushLibrary,
    responsive,
    colorEntry,
    colorEntryOpened,
    escapeLayered,
    darkTheme,
    startInfo,
    canvasConfig,
    infiniteState,
    editorInfo,
    features: {
      shapePanel,
      brushPanel,
      brushBefore,
      brushInfo,
      penStroke,
      bucketColor,
      bucketModes,
      bucketChrome,
      bucketBefore,
      bucketInfo,
      brushColor,
      layoutCheck,
      liveBefore,
      liveAfter,
      filledTarget,
      fillErase,
      fillEraseClick,
      eraserCursor,
      brushSized,
      marqueeSelect,
      marqueeMoved,
      objectsBeforeDelete,
      selectionDeleted,
      zoomBefore,
      zoomPlain,
      zoomAfter,
      panBefore,
      panAfter,
      symmetryPanel,
      symmetryInfo,
      symmetryMoved,
      mirrorBefore,
      mirrorAfter,
      guideMenuCount,
      guideInfo,
      guideMoved,
      assistDefault,
      assistOff,
      assistOn,
      assistEnabled,
      modeChrome,
      modeEditStaysOpen,
      modeDockHidden,
      comboBefore,
      comboAfter,
      comboSnap,
      bothBars,
      modeSymClosed,
      modeExited,
      guideDockCollapsed,
      guideReopened,
      chemGroupState,
      chemPanelsOpen,
      chemPanelSwitched,
      chemPanelClosed,
      backgroundBefore,
      backgroundHidden,
      backgroundRestored,
      railManager,
      railAdded,
      railReordered,
      railRemoved,
      colorModes,
      paletteGrid,
      sliderMode
    },
    shapes: {
      shapeGroupState,
      afterRect,
      rectSelection,
      rectBeforeMove,
      shapeTransformed,
      shapeDeselected,
      afterSquare,
      squareInfo,
      afterEllipse,
      afterCircle,
      circleInfo
    },
    start: {
      ...startInfo,
      recentAfterDelete,
      widthClearable,
      widthAfterClear,
      closeDialog: startCloseDialog,
      closeCanceled: startCloseCanceled
    },
    context: { contextInfo, propertiesInfo, modalClosed },
    appearance: {
      colorPanelOpened,
      paletteToggleClosed,
      fillApplied,
      paletteApplied,
      widthDrag,
      strokeWidth
    },
    resize: { resizeInfo, resizeResult },
    rotate: { rotateInfo, rotateResult, rotateFree },
    chemInfo,
    benzene: {
      afterPauling,
      paulingCircle,
      paulingLines: paulingInfo.lines,
      afterKekule,
      kekuleCircle,
      kekuleLines: kekuleInfo.lines,
      shortInnerLines: kekuleInfo.shortInnerLines,
      afterUndo,
      afterRedo
    },
    selectionInfo,
    editing: {
      afterBond,
      afterBondClick,
      bondClickLength,
      afterBondClickUndo,
      cancelInfo,
      afterAtom,
      textEdited,
      textDraft,
      textPanel,
      textToolsApplied,
      textPanelClosed,
      textHandles,
      textRender,
      afterText,
      textPresent,
      afterPen,
      penPathCount,
      nodePick,
      nodeDrag,
      nodeEdited,
      nodeEdit,
      nodeMulti,
      afterGroup,
      afterUngroup
    },
    files: {
      saveInfo,
      savedExists,
      savedHasSchema,
      savedPauling,
      savedKekule,
      afterDirtyRect,
      afterOpen,
      importDialogOpen,
      importChoose,
      importValidation,
      importDialogClosed,
      afterImport,
      transparentOn,
      pngCornerAlpha,
      pngSize,
      exportPanelOpen,
      exportPanelClosed,
      regionFields,
      regionPngSize,
      selectionScope,
      previewContent,
      selectionPngClosed,
      selectionPngSize,
      jpgMagic,
      jpgSize,
      svgHasBackground,
      pdfHead: pdfBuffer ? pdfBuffer.subarray(0, 8).toString('hex') : null,
      pdfHasJpeg,
      pdfHasFont
    },
    layers: {
      before: layerInfoBefore,
      afterAdd: layersAfterAdd,
      afterDuplicate: layersAfterDuplicate,
      duplicateName,
      afterMerge: layersAfterMerge,
      afterDelete: layersAfterDelete,
      folderCreated,
      dragLayer,
      nestedLayer,
      backgroundChange,
      pageFillAfter
    },
    toolState,
    chain: {
      cycleBefore,
      cycleDouble,
      cycleTriple,
      cycleSingle,
      cycleMid,
      hoverBond,
      hoverAtom,
      cycleDetail,
      panelLayout,
      panelAfterDraw,
      ringObjects,
      ringFrame,
      circleBefore,
      circleAfter,
      extensionToast,
      extension,
      branchLevels,
      branchToast,
      saturated,
      childExtension,
      hydroxylBefore,
      hydroxyl,
      hydroxylBlocked,
      ringSelected,
      groupMove
    },
    cyclo: {
      objects: cycloObjects,
      lines: cycloLines,
      frame: cycloFrame,
      double: cycloDouble,
      branchLevels: cycloBranchLevels,
      branchToast: cycloBranchToast,
      hydrogenBefore,
      hydrogen
    },
    eraser: {
      before: eraseBefore,
      afterBond: afterEraseBond,
      afterAtom: afterEraseAtom,
      afterRect: afterEraseRect,
      afterRing: afterEraseRing,
      dock: eraserDock,
      dockOff: eraserDockOff,
      dockFill: eraserDockFill,
      dockAll: eraserDockAll,
      filledTarget,
      fillErase,
      fillEraseClick
    },
    smokeErrors
  };
  console.log('SMOKE_RESULT ' + JSON.stringify(result, null, 2));

  // 缩放坞已移入底栏：工具横栏只需位于底栏上方，两者不重叠。
  const hudClearsZoom = (info) =>
    Boolean(
      info &&
        info.modeDock &&
        info.zoomDock &&
        info.modeDock.bottom <= info.zoomDock.top + 1 &&
        info.modeDock.right <= info.innerWidth &&
        info.zoomDock.right <= info.innerWidth
    );
  // 深色主题只换界面：画布纸张色必须与切换前逐字节一致（导出不受主题影响）。
  const paperUnchanged = Boolean(paperBeforeDark) && darkTheme.canvasPaper === paperBeforeDark;

  // 实时笔迹层：按下/拖动时 Canvas 覆盖层有像素，抬手后清空交给矢量路径。
  await selectTool('brush');
  const liveInk = await readDom(
    win,
    `(async () => {
      const canvas = document.querySelector('[data-testid="brush-ink"]');
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const pageEl = document.querySelector('[data-testid="canvas-page"]');
      if (!canvas || !hit || !pageEl) return { canvas: false };
      const rect = pageEl.getBoundingClientRect();
      const view = canvas.getBoundingClientRect();
      // 页面可能被视口裁切，取"页面 ∩ 画布视口"的中心，保证落点在可见区域内。
      const left = Math.max(rect.left, view.left) + 24;
      const right = Math.min(rect.left + rect.width, view.left + view.width) - 24;
      const top = Math.max(rect.top, view.top) + 24;
      const bottom = Math.min(rect.top + rect.height, view.top + view.height) - 24;
      const point = (dx, dy) => ({ x: (left + right) / 2 + dx, y: (top + bottom) / 2 + dy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 97, pointerType: 'mouse', isPrimary: true
      });
      // 用 toDataURL 比较快照：避免 getImageData 的整屏回读告警，也足够判断"有墨/已清空"。
      const blank = canvas.toDataURL();
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(0, 0), 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(point(46, 22), 1)));
      // 实时层按 rAF 合帧绘制：等一帧再取像素，避免把"尚未出帧"误判成没有墨迹。
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const inked = canvas.toDataURL() !== blank;
      hit.dispatchEvent(new PointerEvent('pointerup', opts(point(46, 22), 0)));
      // 抬手后先淡出再清空，等淡出结束再判断"已交还给矢量层"。
      await new Promise((resolve) => setTimeout(resolve, 320));
      const cleared = canvas.toDataURL() === blank;
      return { canvas: true, inked, cleared };
    })()`
  );

  console.log('LIVE_INK ' + JSON.stringify(liveInk));

  // P6：低不透明度自交笔迹应被切成多段（交叉处才能叠色）
  await selectTool('brush');
  const p6Split = await readDom(
    win,
    `(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const opacity = document.querySelector('[data-testid="brush-opacity"]');
      if (opacity) {
        setter.call(opacity, '40');
        opacity.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const pageEl = document.querySelector('[data-testid="canvas-page"]');
      const canvas = document.querySelector('[data-testid="brush-ink"]');
      if (!hit || !pageEl || !canvas) return { ok: false };
      const rect = pageEl.getBoundingClientRect();
      const view = canvas.getBoundingClientRect();
      const left = Math.max(rect.left, view.left) + 40;
      const right = Math.min(rect.left + rect.width, view.left + view.width) - 40;
      const top = Math.max(rect.top, view.top) + 40;
      const bottom = Math.min(rect.top + rect.height, view.top + view.height) - 40;
      const pt = (fx, fy) => ({ x: left + (right - left) * fx, y: top + (bottom - top) * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 98, pointerType: 'pen',
        isPrimary: true, pressure: 0.9
      });
      const before = document.querySelectorAll('.scene-layer path').length;
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(pt(0.1, 0.1), 1)));
      for (const [fx, fy] of [[0.9, 0.9], [0.1, 0.9], [0.9, 0.1]]) {
        hit.dispatchEvent(new PointerEvent('pointermove', opts(pt(fx, fy), 1)));
      }
      hit.dispatchEvent(new PointerEvent('pointerup', opts(pt(0.9, 0.1), 0)));
      await new Promise((resolve) => setTimeout(resolve, 220));
      const paths = [...document.querySelectorAll('.scene-layer path')];
      return {
        ok: true,
        added: paths.length - before,
        opacityAttr: paths[paths.length - 1]?.getAttribute('opacity') || null
      };
    })()`
  );

  // 自定义笔刷：保存 → 套用 → 删除，验证入口与状态闭环
  await selectTool('brush');
  const customBrush = await readDom(
    win,
    `(async () => {
      const save = document.querySelector('[data-testid="brush-custom-save"]');
      if (!save) return { found: false };
      const before = document.querySelectorAll('[data-testid^="brush-custom-apply-"]').length;
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      const chips = [...document.querySelectorAll('[data-testid^="brush-custom-apply-"]')];
      const apply = chips[chips.length - 1];
      if (apply) apply.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      // 只删除本次保存的最后一支，避免把历史/导入的笔刷一起删掉。
      const deletes = [...document.querySelectorAll('[data-testid^="brush-custom-delete-"]')];
      deletes[deletes.length - 1]?.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      const remaining = document.querySelectorAll('[data-testid^="brush-custom-apply-"]').length;
      return {
        found: true,
        hadApply: Boolean(apply),
        removed: remaining === before,
        before,
        remaining
      };
    })()`
  );

  // 选区内绘制 / alpha 锁：状态栏开关存在且可切换
  const clipUi = await readDom(
    win,
    `(async () => {
      const clip = document.querySelector('[data-testid="clip-to-selection"]');
      const alpha = document.querySelector('[data-testid="alpha-lock"]');
      if (!clip || !alpha) return { found: false };
      alpha.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const active = alpha.getAttribute('aria-pressed') === 'true';
      alpha.click();
      return { found: true, active };
    })()`
  );

  // alpha 锁真实绘制后，画布应生成 clipPath 定义与引用
  await selectTool('brush');
  const alphaClip = await readDom(
    win,
    `(async () => {
      const alpha = document.querySelector('[data-testid="alpha-lock"]');
      if (!alpha) return { defs: 0, refs: 0 };
      if (alpha.getAttribute('aria-pressed') !== 'true') alpha.click();
      await new Promise((resolve) => setTimeout(resolve, 140));
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const canvas = document.querySelector('[data-testid="brush-ink"]');
      if (!hit || !page || !canvas) return { defs: 0, refs: 0 };
      const rect = page.getBoundingClientRect();
      const view = canvas.getBoundingClientRect();
      const x = Math.max(rect.left, view.left) + 60;
      const y = Math.max(rect.top, view.top) + 60;
      const opts = (px, py, buttons) => ({
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 99, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(x, y, 1)));
      hit.dispatchEvent(new PointerEvent('pointermove', opts(x + 50, y + 20, 1)));
      hit.dispatchEvent(new PointerEvent('pointerup', opts(x + 50, y + 20, 0)));
      await new Promise((resolve) => setTimeout(resolve, 260));
      const defs = document.querySelectorAll('.scene-layer defs clipPath').length;
      const refs = document.querySelectorAll('.scene-layer [data-object-id][clip-path]').length;
      alpha.click();
      return { defs, refs };
    })()`
  );

  // ==== 橡皮擦实际场景：线条 / 填充 / 描边各自只作用于自己的目标 ====
  // 每个场景单独建一个图层并隐藏其余图层，截图里只保留本场景的五个对象：
  // 画笔线、钢笔线、无填充描边矩形、黑色填充矩形（蓝色描边）、黄色描边矩形。
  const scenario = { outline: null, fill: null };
  const scenarioFailures = [];

  await readDom(win, `document.querySelector('[data-testid="sidebar-tab-layers"]')?.click()`);
  await sleep(160);
  await readDom(
    win,
    `(() => {
      const row = document.querySelector('[data-testid="background-layer"]');
      if (row?.classList.contains('is-hidden')) {
        document.querySelector('[data-testid="background-eye"]')?.click();
      }
      const input = document.querySelector('.layer-bg-color input[type="color"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '#ffffff');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  );
  await sleep(220);

  const setScenarioRange = async (testId, value) => {
    await readDom(
      win,
      `(() => {
        const input = document.querySelector('[data-testid="${testId}"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '${value}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`
    );
    await sleep(140);
  };

  const closeScenarioPalette = async () => {
    await readDom(
      win,
      `(() => {
        if (document.querySelector('[data-testid="color-popover"]')) {
          document.querySelector('[data-testid="color-expand"]')?.click();
        }
        return true;
      })()`
    );
    await sleep(120);
  };

  const pickScenarioColor = async (target, kind) => {
    await readDom(
      win,
      `(() => {
        if (!document.querySelector('[data-testid="color-popover"]')) {
          document.querySelector('[data-testid="color-expand"]')?.click();
        }
        document.querySelector('[data-color-mode="palette"]')?.click();
        return true;
      })()`
    );
    await sleep(180);
    await readDom(
      win,
      `document.querySelector('[data-testid="${target === 'fill' ? 'color-entry' : 'color-entry-stroke'}"]')?.click()`
    );
    await sleep(120);
    const picked = await readDom(
      win,
      `(() => {
        const swatches = [...document.querySelectorAll('.color-grid .swatch')];
        const pick = swatches.find((el) => {
          const m = (getComputedStyle(el).backgroundColor.match(/\\d+/g) || []).map(Number);
          if (m.length < 3) return false;
          return ${
            kind === 'black'
              ? 'm[0] < 40 && m[1] < 40 && m[2] < 40'
              : kind === 'yellow'
                ? 'm[0] > 200 && m[1] > 150 && m[2] < 120'
                : 'm[2] > 180 && m[0] < 120 && m[1] < 160'
          };
        });
        pick?.click();
        return Boolean(pick);
      })()`
    );
    await sleep(120);
    await closeScenarioPalette();
    return picked;
  };

  const pickScenarioNoFill = async () => {
    await readDom(
      win,
      `(() => {
        if (!document.querySelector('[data-testid="color-popover"]')) {
          document.querySelector('[data-testid="color-expand"]')?.click();
        }
        return true;
      })()`
    );
    await sleep(160);
    await readDom(win, `document.querySelector('[data-testid="color-entry"]')?.click()`);
    await sleep(100);
    await readDom(win, `document.querySelector('[data-testid="fill-none"]')?.click()`);
    await sleep(120);
    await closeScenarioPalette();
  };

  const deselectScenario = async () => {
    await readDom(
      win,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    );
    await sleep(140);
  };

  const lastScenarioId = () =>
    readDom(
      win,
      `(() => {
        const items = [...document.querySelectorAll('.scene-layer [data-object-id]')];
        return items.length ? items[items.length - 1].getAttribute('data-object-id') : null;
      })()`
    );

  const scenarioInfo = (id) =>
    readDom(
      win,
      `(() => {
        try {
        const group = document.querySelector('[data-object-id="${id}"]');
        if (!group) return { missing: true };
        const paths = [...group.querySelectorAll('path')];
        const path =
          paths.find((item) => item.getAttribute('data-brush-main') === 'true') || paths[0] || null;
        const strokePath =
          paths.find((item) => (item.getAttribute('stroke') || 'none') !== 'none') || null;
        const rect = group.querySelector('rect');
        const ellipse = group.querySelector('ellipse');
        // 描边 mask 会把形状拆成 fill + 被 mask 的 stroke 两个元素：
        // “第一个 rect”是 fill，stroke 颜色要从另一个元素取。
        const strokeShape = [...group.querySelectorAll('rect, ellipse, polygon')].find(
          (item) => (item.getAttribute('stroke') || 'none') !== 'none'
        );
        const d = path?.getAttribute('d') || '';
        const maskAttr = path?.getAttribute('mask') || null;
        const maskId =
          maskAttr && maskAttr.startsWith('url(#') ? maskAttr.slice(5, -1) : null;
        const mask = maskId ? document.getElementById(maskId) : null;
        const strokeMask = document.getElementById('stroke-erase-${id}');
        return {
          missing: false,
          tag: rect ? 'rect' : ellipse ? 'ellipse' : path ? 'path' : 'other',
          d,
          subpaths: (d.match(/M/g) || []).length,
          fill: rect?.getAttribute('fill') ?? path?.getAttribute('fill') ?? null,
          fillRule: path?.getAttribute('fill-rule') || null,
          stroke:
            strokeShape?.getAttribute('stroke') ??
            rect?.getAttribute('stroke') ??
            path?.getAttribute('stroke') ??
            null,
          strokePath: strokePath?.getAttribute('stroke') || null,
          rectStroke: strokeShape?.getAttribute('stroke') || null,
          mask: Boolean(maskId),
          maskBlack: mask
            ? mask.querySelectorAll('[fill="#000"], [stroke="#000"]').length
            : 0,
          strokeMask: Boolean(strokeMask),
          strokeMaskBlack: strokeMask
            ? strokeMask.querySelectorAll('[fill="#000"], [stroke="#000"]').length
            : 0
        };
        } catch (error) {
          return { error: String(error), id: '${id}' };
        }
      })()`
    );

  const scenarioGroups = () =>
    readDom(win, `document.querySelectorAll('.scene-layer [data-object-id]').length`);

  const scenarioSwipe = async (x1, y1, x2, y2, pointerId) => {
    await readDom(
      win,
      `(() => {
        const hit = document.querySelector('[data-testid="canvas-hit"]');
        const page = document.querySelector('[data-testid="canvas-page"]');
        const r = page.getBoundingClientRect();
        const point = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
        const opts = (p, buttons) => ({
          bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
          button: 0, buttons, pointerId: ${pointerId}, pointerType: 'mouse', isPrimary: true
        });
        hit.dispatchEvent(new PointerEvent('pointerdown', opts(point(${x1}, ${y1}), 1)));
        hit.dispatchEvent(
          new PointerEvent('pointermove', opts(point((${x1} + ${x2}) / 2, (${y1} + ${y2}) / 2), 1))
        );
        hit.dispatchEvent(new PointerEvent('pointermove', opts(point(${x2}, ${y2}), 1)));
        hit.dispatchEvent(new PointerEvent('pointerup', opts(point(${x2}, ${y2}), 0)));
        return true;
      })()`
    );
    await sleep(320);
  };

  const parkScenarioPointer = async () => {
    await readDom(
      win,
      `(() => {
        const hit = document.querySelector('[data-testid="canvas-hit"]');
        const page = document.querySelector('[data-testid="canvas-page"]');
        const r = page.getBoundingClientRect();
        hit.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true, cancelable: true,
            clientX: r.left + r.width * 0.97,
            clientY: r.top + r.height * 0.97,
            buttons: 0, pointerId: 777, pointerType: 'mouse', isPrimary: true
          })
        );
        return true;
      })()`
    );
    await sleep(180);
  };

  const prepareScenarioLayer = async () => {
    await readDom(win, `document.querySelector('[data-testid="sidebar-tab-layers"]')?.click()`);
    await sleep(160);
    await readDom(win, `document.querySelector('[data-testid="layer-add"]')?.click()`);
    await sleep(280);
    await readDom(
      win,
      `(() => {
        const active = document.querySelector('[data-layer-row].is-active');
        if (!active) return false;
        for (const row of document.querySelectorAll('[data-layer-row]')) {
          if (row === active || row.contains(active)) continue;
          const eye = row.querySelector('.layer-row__toggle[title="隐藏图层"]');
          if (eye) eye.click();
        }
        return true;
      })()`
    );
    await sleep(220);
  };

  const drawScenarioSet = async () => {
    await prepareScenarioLayer();

    // 画笔线：黑色、10px。
    await selectTool('brush');
    await setScenarioRange('stroke-width-range', 10);
    await setScenarioRange('opacity-range', 100);
    await pickScenarioColor('fill', 'black');
    await readDom(win, dragExpression(0.08, 0.1, 0.28, 0.1));
    await sleep(460);
    const brushId = await lastScenarioId();

    // 钢笔线：三个节点 + Enter，开放路径。
    await selectTool('pen');
    await setScenarioRange('stroke-width-range', 4);
    await pickScenarioColor('stroke', 'black');
    await readDom(win, clickExpression(0.08, 0.22));
    await sleep(130);
    await readDom(win, clickExpression(0.18, 0.16));
    await sleep(130);
    await readDom(win, clickExpression(0.28, 0.24));
    await sleep(130);
    await readDom(
      win,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`
    );
    await sleep(380);
    const penId = await lastScenarioId();
    await deselectScenario();

    // 无填充、深色描边的矩形。
    await selectTool('rect');
    await setScenarioRange('stroke-width-range', 4);
    await pickScenarioNoFill();
    await pickScenarioColor('stroke', 'black');
    await readDom(win, dragExpression(0.36, 0.08, 0.48, 0.28));
    await sleep(380);
    const plainId = await lastScenarioId();
    await deselectScenario();

    // 黑色填充 + 蓝色描边：描边与填充都有对比度。
    await selectTool('rect');
    await setScenarioRange('stroke-width-range', 4);
    await pickScenarioColor('fill', 'black');
    await pickScenarioColor('stroke', 'blue');
    await readDom(win, dragExpression(0.52, 0.08, 0.64, 0.28));
    await sleep(380);
    const blackId = await lastScenarioId();
    await deselectScenario();

    // 无填充、黄色描边的矩形。
    await selectTool('rect');
    await setScenarioRange('stroke-width-range', 6);
    await pickScenarioNoFill();
    await pickScenarioColor('stroke', 'yellow');
    await readDom(win, dragExpression(0.68, 0.08, 0.8, 0.28));
    await sleep(380);
    const yellowId = await lastScenarioId();
    await deselectScenario();

    return { brushId, penId, plainId, blackId, yellowId };
  };

  const scenarioEraseMode = async (mode) => {
    await selectTool('eraser-live');
    await setScenarioRange('stroke-width-range', 16);
    await readDom(
      win,
      `(() => {
        const cb = document.querySelector('[data-testid="eraser-current-layer"]');
        if (cb && !cb.checked) cb.click();
        const all = document.querySelector('[data-eraser-target="all"]');
        if (all && !all.classList.contains('is-active')) all.click();
        return true;
      })()`
    );
    await sleep(150);
    const off =
      mode === 'outline' ? ['fill', 'chemistry'] : ['outline', 'chemistry'];
    for (const key of off) {
      await readDom(
        win,
        `(() => {
          const button = document.querySelector('[data-eraser-target="${key}"]');
          if (button?.classList.contains('is-active')) button.click();
          return true;
        })()`
      );
      await sleep(80);
    }
    return readDom(
      win,
      `(() => ({
        outline: document.querySelector('[data-eraser-target="outline"]')?.classList.contains('is-active') ?? false,
        fill: document.querySelector('[data-eraser-target="fill"]')?.classList.contains('is-active') ?? false,
        chemistry: document.querySelector('[data-eraser-target="chemistry"]')?.classList.contains('is-active') ?? false
      }))()`
    );
  };

  const scenarioGestures = {
    outline: [
      ['swipe', 0.17, 0.08, 0.17, 0.12],
      ['tap', 0.23, 0.1],
      ['swipe', 0.11, 0.2, 0.15, 0.2],
      ['tap', 0.23, 0.215],
      ['swipe', 0.36, 0.14, 0.36, 0.22],
      ['tap', 0.42, 0.08],
      ['swipe', 0.54, 0.08, 0.62, 0.08],
      ['tap', 0.52, 0.18],
      ['swipe', 0.7, 0.08, 0.78, 0.08],
      ['tap', 0.68, 0.18]
    ],
    fill: [
      ['swipe', 0.07, 0.1, 0.12, 0.1],
      ['tap', 0.17, 0.1],
      ['swipe', 0.1, 0.2, 0.14, 0.2],
      ['tap', 0.2, 0.21],
      ['swipe', 0.4, 0.1, 0.44, 0.1],
      ['tap', 0.42, 0.25],
      ['swipe', 0.54, 0.18, 0.62, 0.18],
      ['tap', 0.58, 0.22],
      ['swipe', 0.72, 0.18, 0.76, 0.18],
      ['tap', 0.74, 0.22]
    ]
  };

  const readInfo = async (id) => {
    const info = await scenarioInfo(id);
    if (info?.error) console.log('SCENARIO_INFO_ERROR ' + id + ' ' + info.error);
    return info;
  };
  const readScenarioSet = async (ids) => ({
    groups: await scenarioGroups(),
    brush: await readInfo(ids.brushId),
    pen: await readInfo(ids.penId),
    plain: await readInfo(ids.plainId),
    black: await readInfo(ids.blackId),
    yellow: await readInfo(ids.yellowId)
  });

  for (const mode of ['outline', 'fill']) {
    const ids = await drawScenarioSet();
    const before = await readScenarioSet(ids);
    const targets = await scenarioEraseMode(mode);
    let pointerId = 200;
    for (const gesture of scenarioGestures[mode]) {
      if (gesture[0] === 'swipe') {
        await scenarioSwipe(gesture[1], gesture[2], gesture[3], gesture[4], pointerId);
        pointerId += 1;
      } else {
        await readDom(win, clickExpression(gesture[1], gesture[2]));
        await sleep(300);
      }
    }
    const after = await readScenarioSet(ids);
    await screenshot(`smoke-eraser-${mode}.png`);

    const checks =
      mode === 'outline'
        ? {
            groups: after.groups === before.groups,
            geometryIntact:
              after.brush.d === before.brush.d &&
              after.pen.d === before.pen.d &&
              after.plain.tag === 'rect' &&
              after.black.tag === 'rect' &&
              after.yellow.tag === 'rect',
            brushMask: after.brush.strokeMask && after.brush.strokeMaskBlack >= 1,
            penMask: after.pen.strokeMask && after.pen.strokeMaskBlack >= 1,
            plainMask: after.plain.strokeMask && after.plain.strokeMaskBlack >= 1,
            blackMask: after.black.strokeMask && after.black.strokeMaskBlack >= 1,
            yellowMask: after.yellow.strokeMask && after.yellow.strokeMaskBlack >= 1,
            plainStrokeKept: after.plain.stroke === before.plain.stroke,
            blackFillKept: after.black.fill === before.black.fill,
            blackStrokeKept: after.black.stroke === before.black.stroke,
            yellowStrokeKept: after.yellow.stroke === before.yellow.stroke,
            onlyOutline: targets.outline && !targets.fill && !targets.chemistry
          }
        : {
            groups: after.groups === before.groups,
            brushIntact: after.brush.d === before.brush.d,
            penIntact: after.pen.d === before.pen.d,
            plainIntact: after.plain.tag === 'rect' && after.plain.stroke === before.plain.stroke,
            blackFillKept: after.black.fill === before.black.fill,
            blackMask: after.black.mask && after.black.maskBlack >= 1,
            blackStrokeKept: after.black.strokePath === before.black.stroke,
            yellowIntact: after.yellow.tag === 'rect' && after.yellow.stroke === before.yellow.stroke,
            onlyFill: targets.fill && !targets.outline && !targets.chemistry
          };

    scenario[mode] = { ids, before, after, targets, checks };
    for (const [name, ok] of Object.entries(checks)) {
      if (!ok) scenarioFailures.push(`${mode}.${name}`);
    }
  }
  // ---- 20px 直线 + 5px 橡皮：只遮上沿，下沿必须保留（用户复现用例） ----
  await prepareScenarioLayer();
  await selectTool('line');
  await setScenarioRange('stroke-width-range', 20);
  await pickScenarioColor('stroke', 'black');
  await deselectScenario();
  await readDom(win, dragExpression(0.2, 0.12, 0.8, 0.12));
  await sleep(360);
  const notchLineId = await lastScenarioId();
  await deselectScenario();
  const notchLine = await readDom(
    win,
    `(() => {
      const group = document.querySelector('[data-object-id="${notchLineId}"]');
      const line = group?.querySelector('line');
      return line
        ? {
            strokeWidth: Number(line.getAttribute('stroke-width')),
            x1: Number(line.getAttribute('x1')),
            x2: Number(line.getAttribute('x2'))
          }
        : null;
    })()`
  );
  const notchPage = await readDom(
    win,
    `(() => {
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`
  );
  await scenarioEraseMode('outline');
  await setScenarioRange('stroke-width-range', 5);
  const notchZoom = notchPage.width / 1123;
  const notchCenterY = notchPage.top + notchPage.height * 0.12;
  const notchX = notchPage.left + notchPage.width * 0.5;
  const notchTop = notchCenterY - 10 * notchZoom;
  const notchBottom = notchCenterY + 10 * notchZoom;
  // 橡皮半径 2.5：中心放在上沿下方 1px，只吃掉上沿约 3.5px。
  const notchY = notchTop + 1 * notchZoom;
  if (notchLine) {
    await readDom(
      win,
      `(() => {
        const hit = document.querySelector('[data-testid="canvas-hit"]');
        const opts = (x, y, buttons) => ({
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          button: 0, buttons, pointerId: 811, pointerType: 'mouse', isPrimary: true
        });
        hit.dispatchEvent(new PointerEvent('pointerdown', opts(${notchX}, ${notchY}, 1)));
        hit.dispatchEvent(new PointerEvent('pointerup', opts(${notchX}, ${notchY}, 0)));
        return true;
      })()`
    );
    await sleep(350);
  }
  const notchInfo = notchLine ? await scenarioInfo(notchLineId) : { missing: true };
  await parkScenarioPointer();
  const notchTopPx = notchLine
    ? await samplePixel(notchX, notchTop + 1 * notchZoom)
    : {};
  const notchBottomPx = notchLine
    ? await samplePixel(notchX, notchBottom - 1 * notchZoom)
    : {};
  const notchSidePx = notchLine
    ? await samplePixel(notchX + 20, notchCenterY)
    : {};
  await screenshot('smoke-eraser-outline-top-notch.png');
  const notchChecks = {
    lineKept: Boolean(notchLine) && notchInfo.strokeMask && notchInfo.strokeMaskBlack >= 1,
    geometryIntact:
      Boolean(notchLine) &&
      notchLine.strokeWidth === 20 &&
      Math.abs(notchLine.x2 - notchLine.x1) > 100,
    topNotchWhite: lightPixel(notchTopPx),
    bottomKeptBlack: darkPixel(notchBottomPx),
    sideKeptBlack: darkPixel(notchSidePx)
  };
  for (const [name, ok] of Object.entries(notchChecks)) {
    if (!ok) scenarioFailures.push(`outlineNotch.${name}`);
  }
  console.log(
    'ERASER_OUTLINE_NOTCH ' +
      JSON.stringify(
        {
          line: notchLine,
          info: notchInfo,
          pixels: { top: notchTopPx, bottom: notchBottomPx, side: notchSidePx },
          checks: notchChecks
        },
        null,
        2
      )
  );

  // ---- 仅“擦除填充”的边缘回归：外部滑入/滑出、部分重叠点按、边线中心点按 ----
  // 这里同时做 DOM 包围盒与像素断言；mask 修复后必须不再反填黑/外泄。
  await prepareScenarioLayer();
  await selectTool('rect');
  await setScenarioRange('stroke-width-range', 4);
  await pickScenarioColor('fill', 'black');
  await pickScenarioColor('stroke', 'blue');
  await deselectScenario();
  await readDom(win, dragExpression(0.4, 0.2, 0.6, 0.6));
  await sleep(380);
  const edgeRectId = await lastScenarioId();
  await deselectScenario();
  await scenarioEraseMode('fill');
  const edgeBefore = await scenarioInfo(edgeRectId);
  const edgeRectBoxBefore = await readDom(
    win,
    `(() => {
      const group = document.querySelector('[data-object-id="${edgeRectId}"]');
      const box = group?.getBoundingClientRect();
      return box
        ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
        : null;
    })()`
  );
  const edgeCx = (edgeRectBoxBefore.left + edgeRectBoxBefore.right) / 2;
  const edgeMidY = (edgeRectBoxBefore.top + edgeRectBoxBefore.bottom) / 2;
  const edgeLeftOutside = edgeRectBoxBefore.left - 30;
  const edgeRightOutside = edgeRectBoxBefore.right + 30;
  const edgeTopOutside = edgeRectBoxBefore.top - 14;
  const edgeTopInside = edgeRectBoxBefore.top + 4;
  const edgeTopDeep = edgeRectBoxBefore.top + 30;
  const edgeTapX =
    edgeRectBoxBefore.left + (edgeRectBoxBefore.right - edgeRectBoxBefore.left) * 0.9;
  const edgeCloseX =
    edgeRectBoxBefore.left + (edgeRectBoxBefore.right - edgeRectBoxBefore.left) * 0.508;
  const boxClose = (a, b, tolerance = 4) =>
    Boolean(
      a &&
        b &&
        Math.abs(a.left - b.left) <= tolerance &&
        Math.abs(a.top - b.top) <= tolerance &&
        Math.abs(a.right - b.right) <= tolerance &&
        Math.abs(a.bottom - b.bottom) <= tolerance
    );

  await parkScenarioPointer();
  const edgePxBeforeCenter = await samplePixel(edgeCx, edgeMidY);
  const edgePxBeforeLeft = await samplePixel(edgeLeftOutside, edgeMidY);

  // 步骤 1：从矩形左侧外部滑入，穿过内部，再从右侧滑出；用 40 个 pointermove 模拟慢速拖动。
  await readDom(
    win,
    `(() => {
      const hit = document.querySelector('[data-testid="canvas-hit"]');
      const page = document.querySelector('[data-testid="canvas-page"]');
      const r = page.getBoundingClientRect();
      const pt = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
      const opts = (p, buttons) => ({
        bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
        button: 0, buttons, pointerId: 501, pointerType: 'mouse', isPrimary: true
      });
      hit.dispatchEvent(new PointerEvent('pointerdown', opts(pt(0.3, 0.4), 1)));
      for (let index = 1; index <= 40; index += 1) {
        const fx = 0.3 + ((0.7 - 0.3) * index) / 40;
        hit.dispatchEvent(new PointerEvent('pointermove', opts(pt(fx, 0.4), 1)));
      }
      hit.dispatchEvent(new PointerEvent('pointerup', opts(pt(0.7, 0.4), 0)));
      return true;
    })()`
  );
  await sleep(420);
  await screenshot('smoke-eraser-fill-edge-step1.png');
  const edgeAfter1 = await scenarioInfo(edgeRectId);
  const edgeBoxAfter1 = await readDom(
    win,
    `(() => {
      const path = document.querySelector('[data-object-id="${edgeRectId}"] path');
      const box = path?.getBoundingClientRect();
      return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null;
    })()`
  );

  await parkScenarioPointer();
  const edgePxAfter1Center = await samplePixel(edgeCx, edgeMidY);
  const edgePxAfter1Left = await samplePixel(edgeLeftOutside, edgeMidY);
  const edgePxAfter1Right = await samplePixel(edgeRightOutside, edgeMidY);

  // 步骤 2：点按中心在矩形外侧，圆只与填充区部分重叠。
  await readDom(win, clickExpression(0.39, 0.5));
  await sleep(320);
  await screenshot('smoke-eraser-fill-edge-step2.png');
  const edgeAfter2 = await scenarioInfo(edgeRectId);
  const edgeBoxAfter2 = await readDom(
    win,
    `(() => {
      const path = document.querySelector('[data-object-id="${edgeRectId}"] path');
      const box = path?.getBoundingClientRect();
      return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null;
    })()`
  );

  // 步骤 2b：在未被步骤 1 污染的上边线旁做同样的部分重叠点按，中心在边线外。
  await readDom(win, clickExpression(0.58, 0.19));
  await sleep(320);
  await screenshot('smoke-eraser-fill-edge-step2b.png');
  const edgeAfter2b = await scenarioInfo(edgeRectId);
  const edgeBoxAfter2b = await readDom(
    win,
    `(() => {
      const path = document.querySelector('[data-object-id="${edgeRectId}"] path');
      const box = path?.getBoundingClientRect();
      return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null;
    })()`
  );

  await parkScenarioPointer();
  const edgePxAfter2bOutside = await samplePixel(edgeTapX, edgeTopOutside);
  const edgePxAfter2bInside = await samplePixel(edgeTapX, edgeTopInside);
  const edgePxAfter2bDeep = await samplePixel(edgeTapX, edgeTopDeep);

  // 步骤 3：连续点按上边线，点按中心落在边线上，一半在内一半在外。
  for (const fx of [0.45, 0.5, 0.55]) {
    await readDom(win, clickExpression(fx, 0.2));
    await sleep(280);
  }
  await screenshot('smoke-eraser-fill-edge-step3.png');
  const edgeAfter3 = await scenarioInfo(edgeRectId);
  const edgeBoxAfter3 = await readDom(
    win,
    `(() => {
      const path = document.querySelector('[data-object-id="${edgeRectId}"] path');
      const box = path?.getBoundingClientRect();
      return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null;
    })()`
  );

  await parkScenarioPointer();
  const edgePxAfter3Outside = await samplePixel(edgeCx, edgeTopOutside);
  const edgePxAfter3Inside = await samplePixel(edgeCx, edgeTopInside);
  const edgePxAfter3Deep = await samplePixel(edgeCx, edgeTopDeep);

  // 步骤 3b：近距离连续点按上边线，让两个圆孔明显重叠，观察孔洞重叠后的填充。
  for (const fx of [0.505, 0.512]) {
    await readDom(win, clickExpression(fx, 0.2));
    await sleep(280);
  }
  await screenshot('smoke-eraser-fill-edge-step3b.png');
  const edgeAfter3b = await scenarioInfo(edgeRectId);
  const edgeBoxAfter3b = await readDom(
    win,
    `(() => {
      const path = document.querySelector('[data-object-id="${edgeRectId}"] path');
      const box = path?.getBoundingClientRect();
      return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null;
    })()`
  );
  await parkScenarioPointer();
  const edgePxAfter3bOverlap = await samplePixel(edgeCloseX, edgeTopInside);

  const fillEdgeChecks = {
    beforeDark: darkPixel(edgePxBeforeCenter),
    beforeOutsideLight: lightPixel(edgePxBeforeLeft),
    slideWhite: lightPixel(edgePxAfter1Center),
    slideNoLeakLeft: lightPixel(edgePxAfter1Left),
    slideNoLeakRight: lightPixel(edgePxAfter1Right),
    slideMask: Boolean(edgeAfter1.mask && edgeAfter1.maskBlack >= 1),
    slideBbox: boxClose(edgeRectBoxBefore, edgeBoxAfter1),
    tapOutsideWhite: lightPixel(edgePxAfter2bOutside),
    tapInsideWhite: lightPixel(edgePxAfter2bInside),
    tapDeepDark: darkPixel(edgePxAfter2bDeep),
    tapBbox: boxClose(edgeRectBoxBefore, edgeBoxAfter2b),
    edgeOutsideWhite: lightPixel(edgePxAfter3Outside),
    edgeInsideWhite: lightPixel(edgePxAfter3Inside),
    edgeDeepDark: darkPixel(edgePxAfter3Deep),
    edgeBbox: boxClose(edgeRectBoxBefore, edgeBoxAfter3),
    closeTapWhite: lightPixel(edgePxAfter3bOverlap),
    closeTapBbox: boxClose(edgeRectBoxBefore, edgeBoxAfter3b)
  };
  for (const [name, ok] of Object.entries(fillEdgeChecks)) {
    if (!ok) scenarioFailures.push(`fillEdge.${name}`);
  }
  console.log(
    'ERASER_FILL_EDGE ' +
      JSON.stringify(
        {
          id: edgeRectId,
          before: edgeBefore,
          after1: edgeAfter1,
          after2: edgeAfter2,
          after2b: edgeAfter2b,
          after3: edgeAfter3,
          after3b: edgeAfter3b,
          rectBoxBefore: edgeRectBoxBefore,
          boxAfter1: edgeBoxAfter1,
          boxAfter2: edgeBoxAfter2,
          boxAfter2b: edgeBoxAfter2b,
          boxAfter3: edgeBoxAfter3,
          boxAfter3b: edgeBoxAfter3b,
          pixels: {
            beforeCenter: edgePxBeforeCenter,
            beforeLeft: edgePxBeforeLeft,
            after1Center: edgePxAfter1Center,
            after1Left: edgePxAfter1Left,
            after1Right: edgePxAfter1Right,
            after2bOutside: edgePxAfter2bOutside,
            after2bInside: edgePxAfter2bInside,
            after2bDeep: edgePxAfter2bDeep,
            after3Outside: edgePxAfter3Outside,
            after3Inside: edgePxAfter3Inside,
            after3Deep: edgePxAfter3Deep,
            after3bOverlap: edgePxAfter3bOverlap
          },
          checks: fillEdgeChecks
        },
        null,
        2
      )
  );

  // 测试结束恢复“全部擦除”，不要把 stroke-only 偏好留给真实用户。
  await readDom(
    win,
    `(() => {
      const all = document.querySelector('[data-eraser-target="all"]');
      if (all && !all.classList.contains('is-active')) all.click();
      return true;
    })()`
  );
  await sleep(140);

  console.log('ERASER_SCENARIO ' + JSON.stringify(scenario, null, 2));
  if (scenarioFailures.length > 0) {
    console.error('[smoke] eraser scenario failures:\n- ' + scenarioFailures.join('\n- '));
  }

  // ---- 位图导入：文件头识别 → 渲染进程解码 → 作为位图对象进入画布与导出管线 ----
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAPAAAAB4CAYAAADMtn8nAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAF5SURBVHhe7dMxEQAgEMCwd4YivOMAdhz0LkOW7p21zwWa5g9Ah4EhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQ8D1C6srD207QAAAABJRU5ErkJggg==';
  const imagePngPath = path.join(outDir, 'smoke-import.png');
  const imageSvgPath = path.join(outDir, 'smoke-import.svg');
  const imageSvgHold = `${imageSvgPath}.hold`;
  fs.writeFileSync(imagePngPath, Buffer.from(pngBase64, 'base64'));
  let imageSvgHeld = false;
  if (fs.existsSync(imageSvgPath)) {
    fs.renameSync(imageSvgPath, imageSvgHold);
    imageSvgHeld = true;
  }
  let imageImport = { ok: false };
  try {
    const beforeImage = await countObjects();
    await readDom(
      win,
      `[...document.querySelectorAll('.menubar__trigger')].find((el) => el.textContent === '文件').click()`
    );
    await sleep(180);
    await readDom(
      win,
      `(() => {
        const item = [...document.querySelectorAll('.menu-dropdown .menu-item')].find((el) => (el.textContent || '').includes('导入文件'));
        if (item) item.click();
        return Boolean(item);
      })()`
    );
    await sleep(280);
    const dialogOpen = await readDom(
      win,
      `Boolean(document.querySelector('[data-testid="import-dialog"]'))`
    );
    await readDom(
      win,
      `(() => {
        const button = document.querySelector('[data-testid="import-choose"]');
        if (button) button.click();
        return Boolean(button);
      })()`
    );
    await sleep(900);
    const summary = await readDom(
      win,
      `(() => ({
        open: Boolean(document.querySelector('[data-testid="import-summary"]')),
        badge: document.querySelector('.import-badge')?.textContent || '',
        error: document.querySelector('[data-testid="import-error"]')?.textContent || null,
        body: document.querySelector('[data-testid="import-summary"]')?.textContent || ''
      }))()`
    );
    const dialogStyle = await readDom(
      win,
      `(() => {
        const backdrop = document.querySelector('.modal-backdrop');
        const modal = document.querySelector('.modal');
        if (!backdrop || !modal) return { present: false };
        const br = backdrop.getBoundingClientRect();
        const mr = modal.getBoundingClientRect();
        const bs = getComputedStyle(backdrop);
        const ms = getComputedStyle(modal);
        return {
          present: true,
          backdrop: { z: bs.zIndex, display: bs.display, opacity: bs.opacity, visibility: bs.visibility, x: br.x, y: br.y, w: br.width, h: br.height },
          modal: { z: ms.zIndex, display: ms.display, opacity: ms.opacity, visibility: ms.visibility, x: mr.x, y: mr.y, w: mr.width, h: mr.height, transform: ms.transform }
        };
      })()`
    );
    // 冒烟窗口可能被其他窗口遮挡：截图前强制前置并等一帧，确保捕获到浮层本身。
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    await readDom(
      win,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
    );
    await sleep(240);
    await screenshot('smoke-import-image-dialog.png');
    await readDom(win, `document.querySelector('[data-testid="import-mode-append"]')?.click()`);
    await sleep(140);
    await readDom(win, `document.querySelector('[data-testid="import-confirm"]')?.click()`);
    await sleep(900);
    const afterImage = await countObjects();
    const rendered = await readDom(
      win,
      `[...document.querySelectorAll('svg image')].some((node) => (node.getAttribute('href') || '').startsWith('data:image/png;base64,'))`
    );
    // 选中刚导入的位图 → 导出 SVG：验证位图进入导出管线且 data URL 被原样内嵌。
    await readDom(win, `document.querySelector('[data-testid="export-menu-button"]')?.click()`);
    await sleep(220);
    await readDom(win, `document.querySelector('[data-testid="export-region-entry"]')?.click()`);
    await sleep(340);
    await readDom(win, `document.querySelector('[data-testid="export-scope-selection"]')?.click()`);
    await sleep(180);
    await readDom(win, `document.querySelector('[data-testid="export-format-svg"]')?.click()`);
    await sleep(420);
    await readDom(win, `document.querySelector('[data-testid="export-confirm"]')?.click()`);
    await sleep(1500);
    const exportedSvgPath = path.join(outDir, 'smoke-export.svg');
    const exportedImageSvg = fs.existsSync(exportedSvgPath)
      ? fs.readFileSync(exportedSvgPath, 'utf8')
      : '';
    const svgHasImage =
      exportedImageSvg.includes('<image') &&
      exportedImageSvg.includes('data:image/png;base64,');

    // 位图光栅导出：与 SVG 共用同一条渲染管线，中心像素应落在导入的蓝色块上。
    await readDom(win, `document.querySelector('[data-testid="export-menu-button"]')?.click()`);
    await sleep(220);
    await readDom(win, `document.querySelector('[data-testid="export-region-entry"]')?.click()`);
    await sleep(340);
    await readDom(win, `document.querySelector('[data-testid="export-scope-selection"]')?.click()`);
    await sleep(180);
    await readDom(win, `document.querySelector('[data-testid="export-format-png"]')?.click()`);
    await sleep(600);
    await readDom(win, `document.querySelector('[data-testid="export-confirm"]')?.click()`);
    await sleep(1500);
    const rasterImagePath = path.join(outDir, 'smoke-export.png');
    const rasterImage = fs.existsSync(rasterImagePath)
      ? nativeImage.createFromPath(rasterImagePath)
      : null;
    const rasterSize = rasterImage && !rasterImage.isEmpty() ? rasterImage.getSize() : null;
    const rasterBitmap =
      rasterImage && !rasterImage.isEmpty() ? rasterImage.getBitmap() : null;
    let rasterPixel = null;
    if (rasterBitmap && rasterSize) {
      const x = Math.floor(rasterSize.width / 2);
      const y = Math.floor(rasterSize.height / 2);
      const index = (y * rasterSize.width + x) * 4;
      rasterPixel = {
        b: rasterBitmap[index],
        g: rasterBitmap[index + 1],
        r: rasterBitmap[index + 2],
        a: rasterBitmap[index + 3]
      };
    }
    const rasterHasImage = Boolean(
      rasterPixel && rasterPixel.a > 200 && rasterPixel.b > 200 && rasterPixel.r < 120
    );
    imageImport = {
      ok:
        dialogOpen &&
        summary.open &&
        !summary.error &&
        summary.badge.includes('PNG') &&
        summary.body.includes('240 × 120') &&
        afterImage === beforeImage + 1 &&
        rendered &&
        svgHasImage &&
        rasterHasImage,
      dialogOpen,
      badge: summary.badge,
      error: summary.error,
      added: afterImage - beforeImage,
      rendered,
      svgHasImage,
      rasterSize,
      rasterPixel,
      rasterHasImage,
      dialogStyle
    };
  } catch (error) {
    imageImport = { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(imagePngPath, { force: true });
    if (imageSvgHeld && fs.existsSync(imageSvgHold)) fs.renameSync(imageSvgHold, imageSvgPath);
  }
  console.log('IMAGE_IMPORT ' + JSON.stringify(imageImport));

  // ---- 批量导入：两张位图一次写入「新建图层」，其中一张宽于页面，验证不缩放 ----
  const widePngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAABLAAAABQCAYAAAAJKoxeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAJOSURBVHhe7dghAQAwDMCwmZt/djs/v4KCgJBK6JzdCwAAAABV8wcAAAAAKDGwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASDOwAAAAAEgzsAAAAABIM7AAAAAASHurFV0YgQ8zFQAAAABJRU5ErkJggg==';
  const batchPngA = path.join(outDir, 'smoke-import.png');
  const batchPngB = path.join(outDir, 'smoke-import-2.png');
  const batchBadPng = path.join(outDir, 'smoke-import-bad.png');
  const batchSvgHold = `${imageSvgPath}.batch-hold`;
  fs.writeFileSync(batchPngA, Buffer.from(pngBase64, 'base64'));
  fs.writeFileSync(batchPngB, Buffer.from(widePngBase64, 'base64'));
  fs.writeFileSync(batchBadPng, 'this is not a real png', 'utf8');
  let batchSvgHeld = false;
  if (fs.existsSync(imageSvgPath)) {
    fs.renameSync(imageSvgPath, batchSvgHold);
    batchSvgHeld = true;
  }
  let batchImport = { ok: false };
  try {
    const beforeObjects = await countObjects();
    const beforeLayers = await readDom(
      win,
      `document.querySelectorAll('[data-layer-row]').length`
    );
    await readDom(
      win,
      `[...document.querySelectorAll('.menubar__trigger')].find((el) => el.textContent === '文件').click()`
    );
    await sleep(180);
    await readDom(
      win,
      `(() => {
        const item = [...document.querySelectorAll('.menu-dropdown .menu-item')].find((el) => (el.textContent || '').includes('导入文件'));
        if (item) item.click();
        return Boolean(item);
      })()`
    );
    await sleep(280);
    await readDom(
      win,
      `(() => {
        const button = document.querySelector('[data-testid="import-choose"]');
        if (button) button.click();
        return Boolean(button);
      })()`
    );
    await sleep(1200);
    const batchState = await readDom(
      win,
      `(() => {
        const rows = [...document.querySelectorAll('[data-testid="import-batch-row"]')];
        const layerMode = document.querySelector('[data-testid="import-mode-layer"]');
        return {
          dialog: Boolean(document.querySelector('[data-testid="import-dialog"]')),
          rows: rows.length,
          okRows: rows.filter((row) => row.getAttribute('data-ok') === 'true').length,
          badRows: rows.filter((row) => row.getAttribute('data-ok') === 'false').length,
          badMessage:
            document.querySelector('.import-batch__item[data-ok="false"] .import-batch__error')
              ?.textContent || null,
          layerActive: layerMode?.classList.contains('is-active') ?? false,
          activeMode:
            document.querySelector('.import-mode.is-active')?.getAttribute('data-testid') ?? null,
          layerDisabled: layerMode?.disabled ?? null,
          appendDisabled:
            document.querySelector('[data-testid="import-mode-append"]')?.disabled ?? null,
          error: document.querySelector('[data-testid="import-error"]')?.textContent || null
        };
      })()`
    );
    await screenshot('smoke-import-batch-dialog.png');

    // 删除坏文件 → 继续添加（会重新带出 smoke-import* 三个文件）→ 再删掉新加的 3 行。
    await readDom(
      win,
      `(() => {
        const bad = document.querySelector('.import-batch__item[data-ok="false"]');
        bad?.querySelector('[data-testid="import-remove"]')?.click();
        return Boolean(bad);
      })()`
    );
    await sleep(220);
    await readDom(win, `document.querySelector('[data-testid="import-add-more"]')?.click()`);
    await sleep(1200);
    const afterAddMore = await readDom(
      win,
      `(() => {
        const rows = [...document.querySelectorAll('[data-testid="import-batch-row"]')];
        const list = document.querySelector('[data-testid="import-batch-list"]');
        const style = list ? getComputedStyle(list) : null;
        if (list) list.scrollTop = 120;
        return {
          rows: rows.length,
          okRows: rows.filter((row) => row.getAttribute('data-ok') === 'true').length,
          names: rows.map((row) => row.querySelector('.import-batch__name')?.textContent || ''),
          list: list
            ? {
                overflowY: style?.overflowY || '',
                scrollHeight: list.scrollHeight,
                clientHeight: list.clientHeight,
                scrollTop: list.scrollTop
              }
            : null
        };
      })()`
    );
    for (let index = 0; index < 3; index += 1) {
      await readDom(
        win,
        `(() => {
          const rows = [...document.querySelectorAll('[data-testid="import-batch-row"]')];
          rows[rows.length - 1]?.querySelector('[data-testid="import-remove"]')?.click();
          return rows.length;
        })()`
      );
      await sleep(160);
    }
    const prunedState = await readDom(
      win,
      `(() => {
        const rows = [...document.querySelectorAll('[data-testid="import-batch-row"]')];
        return {
          rows: rows.length,
          okRows: rows.filter((row) => row.getAttribute('data-ok') === 'true').length,
          badRows: rows.filter((row) => row.getAttribute('data-ok') === 'false').length
        };
      })()`
    );
    await readDom(win, `document.querySelector('[data-testid="import-mode-layer"]')?.click()`);
    await sleep(140);
    await readDom(win, `document.querySelector('[data-testid="import-confirm"]')?.click()`);
    await sleep(1200);
    await readDom(win, `document.querySelector('[data-tool="select"]')?.click()`);
    await sleep(250);
    const afterObjects = await countObjects();
    const afterLayers = await readDom(
      win,
      `document.querySelectorAll('[data-layer-row]').length`
    );
    const batchGeometry = await readDom(
      win,
      `(() => {
        const images = [...document.querySelectorAll('svg image')].map((node) => ({
          w: Number(node.getAttribute('width')),
          h: Number(node.getAttribute('height')),
          x: Number(node.getAttribute('x'))
        }));
        const layerNames = [...document.querySelectorAll('[data-layer-row] .layer-row__name')].map(
          (node) => node.textContent || ''
        );
        return {
          images,
          hasNatural: images.some((item) => item.w === 240 && item.h === 120),
          hasWide: images.some((item) => item.w === 1200 && item.h === 80 && item.x < 0),
          layerNames,
          handles: document.querySelectorAll('.selection-overlay rect').length,
          dialogClosed: !document.querySelector('[data-testid="import-dialog"]')
        };
      })()`
    );
    // 属性面板缩放：Godot 风格 X/Y 百分比 + 链式等比开关。
    await readDom(
      win,
      `(() => {
        const rows = [...document.querySelectorAll('[data-object-row]')];
        rows[rows.length - 1]?.click();
        return Boolean(rows.length);
      })()`
    );
    await sleep(220);
    await readDom(win, `document.querySelector('[data-testid="sidebar-tab-properties"]')?.click()`);
    await sleep(220);
    const readScaleInputs = `(() => {
      const inputs = [...document.querySelectorAll('[data-testid="scale-panel"] input')];
      return {
        panel: Boolean(document.querySelector('[data-testid="scale-panel"]')),
        x: inputs[0]?.value ?? null,
        y: inputs[1]?.value ?? null,
        linked: document.querySelector('[data-testid="scale-link"]')?.getAttribute('aria-pressed') === 'true'
      };
    })()`;
    const setScaleInput = (index, value) =>
      `(() => {
        const input = document.querySelectorAll('[data-testid="scale-panel"] input')[${index}];
        if (!input) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '${value}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`;
    const commitScaleInput = (index) =>
      `(() => {
        const input = document.querySelectorAll('[data-testid="scale-panel"] input')[${index}];
        if (!input) return false;
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        return true;
      })()`;
    const readWideSize = `(() => {
      const image = [...document.querySelectorAll('svg image')].find(
        (node) => Number(node.getAttribute('width')) > 0 &&
          (Number(node.getAttribute('width')) === 1200 || Number(node.getAttribute('width')) === 600 || Number(node.getAttribute('width')) === 300)
      );
      return image
        ? { w: Number(image.getAttribute('width')), h: Number(image.getAttribute('height')) }
        : null;
    })()`;
    const scaleInitial = await readDom(win, readScaleInputs);
    await screenshot('smoke-scale-panel.png');
    await readDom(win, setScaleInput(0, 50));
    await sleep(80);
    await readDom(win, commitScaleInput(0));
    await sleep(260);
    const scaleUniformState = await readDom(win, readScaleInputs);
    const scaleUniformSize = await readDom(win, readWideSize);
    await readDom(win, `document.querySelector('[data-testid="scale-link"]')?.click()`);
    await sleep(120);
    await readDom(win, setScaleInput(0, 25));
    await sleep(80);
    await readDom(win, commitScaleInput(0));
    await sleep(260);
    const scaleIndependentState = await readDom(win, readScaleInputs);
    const scaleIndependentSize = await readDom(win, readWideSize);
    await readDom(win, `document.querySelector('.scale-panel .scale-reset')?.click()`);
    await sleep(260);
    const scaleResetSize = await readDom(win, readWideSize);
    const scaleOk =
      scaleInitial.panel &&
      scaleInitial.x === '100' &&
      scaleInitial.y === '100' &&
      scaleInitial.linked === true &&
      scaleUniformState.x === '50' &&
      scaleUniformState.y === '50' &&
      scaleUniformSize?.w === 600 &&
      scaleUniformSize?.h === 40 &&
      scaleIndependentState.linked === false &&
      scaleIndependentState.x === '25' &&
      scaleIndependentState.y === '50' &&
      scaleIndependentSize?.w === 300 &&
      scaleIndependentSize?.h === 40 &&
      scaleResetSize?.w === 1200 &&
      scaleResetSize?.h === 80;

    await readDom(win, `document.querySelector('[data-testid="sidebar-tab-layers"]')?.click()`);
    await sleep(220);

    // 方向键微调 + 长按连续移动（右键长按 260ms 后由定时器连续推进）。
    const readWideX = `(() => {
      const image = [...document.querySelectorAll('svg image')].find(
        (node) => Number(node.getAttribute('width')) === 1200
      );
      return image ? Number(image.getAttribute('x')) : null;
    })()`;
    const wideBefore = await readDom(win, readWideX);
    await readDom(
      win,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))`
    );
    await sleep(900);
    await readDom(
      win,
      `window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))`
    );
    await sleep(120);
    const wideAfter = await readDom(win, readWideX);
    const nudgeOk =
      typeof wideBefore === 'number' &&
      typeof wideAfter === 'number' &&
      wideAfter > wideBefore + 2;
    await readDom(
      win,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`
    );
    await sleep(180);
    const wideUndo = await readDom(win, readWideX);
    const nudgeUndoOk =
      typeof wideBefore === 'number' &&
      typeof wideUndo === 'number' &&
      Math.abs(wideUndo - wideBefore) < 0.6;

    // 对象行眼睛：pointerdown 不应被行拖动捕获。
    const readObjectEyeTitle = `(() => {
      const rows = [...document.querySelectorAll('[data-object-row]')];
      const eye = rows[rows.length - 1]?.querySelector('.object-row__eye:last-of-type');
      return eye?.getAttribute('title') || null;
    })()`;
    const objectEyeBefore = await readDom(win, readObjectEyeTitle);
    await readDom(
      win,
      `(() => {
        const rows = [...document.querySelectorAll('[data-object-row]')];
        const eye = rows[rows.length - 1]?.querySelector('.object-row__eye:last-of-type');
        if (!eye) return false;
        eye.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 81 }));
        eye.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 81 }));
        eye.click();
        return true;
      })()`
    );
    await sleep(180);
    const objectEyeAfter = await readDom(win, readObjectEyeTitle);
    const objectEyeOk = objectEyeBefore === '隐藏对象' && objectEyeAfter === '显示对象';
    await readDom(win, `document.querySelector('[data-object-row] .object-row__eye:last-of-type')?.click()`);
    await sleep(120);

    // 图层行眼睛：导入图层同样可关闭/恢复可见性。
    const layerEyeBefore = await readDom(
      win,
      `(() => {
        const row = [...document.querySelectorAll('[data-layer-row]')].find(
          (item) => item.querySelector('.layer-row__name')?.textContent === 'smoke-import-2'
        );
        return row ? row.classList.contains('is-hidden') : null;
      })()`
    );
    await readDom(
      win,
      `(() => {
        const row = [...document.querySelectorAll('[data-layer-row]')].find(
          (item) => item.querySelector('.layer-row__name')?.textContent === 'smoke-import-2'
        );
        row?.querySelector('.layer-row__toggle')?.click();
        return Boolean(row);
      })()`
    );
    await sleep(180);
    const layerHidden = await readDom(
      win,
      `(() => {
        const row = [...document.querySelectorAll('[data-layer-row]')].find(
          (item) => item.querySelector('.layer-row__name')?.textContent === 'smoke-import-2'
        );
        return row ? row.classList.contains('is-hidden') : null;
      })()`
    );
    await readDom(
      win,
      `(() => {
        const row = [...document.querySelectorAll('[data-layer-row]')].find(
          (item) => item.querySelector('.layer-row__name')?.textContent === 'smoke-import-2'
        );
        row?.querySelector('.layer-row__toggle')?.click();
        return Boolean(row);
      })()`
    );
    await sleep(120);
    const layerEyeOk = layerEyeBefore === false && layerHidden === true;

    batchImport = {
      ok:
        batchState.dialog &&
        batchState.rows === 3 &&
        batchState.okRows === 2 &&
        batchState.badRows === 1 &&
        Boolean(batchState.badMessage) &&
        !batchState.error &&
        batchState.layerActive &&
        afterAddMore.rows === 5 &&
        afterAddMore.okRows === 4 &&
        afterAddMore.list?.overflowY === 'auto' &&
        afterAddMore.list.scrollHeight > afterAddMore.list.clientHeight &&
        afterAddMore.list.scrollTop > 0 &&
        prunedState.rows === 2 &&
        prunedState.okRows === 2 &&
        prunedState.badRows === 0 &&
        afterObjects === beforeObjects + 2 &&
        afterLayers === beforeLayers + 2 &&
        batchGeometry.hasNatural &&
        batchGeometry.hasWide &&
        batchGeometry.layerNames.includes('smoke-import') &&
        batchGeometry.layerNames.includes('smoke-import-2') &&
        batchGeometry.handles >= 9 &&
        batchGeometry.dialogClosed &&
        scaleOk &&
        nudgeOk &&
        nudgeUndoOk &&
        objectEyeOk &&
        layerEyeOk,
      rows: batchState.rows,
      okRows: batchState.okRows,
      badRows: batchState.badRows,
      badMessage: batchState.badMessage,
      afterAddMore,
      prunedState,
      error: batchState.error,
      layerActive: batchState.layerActive,
      activeMode: batchState.activeMode,
      layerDisabled: batchState.layerDisabled,
      appendDisabled: batchState.appendDisabled,
      addedObjects: afterObjects - beforeObjects,
      addedLayers: afterLayers - beforeLayers,
      hasNaturalImage: batchGeometry.hasNatural,
      hasWideImage: batchGeometry.hasWide,
      layerNames: batchGeometry.layerNames,
      handles: batchGeometry.handles,
      dialogClosed: batchGeometry.dialogClosed,
      scale: {
        initial: scaleInitial,
        uniform: scaleUniformState,
        uniformSize: scaleUniformSize,
        independent: scaleIndependentState,
        independentSize: scaleIndependentSize,
        resetSize: scaleResetSize,
        ok: scaleOk
      },
      nudge: { before: wideBefore, after: wideAfter, undo: wideUndo, ok: nudgeOk, undoOk: nudgeUndoOk },
      objectEye: { before: objectEyeBefore, after: objectEyeAfter, ok: objectEyeOk },
      layerEye: { before: layerEyeBefore, hidden: layerHidden, ok: layerEyeOk }
    };
  } catch (error) {
    batchImport = { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(batchPngA, { force: true });
    fs.rmSync(batchPngB, { force: true });
    fs.rmSync(batchBadPng, { force: true });
    if (batchSvgHeld && fs.existsSync(batchSvgHold)) fs.renameSync(batchSvgHold, imageSvgPath);
  }
  console.log('BATCH_IMPORT ' + JSON.stringify(batchImport));

  // ---- 化学交互：选择工具保持化学横栏、一级参数栏、键距设置与新建键几何 ----
  let chemFocus = { ok: false };
  const setInputValue = (selector, value) =>
    `(() => {
      const input = document.querySelector('${selector}');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '${value}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`;
  const commitInput = (selector) =>
    `(() => {
      const input = document.querySelector('${selector}');
      if (!input) return false;
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return true;
    })()`;
  try {
    await selectTool('bond');
    await sleep(260);
    const initialParams = await readDom(
      win,
      `(() => ({
        dock: Boolean(document.querySelector('[data-testid="chem-dock"]')),
        length: document.querySelector('[data-testid="chem-bond-length"]')?.value ?? null,
        width: document.querySelector('[data-testid="chem-bond-width"]')?.value ?? null,
        spacing: document.querySelector('[data-testid="chem-bond-spacing"]')?.value ?? null,
        atomSize: document.querySelector('[data-testid="chem-atom-size"]')?.value ?? null
      }))()`
    );
    await selectTool('select');
    await sleep(220);
    const sticky = await readDom(
      win,
      `(() => ({
        dock: Boolean(document.querySelector('[data-testid="chem-dock"]')),
        tool: document.querySelector('[data-testid="status-tool"]')?.textContent || ''
      }))()`
    );
    await readDom(win, `document.querySelector('[data-testid="chem-confirm"]')?.click()`);
    await sleep(220);
    const closedAfterConfirm = await readDom(
      win,
      `!Boolean(document.querySelector('[data-testid="chem-dock"]'))`
    );

    await selectTool('bond');
    await sleep(260);
    await readDom(win, setInputValue('[data-testid="chem-bond-length"]', 60));
    await readDom(win, commitInput('[data-testid="chem-bond-length"]'));
    await readDom(win, setInputValue('[data-testid="chem-bond-width"]', 3));
    await readDom(win, commitInput('[data-testid="chem-bond-width"]'));
    await readDom(win, setInputValue('[data-testid="chem-bond-spacing"]', 6));
    await readDom(win, commitInput('[data-testid="chem-bond-spacing"]'));
    await sleep(180);
    const changedParams = await readDom(
      win,
      `(() => ({
        length: document.querySelector('[data-testid="chem-bond-length"]')?.value ?? null,
        width: document.querySelector('[data-testid="chem-bond-width"]')?.value ?? null,
        spacing: document.querySelector('[data-testid="chem-bond-spacing"]')?.value ?? null,
        atomSize: document.querySelector('[data-testid="chem-atom-size"]')?.value ?? null
      }))()`
    );
    await screenshot('smoke-chem-params.png');
    await readDom(win, `document.querySelector('[data-bond="double"]')?.click()`);
    await sleep(140);
    await readDom(win, clickExpression(0.08, 0.08));
    await sleep(320);
    const createdBond = await readDom(
      win,
      `(() => {
        const groups = [...document.querySelectorAll('.scene-layer [data-object-id]')];
        const group = [...groups].reverse().find((item) => {
          const lines = item.querySelectorAll('line');
          return lines.length >= 2 && !item.querySelector('path, rect, text, image');
        });
        if (!group) return null;
        const lines = [...group.querySelectorAll('line')].map((line) => ({
          x1: Number(line.getAttribute('x1')),
          y1: Number(line.getAttribute('y1')),
          x2: Number(line.getAttribute('x2')),
          y2: Number(line.getAttribute('y2')),
          width: Number(line.getAttribute('stroke-width'))
        }));
        const length = (line) => Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
        const main = lines.reduce((best, line) => (length(line) > length(best) ? line : best));
        const mainLength = length(main);
        const dx = main.x2 - main.x1;
        const dy = main.y2 - main.y1;
        const norm = Math.max(0.001, Math.hypot(dx, dy));
        const gaps = lines
          .filter((line) => line !== main)
          .map((line) => {
            const px = (line.x1 + line.x2) / 2;
            const py = (line.y1 + line.y2) / 2;
            return Math.abs((px - main.x1) * dy - (py - main.y1) * dx) / norm;
          })
          .filter((gap) => gap > 0.1);
        return {
          lines: lines.length,
          length: mainLength,
          width: main.width,
          gap: gaps.length > 0 ? Math.min(...gaps) : null
        };
      })()`
    );

    await readDom(win, `document.querySelector('[data-testid="settings-button"]')?.click()`);
    await sleep(240);
    await readDom(
      win,
      `document.querySelector('[data-testid="settings-tab-chemistry"]')?.click()`
    );
    await sleep(180);
    const settingsSpacing = await readDom(
      win,
      `document.querySelector('[data-testid="settings-bond-spacing"]')?.value ?? null`
    );
    const settingsAtomSize = await readDom(
      win,
      `document.querySelector('[data-testid="settings-atom-size"]')?.value ?? null`
    );
    await readDom(win, setInputValue('[data-testid="settings-bond-spacing"]', 5));
    await readDom(win, setInputValue('[data-testid="settings-atom-size"]', 20));
    await sleep(180);
    await readDom(win, `document.querySelector('.modal [aria-label="关闭"]')?.click()`);
    await sleep(220);
    const toolbarSpacing = await readDom(
      win,
      `document.querySelector('[data-testid="chem-bond-spacing"]')?.value ?? null`
    );
    const toolbarAtomSize = await readDom(
      win,
      `document.querySelector('[data-testid="chem-atom-size"]')?.value ?? null`
    );

    chemFocus = {
      ok:
        initialParams.dock &&
        initialParams.length === '40' &&
        initialParams.width === '2.2' &&
        initialParams.spacing === '4.2' &&
        initialParams.atomSize === '16' &&
        sticky.dock &&
        sticky.tool.includes('选择') &&
        closedAfterConfirm &&
        changedParams.length === '60' &&
        changedParams.width === '3.0' &&
        changedParams.spacing === '6.0' &&
        changedParams.atomSize === '16' &&
        createdBond &&
        Math.abs(createdBond.length - 60) < 1 &&
        Math.abs(createdBond.width - 3) < 0.2 &&
        createdBond.gap !== null &&
        Math.abs(createdBond.gap - 6) < 0.5 &&
        settingsSpacing === '6' &&
        settingsAtomSize === '16' &&
        toolbarSpacing === '5.0' &&
        toolbarAtomSize === '20',
      initialParams,
      sticky,
      closedAfterConfirm,
      changedParams,
      createdBond,
      settingsSpacing,
      settingsAtomSize,
      toolbarSpacing,
      toolbarAtomSize
    };
  } catch (error) {
    chemFocus = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  console.log('CHEM_FOCUS ' + JSON.stringify(chemFocus));

  // ---- 化学参数扩展：默认值、等比联动、固定化学键、设置命名与全画布整理 ----
  let chemExtras = { ok: false };
  const readLastBond = `(() => {
    const groups = [...document.querySelectorAll('.scene-layer [data-object-id]')];
    const group = [...groups].reverse().find((item) => {
      const lines = item.querySelectorAll('line');
      return lines.length >= 2 && !item.querySelector('path, rect, text, image');
    });
    if (!group) return null;
    const lines = [...group.querySelectorAll('line')].map((line) => ({
      x1: Number(line.getAttribute('x1')),
      y1: Number(line.getAttribute('y1')),
      x2: Number(line.getAttribute('x2')),
      y2: Number(line.getAttribute('y2')),
      width: Number(line.getAttribute('stroke-width'))
    }));
    const length = (line) => Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    const main = lines.reduce((best, line) => (length(line) > length(best) ? line : best));
    const dx = main.x2 - main.x1;
    const dy = main.y2 - main.y1;
    const norm = Math.max(0.001, Math.hypot(dx, dy));
    const gaps = lines
      .filter((line) => line !== main)
      .map((line) => {
        const px = (line.x1 + line.x2) / 2;
        const py = (line.y1 + line.y2) / 2;
        return Math.abs((px - main.x1) * dy - (py - main.y1) * dx) / norm;
      })
      .filter((gap) => gap > 0.1);
    return {
      lines: lines.length,
      length: length(main),
      width: main.width,
      gap: gaps.length > 0 ? Math.min(...gaps) : null
    };
  })()`;
  try {
    await readDom(win, `document.querySelector('[data-testid="chem-bond-defaults"]')?.click()`);
    await sleep(180);
    const defaults = await readDom(
      win,
      `(() => ({
        length: document.querySelector('[data-testid="chem-bond-length"]')?.value ?? null,
        width: document.querySelector('[data-testid="chem-bond-width"]')?.value ?? null,
        spacing: document.querySelector('[data-testid="chem-bond-spacing"]')?.value ?? null,
        atomSize: document.querySelector('[data-testid="chem-atom-size"]')?.value ?? null,
        oldOptions: document.querySelectorAll('[data-testid="bond-fixed-length"], [data-testid="bond-width-lock"]').length,
        fixed: Boolean(document.querySelector('[data-testid="bond-fixed"]'))
      }))()`
    );
    const focusState = await readDom(
      win,
      `(() => {
        const input = document.querySelector('[data-testid="chem-bond-length"]');
        if (!input) return null;
        input.focus();
        input.select();
        return { focused: document.activeElement === input };
      })()`
    );
    const clearedState = await readDom(
      win,
      `(() => {
        const input = document.querySelector('[data-testid="chem-bond-length"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input.value === '';
      })()`
    );
    await readDom(
      win,
      `(() => {
        const input = document.querySelector('[data-testid="chem-bond-length"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '80');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    );
    await sleep(100);
    await readDom(
      win,
      `document.querySelector('[data-testid="chem-bond-length"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`
    );
    await sleep(200);
    const enterCommit = await readDom(
      win,
      `(() => {
        const input = document.querySelector('[data-testid="chem-bond-length"]');
        return { value: input?.value ?? null, focused: document.activeElement === input };
      })()`
    );
    await readDom(win, `document.querySelector('[data-testid="chem-bond-defaults"]')?.click()`);
    await sleep(180);

    await readDom(win, `document.querySelector('[data-testid="chem-bond-uniform"]')?.click()`);
    await sleep(140);
    const uniformOn = await readDom(
      win,
      `document.querySelector('[data-testid="chem-bond-uniform"]')?.getAttribute('aria-pressed') === 'true'`
    );
    await readDom(win, setInputValue('[data-testid="chem-bond-length"]', 80));
    await readDom(win, commitInput('[data-testid="chem-bond-length"]'));
    await sleep(200);
    const uniformScaled = await readDom(
      win,
      `(() => ({
        length: document.querySelector('[data-testid="chem-bond-length"]')?.value ?? null,
        width: document.querySelector('[data-testid="chem-bond-width"]')?.value ?? null,
        spacing: document.querySelector('[data-testid="chem-bond-spacing"]')?.value ?? null,
        atomSize: document.querySelector('[data-testid="chem-atom-size"]')?.value ?? null
      }))()`
    );
    await readDom(win, `document.querySelector('[data-testid="chem-bond-uniform"]')?.click()`);
    await readDom(win, `document.querySelector('[data-testid="chem-bond-defaults"]')?.click()`);
    await sleep(180);
    await readDom(win, `document.querySelector('[data-chem-category="bond"]')?.click()`);
    await sleep(160);
    await readDom(win, `document.querySelector('[data-testid="bond-fixed"]')?.click()`);
    await sleep(160);
    const fixedOn = await readDom(
      win,
      `document.querySelector('[data-testid="bond-fixed"]')?.getAttribute('aria-pressed') === 'true'`
    );
    await readDom(win, dragExpression(0.62, 0.08, 0.76, 0.08));
    await sleep(340);
    const fixedBond = await readDom(win, readLastBond);
    await readDom(win, `document.querySelector('[data-testid="bond-fixed"]')?.click()`);
    await sleep(120);

    await readDom(win, `document.querySelector('[data-testid="settings-button"]')?.click()`);
    await sleep(240);
    await readDom(
      win,
      `document.querySelector('[data-testid="settings-tab-chemistry"]')?.click()`
    );
    await sleep(200);
    const settingsText = await readDom(
      win,
      `document.querySelector('[data-testid="settings-panel-chemistry"]')?.textContent || ''`
    );
    const ranges = await readDom(
      win,
      `(() => ({
        lengthMax: document.querySelector('[data-testid="settings-bond-length"]')?.max ?? null,
        widthMax: document.querySelector('[data-testid="settings-bond-width"]')?.max ?? null,
        spacingMax: document.querySelector('[data-testid="settings-bond-spacing"]')?.max ?? null,
        atomMax: document.querySelector('[data-testid="settings-atom-size"]')?.max ?? null,
        reset: Boolean(document.querySelector('[data-testid="settings-bond-defaults"]'))
      }))()`
    );
    await readDom(win, `document.querySelector('.modal [aria-label="关闭"]')?.click()`);
    await sleep(200);

    // 元素大小：工具栏参数应实际作用到新放置的原子标签字号。
    await readDom(win, setInputValue('[data-testid="chem-atom-size"]', 30));
    await readDom(win, commitInput('[data-testid="chem-atom-size"]'));
    await sleep(160);
    await readDom(win, `document.querySelector('[data-chem-category="element"]')?.click()`);
    await sleep(180);
    await readDom(win, clickExpression(0.88, 0.12));
    await sleep(320);
    const atomFont = await readDom(
      win,
      `(() => {
        const objects = [...document.querySelectorAll('.scene-layer [data-object-id]')];
        const last = objects[objects.length - 1];
        const text = last?.querySelector('text');
        return text ? Number(text.getAttribute('font-size')) : null;
      })()`
    );

    await readDom(
      win,
      `[...document.querySelectorAll('.menubar__trigger')].find((el) => el.textContent === '化学').click()`
    );
    await sleep(180);
    await readDom(
      win,
      `(() => {
        const item = [...document.querySelectorAll('.menu-dropdown .menu-item')].find((el) =>
          (el.textContent || '').includes('结构自动整理')
        );
        if (item) item.click();
        return Boolean(item);
      })()`
    );
    await sleep(320);
    const cleanupToast = await readDom(
      win,
      `[...document.querySelectorAll('[data-testid="toast"]')].map((el) => el.textContent || '').join('|')`
    );

    chemExtras = {
      ok:
        defaults.length === '40' &&
        defaults.width === '2.2' &&
        defaults.spacing === '4.2' &&
        defaults.atomSize === '16' &&
        defaults.oldOptions === 0 &&
        defaults.fixed &&
        focusState?.focused &&
        clearedState &&
        enterCommit.value === '80' &&
        enterCommit.focused === false &&
        uniformOn &&
        uniformScaled.length === '80' &&
        uniformScaled.width === '4.4' &&
        uniformScaled.spacing === '8.4' &&
        uniformScaled.atomSize === '32' &&
        fixedOn &&
        fixedBond &&
        Math.abs(fixedBond.length - 40) < 1 &&
        Math.abs(fixedBond.width - 2.2) < 0.2 &&
        fixedBond.gap !== null &&
        Math.abs(fixedBond.gap - 4.2) < 0.5 &&
        settingsText.includes('化学键键长') &&
        settingsText.includes('化学键键宽') &&
        settingsText.includes('化学键键距') &&
        settingsText.includes('元素大小') &&
        ranges.lengthMax === '400' &&
        ranges.widthMax === '40' &&
        ranges.spacingMax === '100' &&
        ranges.atomMax === '120' &&
        ranges.reset &&
        atomFont === 30 &&
        (cleanupToast.includes('已整理') || cleanupToast.includes('已检查')),
      defaults,
      focusState,
      clearedState,
      enterCommit,
      uniformOn,
      uniformScaled,
      ranges,
      fixedOn,
      fixedBond,
      atomFont,
      cleanupToast
    };
  } catch (error) {
    chemExtras = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  console.log('CHEM_EXTRAS ' + JSON.stringify(chemExtras));

  // ---- 图层栏收起、对象筛选范围、背景行与悬停提示 ----
  let layersPanel = { ok: false };
  try {
    await readDom(win, `document.querySelector('[data-testid="sidebar-tab-layers"]')?.click()`);
    await sleep(260);
    const base = await readDom(
      win,
      `(() => {
        const bg = document.querySelector('[data-testid="background-layer"]');
        const eye = document.querySelector('[data-testid="background-eye"]');
        const rowRect = bg?.getBoundingClientRect();
        const eyeRect = eye?.getBoundingClientRect();
        return {
          collapse: Boolean(document.querySelector('[data-testid="right-sidebar-collapse"]')),
          currentScope: Boolean(document.querySelector('[data-testid="object-scope-current"]')),
          allScope: Boolean(document.querySelector('[data-testid="object-scope-all"]')),
          currentRows: document.querySelectorAll('[data-testid="recent-row"]').length,
          objectRows: document.querySelectorAll('[data-object-row]').length,
          backgroundText: bg?.textContent || '',
          backgroundTitle: bg?.getAttribute('title') || '',
          eyeInTools: Boolean(eye?.closest('.layer-tools')),
          eyeOnRight: Boolean(
            rowRect && eyeRect && eyeRect.left > rowRect.left + rowRect.width / 2
          ),
          bgTop: Math.round(rowRect?.top ?? -1),
          layerChevrons: document.querySelectorAll(
            '[data-testid^="layer-toggle-"], .layer-row__chevron'
          ).length,
          canvasWidth: Math.round(
            document.querySelector('[data-testid="canvas-hit"]')?.getBoundingClientRect().width || 0
          ),
          tutorialHint: Boolean(document.querySelector('.layer-drag-hint, .props-hint')),
          eraserTip: document.querySelector('[data-chem-category="eraser"]')?.getAttribute('title') || ''
        };
      })()`
    );
    await readDom(win, `document.querySelector('[data-testid="object-scope-all"]')?.click()`);
    await sleep(220);
    const allState = await readDom(
      win,
      `(() => ({
        active: document.querySelector('[data-testid="object-scope-all"]')?.getAttribute('aria-pressed') === 'true',
        rows: document.querySelectorAll('[data-object-row]').length,
        layerTags: document.querySelectorAll('.object-row__layer').length,
        title: document.querySelector('.object-list')?.getAttribute('title') || ''
      }))()`
    );
    await readDom(win, `document.querySelector('[data-testid="object-scope-current"]')?.click()`);
    await sleep(180);
    const backState = await readDom(
      win,
      `document.querySelector('[data-testid="object-scope-current"]')?.getAttribute('aria-pressed') === 'true'`
    );

    const panelHeights = await readDom(
      win,
      `(() => {
        const layer = document.querySelector('[data-testid="layer-section"]');
        const objects = document.querySelector('[data-testid="objects-section"]');
        const bg = document.querySelector('[data-testid="background-layer"]');
        return {
          layer: layer?.getBoundingClientRect().height ?? 0,
          objects: objects?.getBoundingClientRect().height ?? 0,
          bgTop: Math.round(bg?.getBoundingClientRect().top ?? -1),
          canvasWidth: Math.round(
            document.querySelector('[data-testid="canvas-hit"]')?.getBoundingClientRect().width || 0
          )
        };
      })()`
    );
    await readDom(win, `document.querySelector('[data-testid="layers-section-collapse"]')?.click()`);
    await sleep(180);
    const layersCollapsedState = await readDom(
      win,
      `(() => {
        const layer = document.querySelector('[data-testid="layer-section"]');
        const objects = document.querySelector('[data-testid="objects-section"]');
        return {
          hidden: !layer || layer.getBoundingClientRect().height < 1,
          objects: objects?.getBoundingClientRect().height ?? 0
        };
      })()`
    );
    await readDom(win, `document.querySelector('[data-testid="layers-section-collapse"]')?.click()`);
    await sleep(180);
    await readDom(win, `document.querySelector('[data-testid="objects-collapse"]')?.click()`);
    await sleep(180);
    const objectsCollapsedState = await readDom(
      win,
      `(() => {
        const body = document.querySelector('.objects-section__body');
        const layer = document.querySelector('[data-testid="layer-section"]');
        const bg = document.querySelector('[data-testid="background-layer"]');
        return {
          bodyHidden: !body || body.getBoundingClientRect().height < 1,
          layer: layer?.getBoundingClientRect().height ?? 0,
          bgTop: Math.round(bg?.getBoundingClientRect().top ?? -1),
          canvasWidth: Math.round(
            document.querySelector('[data-testid="canvas-hit"]')?.getBoundingClientRect().width || 0
          )
        };
      })()`
    );
    await readDom(win, `document.querySelector('[data-testid="objects-collapse"]')?.click()`);
    await sleep(180);
    const sectionsRestored = await readDom(
      win,
      `(() => {
        const bg = document.querySelector('[data-testid="background-layer"]');
        return {
          layer: Boolean(document.querySelector('[data-testid="layer-section"]')?.getBoundingClientRect().height),
          body: Boolean(document.querySelector('.objects-section__body')?.getBoundingClientRect().height),
          bgTop: Math.round(bg?.getBoundingClientRect().top ?? -1)
        };
      })()`
    );

    // 整体收起：面板收成窄轨，内容全部隐藏但保留展开入口，画布回收宽度。
    const beforeWhole = await readDom(
      win,
      `(() => ({
        canvasWidth: Math.round(document.querySelector('[data-testid="canvas-hit"]')?.getBoundingClientRect().width || 0),
        sidebarWidth: Math.round(document.querySelector('.right-sidebar')?.getBoundingClientRect().width || 0)
      }))()`
    );
    await readDom(win, `document.querySelector('[data-testid="right-sidebar-collapse"]')?.click()`);
    await sleep(260);
    const collapsed = await readDom(
      win,
      `(() => {
        const rail = document.querySelector('.right-sidebar--rail');
        return {
          rail: Boolean(rail),
          width: Math.round(rail?.getBoundingClientRect().width || 0),
          expand: Boolean(document.querySelector('[data-testid="right-sidebar-expand"]')),
          contentHidden: (() => {
            const main = document.querySelector('.right-sidebar__main');
            return !main || getComputedStyle(main).display === 'none' ||
              main.getBoundingClientRect().width < 1;
          })(),
          canvasWidth: Math.round(document.querySelector('[data-testid="canvas-hit"]')?.getBoundingClientRect().width || 0)
        };
      })()`
    );
    await readDom(win, `document.querySelector('[data-testid="right-sidebar-expand"]')?.click()`);
    await sleep(260);
    const restored = await readDom(
      win,
      `(() => {
        const bg = document.querySelector('[data-testid="background-layer"]');
        return {
          sidebar: Boolean(document.querySelector('.right-sidebar:not(.right-sidebar--rail)')),
          tabs: Boolean(document.querySelector('.panel-tabs')),
          layers: Boolean(document.querySelector('.layers-panel')),
          bgTop: Math.round(bg?.getBoundingClientRect().top ?? -1),
          canvasWidth: Math.round(document.querySelector('[data-testid="canvas-hit"]')?.getBoundingClientRect().width || 0)
        };
      })()`
    );

    // 属性区局部收起：表头保留、字段隐藏，展开后完整恢复。
    await readDom(win, `document.querySelector('[data-testid="sidebar-tab-properties"]')?.click()`);
    await sleep(240);
    const propsCollapse = await readDom(
      win,
      `(() => ({
        button: Boolean(document.querySelector('[data-testid="properties-section-collapse"]')),
        body: Boolean(document.querySelector('.props-inline__body'))
      }))()`
    );
    await readDom(win, `document.querySelector('[data-testid="properties-section-collapse"]')?.click()`);
    await sleep(180);
    const propsCollapsed = await readDom(
      win,
      `(() => ({
        bodyHidden: !document.querySelector('.props-inline__body'),
        header: Boolean(document.querySelector('.props-inline__head')),
        button: Boolean(document.querySelector('[data-testid="properties-section-collapse"]')),
        expanded: document.querySelector('[data-testid="properties-section-collapse"]')?.getAttribute('aria-expanded') === 'false'
      }))()`
    );
    await readDom(win, `document.querySelector('[data-testid="properties-section-collapse"]')?.click()`);
    await sleep(180);
    const propsRestored = await readDom(win, `Boolean(document.querySelector('.props-inline__body'))`);
    await readDom(win, `document.querySelector('[data-testid="sidebar-tab-layers"]')?.click()`);
    await sleep(200);

    // 调色板整体收起：与取色浮层的局部收起分开，全部内容隐藏后仍可展开恢复。
    const paletteBase = await readDom(
      win,
      `(() => ({
        panel: Boolean(document.querySelector('[data-testid="color-panel"]')),
        collapse: Boolean(document.querySelector('[data-testid="color-panel-collapse"]')),
        rows: document.querySelectorAll('.palette-row').length
      }))()`
    );
    await readDom(win, `document.querySelector('[data-testid="color-panel-collapse"]')?.click()`);
    await sleep(200);
    const paletteCollapsed = await readDom(
      win,
      `(() => ({
        expanded: document.querySelector('[data-testid="color-panel"]')?.getAttribute('data-collapsed') === 'true',
        rowsHidden: document.querySelectorAll('.palette-row').length === 0,
        popoverHidden: !document.querySelector('[data-testid="color-popover"]'),
        expand: Boolean(document.querySelector('[data-testid="color-panel-expand"]'))
      }))()`
    );
    await readDom(win, `document.querySelector('[data-testid="color-panel-expand"]')?.click()`);
    await sleep(200);
    const paletteRestored = await readDom(
      win,
      `(() => ({
        rows: document.querySelectorAll('.palette-row').length,
        collapse: Boolean(document.querySelector('[data-testid="color-panel-collapse"]'))
      }))()`
    );

    layersPanel = {
      ok:
        base.collapse &&
        base.currentScope &&
        base.allScope &&
        base.backgroundText.includes('背景') &&
        !base.backgroundText.includes('#') &&
        base.backgroundTitle.startsWith('背景图层') &&
        base.eyeInTools &&
        base.eyeOnRight &&
        !base.tutorialHint &&
        base.eraserTip.startsWith('化学橡皮') &&
        base.layerChevrons === 0 &&
        allState.active &&
        allState.rows >= base.objectRows &&
        allState.layerTags > 0 &&
        allState.title.startsWith('对象列表') &&
        backState &&
        layersCollapsedState.hidden &&
        layersCollapsedState.objects > panelHeights.objects &&
        objectsCollapsedState.bodyHidden &&
        Math.abs(objectsCollapsedState.layer - panelHeights.layer) <= 1 &&
        objectsCollapsedState.bgTop === panelHeights.bgTop &&
        objectsCollapsedState.canvasWidth === panelHeights.canvasWidth &&
        sectionsRestored.layer &&
        sectionsRestored.body &&
        sectionsRestored.bgTop === base.bgTop &&
        collapsed.rail &&
        collapsed.expand &&
        collapsed.contentHidden &&
        collapsed.width <= 60 &&
        collapsed.canvasWidth > beforeWhole.canvasWidth + 40 &&
        restored.sidebar &&
        restored.tabs &&
        restored.layers &&
        restored.bgTop === base.bgTop &&
        Math.abs(restored.canvasWidth - beforeWhole.canvasWidth) <= 2 &&
        propsCollapse.button &&
        propsCollapse.body &&
        propsCollapsed.bodyHidden &&
        propsCollapsed.header &&
        propsCollapsed.button &&
        propsCollapsed.expanded &&
        propsRestored &&
        paletteBase.panel &&
        paletteBase.collapse &&
        paletteBase.rows >= 2 &&
        paletteCollapsed.expanded &&
        paletteCollapsed.rowsHidden &&
        paletteCollapsed.popoverHidden &&
        paletteCollapsed.expand &&
        paletteRestored.rows >= 2 &&
        paletteRestored.collapse,
      base,
      allState,
      backState,
      panelHeights,
      layersCollapsedState,
      objectsCollapsedState,
      sectionsRestored,
      beforeWhole,
      collapsed,
      restored,
      propsCollapse,
      propsCollapsed,
      propsRestored,
      paletteBase,
      paletteCollapsed,
      paletteRestored
    };
  } catch (error) {
    layersPanel = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  console.log('LAYERS_PANEL ' + JSON.stringify(layersPanel));

  // ---- 文档重命名与关闭确认：双击标题、右键最近文件、统一 Modal ----
  let uiPolish = { ok: false };
  try {
    await readDom(
      win,
      `document.querySelector('[data-testid="doc-title"]')?.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )`
    );
    await sleep(180);
    const titleEditOpen = await readDom(
      win,
      `Boolean(document.querySelector('[data-testid="doc-title-input"]'))`
    );
    await readDom(
      win,
      `(() => {
        const input = document.querySelector('[data-testid="doc-title-input"]');
        if (!input) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '冒烟画布-UI');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    );
    await sleep(100);
    await readDom(
      win,
      `document.querySelector('[data-testid="doc-title-input"]')?.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true })
      )`
    );
    await sleep(220);
    const renamed = await readDom(
      win,
      `({
        title: document.querySelector('[data-testid="doc-title"]')?.textContent || null,
        editing: Boolean(document.querySelector('[data-testid="doc-title-input"]'))
      })`
    );

    await readDom(win, `document.querySelector('.window-btn--close')?.click()`);
    await sleep(220);
    const leaveDialog = await readDom(
      win,
      `(() => {
        const pick = (id) => document.querySelector('[data-testid="leave-document-confirm-' + id + '"]');
        return {
          open: Boolean(document.querySelector('[data-testid="leave-document-confirm"]')),
          modal: Boolean(document.querySelector('.confirm-dialog__icon')),
          title: document.querySelector('.modal__head h3, .modal h3')?.textContent || '',
          cancel: pick('cancel')?.textContent?.trim() || '',
          extra: pick('extra')?.textContent?.trim() || '',
          confirm: pick('confirm')?.textContent?.trim() || '',
          extraDanger: Boolean(pick('extra')?.classList.contains('btn--danger')),
          confirmSuccess: Boolean(pick('confirm')?.classList.contains('btn--success'))
        };
      })()`
    );
    await readDom(
      win,
      `document.querySelector('[data-testid="leave-document-confirm-cancel"]')?.click()`
    );
    await sleep(180);
    const leaveCanceled = await readDom(
      win,
      `!document.querySelector('[data-testid="leave-document-confirm"]')`
    );

    uiPolish = {
      ok:
        titleEditOpen &&
        renamed.title === '冒烟画布-UI' &&
        !renamed.editing &&
        leaveDialog.open &&
        leaveDialog.modal &&
        leaveDialog.cancel === '取消' &&
        leaveDialog.extra === '退出' &&
        leaveDialog.confirm === '保存并退出' &&
        leaveDialog.extraDanger &&
        leaveDialog.confirmSuccess &&
        leaveCanceled,
      titleEditOpen,
      renamed,
      leaveDialog,
      leaveCanceled
    };
  } catch (error) {
    uiPolish = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  console.log('UI_POLISH ' + JSON.stringify(uiPolish));

  // ---- 最近文件：双击重命名、右键菜单、与画布标题双向同步 ----
  let recentSync = { ok: false };
  try {
    await readDom(win, `document.querySelector('.window-btn--close')?.click()`);
    await sleep(220);
    const exitWithDialog = await readDom(
      win,
      `Boolean(document.querySelector('[data-testid="leave-document-confirm-extra"]'))`
    );
    if (exitWithDialog) {
      await readDom(
        win,
        `document.querySelector('[data-testid="leave-document-confirm-extra"]')?.click()`
      );
    }
    await sleep(520);
    const recentCount = await readDom(
      win,
      `document.querySelectorAll('[data-testid="recent-row"]').length`
    );
    if (recentCount > 0) {
      await readDom(
        win,
        `(() => {
          const row = document.querySelector('[data-testid="recent-row"]')?.closest('.recent-item');
          row?.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 220,
            clientY: 220
          }));
          return Boolean(row);
        })()`
      );
      await sleep(180);
      const menuState = await readDom(
        win,
        `(() => {
          const menu = document.querySelector('[data-testid="recent-context-menu"]');
          return {
            open: Boolean(menu),
            text: menu?.textContent || '',
            rename: Boolean(document.querySelector('[data-testid="recent-menu-rename"]')),
            copy: Boolean(document.querySelector('[data-testid="recent-menu-copy"]')),
            remove: Boolean(document.querySelector('[data-testid="recent-menu-delete"]'))
          };
        })()`
      );
      await readDom(win, `document.querySelector('[data-testid="recent-menu-copy"]')?.click()`);
      await sleep(220);
      const copyToast = await readDom(
        win,
        `[...document.querySelectorAll('[data-testid="toast"]')].map((el) => el.textContent || '').join('|')`
      );

      await readDom(
        win,
        `(() => {
          const name = document.querySelector('[data-testid="recent-row"] .recent-item__body strong');
          name?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          return Boolean(name);
        })()`
      );
      await sleep(200);
      const renameInputOpened = await readDom(
        win,
        `Boolean(document.querySelector('[data-testid="recent-rename-input"]'))`
      );
      await readDom(
        win,
        `(() => {
          const input = document.querySelector('[data-testid="recent-rename-input"]');
          if (!input) return false;
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, '冒烟最近-同步');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
          return true;
        })()`
      );
      await sleep(260);
      const recentRenamed = await readDom(
        win,
        `document.querySelector('[data-testid="recent-row"] .recent-item__body strong')?.textContent || null`
      );

      // 右键菜单保留完整三项，关闭后再打开文件。
      await readDom(
        win,
        `(() => {
          const row = document.querySelector('[data-testid="recent-row"]')?.closest('.recent-item');
          row?.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 220,
            clientY: 220
          }));
          return Boolean(row);
        })()`
      );
      await sleep(160);
      const menuAgain = await readDom(
        win,
        `(() => {
          const menu = document.querySelector('[data-testid="recent-context-menu"]');
          return {
            open: Boolean(menu),
            text: menu?.textContent || ''
          };
        })()`
      );
      await readDom(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(160);

      await readDom(win, `document.querySelector('[data-testid="recent-row"]')?.click()`);
      await sleep(900);
      const openedTitle = await readDom(
        win,
        `document.querySelector('[data-testid="doc-title"]')?.textContent || null`
      );

      await readDom(
        win,
        `document.querySelector('[data-testid="doc-title"]')?.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true })
        )`
      );
      await sleep(180);
      await readDom(
        win,
        `(() => {
          const input = document.querySelector('[data-testid="doc-title-input"]');
          if (!input) return false;
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, '冒烟画布-同步');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
          return true;
        })()`
      );
      await sleep(260);
      const canvasRenamed = await readDom(
        win,
        `document.querySelector('[data-testid="doc-title"]')?.textContent || null`
      );

      await readDom(win, `document.querySelector('.window-btn--close')?.click()`);
      await sleep(220);
      const exitAgain = await readDom(
        win,
        `Boolean(document.querySelector('[data-testid="leave-document-confirm-extra"]'))`
      );
      if (exitAgain) {
        await readDom(
          win,
          `document.querySelector('[data-testid="leave-document-confirm-extra"]')?.click()`
        );
      }
      await sleep(520);
      const syncedRecentName = await readDom(
        win,
        `document.querySelector('[data-testid="recent-row"] .recent-item__body strong')?.textContent || null`
      );

      recentSync = {
        ok:
          menuState.open &&
          menuState.rename &&
          menuState.copy &&
          menuState.remove &&
          menuState.text.includes('重命名') &&
          menuState.text.includes('复制') &&
          menuState.text.includes('删除') &&
          copyToast.includes('已复制') &&
          renameInputOpened &&
          recentRenamed === '冒烟最近-同步' &&
          menuAgain.open &&
          menuAgain.text.includes('重命名') &&
          openedTitle === '冒烟最近-同步' &&
          canvasRenamed === '冒烟画布-同步' &&
          syncedRecentName === '冒烟画布-同步',
        recentCount,
        menuState,
        copyToast,
        renameInputOpened,
        recentRenamed,
        menuAgain,
        openedTitle,
        canvasRenamed,
        syncedRecentName
      };
    } else {
      recentSync = { ok: false, error: '最近文件为空，无法验证重命名同步' };
    }
  } catch (error) {
    recentSync = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  console.log('RECENT_SYNC ' + JSON.stringify(recentSync));

  console.log('SMOKE_CONSOLE_MESSAGES ' + JSON.stringify(smokeErrors));

  const failed =
    alphaClip.defs <= 0 ||
    alphaClip.refs <= 0 ||
    !clipUi.found ||
    !clipUi.active ||
    !customBrush.found ||
    !customBrush.hadApply ||
    !customBrush.removed ||
    !liveInk.canvas ||
    !liveInk.inked ||
    !liveInk.cleared ||
    !p6Split.ok ||
    p6Split.added < 3 ||
    Number(p6Split.opacityAttr) >= 0.6 ||
    startInfo.route !== 'start' ||
    !startInfo.launcherBar ||
    !startInfo.newCard ||
    !startInfo.openCard ||
    !startInfo.squareCards ||
    startInfo.deleteButtons !== startInfo.recentRows ||
    startInfo.launcherButtons !== 3 ||
    !startCloseDialog.open ||
    !startCloseDialog.modal ||
    !startCloseDialog.styled ||
    !startCloseCanceled ||
    (startInfo.recentRows > 0 && !startInfo.recentHasDesc) ||
    (startInfo.recentRows > 0 && recentAfterDelete !== startInfo.recentRows - 1) ||
    editorInfo.route !== 'editor' ||
    editorInfo.docTitle !== '冒烟画布' ||
    editorInfo.toolButtons !== 15 ||
    !canvasConfig.open ||
    !canvasConfig.fields ||
    canvasConfig.templates < 4 ||
    !canvasConfig.infiniteOption ||
    !infiniteState.disabled ||
    infiniteState.value !== '4000' ||
    !widthClearable ||
    widthAfterClear !== '' ||
    !editorInfo.railVertical ||
    !editorInfo.railBeforeDock ||
    !editorInfo.leftDock ||
    !editorInfo.paletteButton ||
    !editorInfo.widthSlider ||
    !editorInfo.opacitySlider ||
    !editorInfo.menusInTitlebar ||
    !editorInfo.toolPanelInitiallyClosed ||
    !editorInfo.rightSidebar ||
    editorInfo.rightHasProperties ||
    editorInfo.scrollOverflowX > 1 ||
    editorInfo.scrollOverflowY > 1 ||
    !colorPanelOpened.open ||
    !paletteToggleClosed ||
    colorPanelOpened.indicator ||
    !colorModes.fillNone ||
    !colorModes.strokeNone ||
    colorPanelOpened.indicatorBetween ||
    !colorPanelOpened.titleCentered ||
    !colorPanelOpened.popoverGone ||
    afterRect !== 1 ||
    !shapeGroupState.dock ||
    shapeGroupState.toolActive ||
    shapeGroupState.activeOptions > 0 ||
    rectSelection.tool !== '矩形' ||
    !rectSelection.panelPersist ||
    rectSelection.handles < 8 ||
    !rectBeforeMove ||
    !shapeTransformed ||
    shapeTransformed.handles < 8 ||
    shapeTransformed.tool !== '矩形' ||
    Math.abs((shapeTransformed.y ?? 0) - (rectBeforeMove.y ?? 0)) < 5 ||
    shapeDeselected.handles !== 0 ||
    rectSelection.fill !== 'none' ||
    afterSquare !== 2 ||
    squareInfo.fill !== 'none' ||
    squareInfo.delta === null ||
    squareInfo.delta > 1 ||
    !squareInfo.panelPersist ||
    squareInfo.handles < 1 ||
    afterEllipse !== 3 ||
    afterCircle !== 4 ||
    circleInfo.fill !== 'none' ||
    circleInfo.delta === null ||
    circleInfo.delta > 1 ||
    circleInfo.handles < 1 ||
    circleInfo.allFills.some((fill) => fill !== 'none') ||
    !contextInfo.visible ||
    !contextInfo.hasProperties ||
    propertiesInfo.modal ||
    !propertiesInfo.panel ||
    !propertiesInfo.inSidebar ||
    !propertiesInfo.title ||
    propertiesInfo.title === '对象属性' ||
    propertiesInfo.headHeight > 30 ||
    propertiesInfo.appearanceControls !== 0 ||
    propertiesInfo.alignSections !== 1 ||
    propertiesInfo.visibleTransformFields !== 5 ||
    !propertiesInfo.leftPanelVisible ||
    !modalClosed ||
    fillApplied === 'none' ||
    !fillApplied ||
    !colorModes.panel ||
    colorModes.modes !== 3 ||
    !colorModes.palette ||
    paletteGrid < 40 ||
    !sliderMode.hex ||
    sliderMode.sliders < 7 ||
    paletteApplied.fill !== '#000000' ||
    paletteApplied.swatches < 40 ||
    !widthDrag.dragged ||
    strokeWidth !== '6' ||
    !resizeInfo.resized ||
    !resizeInfo.guideLines ||
    resizeInfo.guideLines.length < 1 ||
    resizeInfo.guideLines.some(
      (line) =>
        Math.min(line.x1, line.x2) < -0.5 ||
        Math.min(line.y1, line.y2) < -0.5 ||
        Math.max(line.x1, line.x2) > resizeInfo.pageW + 0.5 ||
        Math.max(line.y1, line.y2) > resizeInfo.pageH + 0.5
    ) ||
    !resizeResult ||
    resizeResult.width <= resizeInfo.beforeWidth + 10 ||
    !rotateInfo.rotated ||
    rotateInfo.guideLines.length < 1 ||
    rotateInfo.guideLines.some(
      (line) =>
        Math.min(line.x1, line.x2) < -0.5 ||
        Math.min(line.y1, line.y2) < -0.5 ||
        Math.max(line.x1, line.x2) > rotateInfo.pageW + 0.5 ||
        Math.max(line.y1, line.y2) > rotateInfo.pageH + 0.5
    ) ||
    !rotateResult.transform ||
    !rotateResult.transform.includes('rotate(') ||
    !rotateFree.free ||
    rotateFree.guideLines !== 0 ||
    !rotateResult.overlayTransform ||
    !rotateResult.overlayTransform.includes('rotate(') ||
    !chemInfo.chemDock ||
    !chemInfo.chemBar ||
    !chemInfo.chemEdit ||
    !chemInfo.chemExit ||
    chemInfo.chemIconPaths < 3 ||
    chemInfo.chemIconCircles < 2 ||
    chemInfo.bondButtons < 8 ||
    chemInfo.atomChips < 8 ||
    chemInfo.atomGroups < 8 ||
    !chemInfo.hasOHChip ||
    chemInfo.categories !== 6 ||
    chemInfo.panels < 1 ||
    chemInfo.ringCards < 5 ||
    chemInfo.ringIcons !== chemInfo.ringCards ||
    !chemInfo.ringBenzeneCircle ||
    chemInfo.ringCyclohexaneLines < 6 ||
    !chemInfo.ringIconLabels.includes('苯环') ||
    !chemInfo.ringIconLabels.includes('环己烷') ||
    chemInfo.benzeneModes !== 2 ||
    !chemInfo.benzeneInsert ||
    afterPauling !== 11 ||
    paulingCircle !== 1 ||
    paulingInfo.lines !== 6 ||
    afterKekule !== 18 ||
    kekuleCircle !== 1 ||
    kekuleInfo.lines !== 15 ||
    kekuleInfo.shortInnerLines < 3 ||
    afterUndo !== 11 ||
    afterRedo !== 18 ||
    selectionInfo.handles < 6 ||
    selectionInfo.activeTool !== '选择' ||
    afterBond !== 19 ||
    afterBondClick !== 20 ||
    bondClickLength === null ||
    Math.abs(bondClickLength - 40) > 1.5 ||
    afterBondClickUndo !== 19 ||
    // 取消只放弃本次操作，不再强制切回选择工具
    cancelInfo.tool !== '矩形' ||
    cancelInfo.objects !== 20 ||
    !(cancelInfo.toast || '').includes('取消') ||
    afterAtom !== 20 ||
    !textEdited.opened ||
    !textEdited.inputUnchanged ||
    textEdited.size !== '30' ||
    textEdited.fill !== '#FF5500' ||
    !textPanel.bar ||
    !textPanel.composer ||
    textPanel.panels !== 2 ||
    !textPanel.input ||
    textPanel.dock ||
    !textPanel.font ||
    !textPanel.size ||
    !textPanel.spacing ||
    textPanel.directions !== 2 ||
    textPanel.aligns !== 3 ||
    !textPanel.color ||
    !textDraft.visible ||
    textDraft.text !== '苯环与圆形' ||
    !textPanelClosed ||
    textHandles < 4 ||
    !textRender ||
    textRender.fontSize !== '30' ||
    !(textRender.fontFamily || '').includes('Cambria') ||
    textRender.fill !== '#FF5500' ||
    textRender.tspans !== 5 ||
    afterText !== 21 ||
    !textPresent ||
    afterPen !== 22 ||
    penPathCount < 1 ||
    !nodePick.picked ||
    !nodeDrag.dragged ||
    !nodeEdited ||
    !nodeEdit.inserted ||
    !nodeEdit.toggled ||
    !nodeEdit.deleted ||
    !nodeEdit.objectKept ||
    nodeMulti.afterFirst !== 1 ||
    nodeMulti.selected !== 2 ||
    afterGroup !== 23 ||
    afterUngroup !== 22 ||
    !savedExists ||
    !savedHasSchema ||
    !savedPauling ||
    !savedKekule ||
    saveInfo.chip !== '已保存' ||
    !saveInfo.saveButton ||
    !saveInfo.noBackButton ||
    afterDirtyRect !== 23 ||
    afterOpen !== 22 ||
    !importDialogOpen ||
    !importChoose ||
    !importValidation.summary ||
    Boolean(importValidation.error) ||
    (importValidation.formats !== 5 && importValidation.formats !== 0) ||
    !importDialogClosed ||
    afterImport !== 26 ||
    !transparentOn ||
    pngCornerAlpha !== 0 ||
    svgHasBackground ||
    !pdfBuffer ||
    pdfBuffer.subarray(0, 5).toString() !== '%PDF-' ||
    pdfHasJpeg !== false ||
    pdfHasFont !== true ||
    !exportPanelOpen ||
    !exportPanelClosed ||
    !regionFields.overlay ||
    regionFields.x !== '100' ||
    regionFields.y !== '80' ||
    regionFields.w !== '400' ||
    regionFields.h !== '300' ||
    !regionFields.output.includes('800 × 600') ||
    !regionPngSize ||
    regionPngSize.width !== 800 ||
    regionPngSize.height !== 600 ||
    !selectionScope.preview ||
    !selectionScope.previewFit ||
    !selectionScope.previewFit.inside ||
    selectionScope.previewFit.objectFit !== 'contain' ||
    selectionScope.previewFit.imgH > selectionScope.previewFit.boxH ||
    selectionScope.previewFit.imgW > selectionScope.previewFit.boxW ||
    !previewContent ||
    previewContent.empty ||
    // 四边都不能贴边：贴边即说明内容被裁切
    previewContent.left < 1 ||
    previewContent.top < 1 ||
    previewContent.right < 1 ||
    previewContent.bottom < 1 ||
    // 居中容差：包围盒与真实墨迹对不同对象类型本就有偏差（文本/曲线）
    Math.abs(previewContent.left - previewContent.right) > 10 ||
    Math.abs(previewContent.top - previewContent.bottom) > 10 ||
    selectionScope.fieldsShown ||
    selectionScope.overlayShown ||
    selectionScope.width <= 0 ||
    selectionScope.height <= 0 ||
    !selectionScope.hint.includes('选中') ||
    !selectionPngClosed ||
    !selectionPngSize ||
    selectionPngSize.width !== selectionScope.width ||
    selectionPngSize.height !== selectionScope.height ||
    jpgMagic !== 'ffd8ff' ||
    !jpgSize ||
    jpgSize.width !== 2246 ||
    jpgSize.height !== 1588 ||
    !layerInfoBefore.background ||
    !layerInfoBefore.chemTabGone ||
    layerInfoBefore.rows !== 1 ||
    !backgroundChange.changed ||
    pageFillAfter !== '#112233' ||
    layersAfterAdd !== 2 ||
    layersAfterDuplicate !== 3 ||
    duplicateName !== '图层 3' ||
    layersAfterMerge !== 2 ||
    layersAfterDelete !== 1 ||
    folderCreated !== 1 ||
    !dragLayer.moved ||
    !nestedLayer.nested ||
    nestedLayer.nestedIndent !== '20px' ||
    toolState.selectActive !== 'true' ||
    toolState.objectCount !== 26 ||
    !panelLayout.present ||
    !panelAfterDraw ||
    cycleDouble !== cycleBefore + 1 ||
    cycleTriple !== cycleBefore + 2 ||
    cycleSingle !== cycleBefore ||
    !hoverBond.present ||
    hoverBond.lines < 2 ||
    !hoverAtom.present ||
    hoverAtom.circles < 2 ||
    cycleMid.length < 40 ||
    ringFrame.count !== 6 ||
    extension.added !== 1 ||
    extension.objects !== ringObjects + 1 ||
    Math.abs(extension.length - 40) > 0.8 ||
    extension.deltas.length !== 2 ||
    extension.deltas.some((delta) => Math.abs(delta - 120) > 2) ||
    branchLevels.some((value) => value !== branchLevels[0]) ||
    !(branchToast || '').includes('最多容纳 1 重键') ||
    saturated.objects !== extension.objects ||
    !(saturated.toast || '').includes('化合价') ||
    childExtension.objects !== saturated.objects + 1 ||
    childExtension.lines !== saturated.lines + 1 ||
    !childExtension.circle ||
    Math.abs(childExtension.circle.cx - circleBefore.cx) > 0.6 ||
    Math.abs(childExtension.circle.cy - circleBefore.cy) > 0.6 ||
    Math.abs(childExtension.circle.r - circleBefore.r) > 0.6 ||
    !(ringSelected || '').includes('1') ||
    !groupMove.moved ||
    !circleBefore ||
    !circleAfter ||
    Math.abs(circleAfter.cx - circleBefore.cx) > 0.6 ||
    Math.abs(circleAfter.cy - circleBefore.cy) > 0.6 ||
    Math.abs(circleAfter.r - circleBefore.r) > 0.6 ||
    Math.abs(circleBefore.r - 22) > 0.6 ||
    (extensionToast || '').includes('自动改为单键') ||
    cycloFrame.count !== 6 ||
    cycloDouble.lines !== cycloLines + 2 ||
    cycloDouble.objects !== cycloObjects + 1 ||
    (cycloDouble.toast || '').includes('自动改为单键') ||
    cycloBranchLevels.length < 4 ||
    cycloBranchLevels.some((value) => value !== cycloBranchLevels[0]) ||
    !(cycloBranchToast || '').includes('最多容纳 2 重键') ||
    hydrogen.objects !== hydrogenBefore.objects + 2 ||
    hydrogen.lines !== hydrogenBefore.lines + 1 ||
    hydrogen.labels < 1 ||
    hydroxyl.objects !== hydroxylBefore.objects + 2 ||
    hydroxyl.lines !== hydroxylBefore.lines + 1 ||
    hydroxyl.circles !== hydroxylBefore.circles ||
    hydroxyl.labels < 1 ||
    !hydroxyl.circle ||
    Math.abs(hydroxyl.circle.cx - circleBefore.cx) > 0.6 ||
    Math.abs(hydroxyl.circle.cy - circleBefore.cy) > 0.6 ||
    Math.abs(hydroxyl.circle.r - circleBefore.r) > 0.6 ||
    hydroxylBlocked.objects !== hydroxyl.objects ||
    !(hydroxylBlocked.toast || '').includes('无法连接') ||
    afterEraseBond.lines !== eraseBefore.lines - 1 ||
    afterEraseBond.objects !== eraseBefore.objects - 1 ||
    afterEraseAtom.labels !== 0 ||
    afterEraseAtom.lines !== afterEraseBond.lines - 1 ||
    afterEraseAtom.objects !== afterEraseBond.objects - 2 ||

    // P1-01：擦除环上单根键只删除该键并解除芳香环，不再整环删除
    afterEraseRing.circles !== afterEraseRect.circles - 1 ||
    afterEraseRing.lines !== afterEraseRect.lines - 1 ||
    afterEraseRing.objects !== afterEraseRect.objects - 1 ||
    shapePanel.shapes !== 7 ||
    !shapePanel.panel ||
    !shapePanel.bar ||
    !bucketChrome.bar ||
    !bucketChrome.dock ||
    brushPanel.presets !== 4 ||
    brushPanel.glyphs !== 4 ||
    !brushPanel.shapeStillOpen ||
    !brushPanel.shapeSnap ||
    !brushPanel.brushActive ||
    brushInfo.objects !== brushBefore + 1 ||
    brushInfo.width !== '8' ||
    brushInfo.points < 3 ||
    // 压感笔迹：填充轮廓 + 两端圆头 + 至少数段折线
    penStroke.fill === 'none' ||
    penStroke.stroke !== 'none' ||
    penStroke.arcs < 2 ||
    penStroke.segments < 3 ||
    !penStroke.box ||
    penStroke.box.h < 2 ||
    !brushColor ||
    brushInfo.stroke !== brushColor ||
    Math.abs(Number(brushInfo.opacity) - 0.5) > 0.06 ||
    !(marqueeSelect.count || '').includes('1') ||
    !marqueeSelect.overlay ||
    !marqueeSelect.center ||
    !marqueeMoved.center ||
    Math.hypot(
      marqueeMoved.center.x - marqueeSelect.center.x,
      marqueeMoved.center.y - marqueeSelect.center.y
    ) < 10 ||
    selectionDeleted.objects !== objectsBeforeDelete - 1 ||
    selectionDeleted.properties ||
    !layoutCheck.hintAbsent ||
    layoutCheck.sizeLabel !== '大小' ||
    !layoutCheck.centered ||
    !layoutCheck.noOverlap ||
    bucketModes !== 3 ||
    (filledTarget?.fill || '').toLowerCase() !== (bucketColor || '').toLowerCase() ||
    eraserDock.count !== 4 ||
    eraserDock.labels.join('|') !== '擦除线条/描边|擦除填充|擦除化学键|全部擦除' ||
    !eraserDock.dock ||
    eraserDock.active !== 4 ||
    !eraserDock.all ||
    eraserDockOff.active !== 0 ||
    eraserDockOff.all ||
    !eraserDockFill.fill ||
    eraserDockFill.outline ||
    eraserDockFill.all ||
    eraserDockAll.active !== 4 ||
    !eraserDockAll.all ||
    !filledTarget?.fill ||
    filledTarget.fill === 'none' ||
    !filledTarget.stroke ||
    fillErase.missing ||
    fillErase.fill !== filledTarget.fill ||
    !fillErase.mask ||
    fillErase.maskBlack < 1 ||
    fillErase.stroke !== filledTarget.stroke ||
    fillErase.rect ||
    fillEraseClick.missing ||
    fillEraseClick.fill !== filledTarget.fill ||
    fillEraseClick.maskBlack < fillErase.maskBlack ||
    eraserCursor.value !== '30' ||
    eraserCursor.r === null ||
    Math.abs(eraserCursor.r - 30) > 0.5 ||
    brushSized !== '14' ||
    !bucketColor ||
    (bucketInfo.fill || '').toLowerCase() !== (bucketColor || '').toLowerCase() ||
    bucketInfo.objects !== bucketBefore ||
    liveAfter.masks <= liveBefore.masks ||
    !liveAfter.cursor ||
    !zoomBefore ||
    !zoomPlain ||
    !zoomAfter ||
    zoomPlain === zoomBefore ||
    zoomAfter === zoomPlain ||
    symmetryPanel.modes !== 4 ||
    !symmetryInfo.symmetry ||
    symmetryInfo.lines < 1 ||
    symmetryInfo.x === null ||
    symmetryInfo.y1 < 0 ||
    symmetryInfo.y2 > (symmetryInfo.pageHeight ?? 0) + 0.5 ||
    symmetryMoved === null ||
    Math.abs(symmetryMoved - symmetryInfo.x) < 50 ||
    mirrorAfter < mirrorBefore + 2 ||
    guideMenuCount !== 6 ||
    guideInfo.active !== 'one-point' ||
    guideInfo.lines < 18 ||
    guideInfo.outOfBounds !== 0 ||
    !guideMoved ||
    guideMoved.x === null ||
    Math.abs(guideMoved.x - (guideInfo.vpX ?? 0)) < 50 ||
    assistDefault ||
    !assistOff ||
    assistOn ||
    !assistEnabled ||
    Boolean(a11yError) ||
    a11yViolations.length > 0 ||
    responsive['1280'].overflowX > 0 ||
    responsive['1280'].canvas < 480 ||
    !responsive['1280'].leftDock ||
    responsive['1280'].leftDockCollapsed ||
    responsive['1280'].inputOverflow > 0 ||
    !hudClearsZoom(responsive['1280']) ||
    responsive['1120'].overflowX > 0 ||
    responsive['1120'].canvas < 480 ||
    !responsive['1120'].leftDock ||
    !responsive['1120'].leftDockCollapsed ||
    responsive['1120'].leftDockWidth > 60 ||
    responsive['1120'].inputOverflow > 0 ||
    !hudClearsZoom(responsive['1120']) ||
    !responsive['1120'].rightSidebar ||
    !colorEntry.collapsed ||
    colorEntry.width > 60 ||
    !colorEntry.entryVisible ||
    !colorEntry.brushVisible ||
    !colorEntryOpened ||
    !paletteStayedOpen ||
    !escapeLayered.popoverGone ||
    escapeLayered.toolAfter !== colorEntry.toolBefore ||
    darkTheme.theme !== 'dark' ||
    darkTheme.mode !== 'dark' ||
    !paperUnchanged ||
    darkTheme.statusHint < 4.5 ||
    darkTheme.railButton < 4.5 ||
    darkTheme.panelTab < 4.5 ||
    !modeChrome.dock ||
    !modeChrome.single ||
    modeChrome.legacyBar ||
    modeChrome.legacyEdit ||
    !modeChrome.exit ||
    !modeEditStaysOpen ||
    !modeDockHidden ||
    comboAfter < comboBefore + 2 ||
    !comboSnap ||
    comboSnap.deviation === null ||
    // 辅助线已改为三向吸附：只校验笔迹生成（直线度由 tools-check 的方向用例覆盖）
    comboSnap.points < 2 ||
    bothBars !== 1 ||
    modeSymClosed.symmetry ||
    !modeSymClosed.guides ||
    modeExited.bar ||
    modeExited.tool !== '画笔' ||
    !guideDockCollapsed ||
    !guideReopened.bar ||
    !guideReopened.dock ||
    !chemGroupState.dock ||
    chemGroupState.toolActive ||
    chemGroupState.activeCategories > 0 ||
    chemPanelsOpen.panels !== 1 ||
    chemPanelsOpen.bond ||
    !chemPanelsOpen.element ||
    !chemPanelsOpen.above ||
    !chemPanelsOpen.aligned ||
    chemPanelsOpen.icons < 1 ||
    chemPanelsOpen.headerText > 0 ||
    chemPanelSwitched.panels !== 1 ||
    !chemPanelSwitched.bond ||
    chemPanelSwitched.element ||
    chemPanelClosed.bond ||
    chemPanelClosed.remaining !== 0 ||
    backgroundHidden.fill !== 'url(#transparent-checker)' ||
    backgroundHidden.visible !== 'false' ||
    backgroundRestored.visible !== 'true' ||
    !railManager.open ||
    railManager.rows !== 21 ||
    railManager.residents !== 15 ||
    !railAdded ||
    railReordered !== 'guides' ||
    !railRemoved ||
    p0.materialHint ||
    liveDabs.dabs < 1 ||
    !liveDabs.inked ||
    !materialStroke.found ||
    materialStroke.main !== 1 ||
    materialStroke.grain < 1 ||
    materialStroke.paths < 4 ||
    p0.afterCancel !== p0.before ||
    p0.afterLost !== p0.before ||
    p0.handles < 9 ||
    !transformPreview.ok ||
    transformPreview.previewAttr !== 'true' ||
    !String(transformPreview.previewTransform || '').includes('translate(') ||
    !transformPreview.frameTransform ||
    transformPreview.during !== transformPreview.before ||
    transformPreview.afterPreviewAttr !== null ||
    transformPreview.after === transformPreview.before ||
    !resizePreview.ok ||
    resizePreview.previewAttr !== 'true' ||
    resizePreview.during === resizePreview.before ||
    resizePreview.after !== resizePreview.during ||
    resizePreview.afterPreviewAttr !== null ||
    !resizePreview.aspectPreserved ||
    !multiplyStroke.ok ||
    multiplyStroke.grains < 1 ||
    multiplyStroke.liveDabs < 1 ||
    multiplyStroke.flowValue !== '70' ||
    multiplyStroke.blendButtons !== 2 ||
    multiplyStroke.pressureCurve !== '1' ||
    !multiplyStroke.multiplyActive ||
    !brushLibrary.ok ||
    brushLibrary.after !== brushLibrary.before + 1 ||
    !brushLibrary.toast.includes('已导入') ||
    (!brushLibrary.exportToast.includes('已导出') &&
      !brushLibrary.exportToast.includes('已下载')) ||
    brushLibrary.flowValue !== '60' ||
    !brushLibrary.glyph ||
    !brushLibrary.multiplyActive ||
    scenarioFailures.length > 0 ||
    !imageImport.ok ||
    !batchImport.ok ||
    !railPolish.ok ||
    !chemFocus.ok ||
    !chemExtras.ok ||
    !layersPanel.ok ||
    !uiPolish.ok ||
    !recentSync.ok ||
    smokeErrors.length > 0;

  if (failed) {
    // 失败时把顶层 || 条件逐条求值，避免只看到 exit 1 无法定位。
    try {
      const parser = require('@babel/parser');
      const source = fs.readFileSync(__filename, 'utf8');
      const ast = parser.parse(source, { sourceType: 'script' });
      let init = null;
      const findFailed = (node) => {
        if (!node || typeof node !== 'object' || init) return;
        if (node.type === 'VariableDeclarator' && node.id && node.id.name === 'failed') {
          init = node.init;
          return;
        }
        for (const key of Object.keys(node)) {
          if (['loc', 'start', 'end', 'tokens', 'comments'].includes(key)) continue;
          const value = node[key];
          if (Array.isArray(value)) value.forEach(findFailed);
          else if (value && typeof value === 'object') findFailed(value);
        }
      };
      findFailed(ast);
      const operands = [];
      const collect = (node) => {
        if (node.type === 'LogicalExpression' && node.operator === '||') {
          collect(node.left);
          collect(node.right);
        } else {
          operands.push(node);
        }
      };
      if (init) collect(init);
      const failing = [];
      for (const operand of operands) {
        const expression = source.slice(operand.start, operand.end);
        try {
          if (eval(`(${expression})`)) failing.push(expression.replace(/\s+/g, ' '));
        } catch {
          /* 单条表达式异常交给最终 failed 结果处理 */
        }
      }
      console.error('[smoke] failing conditions:\n- ' + failing.join('\n- '));
    } catch (error) {
      console.error('[smoke] could not expand failing conditions:', error);
    }
  }

  app.exit(failed ? 1 : 0);
}

module.exports = { runSmokeFlow };
