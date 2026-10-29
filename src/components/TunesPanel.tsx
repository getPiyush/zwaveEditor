import { useCallback, useEffect, useRef, useState } from "react";

import {
  addTunes,
  listTunes,
  pickAudioFiles,
  previewPause,
  previewPlay,
  previewState,
  removeTune,
} from "../lib/api";
import type { PreviewState, TuneDrop, TuneInfo, WorkspaceInfo } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { WorkspaceBar } from "./WorkspaceBar";

const POLL_MS = 200;
/** Below this many pixels a press on a tune is not yet a drag. */
const DRAG_THRESHOLD = 4;

const NO_PREVIEW: PreviewState = { name: null, playing: false, positionSecs: 0, durationSecs: 0 };

interface Props {
  workspace: WorkspaceInfo | null;
  onWorkspaceChange: (path: string | null) => Promise<void>;
  onClose: () => void;
  /** Where a tune let go at this point of the window would land, if anywhere. */
  resolveDrop: (clientX: number, clientY: number) => TuneDrop | null;
  /** Reports the target under a drag as it moves, and null when it ends. */
  onDragTarget: (target: TuneDrop | null) => void;
  onDrop: (tune: TuneInfo, target: TuneDrop) => void;
}

interface Drag {
  tune: TuneInfo;
  x: number;
  y: number;
  target: TuneDrop | null;
}

function dropLabel(target: TuneDrop | null): string {
  if (!target) return "Release to cancel";
  if (target.kind === "new") return "New track";
  return `${target.kind === "before" ? "Before" : "After"} ${target.trackName}`;
}

/**
 * The quick-tunes library: files kept in the workspace's tunes folder, ready
 * to audition and to drag into the editor.
 */
