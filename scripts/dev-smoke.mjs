import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173';
console.log(`[dev-smoke] vite ready at ${url}`);

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, VDRAW_SMOKE: '1' }
});

child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 1);
});
