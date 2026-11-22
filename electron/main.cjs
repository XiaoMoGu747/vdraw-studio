'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, screen, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const isSmoke = process.env.VDRAW_SMOKE === '1';
const smokeErrors = [];

let mainWindow = null;
let allowClose = false;
let closeRequested = false;
let rendererReady = false;

const { runSmokeFlow } = require('./smoke.cjs');

const SAVE_FOLDER_NAME = 'VDraw保存';

function safeFileStem(name) {
  return (
    String(name || '未命名')
      .replace(/\.vdraw$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim() || '未命名'
  );
}

/** 默认保存到应用所在目录；开发态保存到项目根目录。 */
function preferredSaveRoot() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
}

async function ensureSaveDirectory() {
  const preferred = path.join(preferredSaveRoot(), SAVE_FOLDER_NAME);
  try {
    await fs.promises.mkdir(preferred, { recursive: true });
    return { directory: preferred, fallback: false };
  } catch (error) {
    // 安装到 Program Files 等只读目录时退回“文档/VDraw保存”，避免保存失败。
    const fallback = path.join(app.getPath('documents'), SAVE_FOLDER_NAME);
    await fs.promises.mkdir(fallback, { recursive: true });
    return {
      directory: fallback,
      fallback: true,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function uniqueDocumentPath(directory, stem) {
  let candidate = path.join(directory, `${stem}.vdraw`);
  let index = 2;
  for (;;) {
    try {
      await fs.promises.access(candidate);
      candidate = path.join(directory, `${stem} (${index}).vdraw`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

function sendWindowState(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('window:state', { maximized: win.isMaximized() });
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, Math.max(1040, workArea.width - 56));
  const height = Math.min(920, Math.max(660, workArea.height - 56));

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(1120, width),
    minHeight: Math.min(680, height),
    show: false,
    frame: false,
    backgroundColor: '#eef0f4',
    title: 'VDraw Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.center();
    mainWindow.show();
  });

  mainWindow.on('maximize', () => sendWindowState(mainWindow));
  mainWindow.on('unmaximize', () => sendWindowState(mainWindow));

  // 关闭前交给渲染进程检查未保存修改；冒烟测试直接放行，避免自动化被对话框卡住。
  mainWindow.on('close', (event) => {
    if (allowClose || isSmoke) return;
    // 页面尚未加载或渲染进程已崩溃时没有可用的确认逻辑，直接放行避免窗口无法关闭。
    if (!rendererReady || mainWindow.webContents.isCrashed()) return;
    event.preventDefault();
    if (closeRequested || mainWindow.isDestroyed()) return;
    closeRequested = true;
    mainWindow.webContents.send('app:close-request');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
  });
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
    closeRequested = false;
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    closeRequested = false;
    rendererReady = false;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  if (isSmoke) {
    mainWindow.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) smokeErrors.push(message);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      runSmoke(mainWindow).catch((error) => {
        console.error('[smoke] failed:', error);
        app.exit(1);
      });
    });
  }
}

// 冒烟测试的完整流程放在 electron/smoke.cjs，主进程只负责触发与退出
async function runSmoke(win) {
  await runSmokeFlow(win, smokeErrors);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    ipcMain.handle('window:minimize', () => mainWindow?.minimize());
    ipcMain.handle('window:toggle-maximize', () => {
      if (!mainWindow) return false;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
      return mainWindow.isMaximized();
    });
    ipcMain.handle('window:close', () => mainWindow?.close());
    ipcMain.handle('app:close-response', (_event, shouldClose) => {
      closeRequested = false;
      if (!shouldClose || !mainWindow || mainWindow.isDestroyed()) return false;
      allowClose = true;
      mainWindow.close();
      return true;
    });
    ipcMain.handle('app:info', () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform
    }));

    const artifactsDir = () => path.join(__dirname, '..', 'artifacts');

    ipcMain.handle('file:open-document', async () => {
      if (isSmoke) {
        const smokePath = path.join(artifactsDir(), 'smoke-document.vdraw');
        if (!fs.existsSync(smokePath)) return { canceled: true };
        return { canceled: false, path: smokePath, content: fs.readFileSync(smokePath, 'utf8') };
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '打开 VDraw 文档',
        properties: ['openFile'],
        filters: [
          { name: 'VDraw 文档', extensions: ['vdraw'] },
          { name: 'JSON', extensions: ['json'] }
        ]
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };
      const filePath = result.filePaths[0];
      const content = await fs.promises.readFile(filePath, 'utf8');
      return { canceled: false, path: filePath, content };
    });

    ipcMain.handle('file:open-path', async (_event, filePath) => {
      if (typeof filePath !== 'string' || !filePath) return { canceled: true };
      const content = await fs.promises.readFile(filePath, 'utf8');
      return { canceled: false, path: filePath, content };
    });

    ipcMain.handle('file:save-document', async (_event, payload) => {
      const { content, path: targetPath, suggestedName, forceDialog } = payload ?? {};
      let target = typeof targetPath === 'string' && targetPath ? targetPath : null;
      let directory = target ? path.dirname(target) : null;
      let fallback = false;
      if (!target) {
        if (isSmoke) {
          target = path.join(artifactsDir(), 'smoke-document.vdraw');
          directory = artifactsDir();
        } else if (forceDialog) {
          const resolved = await ensureSaveDirectory();
          directory = resolved.directory;
          fallback = resolved.fallback;
          const defaultPath = path.join(directory, `${safeFileStem(suggestedName)}.vdraw`);
          const result = await dialog.showSaveDialog(mainWindow, {
            title: '另存为 VDraw 文档',
            defaultPath,
            filters: [{ name: 'VDraw 文档', extensions: ['vdraw'] }]
          });
          if (result.canceled || !result.filePath) return { canceled: true };
          target = result.filePath;
          directory = path.dirname(target);
        } else {
          const resolved = await ensureSaveDirectory();
          directory = resolved.directory;
          fallback = resolved.fallback;
          target = await uniqueDocumentPath(directory, safeFileStem(suggestedName));
        }
      }
      const tempPath = `${target}.tmp-${process.pid}-${Date.now()}`;
      await fs.promises.writeFile(tempPath, String(content ?? ''), 'utf8');
      await fs.promises.rename(tempPath, target);
      return { canceled: false, path: target, directory, fallback };
    });

    ipcMain.handle('file:save-dir', async () => ensureSaveDirectory());

    ipcMain.handle('file:open-save-dir', async () => {
      const resolved = await ensureSaveDirectory();
      const error = await shell.openPath(resolved.directory);
      return { ...resolved, error: error || null };
    });

    ipcMain.handle('file:export', async (_event, payload) => {
      const { data, encoding, defaultName, filters } = payload ?? {};
      let targetPath = null;
      if (isSmoke) {
        const extension = filters?.[0]?.extensions?.[0] ?? 'bin';
        targetPath = path.join(artifactsDir(), `smoke-export.${extension}`);
      } else {
        const safeName = String(defaultName || '未命名').replace(/[\\/:*?"<>|]/g, '_');
        const result = await dialog.showSaveDialog(mainWindow, {
          title: '导出',
          defaultPath: path.join(app.getPath('documents'), safeName),
          filters: Array.isArray(filters) && filters.length > 0 ? filters : undefined
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        targetPath = result.filePath;
      }
      const buffer =
        encoding === 'base64'
          ? Buffer.from(String(data ?? ''), 'base64')
          : Buffer.from(String(data ?? ''), 'utf8');
      const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
      await fs.promises.writeFile(tempPath, buffer);
      await fs.promises.rename(tempPath, targetPath);
      return { canceled: false, path: targetPath };
    });

    ipcMain.handle('file:export-pdf', async (_event, payload) => {
      const { svg, defaultName, width, height } = payload ?? {};
      if (typeof svg !== 'string' || svg.length < 32 || svg.length > 50_000_000) {
        throw new Error('PDF 导出内容无效或过大');
      }
      const pageWidth = Number(width);
      const pageHeight = Number(height);
      if (
        !Number.isFinite(pageWidth) ||
        !Number.isFinite(pageHeight) ||
        pageWidth <= 0 ||
        pageHeight <= 0 ||
        pageWidth > 20000 ||
        pageHeight > 20000
      ) {
        throw new Error('PDF 页面尺寸无效');
      }

      let targetPath = null;
      if (isSmoke) {
        targetPath = path.join(artifactsDir(), 'smoke-export.pdf');
      } else {
        const safeName = String(defaultName || '未命名').replace(/[\\/:*?"<>|]/g, '_');
        const result = await dialog.showSaveDialog(mainWindow, {
          title: '导出 PDF',
          defaultPath: path.join(app.getPath('documents'), safeName),
          filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        targetPath = result.filePath;
      }

      // 用 Chromium 的 printToPDF 生成真正的矢量 PDF（文字保留为字体子集），
      // 不再把整页 JPEG 塞进 PDF。隐藏窗口只加载本地临时 HTML，禁止导航/新窗口。
      const tempHtml = path.join(
        app.getPath('temp'),
        `vdraw-pdf-${process.pid}-${Date.now()}.html`
      );
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        @page { size: ${pageWidth}px ${pageHeight}px; margin: 0; }
        html, body { margin: 0; padding: 0; width: ${pageWidth}px; height: ${pageHeight}px; overflow: hidden; background: #ffffff; }
        svg { display: block; width: ${pageWidth}px; height: ${pageHeight}px; }
      </style></head><body>${svg}</body></html>`;
      let printWindow = null;
      try {
        await fs.promises.writeFile(tempHtml, html, 'utf8');
        printWindow = new BrowserWindow({
          show: false,
          width: Math.min(1600, Math.max(320, Math.round(pageWidth))),
          height: Math.min(1600, Math.max(240, Math.round(pageHeight))),
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false
          }
        });
        printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        printWindow.webContents.on('will-navigate', (event) => event.preventDefault());
        await printWindow.loadFile(tempHtml);
        const pdf = await printWindow.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
          pageSize: {
            width: Math.round(pageWidth * 264.583),
            height: Math.round(pageHeight * 264.583)
          },
          margins: { marginType: 'none' }
        });
        const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
        await fs.promises.writeFile(tempPath, pdf);
        await fs.promises.rename(tempPath, targetPath);
        return { canceled: false, path: targetPath };
      } finally {
        if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
        await fs.promises.unlink(tempHtml).catch(() => {});
      }
    });

    ipcMain.handle('file:import-svg', async () => {
      if (isSmoke) {
        const smokePath = path.join(artifactsDir(), 'smoke-import.svg');
        if (!fs.existsSync(smokePath)) return { canceled: true };
        return { canceled: false, path: smokePath, content: fs.readFileSync(smokePath, 'utf8') };
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入 SVG',
        properties: ['openFile'],
        filters: [{ name: 'SVG 矢量图', extensions: ['svg'] }]
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };
      const filePath = result.filePaths[0];
      const content = await fs.promises.readFile(filePath, 'utf8');
      return { canceled: false, path: filePath, content };
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
