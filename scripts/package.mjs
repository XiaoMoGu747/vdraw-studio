#!/usr/bin/env node
/**
 * Windows 打包包装器。
 *
 * electron-builder 默认从 GitHub 下载 Electron/NSIS 二进制；国内网络经常超时。
 * 允许用环境变量覆盖镜像：
 *   ELECTRON_MIRROR
 *   ELECTRON_BUILDER_BINARIES_MIRROR
 * 未设置时使用 npmmirror 作为默认镜像，便于离线/弱网环境复现打包。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const env = {
  ...process.env,
  ELECTRON_MIRROR:
    process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/'
};
// 本机可能全局设置了该变量；Electron 主进程会因此被当成 Node 执行。
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit'
});
if (result.error) {
  console.error('[package] failed to start electron-builder:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);