export function TunesPanel({
  workspace,
  onWorkspaceChange,
  onClose,
  resolveDrop,
  onDragTarget,
  onDrop,
}: Props) {
  const [tunes, setTunes] = useState<TuneInfo[]>([]);
  const [preview, setPreview] = useState<PreviewState>(NO_PREVIEW);
  // The tune being decoded for preview; a long file takes a moment.
  const [loading, setLoading] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TuneInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Where the panel was dragged to; until then the stylesheet places it.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  // Drags outlive renders, so they read the latest callbacks through refs.
  const resolveDropRef = useRef(resolveDrop);
  resolveDropRef.current = resolveDrop;
  const onDragTargetRef = useRef(onDragTarget);
  onDragTargetRef.current = onDragTarget;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  // Each workspace has a library of its own.
  const workspacePath = workspace?.path;
  useEffect(() => {
    let active = true;
    listTunes()
      .then((list) => {
        if (active) setTunes(list);
      })
      .catch(() => {
        /* Not running inside Tauri. */
      });
    return () => {
      active = false;
    };
  }, [workspacePath]);

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
      // A preview should not keep playing from a panel that is gone.
      previewPause().catch(() => {});
    };
  }, []);

  const browse = async () => {
    try {
      setError(null);
      const paths = await pickAudioFiles();
      if (paths.length === 0) return;
      setAdding(true);
      const added = await addTunes(paths);
      setTunes(added.tunes);
      if (added.failures.length > 0) setError(added.failures.join("; "));
    } catch (err) {
      fail(err);
    } finally {
      setAdding(false);
    }
  };

  const togglePreview = async (tune: TuneInfo) => {
    try {
      setError(null);
      if (preview.name === tune.name && preview.playing) {
        await previewPause();
        setPreview((current) => ({ ...current, playing: false }));
        return;
      }
      setLoading(tune.name);
      await previewPlay(tune.name);
      setPreview(await previewState());
    } catch (err) {
      fail(err);
    } finally {
      setLoading(null);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const { name } = removing;
    setRemoving(null);
    try {
      setError(null);
      setTunes(await removeTune(name));
    } catch (err) {
      fail(err);
    }
  };

  // Pointer events rather than HTML drag and drop: the window's native file
  // drop handling takes those over.
  const startTuneDrag = useCallback((event: React.PointerEvent, tune: TuneInfo) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let target: TuneDrop | null = null;

    const onMove = (move: PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD
      ) {
        return;
      }
      dragging = true;
      target = resolveDropRef.current(move.clientX, move.clientY);
      onDragTargetRef.current(target);
      setDrag({ tune, x: move.clientX, y: move.clientY, target });
    };

    const finish = (dropped: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      if (!dragging) return;
      setDrag(null);
      onDragTargetRef.current(null);
      if (dropped && target) onDropRef.current(tune, target);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKeyDown = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.stopPropagation();
      finish(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown, true);
  }, []);

  const startPanelMove = (event: React.PointerEvent) => {
    const panel = panelRef.current;
    if (!panel || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const grabX = event.clientX - rect.left;
    const grabY = event.clientY - rect.top;

    const onMove = (move: PointerEvent) => {
      // Keep the header on screen, so the panel can always be grabbed again.
      setPosition({
        left: Math.min(Math.max(move.clientX - grabX, 0), window.innerWidth - rect.width),
        top: Math.min(Math.max(move.clientY - grabY, 0), window.innerHeight - 40),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <>
      <div
        ref={panelRef}
        className="tunes-panel"
        role="dialog"
        aria-label="Quick tunes"
        style={position ? { left: position.left, top: position.top, right: "auto" } : undefined}
      >
        <div className="tunes-panel__header" onPointerDown={startPanelMove}>
          <h2>Quick tunes</h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="Hide quick tunes"
            title="Hide"
          >
            ×
          </button>
        </div>

        {error && <p className="tunes-panel__error">{error}</p>}

        {tunes.length === 0 ? (
          <p className="tunes-panel__empty">
            No tunes yet. Add the sounds you reach for most, then drag them into the editor.
          </p>
        ) : (
          <ul className="tunes-panel__list">
            {tunes.map((tune) => {
              const loaded = preview.name === tune.name;
              const playing = loaded && preview.playing;
              const progress =
                loaded && preview.durationSecs > 0
                  ? Math.min(preview.positionSecs / preview.durationSecs, 1)
                  : 0;
              return (
                <li
                  key={tune.name}
                  className={`tune${drag?.tune.name === tune.name ? " tune--dragging" : ""}`}
                  onPointerDown={(event) => startTuneDrag(event, tune)}
                  title={`${tune.name} — drag into the editor`}
                >
                  <span className="tune__progress" style={{ width: `${progress * 100}%` }} />
                  <button
                    type="button"
                    className="tune__button"
                    onClick={() => void togglePreview(tune)}
                    disabled={loading !== null}
                    aria-label={playing ? `Pause ${tune.name}` : `Play ${tune.name}`}
                    title={playing ? "Pause" : "Play"}
                  >
                    {loading === tune.name ? "…" : playing ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <span className="tune__name">{tune.name}</span>
                  <button
                    type="button"
                    className="tune__button tune__remove"
                    onClick={() => setRemoving(tune)}
                    aria-label={`Remove ${tune.name}`}
                    title="Remove"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="tunes-panel__footer">
          <button type="button" className="btn btn--primary" onClick={browse} disabled={adding}>
            {adding ? "Adding…" : "Add tunes…"}
          </button>
          <WorkspaceBar workspace={workspace} onChange={onWorkspaceChange} />
        </div>
      </div>

      {drag && (
        <div className="tune-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
          <span className="tune-ghost__name">{drag.tune.name}</span>
          <span className="tune-ghost__target">{dropLabel(drag.target)}</span>
        </div>
      )}

      {removing && (
        <ConfirmDialog
          title="Remove tune?"
          message={`"${removing.name}" will be deleted from the workspace's tunes folder. Tracks already made from it stay as they are.`}
          confirmText="Remove"
          cancelText="Keep"
          isDangerous={true}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" />
    </svg>
  );
}
