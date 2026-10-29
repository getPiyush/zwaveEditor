import { SUPPORTED_EXTENSIONS } from "../lib/api";

interface Props {
  onRecord: () => void;
  onAddFiles: () => void;
  canRecord: boolean;
  isDragging: boolean;
  isImporting: boolean;
  importingName: string | null;
  /** Beat mode only: start a session from a step pattern, no files needed. */
  onNewPattern?: () => void;
}

/** What the session shows before it has any tracks. */
export function EmptySession({
  onRecord,
  onAddFiles,
  canRecord,
  isDragging,
  isImporting,
  importingName,
  onNewPattern,
}: Props) {
  return (
    <div className="empty">
      <div
        className={`dropzone${isDragging ? " dropzone--active" : ""}${
          isImporting ? " dropzone--busy" : ""
        }`}
      >
        {isImporting ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="dropzone__title">Decoding {importingName}…</span>
            <span className="dropzone__hint">Reading the file and building its waveform</span>
          </>
        ) : (
          <>
            <WaveIcon />
            <span className="dropzone__title">
              {isDragging ? "Drop to open" : "Record, or drop audio files here"}
            </span>
            <span className="dropzone__hint">
              press R to record — add several files to play them in parallel
            </span>
            <div className="dropzone__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={onRecord}
                disabled={!canRecord}
              >
                Record
              </button>
              <button type="button" className="btn" onClick={onAddFiles}>
                Add files…
              </button>
            </div>
          </>
        )}
      </div>

      {onNewPattern && !isImporting && (
        <button type="button" className="empty__pattern" onClick={onNewPattern}>
          <span className="empty__pattern-title">Start a beat</span>
          <span className="empty__pattern-hint">
            Program drums, 808s and chimes on a step grid — no files needed
          </span>
        </button>
      )}

      <div className="formats">
        <span className="formats__label">Supported</span>
        <ul className="formats__list">
          {SUPPORTED_EXTENSIONS.map((ext) => (
            <li key={ext} className="chip">
              {ext}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function WaveIcon() {
  // A static mini-waveform, sized in the same proportions as a real one.
  const bars = [0.3, 0.55, 0.85, 0.45, 1, 0.65, 0.35, 0.75, 0.5, 0.25];
  return (
    <svg className="wave-icon" viewBox="0 0 100 40" aria-hidden="true">
      {bars.map((value, index) => {
        const height = value * 34;
        return (
          <rect
            key={index}
            x={index * 10 + 3}
            y={20 - height / 2}
            width={4}
            height={height}
            rx={2}
          />
        );
      })}
    </svg>
  );
}
