import { useCallback, useEffect, useRef, useState } from "react";

import { pickAudioFiles, previewPattern, stopPatternPreview } from "../lib/api";
import {
  noteName,
  noteRange,
  rowIsTuned,
  STEPS_PER_BAR,
  stepNote,
  synthRow,
  transposeRow,
  VOICE_GROUPS,
  voiceInfo,
} from "../lib/beat";
import type { Pattern, PatternRow, SynthVoice } from "../types";

interface Props {
  initial: Pattern;
  /** The session tempo; the pattern always renders at it. */
  bpm: number;
  /** Whether committing adds a new track or replaces the one being edited. */
  isUpdate: boolean;
  /** Shown above the footer, e.g. that updating drops audio edits. */
  note?: string;
  onCommit: (pattern: Pattern) => Promise<void>;
  onClose: () => void;
}

const MAX_ROWS = 12;
const BAR_CHOICES = [1, 2, 4, 8, 16];
/** How long edits settle before the preview loop is re-rendered. */
const PREVIEW_DEBOUNCE_MS = 120;

const SAMPLE_OPTION = "__sample__";

export function PatternDialog({ initial, bpm, isUpdate, note, onCommit, onClose }: Props) {
  const [pattern, setPattern] = useState<Pattern>(() => ({ ...initial, bpm }));
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // While a drag paints across steps, every cell it enters takes this value.
  const paint = useRef<boolean | null>(null);
  // Only a press that starts on the backdrop closes the dialog; a paint drag
  // that happens to end there must not.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const stop = () => (paint.current = null);
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  // The session tempo can change while the dialog is open.
  useEffect(() => {
    setPattern((current) => (current.bpm === bpm ? current : { ...current, bpm }));
  }, [bpm]);

  // Keep the preview loop in step with every edit, without restarting it.
  useEffect(() => {
    if (!previewing) return;
    const timer = window.setTimeout(() => {
      previewPattern(pattern)
        .then(() => setError(null))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [pattern, previewing]);

  // Whatever happens, leaving the dialog silences the preview.
  useEffect(() => () => void stopPatternPreview().catch(() => {}), []);

  const togglePreview = useCallback(() => {
    if (previewing) void stopPatternPreview().catch(() => {});
    setPreviewing((on) => !on);
  }, [previewing]);

  const updateRow = useCallback((id: string, changes: Partial<PatternRow>) => {
    setPattern((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.id === id ? { ...row, ...changes } : row)),
    }));
  }, []);

  /**
   * Turns a step on or off. On a tuned row, a step turned on takes the row's
   * note (the "brush"), so picking a note and painting writes a melody.
   */
  const setStep = useCallback((id: string, index: number, value: boolean) => {
    setPattern((current) => ({
      ...current,
      rows: current.rows.map((row) => {
        if (row.id !== id) return row;
        const tuned = rowIsTuned(row);
        const note = value && tuned ? row.note : null;
        const sameNote = !tuned || (row.stepNotes?.[index] ?? null) === note;
        if (row.steps[index] === value && sameNote) return row;
        const steps = [...row.steps];
        steps[index] = value;
        if (!tuned) return { ...row, steps };
        const stepNotes = row.steps.map((_, i) => row.stepNotes?.[i] ?? null);
        stepNotes[index] = note;
        return { ...row, steps, stepNotes };
      }),
    }));
  }, []);

  /** Moves one step's note by `semitones`, within the row's range. */
  const nudgeStep = useCallback((id: string, index: number, semitones: number) => {
    setPattern((current) => ({
      ...current,
      rows: current.rows.map((row) => {
        if (row.id !== id || !row.steps[index] || !rowIsTuned(row)) return row;
        const [low, high] = noteRange(row);
        const note = Math.min(high, Math.max(low, stepNote(row, index) + semitones));
        const stepNotes = row.steps.map((_, i) => row.stepNotes?.[i] ?? null);
        stepNotes[index] = note;
        return { ...row, stepNotes };
      }),
    }));
  }, []);

  // The wheel nudges a step's note. React's wheel handler is passive, so this
  // listens natively to stop the grid scrolling at the same time.
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const step = (event.target as HTMLElement).closest<HTMLElement>("[data-nudge]");
      if (!step || event.deltaY === 0) return;
      event.preventDefault();
      nudgeStep(step.dataset.row!, Number(step.dataset.step), event.deltaY < 0 ? 1 : -1);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [nudgeStep]);

  const changeSound = async (row: PatternRow, value: string) => {
    if (value === SAMPLE_OPTION) {
      try {
        const [path] = await pickAudioFiles();
        if (!path) return;
        const name = path.split(/[\\/]/).pop() ?? path;
        updateRow(row.id, {
          sound: { kind: "sample", path, name },
          ...transposeRow(row, 60 - row.note),
          choke: false,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const info = voiceInfo(value as SynthVoice);
    updateRow(row.id, {
      sound: { kind: "synth", voice: info.voice },
      // Shift the whole row, so a melody keeps its shape in the new register.
      ...transposeRow(row, info.note - row.note),
      choke: info.choke,
      gain: info.gain,
    });
  };

  const addRow = () =>
    setPattern((current) => ({ ...current, rows: [...current.rows, synthRow("piano")] }));

  const removeRow = (id: string) =>
    setPattern((current) => ({ ...current, rows: current.rows.filter((row) => row.id !== id) }));

  const clearAll = () =>
    setPattern((current) => ({
      ...current,
      rows: current.rows.map((row) => ({
        ...row,
        steps: row.steps.map(() => false),
        stepNotes: undefined,
      })),
    }));

  const hasHits = pattern.rows.some((row) => !row.muted && row.steps.some(Boolean));

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCommit(pattern);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="modal__backdrop"
      onPointerDown={(event) => (pressedBackdrop.current = event.target === event.currentTarget)}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal__content pattern"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Pattern editor"
      >
        <div className="modal__header">
          <h2>{isUpdate ? "Edit pattern" : "New pattern"}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="pattern__controls">
          <button
            type="button"
            className={`btn btn--small${previewing ? " btn--primary" : ""}`}
            onClick={togglePreview}
            aria-pressed={previewing}
          >
            {previewing ? "■ Stop" : "▶ Preview loop"}
          </button>

          <span className="pattern__tempo">{bpm} BPM</span>

          <label className="pattern__field">
            Length
            <select
              value={pattern.bars}
              onChange={(event) =>
                setPattern((current) => ({ ...current, bars: Number(event.target.value) }))
              }
            >
              {BAR_CHOICES.map((bars) => (
                <option key={bars} value={bars}>
                  {bars} {bars === 1 ? "bar" : "bars"}
                </option>
              ))}
            </select>
          </label>

          <label className="pattern__field pattern__swing">
            Swing {Math.round(pattern.swing * 100)}%
            <input
              type="range"
              min={0}
              max={0.6}
              step={0.01}
              value={pattern.swing}
              onChange={(event) =>
                setPattern((current) => ({ ...current, swing: Number(event.target.value) }))
              }
            />
          </label>

          <button type="button" className="btn btn--small" onClick={clearAll}>
            Clear
          </button>
        </div>

        {error && <p className="modal__error pattern__error">{error}</p>}

        <div className="pattern__grid-scroll">
          <div className="pattern__grid" ref={grid}>
            {pattern.rows.map((row) => (
              <div key={row.id} className={`pattern__row${row.muted ? " pattern__row--muted" : ""}`}>
                <div className="pattern__row-head">
                  <select
                    className="pattern__sound"
                    value={row.sound.kind === "synth" ? row.sound.voice : SAMPLE_OPTION}
                    onChange={(event) => void changeSound(row, event.target.value)}
                    title={row.sound.kind === "sample" ? row.sound.path : undefined}
                    aria-label="Sound"
                  >
                    {VOICE_GROUPS.map(({ group, voices }) => (
                      <optgroup key={group} label={group}>
                        {voices.map((info) => (
                          <option key={info.voice} value={info.voice}>
                            {info.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    <option value={SAMPLE_OPTION}>
                      {row.sound.kind === "sample" ? `File: ${row.sound.name}` : "Load sample…"}
                    </option>
                  </select>

                  {rowIsTuned(row) ? (
                    <select
                      className="pattern__note"
                      value={row.note}
                      onChange={(event) => updateRow(row.id, { note: Number(event.target.value) })}
                      title={
                        row.sound.kind === "sample"
                          ? "Note for new steps (C4 plays the sample as recorded)"
                          : "Note for new steps"
                      }
                      aria-label="Note"
                    >
                      {noteOptions(row).map((note) => (
                        <option key={note} value={note}>
                          {noteName(note)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="pattern__note pattern__note--empty" />
                  )}

                  <input
                    type="range"
                    className="pattern__gain"
                    min={0}
                    max={1.5}
                    step={0.01}
                    value={row.gain}
                    onChange={(event) => updateRow(row.id, { gain: Number(event.target.value) })}
                    title={`Volume ${Math.round(row.gain * 100)}%`}
                    aria-label="Row volume"
                  />

                  <button
                    type="button"
                    className={`toggle${row.choke ? " toggle--on toggle--choke" : ""}`}
                    onClick={() => updateRow(row.id, { choke: !row.choke })}
                    title="Choke: each hit cuts off the last (good for 808s and open hats)"
                    aria-pressed={row.choke}
                  >
                    C
                  </button>
                  <button
                    type="button"
                    className={`toggle${row.muted ? " toggle--on toggle--mute" : ""}`}
                    onClick={() => updateRow(row.id, { muted: !row.muted })}
                    title="Mute this row"
                    aria-pressed={row.muted}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    className="track__icon pattern__remove"
                    onClick={() => removeRow(row.id)}
                    title="Remove row"
                    aria-label="Remove row"
                  >
                    ×
                  </button>
                </div>

                <div className="pattern__steps">
                  {row.steps.map((on, index) => {
                    const tuned = rowIsTuned(row);
                    const note = stepNote(row, index);
                    const melodic = on && tuned;
                    return (
                      <button
                        key={index}
                        type="button"
                        className={`pattern__step${on ? " pattern__step--on" : ""}${
                          index % 4 === 0 ? " pattern__step--beat" : ""
                        }`}
                        data-nudge={melodic ? "" : undefined}
                        data-row={row.id}
                        data-step={index}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          // Touch pointers capture themselves; release so the
                          // drag can paint the neighbouring steps.
                          event.currentTarget.releasePointerCapture?.(event.pointerId);
                          // A lit step on another note takes the brush note
                          // instead of switching off.
                          const value = melodic && note !== row.note ? true : !on;
                          paint.current = value;
                          setStep(row.id, index, value);
                        }}
                        onPointerEnter={() => {
                          if (paint.current !== null) setStep(row.id, index, paint.current);
                        }}
                        onKeyDown={(event) => {
                          if (!melodic) return;
                          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                            event.preventDefault();
                            nudgeStep(row.id, index, event.key === "ArrowUp" ? 1 : -1);
                          }
                        }}
                        title={melodic ? `${noteName(note)} · scroll or ↑/↓ to change` : undefined}
                        aria-label={melodic ? `Step ${index + 1}, ${noteName(note)}` : `Step ${index + 1}`}
                        aria-pressed={on}
                      >
                        {melodic ? noteName(note) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {note && <p className="pattern__note-text">{note}</p>}

        <div className="pattern__footer">
          <button
            type="button"
            className="btn btn--small"
            onClick={addRow}
            disabled={pattern.rows.length >= MAX_ROWS}
          >
            + Row
          </button>
          <span className="pattern__hint">
            Click or drag across steps · on instruments, pick a note then paint; scroll a step to
            change its note · {STEPS_PER_BAR} steps = 1 bar
          </span>
          <div className="pattern__footer-actions">
            <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void commit()}
              disabled={busy || !hasHits}
            >
              {busy ? "Rendering…" : isUpdate ? "Update track" : "Add to session"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function noteOptions(row: PatternRow): number[] {
  const [low, high] = noteRange(row);
  const notes: number[] = [];
  for (let note = low; note <= high; note++) notes.push(note);
  // Keep a note set elsewhere (an older pattern, say) selectable.
  if (!notes.includes(row.note)) notes.push(row.note);
  return notes.sort((a, b) => a - b);
}
