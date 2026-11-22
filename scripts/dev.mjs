import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
server.printUrls();

const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173';
const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url }
});

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } finally {
    process.exit(code);
  }
}

child.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => {
  child.kill();
  shutdown(0);
});
