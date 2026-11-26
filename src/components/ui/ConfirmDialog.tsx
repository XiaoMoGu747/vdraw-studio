import { Icon } from './Icon';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  title: string;
  message: string;
  hint?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  extraLabel?: string;
  extraTone?: 'danger' | 'outline';
  tone?: 'primary' | 'danger' | 'success';
  testId?: string;
  onConfirm: () => void;
  onExtra?: () => void;
  onCancel: () => void;
}

/** 全应用统一的确认框：复用 Modal 的焦点陷阱、Esc 与遮罩关闭。 */
export function ConfirmDialog({
  title,
  message,
  hint,
  confirmLabel = '确定',
  cancelLabel = '取消',
  extraLabel,
  extraTone = 'danger',
  tone = 'primary',
  testId,
  onConfirm,
  onExtra,
  onCancel
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <button
            type="button"
            className="btn btn--outline btn--sm"
            data-testid={testId ? `${testId}-cancel` : undefined}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          {extraLabel && onExtra ? (
            <button
              type="button"
              className={`btn btn--sm ${extraTone === 'danger' ? 'btn--danger' : 'btn--outline'}`}
              data-testid={testId ? `${testId}-extra` : undefined}
              onClick={onExtra}
            >
              {extraLabel}
            </button>
          ) : null}
          <button
            type="button"
            className={`btn btn--sm ${
              tone === 'danger'
                ? 'btn--danger'
                : tone === 'success'
                  ? 'btn--success'
                  : 'btn--primary'
            }`}
            data-testid={testId ? `${testId}-confirm` : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-dialog" data-testid={testId}>
        <span
          className={`confirm-dialog__icon${tone === 'danger' ? ' is-danger' : ''}`}
          aria-hidden="true"
        >
          <Icon name="warning" size={18} />
        </span>
        <div className="confirm-dialog__body">
          <p>{message}</p>
          {hint ? <em>{hint}</em> : null}
        </div>
      </div>
    </Modal>
  );
}
