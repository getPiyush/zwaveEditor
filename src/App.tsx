import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import {
  closeClip,
  copyRange,
  cropRange,
  deleteRange,
  importAudio,
  importProjectTrack,
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
  renameClip,
} from "./lib/api";
import {
  defaultPattern,
  floorToBar,
  loadBeat,
  loadMode,
  newPatternId,
  samePattern,
  saveBeat,
  saveMode,
  TRANSPARENT_MASTER,
} from "./lib/beat";
import { moveItem } from "./lib/useReorder";
import { PatternDialog } from "./components/PatternDialog";
import { SessionScreen } from "./components/SessionScreen";
import type {
  AppMode,
  BeatSettings,
  ClipInfo,
  NewTrackSource,
  OpenedProject,
  Pattern,
  ProjectItem,
  SavedPattern,
  Selection,
  Track,
} from "./types";

/**
 * The pattern dialog: a fresh pattern, or one the project keeps. `updating`
 * means committing changes that pattern and the tracks made from it; otherwise
 * committing adds a track and leaves the kept pattern as it is.
 */
interface PatternEditor {
  pattern: Pattern;
  patternId: string | null;
  updating: boolean;
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
  // Every pattern made in this project, kept even once its tracks are gone.
  const [patterns, setPatterns] = useState<SavedPattern[]>([]);
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

