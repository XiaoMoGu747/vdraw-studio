import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import electronPath from 'electron';

await build({ configFile: 'vite.config.ts', logLevel: 'warn' });
console.log('[smoke] renderer build ok, launching electron...');

// 冒烟必须从可复现的干净偏好开跑：工具栏常驻项、横栏折叠等都会写入 localStorage，
// 复用默认 userData 会把上一次人工/自动化留下的状态带进来，导致工具数与横栏断言误判。
// 每次使用新的 profile 目录（artifacts 已被 git 忽略），避免清理旧目录时被文件锁卡住。
const profileDir = path.resolve('artifacts', `smoke-profile-${Date.now()}`);

const child = spawn(electronPath, ['.', `--user-data-dir=${profileDir}`], {
  stdio: 'inherit',
  env: { ...process.env, VDRAW_SMOKE: '1' }
});

child.on('exit', (code) => {
  console.log(`[smoke] electron exited with code ${code}`);
  process.exit(code ?? 1);
});
