import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * 浮层/模态焦点管理：
 * - 打开时聚焦 initialSelector 或首个可聚焦元素；
 * - Tab / Shift+Tab 在容器内循环；
 * - Esc 只关闭当前层，并阻止事件继续冒泡到全局快捷键；
 * - 关闭后焦点回到打开前的元素。
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement>,
  active: boolean,
  onClose: () => void,
  initialSelector?: string
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const focusables = () =>
      Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (element) => element.offsetParent !== null
      );

    const initial =
      (initialSelector ? root?.querySelector<HTMLElement>(initialSelector) : null) ??
      focusables()[0] ??
      root;
    initial?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !root) return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // 只有键盘关闭（焦点仍在层内）才归还焦点；点画布关闭时不抢焦点。
      if (root?.contains(document.activeElement)) previous?.focus?.();
    };
  }, [active, ref, initialSelector]);
}
