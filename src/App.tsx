import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import {
  closeClip,
  copyRange,
  cropRange,
  deleteRange,
  importAudio,
  insertAudioFile,
  isSupportedFile,
  newBlankClip,
  newClipFromClipboard,
  pasteRange,
  pickAudioFiles,
  renderPattern,
  setMaster,
  setMix,
  stopPatternPreview,
  takeStartupFiles,
  transportState,
  undoEdit,
} from "./lib/api";
import {
  defaultPattern,
  floorToBar,
  loadBeat,
  loadMode,
  saveBeat,
  saveMode,
  TRANSPARENT_MASTER,
} from "./lib/beat";
import { PatternDialog } from "./components/PatternDialog";
import { SessionScreen } from "./components/SessionScreen";
import type {
  AppMode,
  BeatSettings,
  ClipInfo,
  NewTrackSource,
  Pattern,
  Selection,
  Track,
} from "./types";

/** The pattern dialog: a fresh pattern, or the one behind an existing track. */
interface PatternEditor {
  pattern: Pattern;
  clipId: number | null;
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards against a second import batch starting while one is in flight.
  const busy = useRef(false);

  // ----- Modes: editor is the original app; beat adds the music tools. -----
  const [mode, setModeState] = useState<AppMode>(loadMode);
  const [beat, setBeat] = useState<BeatSettings>(loadBeat);
  const [patternEditor, setPatternEditor] = useState<PatternEditor | null>(null);
  const patternCount = useRef(0);
  const blankCount = useRef(0);
  const copiedCount = useRef(0);

  const changeMode = useCallback((next: AppMode) => {
    setModeState(next);
    saveMode(next);
    if (next === "editor") {
      setPatternEditor(null);
      void stopPatternPreview().catch(() => {});
    }
  }, []);

  const changeBeat = useCallback((changes: Partial<BeatSettings>) => {
    setBeat((current) => {
      const next = { ...current, ...changes };
      saveBeat(next);
      return next;
    });
  }, []);

  // Editor mode always hears the plain sum, exactly as before the bus existed.
  useEffect(() => {
    const master =
      mode === "beat" ? { gain: beat.masterGain, limiter: beat.limiter } : TRANSPARENT_MASTER;
    setMaster(master).catch(() => {
      /* Not running inside Tauri. */
    });
  }, [mode, beat.masterGain, beat.limiter]);

