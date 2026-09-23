import { SUPPORTED_EXTENSIONS } from "../lib/api";
import { isRunningInTauri } from "../lib/tauri";

interface Props {
  onBrowse: () => void;
  isDragging: boolean;
  isImporting: boolean;
  importingName: string | null;
  error: string | null;
}

export function ImportScreen({ onBrowse, isDragging, isImporting, importingName, error }: Props) {
  return (
    <div className="import">
      {!isRunningInTauri() && (
        <div className="import__brand">
          <h1>zwaveEditor</h1>
          <p>Open sound files to see their waveforms and play them together.</p>
        </div>
      )}

      <button
        type="button"
        className={`dropzone${isDragging ? " dropzone--active" : ""}${
          isImporting ? " dropzone--busy" : ""
        }`}
        onClick={onBrowse}
        disabled={isImporting}
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
              {isDragging ? "Drop to open" : "Drop audio files here"}
            </span>
            <span className="dropzone__hint">
              or click to browse — pick several to play them in parallel
            </span>
          </>
        )}
      </button>

      {error && <p className="import__error">{error}</p>}

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
