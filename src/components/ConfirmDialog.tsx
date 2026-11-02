interface Props {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDangerous?: boolean;
  /** Keeps what the dialog is about readable behind it. */
  clearBackdrop?: boolean;
  /** Sits above every other dialog, for when one may already be open. */
  onTop?: boolean;
  /** A third choice between cancelling and confirming. */
  secondaryText?: string;
  onSecondary?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  isDangerous = false,
  clearBackdrop = false,
  onTop = false,
  secondaryText,
  onSecondary,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div
      className={`modal__backdrop${clearBackdrop ? " modal__backdrop--clear" : ""}${
        onTop ? " modal__backdrop--top" : ""
      }`}
      onClick={onCancel}
    >
      <div className="modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>{title}</h2>
          <button className="modal__close" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__body">
          <p className="confirm-message">{message}</p>

          <div className="confirm-buttons">
            <button onClick={onCancel} className="btn btn--secondary" autoFocus>
              {cancelText}
            </button>
            {secondaryText && (
              <button onClick={onSecondary} className="btn btn--secondary">
                {secondaryText}
              </button>
            )}
            <button
              onClick={onConfirm}
              className={isDangerous ? "btn btn--danger" : "btn btn--primary"}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
