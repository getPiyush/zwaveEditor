import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { repeatRange, transportPause, transportPlay, transportSeek } from "../lib/api";
import { formatTime } from "../lib/format";
import { isRunningInTauri } from "../lib/tauri";
import { useTransport } from "../lib/useTransport";
import { clampView, trackEnd, zoomView } from "../lib/waveform";
import type { ClipInfo, Selection, Track, ViewRange } from "../types";
import { ExportDialog } from "./ExportDialog";
import { AdjustWaveDialog } from "./AdjustWaveDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { RecordingDialog } from "./RecordingDialog";
import { RepeatDialog } from "./RepeatDialog";
import { SessionMinimap } from "./SessionMinimap";
import { Timeline } from "./Timeline";
import { TransportBar } from "./TransportBar";

interface Props {
  tracks: Track[];
  onAddFiles: () => void;
  onTrackChange: (clipId: number, changes: Partial<Track>) => void;
  onTrackRemove: (clipId: number) => void;
  onCloseAll: () => void;
  onEditSelection: (kind: "delete" | "crop", selection: Selection) => Promise<boolean>;
  onCopySelection: (selection: Selection) => Promise<number | null>;
  onPaste: (target: Selection) => Promise<boolean>;
  onUndoTrack: (clipId: number) => Promise<boolean>;
  onRecordingComplete: (clip: ClipInfo) => void;
  isImporting: boolean;
  error: string | null;
}

/** Where on a track, in clip time, a paste at the playhead lands. */
function pastePoint(track: Track, playhead: number): number {
  return Math.min(Math.max(playhead - track.offset, 0), track.clip.durationSecs);
}