  const openPaths = useCallback(async (paths: string[]) => {
    if (busy.current || paths.length === 0) return;
    busy.current = true;
    setError(null);

    const failures: string[] = [];
    const imported: Track[] = [];

    for (const path of paths) {
      const name = path.split("/").pop() ?? path;
      setImporting(name);
      try {
        if (!isSupportedFile(path)) throw new Error("unsupported file type");
        const clip = await importAudio(path);
        imported.push({ clip, gain: 1, muted: false, soloed: false, inMaster: true, offset: 0 });
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // One state update for the batch, so the mix is published once.
    if (imported.length > 0) setTracks((current) => [...current, ...imported]);
    if (failures.length > 0) {
      setError(
        failures.length === 1
          ? `Could not open ${failures[0]}`
          : `Could not open ${failures.length} files — ${failures.join("; ")}`,
      );
    }

    setImporting(null);
    busy.current = false;
  }, []);

  const browse = useCallback(async () => {
    try {
      await openPaths(await pickAudioFiles());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [openPaths]);

  const replaceClip = useCallback((clip: ClipInfo) => {
    setTracks((current) =>
      current.map((track) => (track.clip.id === clip.id ? { ...track, clip } : track)),
    );
  }, []);

  /** Applies a destructive edit. Returns whether it went through. */
  const editSelection = useCallback(
    async (kind: "delete" | "crop", selection: Selection) => {
      try {
        const edit = kind === "delete" ? deleteRange : cropRange;
        replaceClip(await edit(selection.clipId, selection.start, selection.end));
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [replaceClip],
  );

  /** Copies a selection. Returns the clipboard's length, or null if it failed. */
  const copySelection = useCallback(async (selection: Selection) => {
    try {
      const length = await copyRange(selection.clipId, selection.start, selection.end);
      setError(null);
      return length;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  /** Pastes over a range of a track, or inserts when the range is empty. */
  const pasteInto = useCallback(
    async (target: Selection, silence: number) => {
      try {
        replaceClip(await pasteRange(target.clipId, target.start, target.end, silence));
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [replaceClip],
  );

  const undoTrack = useCallback(
    async (clipId: number) => {
      try {
        replaceClip(await undoEdit(clipId));
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [replaceClip],
  );

  /** Joins a whole file onto a track, before or after what is there. */
  const insertFile = useCallback(
    async (clipId: number, path: string, atEnd: boolean) => {
      try {
        replaceClip(await insertAudioFile(clipId, path, atEnd));
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [replaceClip],
  );

  const changeTrack = useCallback((clipId: number, changes: Partial<Track>) => {
    setTracks((current) =>
      current.map((track) => (track.clip.id === clipId ? { ...track, ...changes } : track)),
    );
  }, []);

  const removeTrack = useCallback((clipId: number) => {
    setTracks((current) => current.filter((track) => track.clip.id !== clipId));
    void closeClip(clipId);
  }, []);

  const closeAll = useCallback(() => {
    setTracks((current) => {
      current.forEach((track) => void closeClip(track.clip.id));
      return [];
    });
    setError(null);
  }, []);

  /** Swaps the whole session for an opened project's tracks. */
  const replaceSession = useCallback((opened: Track[]) => {
    setTracks((current) => {
      current.forEach((track) => void closeClip(track.clip.id));
      return opened;
    });
    setError(null);
  }, []);

  const addRecording = useCallback((clip: ClipInfo) => {
    setTracks((current) => [
      ...current,
      { clip, gain: 1, muted: false, soloed: false, inMaster: true, offset: 0 },
    ]);
  }, []);

  /** Adds a blank track, or one holding the clipboard. Returns its id, or null. */
  const addNewTrack = useCallback(async (source: NewTrackSource, offset: number) => {
    try {
      const clip =
        source.kind === "blank"
          ? await newBlankClip(source.seconds, `Blank ${(blankCount.current += 1)}`)
          : await newClipFromClipboard(`Copied ${(copiedCount.current += 1)}`);
      setTracks((current) => [
        ...current,
        { clip, gain: 1, muted: false, soloed: false, inMaster: true, offset },
      ]);
      setError(null);
      return clip.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  const openNewPattern = useCallback(() => {
    setPatternEditor({ pattern: defaultPattern(beat.bpm), clipId: null });
  }, [beat.bpm]);

  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  const openPatternFor = useCallback((clipId: number) => {
    const track = tracksRef.current.find((t) => t.clip.id === clipId);
    if (track?.pattern) setPatternEditor({ pattern: track.pattern, clipId });
  }, []);

  /** Renders the pattern and adds it as a track, or swaps it into the track it came from. */
  const commitPattern = useCallback(async (pattern: Pattern, replaceClipId: number | null) => {
    const existing =
      replaceClipId === null
        ? undefined
        : tracksRef.current.find((t) => t.clip.id === replaceClipId);
    const name = existing
      ? existing.clip.name.replace(/\d+(\.\d+)? BPM$/, `${pattern.bpm} BPM`)
      : `Beat ${(patternCount.current += 1)} · ${pattern.bpm} BPM`;

    const clip = await renderPattern(pattern, name);

    if (existing) {
      setTracks((current) =>
        current.map((t) => (t.clip.id === existing.clip.id ? { ...t, clip, pattern } : t)),
      );
      void closeClip(existing.clip.id);
      return;
    }

    // New patterns land at the start of the bar the playhead is in.
    let offset = 0;
    try {
      offset = floorToBar((await transportState()).positionSecs, pattern.bpm);
    } catch {
      /* No engine; start of the session. */
    }
    setTracks((current) => [
      ...current,
      { clip, gain: 1, muted: false, soloed: false, inMaster: true, offset, pattern },
    ]);
  }, []);

  const editedTrack =
    patternEditor?.clipId != null
      ? tracks.find((t) => t.clip.id === patternEditor.clipId)
      : undefined;

  // The engine mirrors the track list, so publish the whole mix on any change.
  useEffect(() => {
    setMix(tracks).catch(() => {
      /* A track was closed a moment ago; the next publish corrects it. */
    });
  }, [tracks]);

  // Files passed on the command line, or via "Open With".
  useEffect(() => {
    takeStartupFiles()
      .then((paths) => {
        if (paths.length > 0) void openPaths(paths);
      })
      .catch(() => {
        /* Not running inside Tauri. */
      });
  }, [openPaths]);

  // Native drag and drop: the webview reports real file paths, which the HTML
  // drag events cannot.
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setIsDragging(true);
        } else if (event.payload.type === "drop") {
          setIsDragging(false);
          void openPaths(event.payload.paths);
        } else {
          setIsDragging(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* Not running inside Tauri; "Add files…" still works. */
      });

    return () => unlisten?.();
  }, [openPaths]);

  return (
    <>
    <SessionScreen
      tracks={tracks}
      onAddFiles={browse}
      onOpenPaths={openPaths}
      onInsertFile={insertFile}
      onProjectOpened={replaceSession}
      onTrackChange={changeTrack}
      onTrackRemove={removeTrack}
      onCloseAll={closeAll}
      onEditSelection={editSelection}
      onCopySelection={copySelection}
      onPaste={pasteInto}
      onUndoTrack={undoTrack}
      onRecordingComplete={addRecording}
      onNewTrack={addNewTrack}
      isDragging={isDragging}
      isImporting={importing !== null}
      importingName={importing}
      error={error}
      mode={mode}
      onModeChange={changeMode}
      beat={mode === "beat" ? beat : undefined}
      onBeatChange={changeBeat}
      onNewPattern={openNewPattern}
      onEditPattern={openPatternFor}
    />
    {mode === "beat" && patternEditor && (
      <PatternDialog
        initial={patternEditor.pattern}
        bpm={beat.bpm}
        isUpdate={patternEditor.clipId !== null}
        note={
          editedTrack && editedTrack.clip.version > 0
            ? "This track's audio has been edited since it was made. Updating re-renders it from the grid, replacing those edits."
            : undefined
        }
        onCommit={(pattern) => commitPattern(pattern, patternEditor.clipId)}
        onClose={() => setPatternEditor(null)}
      />
    )}
    </>
  );
}
