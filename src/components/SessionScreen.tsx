import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getWorkspace,
  repeatRange,
  setWorkspace,
  transportPause,
  transportPlay,
  transportSeek,
} from "../lib/api";
import { formatTime } from "../lib/format";
import { isRunningInTauri } from "../lib/tauri";
import { useTransport } from "../lib/useTransport";
import { clampView, trackEnd, xToTime, zoomView } from "../lib/waveform";
import type {
  AppMode,
  BeatSettings,
  ClipInfo,
  NewTrackSource,
  Selection,
  Track,
  TuneDrop,
  TuneInfo,
  ViewRange,
  WorkspaceInfo,
} from "../types";
import { AddTrackDialog } from "./AddTrackDialog";
import { BeatBar } from "./BeatBar";
import { ExportDialog } from "./ExportDialog";
import { ModeSwitch } from "./ModeSwitch";
import { AdjustWaveDialog } from "./AdjustWaveDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptySession } from "./EmptySession";
import { ProjectDialog } from "./ProjectDialog";
import { RecordingDialog } from "./RecordingDialog";
import { RepeatDialog } from "./RepeatDialog";
import { SessionMinimap } from "./SessionMinimap";
import { Timeline } from "./Timeline";
import { TransportBar } from "./TransportBar";
import { TunesPanel } from "./TunesPanel";

interface Props {
  tracks: Track[];
  onAddFiles: () => void;
  onOpenPaths: (paths: string[]) => void;
  onInsertFile: (clipId: number, path: string, atEnd: boolean) => Promise<boolean>;
  onProjectOpened: (tracks: Track[]) => void;
  onTrackChange: (clipId: number, changes: Partial<Track>) => void;
  onTrackRemove: (clipId: number) => void;
  onCloseAll: () => void;
  onEditSelection: (kind: "delete" | "crop", selection: Selection) => Promise<boolean>;
  onCopySelection: (selection: Selection) => Promise<number | null>;
  onPaste: (target: Selection, silence: number) => Promise<boolean>;
  onUndoTrack: (clipId: number) => Promise<boolean>;
  onRecordingComplete: (clip: ClipInfo) => void;
  /** Adds a track starting at `offset`. Returns its clip id, or null if it failed. */
  onNewTrack: (source: NewTrackSource, offset: number) => Promise<number | null>;
  isDragging: boolean;
  isImporting: boolean;
  importingName: string | null;
  error: string | null;
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  /** Present in beat mode only. Everything beat-specific keys off it. */
  beat?: BeatSettings;
  onBeatChange: (changes: Partial<BeatSettings>) => void;
  onNewPattern: () => void;
  onEditPattern: (clipId: number) => void;
}

/**
 * Where on a track, in clip time, a paste at the playhead lands. With blank
 * filler on it may lie past the clip's end; the gap is then filled with silence.
 */
function pastePoint(track: Track, playhead: number, filler: boolean): number {
  const at = Math.max(playhead - track.offset, 0);
  return filler ? at : Math.min(at, track.clip.durationSecs);
}

