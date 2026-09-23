import { formatTime } from "../lib/format";
import type { TransportState } from "../types";

interface Props {
  state: TransportState;
  position: number;
  duration: number;
  onPlayPause: () => void;
  onStop: () => void;
  onRecord: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}

export function TransportBar({
  state,
  position,
  duration,
  onPlayPause,
  onStop,
  onRecord,
  onZoomIn,
  onZoomOut,
  onFit,
}: Props) {
  return (
    <div className="transport">
      <div className="transport__buttons">
        <button
          type="button"
          className="transport__play"
          onClick={onPlayPause}
          disabled={!state.ready || duration <= 0}
          title={state.playing ? "Pause (space)" : "Play (space)"}
          aria-label={state.playing ? "Pause" : "Play"}
        >
          {state.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={!state.ready}
          title="Stop and return to the start"
          aria-label="Stop"
        >
          <StopIcon />
        </button>
        <button
          type="button"
          onClick={onRecord}
          disabled={state.playing || !state.ready}
          title="Record audio (R)"
          aria-label="Record"
          className="transport__record"
        >
          <RecordIcon />
        </button>
      </div>

      <div className="transport__time">
        <span className="transport__position">{formatTime(position)}</span>
        <span className="transport__duration">/ {formatTime(duration)}</span>
      </div>

      <div className="transport__spacer" />

      {state.error && <span className="transport__error">{state.error}</span>}

      <div className="transport__zoom">
        <button type="button" onClick={onZoomIn} title="Zoom in (+)">
          +
        </button>
        <button type="button" onClick={onZoomOut} title="Zoom out (−)">
          −
        </button>
        <button type="button" onClick={onFit} title="Fit the whole session (0)">
          Fit
        </button>
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function RecordIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <circle cx="8" cy="8" r="5" fill="currentColor" />
    </svg>
  );
}
