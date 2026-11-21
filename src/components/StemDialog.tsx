import { useState } from "react";

import { formatTime } from "../lib/format";
import type { Track } from "../types";

interface Props {
  tracks: Track[];
  /** Ticked when the dialog opens. */
  initialIds: number[];
  defaultName: string;
  /** Resolves once the stem is made, or has failed (the session shows why). */
  onMake: (clipIds: number[], name: string) => Promise<void>;
  onClose: () => void;
}

/** Picks tracks to mix down into one stem track. */
export function StemDialog({ tracks, initialIds, defaultName, onMake, onClose }: Props) {
  const [picked, setPicked] = useState<Set<number>>(new Set(initialIds));
  const [name, setName] = useState(defaultName);
  const [processing, setProcessing] = useState(false);
  const chosen = tracks.filter((track) => picked.has(track.clip.id));

  const toggle = (id: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const make = async () => {
    setProcessing(true);
    await onMake(
      chosen.map((track) => track.clip.id),
      name.trim() || defaultName,
    );
    onClose();
  };

  return (
    <div className="modal__backdrop" onClick={processing ? undefined : onClose}>
      <div className="modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Make a stem</h2>
          <button className="modal__close" onClick={onClose} disabled={processing} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__body stem-dialog">
          <p>
            The tracks ticked are mixed down into one track, which you can move, mix and add effects
            to like any other. Open it with ⧉ to change the tracks inside; the stem is mixed again
            when you come back.
          </p>

          <label className="stem-dialog__name">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && chosen.length > 0 && !processing) void make();
              }}
              disabled={processing}
              aria-label="Stem name"
            />
          </label>

          <div className="add-track__beats-tools">
            <button
              type="button"
              className="btn btn--small"
              onClick={() =>
                setPicked(
                  chosen.length === tracks.length
                    ? new Set()
                    : new Set(tracks.map((track) => track.clip.id)),
                )
              }
              disabled={processing}
            >
              {chosen.length === tracks.length ? "Select none" : "Select all"}
            </button>
          </div>

          <ul className="add-track__beats stem-dialog__tracks">
            {tracks.map((track, index) => (
              <li key={track.clip.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(track.clip.id)}
                    onChange={() => toggle(track.clip.id)}
                    disabled={processing}
                  />
                  <span>
                    {index + 1}. {track.clip.name}
                    {track.stemId ? " (stem)" : ""}
                  </span>
                </label>
                <span className="stem-dialog__meta">
                  {formatTime(track.offset)} · {formatTime(track.clip.durationSecs)}
                  {track.muted || !track.inMaster ? " · silent" : ""}
                </span>
              </li>
            ))}
          </ul>

          <p className="stem-dialog__hint">
            Volume, mute, solo and effects of each track are kept inside the stem. The stem starts
            where the earliest track does.
          </p>

          <div className="modal__footer stem-dialog__buttons">
            <button onClick={onClose} disabled={processing} className="btn btn--secondary">
              Cancel
            </button>
            <button
              onClick={() => void make()}
              disabled={processing || chosen.length === 0}
              className="btn btn--primary"
            >
              {processing
                ? "Mixing…"
                : chosen.length > 1
                  ? `Make stem of ${chosen.length} tracks`
                  : "Make stem"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
