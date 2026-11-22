import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { BrushBlendMode, Vec } from '../../types/document';
import { buildBrushNodes, brushOutlineData, type BrushProjection, type BrushSample } from '../../core/brush';
import { brushMaterialLayers, type BrushMaterialLayers } from '../../core/brushMaterial';
import { pathData } from '../../core/io/svg';
import type { NibShape } from '../../core/nib';

export interface BrushInkOptions {
  color: string;
  opacity: number;
  /** 软边硬度 0–1：越大边缘越实。 */
  hardness: number;
  /** 纹理点间距系数（相对笔宽）。 */
  spacing: number;
  /** 纹理强度 0–1，0 表示无纹理。 */
  texture: number;
  /** 画笔标称宽度：dab 间距的基准，与落笔后的最大节点宽度口径一致。 */
  size: number;
  /** 每 dab 墨量 0–1。 */
  flow: number;
  /** dab 混合模式。 */
  blendMode: BrushBlendMode;
  /** 是否按材质绘制软边/dab；与落笔后的入库阈值同源。 */
  material: boolean;
  /** 与落笔同一份宽度/压感/渐隐/平滑参数。 */
  projection: BrushProjection;
  /** 整笔固定种子：实时 dab 与落笔后的矢量 dab 使用同一纹理。 */
  seed: number;
}

export interface BrushInkHandle {
  /** 开始一笔：清空画布并锁定材质。 */
  begin: (options: BrushInkOptions) => void;
  /** 追加一段：记录采样点，下一帧按与成品相同的几何管线重绘整条笔迹。 */
  segment: (from: BrushSample, to: BrushSample, nib?: NibShape, channel?: number) => void;
  /** 结束：等成品层提交后的下一帧再同步清空（不做透明度过渡）。 */
  handoff: () => void;
  /** 取消/切换工具：立即清空。 */
  clear: () => void;
}

interface BrushInkLayerProps {
  pan: Vec;
  zoom: number;
}

interface InkPoint extends BrushSample {
  nib?: NibShape;
}

interface InkChannel {
  points: InkPoint[];
  /** 该通道最近一次的有效笔尖；落笔时对整条笔迹使用同一个平均笔尖。 */
  nib?: NibShape;
}

/** 实时预览的几何上限：超长笔迹隔点取点，保证每帧重建仍跟手。 */
const PREVIEW_MAX_POINTS = 1600;

function materialOf(style: BrushInkOptions) {
  return {
    hardness: style.hardness,
    spacing: style.spacing,
    texture: style.texture,
    seed: style.seed,
    flow: style.flow,
    blendMode: style.blendMode
  };
}

/**
 * 绘制期实时笔迹层。
 *
 * 关键修正：不再"逐 pointermove 段各描一次"。
 * 逐段描边会在圆头接缝处反复叠加 alpha，半透明/软边笔刷（铅笔、马克）在实时层
 * 看起来更深更宽，而落笔后的矢量只有一次覆盖，松手就会"变浅、变细"。
 * 现在每帧用与 finishBrush 完全相同的管线（滤波 → 抽稀 → 贝塞尔 → 宽度包络）
 * 重建整条笔迹，并以单条路径填充，实时与成品的透明度、宽度和纹理同源。
 */
