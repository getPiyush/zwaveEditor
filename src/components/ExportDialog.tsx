import { useState } from "react";

import { exportMaster, exportTracks, pickDirectory, pickSavePath } from "../lib/api";
import type { ExportFormat, MasterBus, Track } from "../types";

interface Props {
  tracks: Track[];
  /** Beat mode's master bus; left out in editor mode, which exports as before. */
  master?: MasterBus;
  onClose: () => void;
}

type FormatKind = ExportFormat["kind"];

interface FormatChoice {
  kind: FormatKind;
  label: string;
  /** File-dialog filter name. */
  filter: string;
  /** Settings for this format; `defaultIndex` picks the one selected first. */
  options: { label: string; format: ExportFormat }[];
  defaultIndex: number;
}

const FORMATS: FormatChoice[] = [
  {
    kind: "wav",
    label: "WAV",
    filter: "WAV audio",
    options: [
      { label: "16-bit PCM", format: { kind: "wav", bitDepth: "int16" } },
      { label: "24-bit PCM", format: { kind: "wav", bitDepth: "int24" } },
      { label: "32-bit float", format: { kind: "wav", bitDepth: "float32" } },
    ],
    defaultIndex: 0,
  },
  {
    kind: "flac",
    label: "FLAC (lossless)",
    filter: "FLAC audio",
    options: [
      { label: "16-bit", format: { kind: "flac", bitDepth: "int16" } },
      { label: "24-bit", format: { kind: "flac", bitDepth: "int24" } },
    ],
    defaultIndex: 0,
  },
  {
    kind: "mp3",
    label: "MP3",
    filter: "MP3 audio",
    options: [128, 192, 256, 320].map((kbps) => ({
      label: `${kbps} kbps`,
      format: { kind: "mp3", kbps },
    })),
    defaultIndex: 1,
  },
  {
    kind: "aac",
    label: "AAC",
    filter: "AAC audio",
    options: [128, 192, 256, 320].map((kbps) => ({
      label: `${kbps} kbps`,
      format: { kind: "aac", kbps },
    })),
    defaultIndex: 1,
  },
  {
    kind: "ogg",
    label: "Ogg Vorbis",
    filter: "Ogg Vorbis audio",
    options: [
      { label: "Quality 3 (~112 kbps)", format: { kind: "ogg", quality: 0.3 } },
      { label: "Quality 5 (~160 kbps)", format: { kind: "ogg", quality: 0.5 } },
      { label: "Quality 7 (~224 kbps)", format: { kind: "ogg", quality: 0.7 } },
      { label: "Quality 9 (~320 kbps)", format: { kind: "ogg", quality: 0.9 } },
    ],
    defaultIndex: 1,
  },
];

/** Exports the tracks that are checked into the master. */
export function ExportDialog({ tracks, master, onClose }: Props) {
  const [kind, setKind] = useState<FormatKind>("wav");
  const [optionIndex, setOptionIndex] = useState(0);
  const choice = FORMATS.find((f) => f.kind === kind) ?? FORMATS[0];
  const format = (choice.options[optionIndex] ?? choice.options[choice.defaultIndex]).format;

  const chooseKind = (next: FormatKind) => {
    const nextChoice = FORMATS.find((f) => f.kind === next) ?? FORMATS[0];
    setKind(next);
    setOptionIndex(nextChoice.defaultIndex);
  };
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = tracks.filter((track) => track.inMaster);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const message = await action();
      if (message) setResult(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const exportMix = () =>
    run(async () => {
      const path = await pickSavePath(`master-mix.${kind}`, {
        name: choice.filter,
        extension: kind,
      });
      if (!path) return null;
      const written = await exportMaster(selected, path, format, master);
      return `Wrote the master mix to ${written}`;
    });

  const exportSeparately = () =>
    run(async () => {
      const directory = await pickDirectory();
      if (!directory) return null;
      const written = await exportTracks(
        selected.map((track) => track.clip.id),
        directory,
        format,
      );
      return `Wrote ${written.length} ${written.length === 1 ? "file" : "files"} to ${directory}`;
    });

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Export"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title">Export</h2>
        <p className="modal__subtitle">
          {selected.length === 0
            ? "No files are checked for the master track."
            : `${selected.length} of ${tracks.length} ${
                tracks.length === 1 ? "file" : "files"
              } checked for the master.`}
        </p>

        {selected.length > 0 && (
          <ul className="modal__list">
            {selected.map((track) => (
              <li key={track.clip.id}>{track.clip.name}</li>
            ))}
          </ul>
        )}

        <label className="modal__field">
          <span>Format</span>
          <select
            value={kind}
            onChange={(event) => chooseKind(event.target.value as FormatKind)}
            disabled={busy}
          >
            {FORMATS.map((f) => (
              <option key={f.kind} value={f.kind}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label className="modal__field">
          <span>{kind === "wav" || kind === "flac" ? "Bit depth" : "Quality"}</span>
          <select
            value={optionIndex}
            onChange={(event) => setOptionIndex(Number(event.target.value))}
            disabled={busy}
          >
            {choice.options.map((option, index) => (
              <option key={option.label} value={index}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className="modal__actions">
          <button type="button" onClick={exportMix} disabled={busy || selected.length === 0}>
            Export master mix…
          </button>
          <button
            type="button"
            onClick={exportSeparately}
            disabled={busy || selected.length === 0}
          >
            Export files separately…
          </button>
        </div>

        {busy && <p className="modal__note">Writing…</p>}
        {result && <p className="modal__note modal__note--ok">{result}</p>}
        {error && <p className="modal__note modal__note--error">{error}</p>}

        <p className="modal__hint">
          The master mix is summed to stereo at the highest sample rate in use.
          Separate files keep each track's own rate and channels, and ignore where the
          track starts.
          {(kind === "mp3" || kind === "aac") &&
            " MP3 and AAC hold at most two channels, and rates above what the format supports are resampled."}
        </p>

        <div className="modal__footer">
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
