import { useState } from "react";

import { exportMaster, exportTracks, pickDirectory, pickSavePath } from "../lib/api";
import type { BitDepth, Track } from "../types";

interface Props {
  tracks: Track[];
  onClose: () => void;
}

const DEPTHS: { value: BitDepth; label: string }[] = [
  { value: "int16", label: "16-bit PCM" },
  { value: "int24", label: "24-bit PCM" },
  { value: "float32", label: "32-bit float" },
];

/** Exports the tracks that are checked into the master. */
export function ExportDialog({ tracks, onClose }: Props) {
  const [bitDepth, setBitDepth] = useState<BitDepth>("int16");
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
      const path = await pickSavePath("master-mix.wav");
      if (!path) return null;
      const written = await exportMaster(selected, path, bitDepth);
      return `Wrote the master mix to ${written}`;
    });

  const exportSeparately = () =>
    run(async () => {
      const directory = await pickDirectory();
      if (!directory) return null;
      const written = await exportTracks(
        selected.map((track) => track.clip.id),
        directory,
        bitDepth,
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
            value={bitDepth}
            onChange={(event) => setBitDepth(event.target.value as BitDepth)}
            disabled={busy}
          >
            {DEPTHS.map((depth) => (
              <option key={depth.value} value={depth.value}>
                WAV · {depth.label}
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