export function SessionScreen({
  tracks,
  onAddFiles,
  onTrackChange,
  onTrackRemove,
  onCloseAll,
  onEditSelection,
  onCopySelection,
  onPaste,
  onUndoTrack,
  onRecordingComplete,
  isImporting,
  error,
}: Props) {
  const { state, position, anticipate } = useTransport();
  const [view, setView] = useState<ViewRange>({ start: 0, end: 1 });
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [followPlayhead, setFollowPlayhead] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [lastEdited, setLastEdited] = useState<number | null>(null);
  // The track last clicked; paste lands here when nothing is selected.
  const [activeClipId, setActiveClipId] = useState<number | null>(null);
  // Length of what is on the clipboard, in seconds, or null if nothing is.
  const [clipboard, setClipboard] = useState<number | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showRecording, setShowRecording] = useState(false);
  const [showRepeat, setShowRepeat] = useState(false);
  const [showAdjustWave, setShowAdjustWave] = useState(false);
  const [showConfirmCloseAll, setShowConfirmCloseAll] = useState(false);

  // The session runs until its last track ends.
  const duration = useMemo(
    () => tracks.reduce((longest, track) => Math.max(longest, trackEnd(track)), 0),
    [tracks],
  );

  const selectedTrack = selection
    ? tracks.find((track) => track.clip.id === selection.clipId)
    : undefined;
  const activeTrack = tracks.find((track) => track.clip.id === activeClipId);

  // Read through a ref where it is needed in callbacks, so they are not rebuilt
  // on every animation frame of playback.
  const positionRef = useRef(position);
  positionRef.current = position;

  // Refit when the session grows, but only for someone who was already looking
  // at the whole thing — a zoomed-in view should stay where it is.
  const viewRef = useRef(view);
  viewRef.current = view;
  // The session length this view was last fitted to. Also makes the effect
  // idempotent, which it has to be: React invokes effects twice in dev.
  const fittedDuration = useRef<number | null>(null);

  useEffect(() => {
    if (fittedDuration.current === duration) return;
    const wasShowingEverything =
      fittedDuration.current === null || viewRef.current.end >= fittedDuration.current - 0.001;
    fittedDuration.current = duration;
    setView(
      wasShowingEverything
        ? { start: 0, end: Math.max(duration, 0.001) }
        : clampView(viewRef.current, duration),
    );
  }, [duration]);

  // A selection cannot outlive the track it belongs to, and neither can focus.
  useEffect(() => {
    if (selection && !tracks.some((track) => track.clip.id === selection.clipId)) {
      setSelection(null);
    }
    if (activeClipId !== null && !tracks.some((track) => track.clip.id === activeClipId)) {
      setActiveClipId(null);
    }
  }, [tracks, selection, activeClipId]);

  const changeView = useCallback(
    (next: ViewRange) => setView(clampView(next, duration)),
    [duration],
  );

  const zoomBy = useCallback(
    (factor: number) => setView((current) => zoomView(current, factor, 0.5, duration)),
    [duration],
  );

  const fitAll = useCallback(
    () => setView({ start: 0, end: Math.max(duration, 0.001) }),
    [duration],
  );

  const seek = useCallback(
    (seconds: number) => {
      const clamped = Math.min(Math.max(seconds, 0), duration);
      anticipate(clamped);
      void transportSeek(clamped);
    },
    [anticipate, duration],
  );

  const togglePlay = useCallback(() => {
    if (state.playing) {
      void transportPause();
      return;
    }
    // Playing with a range selected starts from the top of that range.
    if (selection && selectedTrack) seek(selectedTrack.offset + selection.start);
    setFollowPlayhead(true);
    void transportPlay();
  }, [state.playing, selection, selectedTrack, seek]);

  const stop = useCallback(() => {
    void transportPause();
    seek(0);
  }, [seek]);

  const applyEdit = useCallback(
    async (kind: "delete" | "crop") => {
      if (!selection) return;
      const target = selection;
      const offset = selectedTrack?.offset ?? 0;
      if (await onEditSelection(kind, target)) {
        setLastEdited(target.clipId);
        setSelection(null);
        if (kind === "crop") seek(offset);
      }
    },
    [selection, selectedTrack, onEditSelection, seek],
  );

  const copy = useCallback(
    async (cut: boolean) => {
      if (!selection) return;
      const length = await onCopySelection(selection);
      if (length === null) return;
      setClipboard(length);
      if (cut) await applyEdit("delete");
    },
    [selection, onCopySelection, applyEdit],
  );

  // Pastes over the selection, or inserts at the playhead on the active track.
  // Either way the playhead ends up just after the pasted audio, so pasting
  // again lays down the next copy.
  const paste = useCallback(async () => {
    if (clipboard === null) return;
    let target: Selection;
    let offset: number;
    if (selection && selectedTrack) {
      target = selection;
      offset = selectedTrack.offset;
    } else if (activeTrack) {
      const at = pastePoint(activeTrack, positionRef.current);
      target = { clipId: activeTrack.clip.id, start: at, end: at };
      offset = activeTrack.offset;
    } else {
      return;
    }

    if (await onPaste(target)) {
      setLastEdited(target.clipId);
      setActiveClipId(target.clipId);
      setSelection(null);
      // Not `seek`: the session may have just grown past the duration it clamps to.
      const after = offset + target.start + clipboard;
      anticipate(after);
      void transportSeek(after);
    }
  }, [clipboard, selection, selectedTrack, activeTrack, onPaste, anticipate]);

  const undo = useCallback(
    async (clipId: number) => {
      if (await onUndoTrack(clipId)) setSelection(null);
    },
    [onUndoTrack],
  );

  const handleRecordingComplete = useCallback(
    (clipInfo: ClipInfo) => {
      onRecordingComplete(clipInfo);
      setSelection(null);
    },
    [onRecordingComplete],
  );

  const handleRepeat = useCallback(
    async (count: number) => {
      if (!selection) return;
      try {
        const updated = await repeatRange(selection.clipId, selection.start, selection.end, count);
        onTrackChange(selection.clipId, { clip: updated });
        setSelection(null);
      } catch (err) {
        // Error will be shown via parent's error handling
      }
    },
    [selection, onTrackChange],
  );

  // Keep the playhead on screen while playing, unless the user has scrolled away.
  useEffect(() => {
    if (!state.playing || !followPlayhead) return;
    if (position >= view.start && position <= view.end) return;
    const span = view.end - view.start;
    setView(clampView({ start: position, end: position + span }, duration));
  }, [position, state.playing, followPlayhead, view, duration]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === "z") {
          if (lastEdited !== null) void undo(lastEdited);
        } else if ((key === "c" || key === "x") && selection) {
          void copy(key === "x");
        } else if (key === "v" && clipboard !== null && (selection || activeTrack)) {
          void paste();
        } else if (key === "r" && selection) {
          setShowRepeat(true);
        } else {
          return;
        }
        event.preventDefault();
        return;
      }

      switch (event.key) {
        case " ":
          togglePlay();
          break;
        case "Backspace":
        case "Delete":
          void applyEdit("delete");
          break;
        case "Escape":
          setSelection(null);
          break;
        case "+":
        case "=":
          zoomBy(0.5);
          break;
        case "-":
        case "_":
          zoomBy(2);
          break;
        case "0":
          fitAll();
          break;
        case "Home":
          seek(0);
          break;
        case "End":
          seek(duration);
          break;
        case "r":
        case "R":
          if (!state.playing) setShowRecording(true);
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    togglePlay,
    zoomBy,
    fitAll,
    seek,
    duration,
    applyEdit,
    undo,
    lastEdited,
    copy,
    paste,
    selection,
    clipboard,
    activeTrack,
    state.playing,
  ]);

  const inMasterCount = tracks.filter((track) => track.inMaster).length;

  return (
    <div className="session">
      <header className="session__header">
        <div>
          {!isRunningInTauri() && <h1 className="session__title">zwaveEditor</h1>}
          <p className="session__meta">
            {tracks.length} {tracks.length === 1 ? "track" : "tracks"} · {inMasterCount} in master
            · {formatTime(duration, 2)}
            {state.outputSampleRate > 0
              ? ` · output ${(state.outputSampleRate / 1000).toFixed(1)} kHz`
              : ""}
          </p>
        </div>
        <div className="session__actions">
          <button type="button" onClick={onAddFiles} disabled={isImporting}>
            {isImporting ? "Importing…" : "Add files…"}
          </button>
          <button type="button" onClick={() => setShowExport(true)} disabled={inMasterCount === 0}>
            Export…
          </button>
          <button type="button" onClick={() => setShowConfirmCloseAll(true)}>
            Close all
          </button>
        </div>
      </header>

      {error && <p className="session__error">{error}</p>}

      <TransportBar
        state={state}
        position={position}
        duration={duration}
        onPlayPause={togglePlay}
        onStop={stop}
        onRecord={() => setShowRecording(true)}
        onZoomIn={() => zoomBy(0.5)}
        onZoomOut={() => zoomBy(2)}
        onFit={fitAll}
      />

      {selection && selectedTrack && (
        <div className="editbar">
          <span className="editbar__range">
            <strong>{selectedTrack.clip.name}</strong> {formatTime(selection.start)} –{" "}
            {formatTime(selection.end)}
            <span className="editbar__length">
              ({formatTime(selection.end - selection.start)})
            </span>
          </span>
          <div className="editbar__actions">
            <button type="button" onClick={() => void copy(false)}>
              Copy
            </button>
            <button type="button" onClick={() => void copy(true)}>
              Cut
            </button>
            <button type="button" onClick={() => void paste()} disabled={clipboard === null}>
              Paste
            </button>
            <button type="button" onClick={() => void applyEdit("delete")}>
              Delete selection
            </button>
            <button type="button" onClick={() => void applyEdit("crop")}>
              Crop to selection
            </button>
            <button type="button" onClick={() => setShowRepeat(true)}>
              Repeat…
            </button>
            <button type="button" onClick={() => setShowAdjustWave(true)}>
              Adjust…
            </button>
            <button type="button" onClick={() => setSelection(null)}>
              Clear
            </button>
          </div>
        </div>
      )}

      {!selection && clipboard !== null && activeTrack && (
        <div className="editbar">
          <span className="editbar__range">
            <strong>{activeTrack.clip.name}</strong> clipboard {formatTime(clipboard)} → at{" "}
            {formatTime(pastePoint(activeTrack, position))}
          </span>
          <div className="editbar__actions">
            <button type="button" onClick={() => void paste()}>
              Paste at playhead
            </button>
          </div>
        </div>
      )}

      <div
        className="session__timeline"
        onPointerDownCapture={() => setFollowPlayhead(false)}
      >
        <Timeline
          tracks={tracks}
          view={view}
          duration={duration}
          playhead={position}
          onViewChange={changeView}
          onSeek={seek}
          onTrackChange={onTrackChange}
          onTrackRemove={onTrackRemove}
          onTrackUndo={(clipId) => void undo(clipId)}
          onHoverTimeChange={setHoverTime}
          selection={selection}
          onSelectionChange={setSelection}
          activeClipId={activeClipId}
          onActiveTrackChange={setActiveClipId}
        />
      </div>

      <SessionMinimap
        tracks={tracks}
        view={view}
        duration={duration}
        onViewChange={changeView}
      />

      <footer className="statusbar">
        <span>
          <span className="statusbar__label">Playhead</span>
          {formatTime(position)}
        </span>
        <span>
          <span className="statusbar__label">Pointer</span>
          {hoverTime !== null ? formatTime(hoverTime) : "—"}
        </span>
        <span>
          <span className="statusbar__label">Selection</span>
          {selection ? formatTime(selection.end - selection.start) : "—"}
        </span>
        <span className="statusbar__hint">
          drag to select · ⌘/Ctrl + C / X / V copy, cut, paste · ⌘/Ctrl + drag move track · space play/pause · ⌘/Ctrl + scroll zoom · shift + scroll pan
        </span>
      </footer>

      {showExport && <ExportDialog tracks={tracks} onClose={() => setShowExport(false)} />}

      {showRecording && (
        <RecordingDialog
          onClose={() => setShowRecording(false)}
          onRecordingComplete={handleRecordingComplete}
        />
      )}

      {showRepeat && selection && (
        <RepeatDialog
          selection={selection}
          onRepeat={handleRepeat}
          onClose={() => setShowRepeat(false)}
        />
      )}

      {showAdjustWave && selection && (
        <AdjustWaveDialog
          selection={selection}
          onClipUpdated={(clipInfo) => {
            onTrackChange(selection.clipId, { clip: clipInfo });
          }}
          onClose={() => setShowAdjustWave(false)}
        />
      )}

      {showConfirmCloseAll && (
        <ConfirmDialog
          title="Close all tracks?"
          message={`You have ${tracks.length} track${tracks.length !== 1 ? "s" : ""} open. This will close all of them. This action cannot be undone.`}
          confirmText="Close all"
          cancelText="Keep open"
          isDangerous={true}
          onConfirm={() => {
            setShowConfirmCloseAll(false);
            onCloseAll();
          }}
          onCancel={() => setShowConfirmCloseAll(false)}
        />
      )}
    </div>
  );
}
