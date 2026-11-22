import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = await mkdtemp(path.join(tmpdir(), 'vdraw-unit-'));
const outFile = path.join(outDir, 'unit.test.mjs');

try {
  await build({
    absWorkingDir: root,
    entryPoints: ['tests/unit.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node:*'],
    outfile: outFile,
    logLevel: 'warning'
  });
  const child = spawn(process.execPath, [outFile], { stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value ?? 1)));
  process.exitCode = code;
} finally {
  await rm(outDir, { recursive: true, force: true });
}
