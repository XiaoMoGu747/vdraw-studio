import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from './Icon';
import { useFocusTrap } from './useFocusTrap';

type ColorMode = 'wheel' | 'palette' | 'slider';
type Target = 'fill' | 'stroke';

interface ColorPanelProps {
  fill: string | null;
  stroke: string | null;
  onChangeFill: (color: string | null) => void;
  onChangeStroke: (color: string | null) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return `#${raw.toUpperCase()}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHex(hex) ?? '#000000';
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (value: number) =>
    clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToHsv(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function hsvToRgb(h: number, s: number, v: number) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 };
}

function rgbToCmyk(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const k = 1 - Math.max(rn, gn, bn);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: ((1 - rn - k) / (1 - k)) * 100,
    m: ((1 - gn - k) / (1 - k)) * 100,
    y: ((1 - bn - k) / (1 - k)) * 100,
    k: k * 100
  };
}

const PALETTE_GROUPS: { name: string; colors: string[] }[] = [
  {
    name: '基本色',
    colors: [
      '#000000', '#FFFFFF', '#F5F0E6', '#F7D9A0', '#FFE24A', '#FFC53D', '#FF8A1F', '#F04E23', '#D8232A', '#B3161D',
      '#A4D627', '#8FBF1F', '#6FA92A', '#2F8F3A', '#23A455', '#2FC1C9', '#4BB8E8', '#3B8FE0', '#3B5BA9', '#3B2E8C'
    ]
  },
  {
    name: '中国传统色',
    colors: [
      '#F2E6D8', '#E8D5B7', '#D9C08C', '#C9A227', '#E8A33D', '#E06B2D', '#D23C3C', '#B32B45', '#8E2C4B', '#7A2233',
      '#B9E3D0', '#7FCFAE', '#3E9E7E', '#2A6F63', '#3AA0C9', '#2F6FA8', '#8E5FA8', '#5A4A78', '#2E3550', '#121826'
    ]
  },
  {
    name: '肤色',
    colors: [
      '#FDE9DC', '#F8D9C4', '#F3C7A8', '#EFB98F', '#E9A97C', '#E29A6C', '#D98B5F', '#C97A50', '#B36843',
      '#F7E3D3', '#EFC7AC', '#DDA987', '#C08A63', '#9C6B47', '#7A5036', '#5A3826', '#3E2519', '#2A1910'
    ]
  },
  {
    name: '复古情怀',
    colors: [
      '#EBA86B', '#D9773C', '#B5473C', '#8E2F44', '#C25B7C', '#E58EA0', '#F2B8BE', '#F3CDB4', '#EFE1CE', '#E4C9A8',
      '#16506B', '#1E6E63', '#2E8B57', '#6FA83A', '#B7C93E', '#E4E39B', '#C2A97B', '#8A6B4A', '#5C4630', '#2E2118'
    ]
  },
  {
    name: '霓虹星空',
    colors: [
      '#38D6F2', '#3BA9F0', '#3F6DF0', '#5B4BE0', '#7E4FE0', '#A24FE0', '#C24FD8', '#E050C0', '#F0569A', '#FF6A7E',
      '#FFB07E', '#E8E3D0', '#F7F3E4', '#B7F26A', '#6FE0A8', '#3ED0C4', '#3CB7E0', '#4C7CFF', '#6A4CFF', '#3A2F8C'
    ]
  }
];

const RECENT_KEY = 'vdraw.colors.recent.v1';
const RECENT_LIMIT = 9;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => normalizeHex(item)).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeRecent(colors: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(colors.slice(0, RECENT_LIMIT)));
  } catch {
    /* 忽略本地存储失败 */
  }
}

/** 对角红线“无颜色”色块（规范 5.7）。 */
function NoneSwatch({ active }: { active: boolean }) {
  return (
    <span className={`swatch swatch--none${active ? ' is-active' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 20 20" focusable="false">
        <path d="M3 17L17 3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/**
 * 调色板：折叠态只占一行（填充/描边双色块 + 当前色 + 最近色），
 * 点击色块展开浮层；默认使用色板模式。支持“无填充/无描边”。
 */
export function ColorPanel({ fill, stroke, onChangeFill, onChangeStroke }: ColorPanelProps) {
  const [mode, setMode] = useState<ColorMode>('palette');
  const [target, setTarget] = useState<Target>('fill');
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [open, setOpen] = useState(false);
  const [popover, setPopover] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const lastApplied = useRef<string | null>(null);

  const activeColor = target === 'fill' ? fill : stroke;
  const color = activeColor ?? recent[0] ?? '#1B1B1B';
  const rgb = useMemo(() => hexToRgb(color), [color]);
  const hsv = useMemo(() => rgbToHsv(rgb.r, rgb.g, rgb.b), [rgb.r, rgb.g, rgb.b]);
  const [hue, setHue] = useState(hsv.h);
  const [sat, setSat] = useState(hsv.s);
  const [val, setVal] = useState(hsv.v);
  const [hexDraft, setHexDraft] = useState(color.replace('#', ''));
  const ringRef = useRef<HTMLDivElement>(null);
  const squareRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'ring' | 'square' | null>(null);

  useEffect(() => {
    setHexDraft(color.replace('#', ''));
    const next = rgbToHsv(rgb.r, rgb.g, rgb.b);
    setHue(next.h);
    setSat(next.s);
    setVal(next.v);
  }, [color, rgb.r, rgb.g, rgb.b]);

  const recordRecent = (hex: string) => {
    const normalized = normalizeHex(hex);
    if (!normalized) return;
    setRecent((prev) => {
      const next = [normalized, ...prev.filter((item) => item !== normalized)].slice(0, RECENT_LIMIT);
      writeRecent(next);
      return next;
    });
  };

  const apply = (hex: string) => {
    const normalized = normalizeHex(hex);
    if (!normalized) return;
    lastApplied.current = normalized;
    if (target === 'fill') onChangeFill(normalized);
    else onChangeStroke(normalized);
    if (!dragging.current) recordRecent(normalized);
  };

  const applyHsv = (h: number, s: number, v: number) => {
    setHue(h);
    setSat(s);
    setVal(v);
    const next = hsvToRgb(h, s, v);
    apply(rgbToHex(next.r, next.g, next.b));
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current) return;
      if (dragging.current === 'ring' && ringRef.current) {
        const rect = ringRef.current.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        let nextHue = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
        if (nextHue < 0) nextHue += 360;
        applyHsv(nextHue, sat, val);
      } else if (dragging.current === 'square' && squareRef.current) {
        const rect = squareRef.current.getBoundingClientRect();
        const s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const v = clamp(1 - (event.clientY - rect.top) / rect.height, 0, 1);
        applyHsv(hue, s, v);
      }
    };
    const up = () => {
      if (dragging.current && lastApplied.current) recordRecent(lastApplied.current);
      dragging.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  // 浮层栈：打开时登记，全局快捷键据此让位；Esc 只关闭最上层。
  useEffect(() => {
    if (!open) return;
    const { pushOverlay, popOverlay } = useAppStore.getState();
    pushOverlay();
    return () => popOverlay();
  }, [open]);

  useFocusTrap(
    popoverRef,
    open && Boolean(popover),
    () => setOpen(false),
    '.color-grid .swatch, .color-wheel__ring, .color-sliders input'
  );

  // 浮层位置跟随折叠条，避免被左侧栏的滚动容器裁剪。
  useEffect(() => {
    if (!open) {
      setPopover(null);
      return;
    }
    const place = () => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 252;
      const height = Math.min(window.innerHeight - 24, 520);
      const left = Math.min(rect.right + 8, window.innerWidth - width - 8);
      const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - height - 8));
      setPopover({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node;
      if (rootRef.current?.contains(node) || popoverRef.current?.contains(node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const cmyk = rgbToCmyk(rgb.r, rgb.g, rgb.b);
  const wheelRgb = hsvToRgb(hue, 1, 1);
  const wheelColor = rgbToHex(wheelRgb.r, wheelRgb.g, wheelRgb.b);
  const recentPreview = recent.slice(0, 3);

  const renderSwatch = (which: Target) => {
    const value = which === 'fill' ? fill : stroke;
    const label = which === 'fill' ? '填充' : '描边';
    return (
      <span className="palette-swatch-wrap">
        <button
          type="button"
          className={`palette-swatch${target === which ? ' is-active' : ''}${
            value === null ? ' is-none' : ''
          }`}
          title={`${label}颜色：${value ?? '无'}（点击编辑）`}
          aria-label={`${label}颜色`}
          data-color-target={which}
          data-testid={which === 'fill' ? 'color-entry' : 'color-entry-stroke'}
          onClick={() => {
            setTarget(which);
            setOpen(true);
          }}
        >
          {value === null ? <NoneSwatch active /> : <span style={{ background: value }} />}
        </button>
        {value !== null ? (
          <button
            type="button"
            className="palette-swatch__clear"
            title={`清除${label}`}
            aria-label={`清除${label}`}
            onClick={() => {
              setTarget(which);
              if (which === 'fill') onChangeFill(null);
              else onChangeStroke(null);
            }}
          >
            <Icon name="close" size={9} strokeWidth={2.4} />
          </button>
        ) : null}
      </span>
    );
  };

  return (
    <div className="color-panel" data-testid="color-panel" ref={rootRef}>
      <div className="palette-bar" ref={barRef}>
        {/* 展开按钮放在左上角：与标题同排，收缩态也保持同一位置。 */}
        <div className="palette-bar__head">
          <button
            type="button"
            className={`palette-expand${open ? ' is-open' : ''}`}
            data-testid="color-expand"
            title={open ? '收起调色板' : '展开调色板'}
            aria-label={open ? '收起调色板' : '展开调色板'}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="chevronDown" size={13} />
          </button>
          <span className="palette-bar__title">调色板</span>
        </div>

        {(['fill', 'stroke'] as const).map((which) => {
          const value = which === 'fill' ? fill : stroke;
          const label = which === 'fill' ? '填充' : '描边';
          return (
            <div
              key={which}
              className={`palette-row${target === which ? ' is-active' : ''}`}
              data-testid={`palette-row-${which}`}
            >
              <span className="palette-row__name">{label}</span>
              {renderSwatch(which)}
              <button
                type="button"
                className="palette-row__value"
                data-testid={`palette-${which}-hex`}
                title={`编辑${label}颜色：${value ?? '无'}`}
                aria-label={`${label}颜色 ${value ?? '无'}`}
                onClick={() => {
                  setTarget(which);
                  setOpen(true);
                }}
              >
                {value ?? '无'}
              </button>
            </div>
          );
        })}

        <div className="palette-recent" aria-label="最近使用颜色">
          <span className="palette-recent__label">最近</span>
          {recentPreview.map((item) => (
            <button
              key={item}
              type="button"
              className="swatch swatch--quick"
              style={{ background: item }}
              title={item}
              onClick={() => {
                apply(item);
              }}
            />
          ))}
        </div>
      </div>

      {open && popover
        ? createPortal(
            <div
              className="color-popover"
              data-testid="color-popover"
              ref={popoverRef}
              style={{ left: popover.left, top: popover.top }}
              role="dialog"
              aria-modal="false"
              aria-label="调色板"
              tabIndex={-1}
            >
              <div className="color-panel__modes">
                <button
                  type="button"
                  data-color-mode="palette"
                  className={mode === 'palette' ? 'is-active' : ''}
                  title="色板"
                  onClick={() => setMode('palette')}
                >
                  <Icon name="grid" size={15} />
                </button>
                <button
                  type="button"
                  data-color-mode="wheel"
                  className={mode === 'wheel' ? 'is-active' : ''}
                  title="色环"
                  onClick={() => setMode('wheel')}
                >
                  <Icon name="circle" size={15} />
                </button>
                <button
                  type="button"
                  data-color-mode="slider"
                  className={mode === 'slider' ? 'is-active' : ''}
                  title="滑块"
                  onClick={() => setMode('slider')}
                >
                  <Icon name="alignLeft" size={15} />
                </button>
                <div className="color-panel__target">
                  <button
                    type="button"
                    data-color-target-tab="fill"
                    className={target === 'fill' ? 'is-active' : ''}
                    onClick={() => setTarget('fill')}
                  >
                    填充
                  </button>
                  <button
                    type="button"
                    data-color-target-tab="stroke"
                    className={target === 'stroke' ? 'is-active' : ''}
                    onClick={() => setTarget('stroke')}
                  >
                    描边
                  </button>
                </div>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm color-popover__close"
                  title="收起"
                  onClick={() => setOpen(false)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>

              <div className="color-panel__none-row">
                <button
                  type="button"
                  className={`color-none-option${target === 'fill' ? ' is-target' : ''}`}
                  data-testid="fill-none"
                  title="无填充：只保留轮廓"
                  onClick={() => {
                    setTarget('fill');
                    onChangeFill(null);
                  }}
                >
                  <NoneSwatch active={fill === null} />
                  无填充
                </button>
                <button
                  type="button"
                  className={`color-none-option${target === 'stroke' ? ' is-target' : ''}`}
                  data-testid="stroke-none"
                  title="无描边：只保留填充"
                  onClick={() => {
                    setTarget('stroke');
                    onChangeStroke(null);
                  }}
                >
                  <NoneSwatch active={stroke === null} />
                  无描边
                </button>
              </div>

              {mode === 'wheel' ? (
                <div className="color-wheel">
                  <div
                    ref={ringRef}
                    className="color-wheel__ring"
                    data-testid="color-wheel"
                    onPointerDown={(event) => {
                      dragging.current = 'ring';
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                    }}
                  >
                    <span
                      className="color-wheel__knob"
                      style={{ transform: `rotate(${hue - 90}deg) translateY(-88px)` }}
                    />
                    <div
                      ref={squareRef}
                      className="color-wheel__square"
                      style={{ background: wheelColor }}
                      onPointerDown={(event) => {
                        dragging.current = 'square';
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture?.(event.pointerId);
                      }}
                    >
                      <span className="color-wheel__white" />
                      <span className="color-wheel__black" />
                      <span
                        className="color-wheel__cursor"
                        style={{ left: `${sat * 100}%`, top: `${(1 - val) * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {mode === 'palette' ? (
                <div className="color-palette">
                  {PALETTE_GROUPS.map((group) => (
                    <section key={group.name}>
                      <h4>{group.name}</h4>
                      <div className="color-grid">
                        {group.colors.map((swatch) => (
                          <button
                            key={`${group.name}-${swatch}`}
                            type="button"
                            className={`swatch${color.toUpperCase() === swatch ? ' is-active' : ''}`}
                            style={{ background: swatch }}
                            title={swatch}
                            aria-label={`颜色 ${swatch}`}
                            onClick={() => apply(swatch)}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : null}

              {mode === 'slider' ? (
                <div className="color-sliders">
                  <div className="color-sliders__hex">
                    <span>#</span>
                    <input
                      value={hexDraft}
                      spellCheck={false}
                      aria-label="十六进制颜色"
                      onChange={(event) => {
                        setHexDraft(event.target.value);
                        const normalized = normalizeHex(event.target.value);
                        if (normalized) apply(normalized);
                      }}
                      onBlur={() => setHexDraft(color.replace('#', ''))}
                    />
                    <span className="color-sliders__solid" style={{ background: color }} />
                  </div>

                  {(['r', 'g', 'b'] as const).map((channel) => (
                    <div className="color-slider-row" key={channel}>
                      <span>{channel.toUpperCase()}</span>
                      <input
                        type="range"
                        min={0}
                        max={255}
                        value={rgb[channel]}
                        className={`color-slider color-slider--${channel}`}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          const next = { ...rgb, [channel]: value };
                          apply(rgbToHex(next.r, next.g, next.b));
                        }}
                      />
                      <input
                        className="color-slider__value"
                        type="number"
                        min={0}
                        max={255}
                        value={Math.round(rgb[channel])}
                        onChange={(event) => {
                          const value = clamp(Number(event.target.value) || 0, 0, 255);
                          const next = { ...rgb, [channel]: value };
                          apply(rgbToHex(next.r, next.g, next.b));
                        }}
                      />
                    </div>
                  ))}

                  {(['h', 's', 'v'] as const).map((key) => {
                    const max = key === 'h' ? 360 : 100;
                    const raw = key === 'h' ? hsv.h : key === 's' ? hsv.s * 100 : hsv.v * 100;
                    return (
                      <div className="color-slider-row" key={key}>
                        <span>{key.toUpperCase()}</span>
                        <input
                          type="range"
                          min={0}
                          max={max}
                          value={Math.round(raw)}
                          className={`color-slider color-slider--${key}`}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            applyHsv(
                              key === 'h' ? value : hue,
                              key === 's' ? value / 100 : sat,
                              key === 'v' ? value / 100 : val
                            );
                          }}
                        />
                        <input
                          className="color-slider__value"
                          type="number"
                          min={0}
                          max={max}
                          value={Math.round(raw)}
                          onChange={(event) => {
                            const value = clamp(Number(event.target.value) || 0, 0, max);
                            applyHsv(
                              key === 'h' ? value : hue,
                              key === 's' ? value / 100 : sat,
                              key === 'v' ? value / 100 : val
                            );
                          }}
                        />
                      </div>
                    );
                  })}

                  {(['c', 'm', 'y', 'k'] as const).map((key) => (
                    <div className="color-slider-row" key={key}>
                      <span>{key.toUpperCase()}</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round(cmyk[key])}
                        className={`color-slider color-slider--${key}`}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          const next = { ...cmyk, [key]: value };
                          const k = next.k / 100;
                          const r = 255 * (1 - next.c / 100) * (1 - k);
                          const g = 255 * (1 - next.m / 100) * (1 - k);
                          const b = 255 * (1 - next.y / 100) * (1 - k);
                          apply(rgbToHex(r, g, b));
                        }}
                      />
                      <input
                        className="color-slider__value"
                        type="number"
                        min={0}
                        max={100}
                        value={Math.round(cmyk[key])}
                        onChange={(event) => {
                          const value = clamp(Number(event.target.value) || 0, 0, 100);
                          const next = { ...cmyk, [key]: value };
                          const k = next.k / 100;
                          const r = 255 * (1 - next.c / 100) * (1 - k);
                          const g = 255 * (1 - next.m / 100) * (1 - k);
                          const b = 255 * (1 - next.y / 100) * (1 - k);
                          apply(rgbToHex(r, g, b));
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              {recent.length > 0 ? (
                <div className="color-panel__recent">
                  <span>最近</span>
                  <div className="color-panel__recent-list">
                    {recent.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className="swatch swatch--quick"
                        style={{ background: item }}
                        title={item}
                        aria-label={`最近颜色 ${item}`}
                        onClick={() => apply(item)}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="color-panel__clear-recent"
                    title="清空最近颜色"
                    onClick={() => {
                      setRecent([]);
                      writeRecent([]);
                    }}
                  >
                    清空
                  </button>
                </div>
              ) : null}

              <p className="color-popover__hint">
                目标：{target === 'fill' ? '填充' : '描边'} · 未选中对象时修改的是新图形默认样式
              </p>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
