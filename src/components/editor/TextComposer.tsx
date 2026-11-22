import { useEffect, useRef } from 'react';
import { FONT_CHOICES } from '../../core/tools';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';

interface TextComposerProps {
  /** 左侧输入框的内容：只有用户输入才会改它，右侧工具不会回写。 */
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 文字合成器：画布下方浮出的"输入 + 工具"双面板。
 *
 * 交互口径（与主流作图软件一致）：
 * - 左侧只负责**内容**，右侧只负责**格式**；点右侧工具不会改动左侧文字；
 * - 画布中央实时渲染同一套 `patchTextObject` 结果，所见即所得；
 * - 确定后落字成普通文本对象，接着就能旋转/缩放/拖动。
 */
export function TextComposer({ value, onChange, onConfirm, onCancel }: TextComposerProps) {
  const textSettings = useAppStore((state) => state.textSettings);
  const setTextSettings = useAppStore((state) => state.setTextSettings);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // 上标 / 下标 / 项目符号沿用原有的插入事件，插到光标处。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      const element = textareaRef.current;
      if (!element || typeof detail !== 'string') return;
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      const next = `${element.value.slice(0, start)}${detail}${element.value.slice(end)}`;
      onChange(next);
      const caret = start + detail.length;
      window.requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(caret, caret);
      });
    };
    window.addEventListener('vdraw:insert-text', handler);
    return () => window.removeEventListener('vdraw:insert-text', handler);
  }, [onChange]);

  const patch = (next: Parameters<typeof setTextSettings>[0]) => setTextSettings(next);
  const insert = (text: string) =>
    window.dispatchEvent(new CustomEvent('vdraw:insert-text', { detail: text }));

  const fontSize = Math.max(6, Math.round(textSettings.fontSize));
  // 间距按"字号的百分比"呈现：画家更关心相对疏密，而不是绝对像素。
  const spacingPercent =
    textSettings.fontSize > 0
      ? Math.round((textSettings.letterSpacing / textSettings.fontSize) * 100)
      : 0;
  const setSpacing = (percent: number) =>
    patch({ letterSpacing: Number(((percent / 100) * fontSize).toFixed(2)) });
  const align = textSettings.align ?? 'left';
  const bold = textSettings.fontWeight >= 600;

  return (
    <div
      className="text-composer"
      data-testid="text-composer"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="text-composer__input">
        <textarea
          ref={textareaRef}
          className="text-composer__area"
          data-testid="text-composer-input"
          value={value}
          placeholder="输入文字内容"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onConfirm();
            }
          }}
        />
      </div>

      <div className="text-composer__tools">
        <header className="text-composer__head">
          <span className="text-composer__title">文字</span>
          <button
            type="button"
            className="text-composer__action is-primary"
            data-testid="text-composer-confirm"
            onClick={onConfirm}
          >
            确定
          </button>
          <button
            type="button"
            className="text-composer__action"
            data-testid="text-composer-cancel"
            onClick={onCancel}
          >
            取消
          </button>
        </header>

        <label className="text-composer__field text-composer__field--font">
          <select
            data-testid="text-font"
            value={textSettings.fontFamily}
            onChange={(event) => patch({ fontFamily: event.target.value })}
          >
            {FONT_CHOICES.map((font) => (
              <option key={font.value} value={font.value}>
                {font.label}
              </option>
            ))}
          </select>
        </label>

        <div className="text-composer__field">
          <span className="text-composer__label">大小</span>
          <input
            type="number"
            min={6}
            max={200}
            data-testid="text-size"
            value={fontSize}
            onChange={(event) => patch({ fontSize: Math.max(6, Number(event.target.value) || 20) })}
          />
        </div>
        <input
          className="text-composer__slider"
          type="range"
          min={6}
          max={120}
          step={1}
          aria-label="字号"
          value={fontSize}
          onChange={(event) => patch({ fontSize: Number(event.target.value) })}
        />

        <div className="text-composer__field">
          <span className="text-composer__label">间距</span>
          <input
            type="number"
            min={-20}
            max={100}
            data-testid="text-spacing"
            value={spacingPercent}
            onChange={(event) => setSpacing(Number(event.target.value) || 0)}
          />
          <em>%</em>
        </div>
        <input
          className="text-composer__slider"
          type="range"
          min={-20}
          max={80}
          step={1}
          aria-label="字间距"
          value={spacingPercent}
          onChange={(event) => setSpacing(Number(event.target.value))}
        />

        <div className="text-composer__field">
          <span className="text-composer__label">方向</span>
          <div className="text-composer__segment">
            {(
              [
                ['horizontal', '横排'],
                ['vertical', '竖排']
              ] as const
            ).map(([direction, label]) => (
              <button
                key={direction}
                type="button"
                data-text-direction={direction}
                className={textSettings.direction === direction ? 'is-active' : ''}
                onClick={() => patch({ direction })}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-composer__label text-composer__label--tight">颜色</span>
          <input
            type="color"
            data-testid="text-color"
            value={textSettings.color}
            onChange={(event) => patch({ color: event.target.value.toUpperCase() })}
          />
        </div>

        <div className="text-composer__field">
          <span className="text-composer__label">属性</span>
          <div className="text-composer__segment" data-testid="text-align">
            {(
              [
                ['left', 'alignLeft', '左对齐'],
                ['center', 'alignCenterH', '居中'],
                ['right', 'alignRight', '右对齐']
              ] as const
            ).map(([value, icon, title]) => (
              <button
                key={value}
                type="button"
                data-text-align={value}
                title={title}
                className={align === value ? 'is-active' : ''}
                onClick={() => patch({ align: value })}
              >
                <Icon name={icon} size={15} />
              </button>
            ))}
            <button
              type="button"
              data-testid="text-bold"
              title="加粗"
              className={bold ? 'is-active' : ''}
              onClick={() => patch({ fontWeight: bold ? 400 : 700 })}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              data-testid="text-italic-toggle"
              title="斜体"
              className={textSettings.italic ? 'is-active' : ''}
              onClick={() => patch({ italic: !textSettings.italic })}
            >
              <em>I</em>
            </button>
            <button
              type="button"
              data-testid="text-superscript"
              title="插入上标（^{2}）"
              onClick={() => insert('^{}')}
            >
              x²
            </button>
            <button
              type="button"
              data-testid="text-subscript"
              title="插入下标（_{2}）"
              onClick={() => insert('_{}')}
            >
              x₂
            </button>
            <button
              type="button"
              data-testid="text-bullet"
              title="插入项目符号"
              onClick={() => insert('• ')}
            >
              •
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
