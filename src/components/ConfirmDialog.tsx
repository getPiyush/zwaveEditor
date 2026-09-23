interface Props {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDangerous?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  isDangerous = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div className="modal__backdrop" onClick={onCancel}>
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
            <button onClick={onCancel} className="btn btn--secondary">
              {cancelText}
            </button>
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
