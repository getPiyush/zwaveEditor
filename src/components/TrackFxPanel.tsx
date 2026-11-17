import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { createPortal } from "react-dom";

import { beatSeconds } from "../lib/beat";
import { DEFAULT_FX, fxIsActive, MAX_DELAY_SECONDS } from "../lib/fx";
import type { TrackFx } from "../types";

interface Props {
  name: string;
  fx: TrackFx | undefined;
  /** Beat mode's tempo, for delay times that land on the grid. */
  bpm?: number;
  /** The button it opened from; the panel sits beside it. */
  anchor: HTMLElement;
  onChange: (fx: TrackFx | undefined) => void;
  onClose: () => void;
}

const PANEL_WIDTH = 260;

/** Delay times as fractions of a beat, offered in beat mode. */
const SYNCED_DELAYS: { label: string; beats: number }[] = [
  { label: "1/16", beats: 0.25 },
  { label: "1/8", beats: 0.5 },
  { label: "1/8.", beats: 0.75 },
  { label: "1/4", beats: 1 },
  { label: "1/2", beats: 2 },
];

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * A track's reverb, delay, wet and dry, in a panel floating beside its FX
 * button. It is portalled out of the track header, which clips its contents.
 */
export function TrackFxPanel({ name, fx, bpm, anchor, onChange, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const settings = fx ?? DEFAULT_FX;

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const height = panel.current?.offsetHeight ?? 0;
      const left = Math.min(rect.right + 8, window.innerWidth - PANEL_WIDTH - 8);
      const top = Math.max(8, Math.min(rect.top - 8, window.innerHeight - height - 8));
      setPosition({ top, left: Math.max(8, left) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  // Kept even while it changes nothing (say, Wet set before Reverb), so no
  // setting is lost; the engine skips effects that leave the sound as it is.
  const set = (changes: Partial<TrackFx>) => onChange({ ...settings, ...changes });

  const slider = (
    label: string,
    value: number,
    shown: string,
    min: number,
    max: number,
    step: number,
    apply: (value: number) => void,
    title: string,
  ) => (
    <label className="fx__row" title={title}>
      <span className="fx__label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => apply(Number(event.target.value))}
        aria-label={`${label} for ${name}`}
      />
      <span className="fx__value">{shown}</span>
    </label>
  );

  // A portal still bubbles React events up the component tree, into the
  // track row and the timeline, which would seek, select or grab the pointer.
  // Keys stop here too, so Space on a button doesn't start playback.
  const contain = (event: SyntheticEvent) => event.stopPropagation();

  return createPortal(
    <div
      ref={panel}
      className="fx"
      style={{ top: position.top, left: position.left, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={`Effects for ${name}`}
      onPointerDown={contain}
      onPointerUp={contain}
      onMouseDown={contain}
      onMouseUp={contain}
      onClick={contain}
      onDoubleClick={contain}
      onContextMenu={contain}
      onWheel={contain}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="fx__head">
        <span className="fx__title">Effects · {name}</span>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => onChange(undefined)}
          disabled={!fxIsActive(settings)}
          title="Turn every effect off"
        >
          Reset
        </button>
      </div>

      {slider(
        "Reverb",
        settings.reverb,
        settings.reverb > 0 ? percent(settings.reverb) : "off",
        0,
        1,
        0.01,
        (reverb) => set({ reverb }),
        "Room size: small rooms are tight, large ones ring on. Off at 0.",
      )}
      {slider(
        "Delay",
        settings.delay,
        settings.delay > 0 ? `${Math.round(settings.delay * 1000)} ms` : "off",
        0,
        MAX_DELAY_SECONDS,
        0.005,
        (delay) => set({ delay }),
        "Time between echoes. Off at 0.",
      )}
      {bpm !== undefined && (
        <div className="fx__sync" role="group" aria-label="Delay time in beats">
          {SYNCED_DELAYS.map(({ label, beats }) => {
            const seconds = beatSeconds(bpm) * beats;
            const on = Math.abs(settings.delay - seconds) < 0.002;
            return (
              <button
                key={label}
                type="button"
                className={`btn btn--small${on ? " fx__sync--on" : ""}`}
                disabled={seconds > MAX_DELAY_SECONDS}
                onClick={() => set({ delay: Number(seconds.toFixed(4)) })}
                title={`${label} note at ${bpm} BPM: ${Math.round(seconds * 1000)} ms`}
                aria-pressed={on}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {slider(
        "Feedback",
        settings.feedback,
        percent(settings.feedback),
        0,
        0.9,
        0.01,
        (feedback) => set({ feedback }),
        "How many echoes: each one comes round this much quieter.",
      )}
      {slider(
        "Wet",
        settings.wet,
        percent(settings.wet),
        0,
        1.5,
        0.01,
        (wet) => set({ wet }),
        "Level of the reverb and echoes.",
      )}
      {slider(
        "Dry",
        settings.dry,
        percent(settings.dry),
        0,
        1.5,
        0.01,
        (dry) => set({ dry }),
        "Level of the track itself. Take it to 0 to hear only the effects.",
      )}
      {settings.wet === 0 && (settings.reverb > 0 || settings.delay > 0) && (
        <p className="fx__hint">Turn up Wet to hear the reverb and delay.</p>
      )}
    </div>,
    document.body,
  );
}