export function SessionScreen({
  tracks,
  onAddFiles,
  onOpenPaths,
  onInsertFile,
  onProjectOpened,
  onTrackChange,
  onTrackRemove,
  onCloseAll,
  onEditSelection,
  onCopySelection,
  onPaste,
  onUndoTrack,
  onRecordingComplete,
  onNewTrack,
  isDragging,
  isImporting,
  importingName,
  error,
  mode,
  onModeChange,
  beat,
  onBeatChange,
  onNewPattern,
  onEditPattern,
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
  // Blank filler: lets a paste land past a track's end, padding the gap with
  // silence, plus an optional extra gap of silence ahead of every paste.
  const [filler, setFiller] = useState(false);
  const [fillerGapDraft, setFillerGapDraft] = useState("0");
  const fillerGap = filler ? Math.max(Number(fillerGapDraft) || 0, 0) : 0;
  const [showExport, setShowExport] = useState(false);
  const [showRecording, setShowRecording] = useState(false);
  const [showRepeat, setShowRepeat] = useState(false);
  const [showAddTrack, setShowAddTrack] = useState(false);
  const [showAdjustWave, setShowAdjustWave] = useState(false);
  const [showConfirmCloseAll, setShowConfirmCloseAll] = useState(false);
  const [showTunes, setShowTunes] = useState(false);
  const [projectDialog, setProjectDialog] = useState<"save" | "open" | null>(null);
  // The project this session was last saved as or opened from.
  const [projectName, setProjectName] = useState<string | null>(null);
  const [workspace, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  // Where the tune being dragged out of the panel would land right now.
  const [tuneDrop, setTuneDrop] = useState<TuneDrop | null>(null);

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

  useEffect(() => {
    getWorkspace()
      .then(setWorkspaceInfo)
      .catch(() => {
        /* Not running inside Tauri. */
      });
  }, []);

  const changeWorkspace = useCallback(async (path: string | null) => {
    setWorkspaceInfo(await setWorkspace(path));
  }, []);

  // A tune let go over a track joins it, on whichever side of the track's
  // middle it was dropped; anywhere else in the editor it becomes a new track.
  const resolveTuneDrop = useCallback(
    (clientX: number, clientY: number): TuneDrop | null => {
      const hit = document.elementFromPoint(clientX, clientY);
      if (!hit || hit.closest(".tunes-panel")) return null;

      const row = hit.closest<HTMLElement>("[data-clip-id]");
      const track = row && tracks.find((t) => t.clip.id === Number(row.dataset.clipId));
      if (!row || !track) return { kind: "new" };

      const joined = { clipId: track.clip.id, trackName: track.clip.name };
      const lane = row.querySelector(".track__lane")?.getBoundingClientRect();
      // Over the header there is no position to read, so the tune goes on the end.
      if (!lane || clientX < lane.left) return { kind: "after", ...joined };
      const time = xToTime(clientX - lane.left, view, lane.width);
      const middle = track.offset + track.clip.durationSecs / 2;
      return { kind: time < middle ? "before" : "after", ...joined };
    },
    [tracks, view],
  );

  const dropTune = useCallback(
    async (tune: TuneInfo, target: TuneDrop) => {
      if (target.kind === "new") {
        onOpenPaths([tune.path]);
      } else if (await onInsertFile(target.clipId, tune.path, target.kind === "after")) {
        setLastEdited(target.clipId);
        setActiveClipId(target.clipId);
        setSelection(null);
      }
    },
    [onOpenPaths, onInsertFile],
  );

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
    setFollowPlayhead(true);
    // Playing with a range selected plays just that range, from its top.
    if (selection && selectedTrack && selection.end > selection.start) {
      seek(selectedTrack.offset + selection.start);
      void transportPlay(selectedTrack.offset + selection.end);
      return;
    }
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
    let silence = fillerGap;
    if (selection && selectedTrack) {
      target = selection;
      offset = selectedTrack.offset;
    } else if (activeTrack) {
      const aimed = pastePoint(activeTrack, positionRef.current, filler);
      const at = Math.min(aimed, activeTrack.clip.durationSecs);
      target = { clipId: activeTrack.clip.id, start: at, end: at };
      offset = activeTrack.offset;
      silence += aimed - at;
    } else {
      return;
    }

    if (await onPaste(target, silence)) {
      setLastEdited(target.clipId);
      setActiveClipId(target.clipId);
      setSelection(null);
      // Not `seek`: the session may have just grown past the duration it clamps to.
      const after = offset + target.start + silence + clipboard;
      anticipate(after);
      void transportSeek(after);
    }
  }, [clipboard, selection, selectedTrack, activeTrack, onPaste, anticipate, filler, fillerGap]);

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

  // A new track becomes the active one, so a paste at the playhead lands on it.
  const addTrack = useCallback(
    async (source: NewTrackSource) => {
      const offset = source.kind === "clipboard" ? positionRef.current : 0;
      const clipId = await onNewTrack(source, offset);
      if (clipId === null) return;
      setActiveClipId(clipId);
      setSelection(null);
    },
    [onNewTrack],
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
          if (state.ready && !state.playing) setShowRecording(true);
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
    state.ready,
  ]);

  const inMasterCount = tracks.filter((track) => track.inMaster).length;

  // Silence a paste at the playhead would lay down ahead of the clipboard.
  const pasteSilence = activeTrack
    ? fillerGap +
      Math.max(pastePoint(activeTrack, position, filler) - activeTrack.clip.durationSecs, 0)
    : 0;

  const fillerControls = (
    <span className="editbar__filler">
      <label title="Paste past a track's end, filling the gap with silence">
        <input
          type="checkbox"
          checked={filler}
          onChange={(event) => setFiller(event.target.checked)}
        />
        Blank filler
      </label>
      {filler && (
        <label title="Extra silence to put just before the pasted audio">
          +
          <input
            type="number"
            min={0}
            step={0.1}
            value={fillerGapDraft}
            onChange={(event) => setFillerGapDraft(event.target.value)}
            aria-label="Silence before paste, in seconds"
          />
          s
        </label>
      )}
    </span>
  );

  return (
    <div className="session">
      <header className="session__header">
        <div>
          {!isRunningInTauri() && <h1 className="session__title">zwaveEditor</h1>}
          <p className="session__meta">
            {projectName ? `${projectName} · ` : ""}
            {tracks.length} {tracks.length === 1 ? "track" : "tracks"} · {inMasterCount} in master
            · {formatTime(duration, 2)}
            {state.outputSampleRate > 0
              ? ` · output ${(state.outputSampleRate / 1000).toFixed(1)} kHz`
              : ""}
          </p>
        </div>
        <div className="session__actions">
          <ModeSwitch mode={mode} onChange={onModeChange} />
          <button
            type="button"
            className={`session__tunes${showTunes ? " session__tunes--on" : ""}`}
            onClick={() => setShowTunes((shown) => !shown)}
            title="Quick tunes"
            aria-label="Quick tunes"
            aria-pressed={showTunes}
          >
            <TunesIcon />
          </button>
          <button type="button" onClick={() => setShowAddTrack(true)} disabled={isImporting}>
            {isImporting ? "Importing…" : "Add track…"}
          </button>
          <button type="button" onClick={() => setProjectDialog("open")}>
            Open project…
          </button>
          <button
            type="button"
            onClick={() => setProjectDialog("save")}
            disabled={tracks.length === 0}
          >
            Save project…
          </button>
          <button type="button" onClick={() => setShowExport(true)} disabled={inMasterCount === 0}>
            Export…
          </button>
          <button
            type="button"
            onClick={() => setShowConfirmCloseAll(true)}
            disabled={tracks.length === 0}
          >
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

      {beat && (
        <BeatBar
          settings={beat}
          position={position}
          onChange={onBeatChange}
          onNewPattern={onNewPattern}
        />
      )}

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
            {clipboard !== null && fillerControls}
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
            {formatTime(pastePoint(activeTrack, position, filler))}
            {pasteSilence > 0 && (
              <span className="editbar__length">(after {formatTime(pasteSilence)} of silence)</span>
            )}
          </span>
          <div className="editbar__actions">
            {fillerControls}
            <button type="button" onClick={() => void paste()}>
              Paste at playhead
            </button>
          </div>
        </div>
      )}

      {tracks.length === 0 ? (
        <EmptySession
          onRecord={() => setShowRecording(true)}
          onAddFiles={onAddFiles}
          canRecord={state.ready && !state.playing}
          isDragging={isDragging}
          isImporting={isImporting}
          importingName={importingName}
          onNewPattern={beat ? onNewPattern : undefined}
        />
      ) : (
        <>
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
              tuneDrop={tuneDrop}
              beat={beat}
              onTrackEditPattern={beat ? onEditPattern : undefined}
            />
          </div>

          <SessionMinimap
            tracks={tracks}
            view={view}
            duration={duration}
            onViewChange={changeView}
          />
        </>
      )}

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

      {showTunes && (
        <TunesPanel
          workspace={workspace}
          onWorkspaceChange={changeWorkspace}
          onClose={() => setShowTunes(false)}
          resolveDrop={resolveTuneDrop}
          onDragTarget={setTuneDrop}
          onDrop={(tune, target) => void dropTune(tune, target)}
        />
      )}

      {projectDialog && (
        <ProjectDialog
          mode={projectDialog}
          tracks={tracks}
          currentName={projectName}
          workspace={workspace}
          onWorkspaceChange={changeWorkspace}
          onSaved={setProjectName}
          onOpened={(name, opened) => {
            onProjectOpened(opened);
            setProjectName(name);
            setSelection(null);
            setLastEdited(null);
          }}
          onClose={() => setProjectDialog(null)}
        />
      )}

      {showExport && (
        <ExportDialog
          tracks={tracks}
          master={beat ? { gain: beat.masterGain, limiter: beat.limiter } : undefined}
          onClose={() => setShowExport(false)}
        />
      )}

      {showRecording && (
        <RecordingDialog
          onClose={() => setShowRecording(false)}
          onRecordingComplete={handleRecordingComplete}
        />
      )}

      {showAddTrack && (
        <AddTrackDialog
          clipboard={clipboard}
          playhead={position}
          defaultSeconds={duration > 0 ? duration : 10}
          isImporting={isImporting}
          onBlank={(seconds) => addTrack({ kind: "blank", seconds })}
          onClipboard={() => addTrack({ kind: "clipboard" })}
          onFile={onAddFiles}
          onTune={(tune) => onOpenPaths([tune.path])}
          onClose={() => setShowAddTrack(false)}
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
            setProjectName(null);
            onCloseAll();
          }}
          onCancel={() => setShowConfirmCloseAll(false)}
        />
      )}
    </div>
  );
}

function TunesIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M6 2.8v7.3a2.2 2.2 0 1 0 1.2 2V5.6l5-1.2v4.4a2.2 2.2 0 1 0 1.2 2V1.6z"
        fill="currentColor"
      />
    </svg>
  );
}
