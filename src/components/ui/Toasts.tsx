import { useAppStore } from '../../store/useAppStore';
import { Icon } from './Icon';

export function Toasts() {
  const toasts = useAppStore((state) => state.toasts);
  const dismissToast = useAppStore((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} data-testid="toast">
          <span className="toast__icon">
            <Icon
              name={toast.tone === 'success' ? 'check' : toast.tone === 'warn' ? 'warning' : 'info'}
              size={15}
            />
          </span>
          <span className="toast__message">{toast.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="关闭提示"
            onClick={() => dismissToast(toast.id)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
