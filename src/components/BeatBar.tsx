import { useState } from "react";

import { clampBpm, formatBarBeat, MAX_BPM, MIN_BPM, SNAP_OPTIONS } from "../lib/beat";
import type { BeatSettings, SnapDivision } from "../types";

interface Props {
  settings: BeatSettings;
  position: number;
  onChange: (changes: Partial<BeatSettings>) => void;
  onNewPattern: () => void;
}

/** Beat mode's toolbar: tempo, snap, the pattern maker, and the master bus. */
export function BeatBar({ settings, position, onChange, onNewPattern }: Props) {
  // What is typed into the tempo field, until it is committed.
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);

  const commitBpm = () => {
    if (bpmDraft === null) return;
    const value = Number(bpmDraft);
    if (bpmDraft.trim() !== "" && Number.isFinite(value)) onChange({ bpm: clampBpm(value) });
    setBpmDraft(null);
  };

  const gainDb = settings.masterGain > 0 ? 20 * Math.log10(settings.masterGain) : -Infinity;

  return (
    <div className="beatbar">
      <label className="beatbar__field">
        <span className="beatbar__label">Tempo</span>
        <input
          type="number"
          className="beatbar__bpm"
          min={MIN_BPM}
          max={MAX_BPM}
          step={1}
          value={bpmDraft ?? String(settings.bpm)}
          onChange={(event) => setBpmDraft(event.target.value)}
          onBlur={commitBpm}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setBpmDraft(null);
              event.currentTarget.blur();
            }
          }}
          aria-label="Tempo in beats per minute"
        />
        <span className="beatbar__unit">BPM</span>
      </label>

      <label className="beatbar__field">
        <span className="beatbar__label">Snap</span>
        <select
          value={settings.snap}
          onChange={(event) => onChange({ snap: event.target.value as SnapDivision })}
          aria-label="Snap to grid"
        >
          {SNAP_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <span className="beatbar__position" title="Playhead in bar.beat.sixteenth">
        {formatBarBeat(position, settings.bpm)}
      </span>

      <button type="button" className="beatbar__new" onClick={onNewPattern}>
        + New pattern
      </button>

      <div className="beatbar__spacer" />

      <label className="beatbar__field beatbar__master">
        <span className="beatbar__label">Master</span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={settings.masterGain}
          onChange={(event) => onChange({ masterGain: Number(event.target.value) })}
          onDoubleClick={() => onChange({ masterGain: 1 })}
          title="Master volume — double-click for 0 dB"
          aria-label="Master volume"
        />
        <span className="beatbar__unit beatbar__db">
          {Number.isFinite(gainDb) ? `${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)} dB` : "−∞"}
        </span>
      </label>

      <label className="beatbar__check" title="Keeps the mix from clipping, in playback and in the master export">
        <input
          type="checkbox"
          checked={settings.limiter}
          onChange={(event) => onChange({ limiter: event.target.checked })}
        />
        Limiter
      </label>
    </div>
  );
}