  const renameTrack = useCallback(
    async (clipId: number, name: string) => {
      try {
        replaceClip(await renameClip(clipId, name));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
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

  const reorderTracks = useCallback((from: number, slot: number) => {
    setTracks((current) => moveItem(current, from, slot));
  }, []);

  const closeAll = useCallback(() => {
    setTracks((current) => {
      current.forEach((track) => void closeClip(track.clip.id));
      return [];
    });
    setPatterns([]);
    setError(null);
  }, []);

  /** Swaps the whole session for an opened project's tracks and patterns. */
  const replaceSession = useCallback((opened: OpenedProject) => {
    setTracks((current) => {
      current.forEach((track) => void closeClip(track.clip.id));
      return opened.tracks;
    });
    setPatterns(opened.patterns);
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
    setPatternEditor({ pattern: defaultPattern(beat.bpm), patternId: null, updating: false });
  }, [beat.bpm]);

  const bpmRef = useRef(beat.bpm);
  bpmRef.current = beat.bpm;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const patternsRef = useRef(patterns);
  patternsRef.current = patterns;

  /** Opens a kept pattern to place it again, or to start a new one from it. */
  const openSavedPattern = useCallback((id: string) => {
    const saved = patternsRef.current.find((p) => p.id === id);
    if (saved) setPatternEditor({ pattern: saved.pattern, patternId: id, updating: false });
  }, []);

  const openPatternFor = useCallback((clipId: number) => {
    const track = tracksRef.current.find((t) => t.clip.id === clipId);
    const saved = patternsRef.current.find((p) => p.id === track?.patternId);
    if (saved) setPatternEditor({ pattern: saved.pattern, patternId: saved.id, updating: true });
  }, []);

  /**
   * Updates a kept pattern and every track made from it, or adds a track. An
   * added track only reuses a kept pattern if the grid is unchanged; anything
   * else is kept as a new pattern, so the earlier one is never overwritten.
   */
  const commitPattern = useCallback(async (pattern: Pattern, editor: PatternEditor) => {
    const saved = patternsRef.current.find((p) => p.id === editor.patternId);

    if (saved && editor.updating) {
      const linked = tracksRef.current.filter((t) => t.patternId === saved.id);
      const clips = await Promise.all(
        linked.map((t) =>
          renderPattern(pattern, t.clip.name.replace(/\d+(\.\d+)? BPM$/, `${pattern.bpm} BPM`)),
        ),
      );
      setPatterns((current) => current.map((p) => (p.id === saved.id ? { ...p, pattern } : p)));
      setTracks((current) =>
        current.map((t) => {
          const index = linked.findIndex((l) => l.clip.id === t.clip.id);
          return index < 0 ? t : { ...t, clip: clips[index] };
        }),
      );
      linked.forEach((t) => void closeClip(t.clip.id));
      return;
    }

    const entry: SavedPattern =
      saved && samePattern(saved.pattern, pattern)
        ? saved
        : { id: newPatternId(), name: `Beat ${patternsRef.current.length + 1}`, pattern };

    const clip = await renderPattern(pattern, `${entry.name} · ${pattern.bpm} BPM`);

    if (entry !== saved) setPatterns((current) => [...current, entry]);

    // New patterns land at the start of the session-grid bar the playhead is in.
    let offset = 0;
    try {
      offset = floorToBar((await transportState()).positionSecs, bpmRef.current);
    } catch {
      /* No engine; start of the session. */
    }
    setTracks((current) => [
      ...current,
      { clip, gain: 1, muted: false, soloed: false, inMaster: true, offset, patternId: entry.id },
    ]);
  }, []);

  /**
   * Makes a pattern from another project one of this session's. An identical
   * one already here is reused; otherwise it gets a fresh id, and the project's
   * name if its own is taken.
   */
  const adoptPattern = useCallback((saved: SavedPattern, project: string): SavedPattern => {
    const existing = patternsRef.current.find((p) => samePattern(p.pattern, saved.pattern));
    if (existing) return existing;
    const taken = new Set(patternsRef.current.map((p) => p.name));
    let name = taken.has(saved.name) ? `${saved.name} (${project})` : saved.name;
    for (let n = 2; taken.has(name); n++) name = `${saved.name} (${project} ${n})`;
    const entry = { id: newPatternId(), name, pattern: saved.pattern };
    patternsRef.current = [...patternsRef.current, entry];
    setPatterns((current) => [...current, entry]);
    return entry;
  }, []);

  /**
   * Adds a track or a beat from another saved project, at the playhead (the
   * start of its bar in Beat mode). Returns the new clip's id, or null.
   */
  const addFromProject = useCallback(
    async (item: ProjectItem): Promise<number | null> => {
      try {
        let offset = 0;
        try {
          const at = (await transportState()).positionSecs;
          offset = modeRef.current === "beat" ? floorToBar(at, bpmRef.current) : at;
        } catch {
          /* No engine; start of the session. */
        }

        let track: Track;
        if (item.kind === "track") {
          const loaded = await importProjectTrack(item.project, item.track.index);
          const entry = item.pattern && adoptPattern(item.pattern, item.project);
          // A solo carried over would silence the rest of this session.
          track = { ...loaded, soloed: false, offset, patternId: entry?.id };
        } else {
          const entry = adoptPattern(item.pattern, item.project);
          const clip = await renderPattern(
            entry.pattern,
            `${entry.name} · ${entry.pattern.bpm} BPM`,
          );
          track = { clip, gain: 1, muted: false, soloed: false, inMaster: true, offset, patternId: entry.id };
        }
        setTracks((current) => [...current, track]);
        setError(null);
        return track.clip.id;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [adoptPattern],
  );

  const openedPattern = patterns.find((p) => p.id === patternEditor?.patternId);
  const linkedTracks = openedPattern ? tracks.filter((t) => t.patternId === openedPattern.id) : [];

  let patternNote: string | undefined;
  if (patternEditor?.updating) {
    const parts: string[] = [];
    if (linkedTracks.length > 1) {
      parts.push(`Updating re-renders all ${linkedTracks.length} tracks made from this pattern.`);
    }
    if (linkedTracks.some((t) => t.clip.version > 0)) {
      parts.push("Audio edits made to them since are replaced by the grid.");
    }
    patternNote = parts.join(" ") || undefined;
  } else if (openedPattern) {
    patternNote = `Adds a track. If you change the grid it is kept as a new pattern, and ${openedPattern.name} stays as it is.`;
  }

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
      patterns={patterns}
      patternDraftOpen={mode === "beat" && patternEditor !== null}
      onAddFiles={browse}
      onOpenPaths={openPaths}
      onInsertFile={insertFile}
      onProjectOpened={replaceSession}
      onTrackChange={changeTrack}
      onTrackRemove={removeTrack}
      onTrackReorder={reorderTracks}
      onCloseAll={closeAll}
      onEditSelection={editSelection}
      onCopySelection={copySelection}
      onPaste={pasteInto}
      onUndoTrack={undoTrack}
      onRenameTrack={renameTrack}
      onRecordingComplete={addRecording}
      onNewTrack={addNewTrack}
      onAddFromProject={addFromProject}
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
      onOpenPattern={openSavedPattern}
    />
    {mode === "beat" && patternEditor && (
      <PatternDialog
        initial={patternEditor.pattern}
        bpm={beat.bpm}
        title={
          openedPattern
            ? `${patternEditor.updating ? "Edit " : ""}${openedPattern.name}`
            : "New pattern"
        }
        isUpdate={patternEditor.updating}
        note={patternNote}
        onCommit={(pattern) => commitPattern(pattern, patternEditor)}
        onClose={() => setPatternEditor(null)}
      />
    )}
    </>
  );
}
