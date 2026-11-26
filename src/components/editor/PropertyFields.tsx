import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';

export function Stepper({
  value,
  min,
  max,
  onChange
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="stepper">
      <button type="button" aria-label="减少" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <Icon name="minus" size={13} />
      </button>
      <span>{value > 0 ? `+${value}` : value}</span>
      <button type="button" aria-label="增加" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        <Icon name="plus" size={13} />
      </button>
    </div>
  );
}

export function NumberField({
  label,
  value,
  suffix,
  disabled,
  placeholder,
  commitWhenEmpty = false,
  onCommit
}: {
  label: string;
  value: number | null;
  suffix?: string;
  disabled?: boolean;
  placeholder?: string;
  /** value 为 null 时仍提交输入的数值（用于"相对增量"字段，提交后清空）。 */
  commitWhenEmpty?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(Math.round(value * 10) / 10));
  useEffect(() => {
    setDraft(value === null ? '' : String(Math.round(value * 10) / 10));
  }, [value]);
  // 面板可能因切换选择/关闭而卸载；此时 blur 不会触发，必须主动结束事务。
  useEffect(() => () => useAppStore.getState().endTransaction(), []);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-unit">
        <input
          className="input"
          value={draft}
          disabled={disabled}
          placeholder={placeholder ?? '—'}
          onFocus={() => useAppStore.getState().beginTransaction()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const next = Number.parseFloat(draft);
            if (!Number.isNaN(next) && (value !== null || commitWhenEmpty)) onCommit(next);
            // 非法 / 被父级拒绝的输入要回到当前真实值，不能把旧文本留在框里造成“已改”的错觉。
            if (commitWhenEmpty) setDraft('');
            else setDraft(value === null ? '' : String(Math.round(value * 10) / 10));
            useAppStore.getState().endTransaction();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
        />
        {suffix ? <em>{suffix}</em> : null}
      </div>
    </label>
  );
}

export function TextDraft({
  value,
  multiline,
  placeholder,
  onCommit
}: {
  value: string;
  multiline?: boolean;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => useAppStore.getState().endTransaction(), []);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        className="input prop-textarea"
        value={draft}
        placeholder={placeholder}
        onFocus={() => useAppStore.getState().beginTransaction()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          commit();
          useAppStore.getState().endTransaction();
        }}
      />
    );
  }
  return (
    <input
      className="input"
      value={draft}
      placeholder={placeholder}
      onFocus={() => useAppStore.getState().beginTransaction()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        commit();
        useAppStore.getState().endTransaction();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
      }}
    />
  );
}
