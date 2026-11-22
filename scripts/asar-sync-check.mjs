import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';

/**
 * 双端一致性：打包后的 app.asar 内 dist 前端产物必须与磁盘 dist 逐字节一致。
 * 这是"网页端与 PC 端共用同一份前端"的唯一硬证据，避免打包遗漏旧产物。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 允许用 VDRAW_ASAR_PATH 指向其他打包目录（例如临时输出目录仍可做同一份校验）。
const asarPath = process.env.VDRAW_ASAR_PATH
  ? path.resolve(root, process.env.VDRAW_ASAR_PATH)
  : path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');

if (!existsSync(asarPath)) {
  console.error(`[asar-sync] 找不到 ${path.relative(root, asarPath)}，请先运行 npm run pack / dist:win`);
  process.exit(1);
}

const entries = asar
  .listPackage(asarPath)
  .filter((entry) => entry.replace(/\\/g, '/').toLowerCase().startsWith('/dist/'));

if (entries.length === 0) {
  console.error('[asar-sync] app.asar 内没有 dist 产物');
  process.exit(1);
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
let failed = 0;

for (const entry of entries) {
  const relative = entry.replace(/\\/g, '/').replace(/^\//, '');
  const diskPath = path.join(root, ...relative.split('/'));
  if (!existsSync(diskPath)) {
    console.error(`[asar-sync] 缺失磁盘文件 ${relative}`);
    failed += 1;
    continue;
  }
  // listPackage 同时返回目录项，目录不参与逐字节比较。
  if (statSync(diskPath).isDirectory()) continue;
  // asar 内部路径使用宿主平台的路径分隔符。
  const packed = asar.extractFile(asarPath, relative.split('/').join(path.sep));
  const diskHash = sha(readFileSync(diskPath));
  const packedHash = sha(packed);
  if (diskHash !== packedHash) {
    console.error(`[asar-sync] 哈希不一致 ${relative}`);
    console.error(`  disk  ${diskHash}`);
    console.error(`  asar  ${packedHash}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`[asar-sync] 失败：${failed}/${entries.length} 个文件不一致`);
  process.exit(1);
}

console.log(`[asar-sync] 通过：dist 共 ${entries.length} 个文件与 app.asar 逐字节一致`);
