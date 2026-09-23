import { useState } from "react";

import { channelLayoutName, formatSampleRate, formatTime } from "../lib/format";
import type { Track } from "../types";

interface Props {
  track: Track;
  colors: { peak: string; rms: string };
  index: number;
  onChange: (changes: Partial<Track>) => void;
  onRemove: () => void;
  onUndo: () => void;
}

export function TrackHeader({ track, colors, index, onChange, onRemove, onUndo }: Props) {
  const { clip } = track;
  // What is typed into the start field, until it is committed.
  const [offsetDraft, setOffsetDraft] = useState<string | null>(null);

  const commitOffset = () => {
    if (offsetDraft === null) return;
    const seconds = Number(offsetDraft);
    if (offsetDraft.trim() !== "" && Number.isFinite(seconds)) {
      onChange({ offset: Math.max(0, seconds) });
    }
    setOffsetDraft(null);
  };

  return (
    <div className="track__header">
      <div className="track__title">
        <input
          type="checkbox"
          className="track__include"
          checked={track.inMaster}
          onChange={(event) => onChange({ inMaster: event.target.checked })}
          title="Include in the master track and in exports"
          aria-label={`Include ${clip.name} in the master`}
        />
        <span className="track__swatch" style={{ background: colors.peak }} />
        <span className="track__name" title={clip.path}>
          {index + 1}. {clip.name}
        </span>
        <button
          type="button"
          className="track__icon"
          onClick={onUndo}
          disabled={!clip.canUndo}
          title="Undo the last edit on this track"
          aria-label={`Undo the last edit on ${clip.name}`}
        >
          ↶
        </button>
        <button
          type="button"
          className="track__icon track__remove"
          onClick={onRemove}
          title="Remove track"
          aria-label={`Remove ${clip.name}`}
        >
          ×
        </button>
      </div>

      <p className="track__meta">
        {formatTime(clip.durationSecs, 2)} · {formatSampleRate(clip.sampleRate)} ·{" "}
        {channelLayoutName(clip.channelCount)}
      </p>

      <div className="track__controls">
        <button
          type="button"
          className={`toggle${track.muted ? " toggle--on toggle--mute" : ""}`}
          onClick={() => onChange({ muted: !track.muted })}
          title="Mute"
          aria-pressed={track.muted}
        >
          M
        </button>
        <button
          type="button"
          className={`toggle${track.soloed ? " toggle--on toggle--solo" : ""}`}
          onClick={() => onChange({ soloed: !track.soloed })}
          title="Solo"
          aria-pressed={track.soloed}
        >
          S
        </button>
        <input
          type="range"
          className="track__gain"
          min={0}
          max={1.5}
          step={0.01}
          value={track.gain}
          onChange={(event) => onChange({ gain: Number(event.target.value) })}
          title={`Volume ${Math.round(track.gain * 100)}%`}
          aria-label={`Volume for ${clip.name}`}
        />
        <input
          type="number"
          className="track__offset"
          min={0}
          step={0.01}
          value={offsetDraft ?? String(Number(track.offset.toFixed(3)))}
          onChange={(event) => setOffsetDraft(event.target.value)}
          onBlur={commitOffset}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setOffsetDraft(null);
              event.currentTarget.blur();
            }
          }}
          title={`Starts at ${formatTime(track.offset)} — ⌘/Ctrl + drag the waveform to move it`}
          aria-label={`Start time in seconds for ${clip.name}`}
        />
      </div>
    </div>
  );
}