export const BrushInkLayer = forwardRef<BrushInkHandle, BrushInkLayerProps>(
  function BrushInkLayer({ pan, zoom }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const styleRef = useRef<(BrushInkOptions & { active: boolean }) | null>(null);
    const channelsRef = useRef(new Map<number, InkChannel>());
    const transformRef = useRef({ pan, zoom });
    const frameRef = useRef<number | null>(null);
    transformRef.current = { pan, zoom };

    const cancelFrame = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const fillLayer = (
      ctx: CanvasRenderingContext2D,
      d: string,
      color: string,
      alpha: number,
      blend?: BrushBlendMode
    ) => {
      if (alpha <= 0.001 || !d) return;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.globalCompositeOperation = blend === 'multiply' ? 'multiply' : 'source-over';
      ctx.fillStyle = color;
      ctx.fill(new Path2D(d), 'nonzero');
    };

    const strokeCenter = (
      ctx: CanvasRenderingContext2D,
      d: string,
      color: string,
      alpha: number,
      width: number,
      blend?: BrushBlendMode
    ) => {
      if (alpha <= 0.001 || !d) return;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.globalCompositeOperation = blend === 'multiply' ? 'multiply' : 'source-over';
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.4, width);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(new Path2D(d));
    };

    const drawLayers = (
      ctx: CanvasRenderingContext2D,
      style: BrushInkOptions,
      layers: BrushMaterialLayers | null,
      outline: string | null,
      centerline: string,
      bodyWidth: number
    ) => {
      const bodyAlpha = style.opacity * (layers?.bodyOpacity ?? 1);
      const bodyBlend = layers?.blendMode;
      if (layers) {
        // 软边在成品里位于 body 组内，组透明度 = flow；这里把两级 alpha 乘在一起。
        for (const layer of layers.edges) {
          fillLayer(ctx, layer.d, style.color, bodyAlpha * layer.opacity, bodyBlend);
        }
      }
      if (outline) {
        fillLayer(ctx, outline, style.color, bodyAlpha, bodyBlend);
      } else {
        strokeCenter(ctx, centerline, style.color, bodyAlpha, bodyWidth, bodyBlend);
      }
      if (layers) {
        // 墨点在成品里位于 body 组外，只乘自身透明度。
        for (const layer of layers.grain) {
          fillLayer(ctx, layer.d, style.color, style.opacity * layer.opacity, layer.blendMode);
        }
      }
    };

    const drawChannel = (
      ctx: CanvasRenderingContext2D,
      style: BrushInkOptions,
      channel: InkChannel
    ): number => {
      if (channel.points.length === 0) return 0;
      const points =
        channel.points.length > PREVIEW_MAX_POINTS
          ? channel.points.filter(
              (_, index) => index % 2 === 0 || index === channel.points.length - 1
            )
          : channel.points;
      const samples: BrushSample[] = points.map((point) => ({
        x: point.x,
        y: point.y,
        pressure: point.pressure,
        t: point.t
      }));
      const { nodes } = buildBrushNodes(samples, style.projection);
      if (nodes.length === 0) return 0;
      const nib = channel.nib;
      if (nib && nib.aspect < 0.985) {
        for (const node of nodes) {
          node.nibAngle = nib.angle;
          node.nibAspect = nib.aspect;
        }
      }
      if (nodes.length === 1) {
        // 单点：落笔后是 2 个几乎重合的节点，这里按圆点/椭圆补一个即可。
        const radius = Math.max(0.35, (style.projection.width / 2) * (nib?.aspect ?? 1));
        ctx.globalAlpha = style.opacity * (style.material ? style.flow : 1);
        ctx.globalCompositeOperation =
          style.blendMode === 'multiply' ? 'multiply' : 'source-over';
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.ellipse(nodes[0].x, nodes[0].y, radius, radius * (nib?.aspect ?? 1), 0, 0, Math.PI * 2);
        ctx.fill();
        return 0;
      }
      const outline = brushOutlineData(nodes);
      const centerline = pathData(nodes, false);
      const layers = style.material
        ? brushMaterialLayers(nodes, materialOf(style), style.size, { noCache: true })
        : null;
      drawLayers(ctx, style, layers, outline, centerline, style.projection.width);
      return layers?.dabCount ?? 0;
    };

    const flush = () => {
      frameRef.current = null;
      const style = styleRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!style?.active || !canvas || !ctx) return;
      if (channelsRef.current.size === 0) return;
      const dpr = Number(canvas.dataset.dpr || 1);
      // 每帧整条重绘：这是避免半透明笔迹在接缝处叠色的关键。
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const { pan: nextPan, zoom: nextZoom } = transformRef.current;
      ctx.setTransform(
        dpr * nextZoom,
        0,
        0,
        dpr * nextZoom,
        dpr * nextPan.x,
        dpr * nextPan.y
      );
      let dabs = 0;
      for (const channel of channelsRef.current.values()) {
        dabs += drawChannel(ctx, style, channel);
      }
      canvas.dataset.dabs = String(dabs);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    const schedule = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(flush);
    };

    useEffect(() => {
      const canvas = canvasRef.current;
      const parent = canvas?.parentElement;
      if (!canvas || !parent) return;

      const resize = () => {
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        const width = Math.max(1, parent.clientWidth);
        const height = Math.max(1, parent.clientHeight);
        const nextWidth = Math.round(width * dpr);
        const nextHeight = Math.round(height * dpr);
        if (canvas.width === nextWidth && canvas.height === nextHeight) return;
        canvas.width = nextWidth;
        canvas.height = nextHeight;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.dataset.dpr = String(dpr);
        // 尺寸变化会清空画布：下一帧由 flush 重建整条笔迹，不再依赖增量内容。
        schedule();
      };

      resize();
      const observer =
        typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => resize());
      observer?.observe(parent);
      window.addEventListener('resize', resize);
      return () => {
        observer?.disconnect();
        window.removeEventListener('resize', resize);
        cancelFrame();
      };
      // 只依赖 ref/常量：schedule 每帧重建但语义稳定，不需要重新绑定 ResizeObserver。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const resetCanvas = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      canvas.style.transition = 'none';
      canvas.style.opacity = '1';
      canvas.style.mixBlendMode = 'normal';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    useImperativeHandle(
      ref,
      () => ({
        begin: (options) => {
          cancelFrame();
          resetCanvas();
          styleRef.current = { ...options, active: true };
          channelsRef.current.clear();
          if (canvasRef.current) {
            canvasRef.current.dataset.dabs = '0';
            // 单张透明画布无法对下方 SVG 做正片叠底：把混合交给 CSS，
            // 与成品 <g mix-blend-mode:multiply> 的合成对象保持一致。
            canvasRef.current.style.mixBlendMode =
              options.blendMode === 'multiply' ? 'multiply' : 'normal';
            const dpr = Number(canvasRef.current.dataset.dpr || 1);
            const { pan: nextPan, zoom: nextZoom } = transformRef.current;
            const ctx = canvasRef.current.getContext('2d');
            if (ctx) {
              ctx.setTransform(
                dpr * nextZoom,
                0,
                0,
                dpr * nextZoom,
                dpr * nextPan.x,
                dpr * nextPan.y
              );
            }
          }
        },
        segment: (from, to, nib, channel = 0) => {
          const style = styleRef.current;
          if (!style?.active) return;
          let state = channelsRef.current.get(channel);
          if (!state) {
            state = { points: [] };
            channelsRef.current.set(channel, state);
          }
          if (nib) state.nib = nib;
          if (state.points.length === 0) {
            state.points.push({ ...from, nib });
          }
          const last = state.points[state.points.length - 1];
          if (Math.hypot(to.x - last.x, to.y - last.y) > 0.001) {
            state.points.push({ ...to, nib });
          }
          schedule();
        },
        handoff: () => {
          if (!styleRef.current?.active) return;
          // 先同步画完最后一帧（含抬手补点），保证交接瞬间几何完整。
          cancelFrame();
          flush();
          if (styleRef.current) styleRef.current.active = false;
          // 关键：不再用 opacity 过渡淡出。
          // 实时层与成品层同色同形，交叉淡出的 130ms 里两层会同时可见：
          // 半透明/正片叠底的笔刷（铅笔、马克）先叠深再回落，就是松手时的"闪一下"。
          // 改成等一帧——指针抬起属于离散事件，React 已在该事件结束时提交成品，
          // 下一帧开始绘制前清空即可，既没有叠加也没有空档。
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = null;
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d');
            channelsRef.current.clear();
            if (!canvas || !ctx) return;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            // dataset.dabs 保留最后一帧的墨点数：它是"这一笔产生了多少 dab"的诊断值，
            // 清空画布不等于这笔没画过（下一笔 begin() 会重新归零）。
            canvas.style.transition = 'none';
            canvas.style.opacity = '1';
            canvas.style.mixBlendMode = 'normal';
          });
        },
        clear: () => {
          if (styleRef.current) styleRef.current.active = false;
          cancelFrame();
          channelsRef.current.clear();
          if (canvasRef.current) canvasRef.current.dataset.dabs = '0';
          resetCanvas();
        }
      }),
      // 句柄通过 ref 调用；flush/schedule 只读写 ref 与画布，不随渲染变化。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    );

    return <canvas ref={canvasRef} className="brush-ink" data-testid="brush-ink" aria-hidden="true" />;
  }
);
