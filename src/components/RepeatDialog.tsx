import { useState } from "react";
import type { Selection } from "../types";

interface Props {
  selection: Selection;
  onRepeat: (count: number) => Promise<void>;
  onClose: () => void;
}

export function RepeatDialog({ selection, onRepeat, onClose }: Props) {
  const [count, setCount] = useState(2);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duration = selection.end - selection.start;
  const resultDuration = duration * count;

  const handleRepeat = async () => {
    try {
      setError(null);
      setProcessing(true);
      await onRepeat(count);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProcessing(false);
    }
  };

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Repeat Selection</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__body">
          {error && <p className="modal__error">{error}</p>}

          <div className="repeat-form">
            <label>
              Repeat count:
              <input
                type="number"
                min="1"
                max="100"
                value={count}
                onChange={(e) => setCount(Math.max(1, parseInt(e.target.value) || 1))}
                disabled={processing}
              />
            </label>

            <div className="repeat-preview">
              <p>Original duration: {duration.toFixed(2)}s</p>
              <p>Result duration: {resultDuration.toFixed(2)}s</p>
            </div>

            <div className="repeat-buttons">
              <button onClick={handleRepeat} disabled={processing} className="btn btn--primary">
                Repeat
              </button>
              <button onClick={onClose} disabled={processing} className="btn btn--secondary">
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
