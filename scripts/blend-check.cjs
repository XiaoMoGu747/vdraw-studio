'use strict';

/**
 * PNG/JPG 的逐 dab 混合校验：
 * 用与 raster.ts 相同的「SVG → <img> → canvas」路径，检查
 * mix-blend-mode:multiply 是否真的把黄底 × 蓝块变成黑色。
 *
 * PDF 不走这条链路：PDF 导出前会把 multiply 预乘成普通 fill，
 * 不依赖打印管线的 mix-blend-mode，相关断言在 check:tools。
 */
const { app, BrowserWindow } = require('electron');

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60" viewBox="0 0 180 60">',
  '<rect width="180" height="60" fill="#ffff00"/>',
  '<rect x="0" y="0" width="60" height="60" fill="#0000ff"/>',
  '<rect x="60" y="0" width="60" height="60" fill="#0000ff" style="mix-blend-mode:multiply"/>',
  '</svg>'
].join('');

const HTML = `<!doctype html><html><body style="margin:0;background:#fff">${SVG}</body></html>`;

const SCRIPT = `(async () => {
  const svg = ${JSON.stringify(SVG)};
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('SVG 图像加载失败'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = 180;
  canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const sample = (x) => [...ctx.getImageData(x, 30, 1, 1).data];
  return { normal: sample(30), multiply: sample(90), yellow: sample(150) };
})()`;

const isBlue = (pixel) => pixel[0] < 30 && pixel[1] < 30 && pixel[2] > 180;
const isBlack = (pixel) => pixel[0] < 30 && pixel[1] < 30 && pixel[2] < 30;
const isYellow = (pixel) => pixel[0] > 200 && pixel[1] > 200 && pixel[2] < 90;

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 200,
    webPreferences: { contextIsolation: true }
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
    const result = await win.webContents.executeJavaScript(SCRIPT, true);
    console.log(
      `[blend-check] normal=${JSON.stringify(result.normal)} multiply=${JSON.stringify(result.multiply)} yellow=${JSON.stringify(result.yellow)}`
    );
    if (!isBlue(result.normal) || !isBlack(result.multiply) || !isYellow(result.yellow)) {
      throw new Error('PNG/JPG 光栅化未正确应用 multiply');
    }
    console.log('[blend-check] 通过：PNG/JPG 保留逐 dab 正片叠底');
    app.exit(0);
  } catch (error) {
    console.error('[blend-check] FAIL:', error && error.message ? error.message : error);
    app.exit(1);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main();
