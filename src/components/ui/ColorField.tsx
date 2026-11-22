import { useEffect, useState } from 'react';

interface ColorFieldProps {
  label: string;
  value: string | null;
  onChange: (color: string) => void;
  onClear?: () => void;
  clearLabel?: string;
}

const HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/;

/** 常驻调色板：覆盖中性色、主色与化学结构常用的高对比色。 */
export const QUICK_PALETTE = [
  '#1B1B1B',
  '#3D4450',
  '#64748B',
  '#94A3B8',
  '#D7DEE8',
  '#FFFFFF',
  '#3F6DF0',
  '#2563EB',
  '#0EA5E9',
  '#0F9D8F',
  '#2F9E44',
  '#D97706',
  '#E8590C',
  '#E5484D',
  '#DB2777',
  '#7C5CF0'
];

export function ColorField({ label, value, onChange, onClear, clearLabel = '无' }: ColorFieldProps) {
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  const commit = (raw: string) => {
    setDraft(raw);
    if (HEX_PATTERN.test(raw)) {
      onChange(raw.startsWith('#') ? raw.toUpperCase() : `#${raw.toUpperCase()}`);
    }
  };

  const normalized = value ? value.toUpperCase() : null;

  return (
    <div className="color-field">
      <div className="color-field__row">
        <span className="color-field__label">{label}</span>
        <label
          className={`color-swatch${value ? '' : ' is-empty'}`}
          style={value ? { background: value } : undefined}
          title="打开系统取色器"
        >
          <input
            type="color"
            value={value ?? '#ffffff'}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            tabIndex={-1}
          />
          {!value ? <span className="color-swatch__slash" /> : null}
        </label>
        <input
          className="input input--hex"
          value={draft}
          placeholder="无"
          spellCheck={false}
          onChange={(event) => commit(event.target.value)}
          onBlur={() => setDraft(value ?? '')}
        />
        {onClear ? (
          <button type="button" className="mini-btn" onClick={onClear}>
            {clearLabel}
          </button>
        ) : null}
      </div>
      <div className="color-field__palette" aria-label={`${label}常用颜色`}>
        {QUICK_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            className={`swatch swatch--quick${normalized === color ? ' is-active' : ''}`}
            style={{ background: color }}
            title={color}
            aria-label={color}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
    </div>
  );
}
