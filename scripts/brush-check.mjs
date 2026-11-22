import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 画笔几何基线：进入 CI 前的最小断言集。
 * 覆盖抽稀、贝塞尔拟合、压感宽度、宽度包络与单点落墨。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const entry = `
import {
  buildBrushNodes,
  brushOutlineData,
  filterSamples,
  strokeWidths
} from './src/core/brush.ts';

const fail = (message) => {
  console.error('FAIL ' + message);
  process.exitCode = 1;
};

const line = (count, stepMs = 4) =>
  Array.from({ length: count }, (_, index) => ({
    x: index,
    y: 0,
    pressure: 1,
    t: index * stepMs
  }));

// 1) 抽稀：一条直线不应保留全部采样点
const straight = buildBrushNodes(line(200), {
  smoothing: 0,
  pressure: false,
  taper: 0,
  width: 3
});
if (straight.nodes.length > 8) fail('抽稀不足: ' + straight.nodes.length);
if (straight.uniform !== true) fail('等宽笔迹不应写入宽度字段');

// 2) 贝塞尔拟合：内部节点必须有控制柄
const curved = buildBrushNodes(
  Array.from({ length: 240 }, (_, index) => {
    const t = index / 24;
    return { x: t * 30, y: Math.sin(t) * 40, pressure: 1, t: index * 4 };
  }),
  { smoothing: 20, pressure: false, taper: 0, width: 4 }
);
if (curved.nodes.length < 3) fail('曲线节点过少: ' + curved.nodes.length);
const smoothNodes = curved.nodes.filter((node) => node.handleIn || node.handleOut);
if (smoothNodes.length < curved.nodes.length - 2) fail('贝塞尔控制柄缺失');

// 3) 压感：宽度必须有差异，并生成轮廓
const pressureSamples = line(120).map((sample, index) => ({
  ...sample,
  pressure: 0.2 + 0.8 * (index / 119)
}));
const pressure = buildBrushNodes(pressureSamples, {
  smoothing: 10,
  pressure: true,
  taper: 0,
  width: 20,
  minRatio: 0.35
});
if (pressure.uniform !== false) fail('压感笔迹应判定为非等宽');
const widths = pressure.nodes.map((node) => node.width ?? 0);
const minWidth = Math.min(...widths);
const maxWidth = Math.max(...widths);
if (!(maxWidth > minWidth * 1.5)) fail('压感宽度范围不足: ' + minWidth + '~' + maxWidth);
const outline = brushOutlineData(pressure.nodes);
if (!outline || !outline.includes('A') || !outline.endsWith('Z')) fail('宽度包络生成失败');

// 4) 起收笔渐隐：两端应明显细于中段
const taper = buildBrushNodes(line(200).map((sample, index) => ({ ...sample, x: index * 2 })), {
  smoothing: 5,
  pressure: false,
  taper: 0.4,
  width: 10
});
const taperWidths = taper.nodes.map((node) => node.width ?? 0);
if (!(taperWidths[0] < taperWidths[Math.floor(taperWidths.length / 2)] * 0.6)) {
  fail('起笔渐隐未生效');
}

// 5) 单点落墨：单击应得到可渲染的短笔迹
const dot = buildBrushNodes([{ x: 10, y: 10, pressure: 1, t: 0 }], {
  smoothing: 0,
  pressure: false,
  taper: 0,
  width: 6
});
if (dot.nodes.length !== 2) fail('单点落墨节点数异常: ' + dot.nodes.length);
if (!dot.uniform) fail('单点落墨不应写入宽度字段');

// 6) 节点上限：超长笔迹必须被抽稀到 1200 节点以内
const huge = buildBrushNodes(
  Array.from({ length: 6000 }, (_, index) => ({
    x: index * 0.4,
    y: Math.sin(index / 30) * 18,
    pressure: 1,
    t: index * 3
  })),
  { smoothing: 8, pressure: false, taper: 0, width: 2 }
);
if (huge.nodes.length > 1200) fail('节点上限失效: ' + huge.nodes.length);

// 7) 采样率无关性：同一路径在 120Hz 与 240Hz 下偏差都应很小
const reference = (x) => Math.sin(x / 20) * 12;
const samplePath = (stepMs, xStep) =>
  Array.from({ length: Math.floor(240 / xStep) }, (_, index) => {
    const x = index * xStep;
    return { x, y: reference(x), pressure: 1, t: index * stepMs };
  });
const slow = filterSamples(samplePath(8, 1), 12);
const fast = filterSamples(samplePath(4, 0.5), 12);
const deviation = (samples) =>
  Math.max(...samples.map((sample) => Math.abs(sample.y - reference(sample.x))));
const slowDeviation = deviation(slow);
const fastDeviation = deviation(fast);
if (slowDeviation > 4 || fastDeviation > 4) {
  fail('平滑后偏差过大: ' + slowDeviation.toFixed(2) + '/' + fastDeviation.toFixed(2));
}

// 8) 宽度曲线单调性（无渐隐时）
const monotonic = strokeWidths(pressureSamples, {
  smoothing: 10,
  pressure: true,
  taper: 0,
  width: 20,
  minRatio: 0.35
});
for (let index = 1; index < monotonic.length; index += 1) {
  if (monotonic[index] + 1e-6 < monotonic[index - 1]) {
    fail('压感宽度不单调 @' + index);
    break;
  }
}

if (!process.exitCode) {
  console.log('OK brush geometry');
  console.log('  straight nodes: ' + straight.nodes.length);
  console.log('  curve nodes: ' + curved.nodes.length);
  console.log('  pressure width: ' + minWidth.toFixed(2) + '~' + maxWidth.toFixed(2));
  console.log('  huge nodes: ' + huge.nodes.length);
  console.log('  smoothing deviation: ' + slowDeviation.toFixed(2) + 'px / ' + fastDeviation.toFixed(2) + 'px');
}
`;

const dir = await mkdtemp(path.join(tmpdir(), 'vdraw-brush-'));
const outfile = path.join(dir, 'brush-check.mjs');

try {
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile,
    logLevel: 'silent'
  });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
