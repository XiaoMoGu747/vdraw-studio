import { spawn } from 'node:child_process';
import { build } from 'vite';
import electronPath from 'electron';

await build({ configFile: 'vite.config.ts', logLevel: 'warn' });
console.log('[smoke] renderer build ok, launching electron...');

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VDRAW_SMOKE: '1' }
});

child.on('exit', (code) => {
  console.log(`[smoke] electron exited with code ${code}`);
  process.exit(code ?? 1);
});
