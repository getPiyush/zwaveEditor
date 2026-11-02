import { useEffect, useState } from "react";

import { listTunes, previewPause, previewPlay, previewState } from "../lib/api";
import { formatTime } from "../lib/format";
import type { PreviewState, TuneInfo } from "../types";

const POLL_MS = 200;

interface Props {
  /** Length of what is on the clipboard, in seconds, or null if nothing is. */
  clipboard: number | null;
  /** Where the playhead is; a track of copied sound starts there. */
  playhead: number;
  /** What the blank length starts out as. */
  defaultSeconds: number;
  isImporting: boolean;
  onBlank: (seconds: number) => Promise<void>;
  onClipboard: () => Promise<void>;
  onFile: () => void;
  onTune: (tune: TuneInfo) => void;
  onClose: () => void;
}

export function AddTrackDialog({
  clipboard,
  playhead,
  defaultSeconds,
  isImporting,
  onBlank,
  onClipboard,
  onFile,
  onTune,
  onClose,
}: Props) {
  const [secondsDraft, setSecondsDraft] = useState(defaultSeconds.toFixed(1));
  const [processing, setProcessing] = useState(false);
  const seconds = Number(secondsDraft);
  const validSeconds = Number.isFinite(seconds) && seconds > 0;
  // Null until the quick-tunes library has been read.
  const [tunes, setTunes] = useState<TuneInfo[] | null>(null);
  const [tunePath, setTunePath] = useState("");
  const tune = tunes?.find((t) => t.path === tunePath);

  useEffect(() => {
    listTunes()
      .then((found) => {
        setTunes(found);
        if (found.length > 0) setTunePath(found[0].path);
      })
      .catch(() => setTunes([]));
  }, []);

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewing = !!tune && preview?.name === tune.name && preview.playing;

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const next = await previewState();
        if (active) setPreview(next);
      } catch {
        /* Not running inside Tauri. */
      }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
      // A preview should not outlive the dialog it was started from.
      previewPause().catch(() => {});
    };
  }, []);

  const togglePreview = async () => {
    if (!tune) return;
    try {
      if (previewing) {
        await previewPause();
        setPreview((current) => current && { ...current, playing: false });
        return;
      }
      setPreviewLoading(true);
      await previewPlay(tune.name);
      setPreview(await previewState());
    } catch {
      /* The tune could not be decoded; adding it will report why. */
    } finally {
      setPreviewLoading(false);
    }
  };

  const chooseTune = (path: string) => {
    setTunePath(path);
    if (previewing) previewPause().catch(() => {});
  };

  const run = async (action: () => Promise<void>) => {
    setProcessing(true);
    await action();
    onClose();
  };

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Add Track</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__body">
          <div className="add-track">
            <section className="add-track__option">
              <div>
                <h3>Blank track</h3>
                <p>Silence to paste copied sound into, anywhere along it.</p>
                <label className="add-track__length">
                  Length
                  <input
                    type="number"
                    min={0.1}
                    step={0.5}
                    value={secondsDraft}
                    onChange={(e) => setSecondsDraft(e.target.value)}
                    disabled={processing}
                  />
                  s
                </label>
              </div>
              <button
                className="btn btn--primary"
                onClick={() => void run(() => onBlank(seconds))}
                disabled={processing || !validSeconds}
              >
                Add blank
              </button>
            </section>

            <section className="add-track__option">
              <div>
                <h3>From copied sound</h3>
                <p>
                  {clipboard === null
                    ? "Copy a selection first."
                    : `${formatTime(clipboard)} of copied sound, starting at the playhead (${formatTime(playhead)}).`}
                </p>
              </div>
              <button
                className="btn btn--primary"
                onClick={() => void run(onClipboard)}
                disabled={processing || clipboard === null}
              >
                Add copied
              </button>
            </section>

            <section className="add-track__option">
              <div>
                <h3>From quick tunes</h3>
                {tunes === null ? (
                  <p>Reading quick tunes…</p>
                ) : tunes.length === 0 ? (
                  <p>No quick tunes yet — add some from the quick tunes panel.</p>
                ) : (
                  <div className="add-track__tune-row">
                    <select
                      className="add-track__tune"
                      value={tunePath}
                      onChange={(e) => chooseTune(e.target.value)}
                      disabled={processing}
                      aria-label="Quick tune"
                    >
                      {tunes.map((t) => (
                        <option key={t.path} value={t.path}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => void togglePreview()}
                      disabled={processing || previewLoading || !tune}
                      title={previewing ? "Stop the preview" : "Hear this tune before adding it"}
                    >
                      {previewLoading ? "…" : previewing ? "Stop" : "Preview"}
                    </button>
                    {previewing && preview && (
                      <span className="add-track__time">
                        {formatTime(preview.positionSecs)} / {formatTime(preview.durationSecs)}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <button
                className="btn btn--primary"
                onClick={() => {
                  if (!tune) return;
                  onTune(tune);
                  onClose();
                }}
                disabled={processing || isImporting || !tune}
              >
                Add tune
              </button>
            </section>

            <section className="add-track__option">
              <div>
                <h3>From a file</h3>
                <p>Each audio file picked becomes a track of its own.</p>
              </div>
              <button
                className="btn btn--primary"
                onClick={() => {
                  onFile();
                  onClose();
                }}
                disabled={processing || isImporting}
              >
                Choose files…
              </button>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
