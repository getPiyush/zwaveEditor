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
  openProject,
  pasteRange,
  pickAudioFiles,
  renderMix,
  renderPattern,
  setMaster,
  setMix,
  stopPatternPreview,
  takeStartupFiles,
  transportPause,
  transportSeek,
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
import { mixKey, newStemId, stemFamily } from "./lib/stem";
import { moveItem } from "./lib/useReorder";
import { PatternDialog } from "./components/PatternDialog";
import { SessionScreen } from "./components/SessionScreen";
import type {
  BeatTrack,
  AppMode,
  BeatSettings,
  ClipInfo,
  NewTrackSource,
  OpenedProject,
  Pattern,
  ProjectItem,
  SavedPattern,
  Selection,
  Stem,
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

/** One stem opened from the level above: what to go back to, and how it stood. */
interface StemLevel {
  stemId: string;
  /** The stem's own track, one of `parentTracks`. */
  clipId: number;
  /** The tracks of the level above, as they were when the stem was opened. */
  parentTracks: Track[];
  /** `mixKey` of the stem's tracks when it was opened, to tell if they changed. */
  enteredKey: string;
}

/** The playhead, or the start if there is no engine. Pauses playback first if asked. */
async function playheadNow(pause = false): Promise<number> {
  try {
    if (pause) await transportPause();
    return (await transportState()).positionSecs;
  } catch {
    return 0;
  }
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
  // Every stem in the session, nested ones too. The one open right now has
  // its tracks in `tracks`; its entry here is brought up to date on leaving.
  const [stems, setStems] = useState<Stem[]>([]);
  // The stems opened, outermost first. Empty at the session's top level.
  const [stemTrail, setStemTrail] = useState<StemLevel[]>([]);
  const [mixingStem, setMixingStem] = useState(false);
  const stemBusy = useRef(false);
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

  /** Forgets a stem and every stem inside it, closing their tracks' clips. */
  const dropStem = useCallback((id: string) => {
    const family = stemFamily(id, stemsRef.current);
    stemsRef.current.forEach((stem) => {
      if (family.has(stem.id)) stem.tracks.forEach((track) => void closeClip(track.clip.id));
    });
    stemsRef.current = stemsRef.current.filter((stem) => !family.has(stem.id));
    setStems(stemsRef.current);
  }, []);

  const removeTrack = useCallback(
    (clipId: number) => {
      const removed = tracksRef.current.find((track) => track.clip.id === clipId);
      setTracks((current) => current.filter((track) => track.clip.id !== clipId));
      void closeClip(clipId);
      if (removed?.stemId) dropStem(removed.stemId);
    },
    [dropStem],
  );

  /** Closes every clip the session holds: this level, the levels above, and all stems. */
  const closeEverything = useCallback(() => {
    const ids = new Set<number>();
    const add = (list: Track[]) => list.forEach((track) => ids.add(track.clip.id));
    add(tracksRef.current);
    stemTrailRef.current.forEach((level) => add(level.parentTracks));
    stemsRef.current.forEach((stem) => add(stem.tracks));
    ids.forEach((id) => void closeClip(id));
    stemsRef.current = [];
    stemTrailRef.current = [];
    setStems([]);
    setStemTrail([]);
  }, []);

  const reorderTracks = useCallback((from: number, slot: number) => {
    setTracks((current) => moveItem(current, from, slot));
  }, []);

  const closeAll = useCallback(() => {
    closeEverything();
    setTracks([]);
    setPatterns([]);
    setError(null);
  }, [closeEverything]);

  /** Swaps the whole session for an opened project's tracks, patterns and stems. */
  const replaceSession = useCallback(
    (opened: OpenedProject) => {
      closeEverything();
      setTracks(opened.tracks);
      setPatterns(opened.patterns);
      stemsRef.current = opened.stems ?? [];
      setStems(stemsRef.current);
      setError(null);
    },
    [closeEverything],
  );

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
  const stemsRef = useRef(stems);
  stemsRef.current = stems;
  const stemTrailRef = useRef(stemTrail);
  stemTrailRef.current = stemTrail;

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
   * Mixes the chosen tracks down into one stem track, which takes the place of
   * the first of them. The stem starts where the earliest of them does.
   * Returns the stem track's clip id, or null if it failed.
   */
  const makeStem = useCallback(async (clipIds: number[], name: string): Promise<number | null> => {
    const chosen = tracksRef.current.filter((track) => clipIds.includes(track.clip.id));
    if (chosen.length === 0 || stemBusy.current) return null;
    stemBusy.current = true;
    setMixingStem(true);
    try {
      const start = Math.min(...chosen.map((track) => track.offset));
      const members = chosen.map((track) => ({ ...track, offset: track.offset - start }));
      const stemName = name.trim() || "Stem";
      const clip = await renderMix(members, stemName);
      const stem: Stem = { id: newStemId(), name: stemName, tracks: members };
      const track: Track = {
        clip,
        gain: 1,
        muted: false,
        soloed: false,
        inMaster: true,
        offset: start,
        stemId: stem.id,
      };
      stemsRef.current = [...stemsRef.current, stem];
      setStems(stemsRef.current);
      setTracks((current) => {
        const first = current.findIndex((t) => clipIds.includes(t.clip.id));
        const kept = current.filter((t) => !clipIds.includes(t.clip.id));
        const at = current.slice(0, Math.max(first, 0)).filter((t) => !clipIds.includes(t.clip.id)).length;
        return [...kept.slice(0, at), track, ...kept.slice(at)];
      });
      setError(null);
      return clip.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      stemBusy.current = false;
      setMixingStem(false);
    }
  }, []);

  /** Opens a stem track to work on the tracks inside it. The playhead keeps its place. */
  const openStem = useCallback(async (clipId: number) => {
    if (stemBusy.current) return;
    const track = tracksRef.current.find((t) => t.clip.id === clipId);
    const stem = stemsRef.current.find((s) => s.id === track?.stemId);
    if (!track || !stem) return;
    const at = await playheadNow(true);
    const level: StemLevel = {
      stemId: stem.id,
      clipId,
      parentTracks: tracksRef.current,
      enteredKey: mixKey(stem.tracks),
    };
    stemTrailRef.current = [...stemTrailRef.current, level];
    setStemTrail(stemTrailRef.current);
    setTracks(stem.tracks);
    void transportSeek(Math.max(0, at - track.offset)).catch(() => {});
  }, []);

  /**
   * Goes back up to `depth` stems deep (0 is the session). Each stem left is
   * mixed down again if its tracks changed, and that change carries up to the
   * stems around it. A stem left with no tracks is removed.
   */
  const leaveStems = useCallback(async (depth: number) => {
    let trail = stemTrailRef.current;
    if (trail.length <= depth || stemBusy.current) return;
    stemBusy.current = true;
    setMixingStem(true);
    // Old clips are closed only once every level has been mixed, and new ones
    // are closed again if any level fails, so a failure changes nothing.
    const replaced: number[] = [];
    const rendered: number[] = [];
    try {
      let at = await playheadNow(true);
      let current = tracksRef.current;
      let all = stemsRef.current;
      while (trail.length > depth) {
        const level = trail[trail.length - 1];
        const stemTrack = level.parentTracks.find((t) => t.clip.id === level.clipId);
        let parent = level.parentTracks;
        if (current.length === 0 || !stemTrack) {
          parent = parent.filter((t) => t.clip.id !== level.clipId);
          replaced.push(level.clipId);
          all = all.filter((stem) => stem.id !== level.stemId);
        } else {
          if (mixKey(current) !== level.enteredKey) {
            const clip = await renderMix(current, stemTrack.clip.name);
            rendered.push(clip.id);
            replaced.push(level.clipId);
            parent = parent.map((t) => (t.clip.id === level.clipId ? { ...t, clip } : t));
          }
          const members = current;
          all = all.map((stem) =>
            stem.id === level.stemId ? { ...stem, name: stemTrack.clip.name, tracks: members } : stem,
          );
        }
        at += stemTrack?.offset ?? 0;
        current = parent;
        trail = trail.slice(0, -1);
      }
      replaced.forEach((id) => void closeClip(id));
      stemsRef.current = all;
      stemTrailRef.current = trail;
      tracksRef.current = current;
      setStems(all);
      setStemTrail(trail);
      setTracks(current);
      setError(null);
      void transportSeek(at).catch(() => {});
    } catch (err) {
      rendered.forEach((id) => void closeClip(id));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      stemBusy.current = false;
      setMixingStem(false);
    }
  }, []);

  /**
   * Opens a saved project as one stem track: every track of it, mixed down,
   * with its patterns and stems brought along so the stem can be opened and
   * changed here. The project's own timeline is kept inside the stem.
   */
  const stemFromProject = useCallback(
    async (project: string, offset: number): Promise<Track> => {
      const opened = await openProject(project);
      const nestedStems = opened.stems ?? [];
      try {
        if (opened.tracks.length === 0) throw new Error(`${project} has no tracks to make a stem of`);
        const stemIds = new Map(nestedStems.map((stem) => [stem.id, newStemId()]));
        const kept = new Map(opened.patterns.map((p) => [p.id, p]));
        const adopt = (track: Track): Track => {
          const saved = track.patternId ? kept.get(track.patternId) : undefined;
          return {
            ...track,
            patternId: saved ? adoptPattern(saved, project).id : undefined,
            stemId: track.stemId ? stemIds.get(track.stemId) : undefined,
          };
        };
        const members = opened.tracks.map(adopt);
        const clip = await renderMix(members, project);
        const stem: Stem = { id: newStemId(), name: project, tracks: members };
        const nested = nestedStems.map((s) => ({
          id: stemIds.get(s.id)!,
          name: s.name,
          tracks: s.tracks.map(adopt),
        }));
        stemsRef.current = [...stemsRef.current, ...nested, stem];
        setStems(stemsRef.current);
        return { clip, gain: 1, muted: false, soloed: false, inMaster: true, offset, stemId: stem.id };
      } catch (err) {
        opened.tracks.forEach((track) => void closeClip(track.clip.id));
        nestedStems.forEach((stem) => stem.tracks.forEach((track) => void closeClip(track.clip.id)));
        throw err;
      }
    },
    [adoptPattern],
  );

  /**
   * Renders beats from a beats file and mixes them into one stem track. Each
   * of the file's tracks made from a picked beat becomes a track inside the
   * stem, where it sat in the file and mixed as it was; a picked beat no track
   * uses starts at the top. The stem starts where the earliest of them does,
   * that far past `offset`, so the beats keep their places relative to it.
   */
  const stemFromBeats = useCallback(
    async (
      source: string,
      name: string,
      picked: SavedPattern[],
      fileTracks: BeatTrack[],
      offset: number,
    ): Promise<Track> => {
      if (picked.length === 0) throw new Error("Pick at least one beat to make a stem of");
      const members: Track[] = [];
      try {
        for (const saved of picked) {
          const entry = adoptPattern(saved, source);
          const placed = fileTracks.filter((t) => t.patternId === saved.id);
          const label = `${entry.name} · ${entry.pattern.bpm} BPM`;
          if (placed.length === 0) {
            const clip = await renderPattern(entry.pattern, label);
            members.push({ clip, gain: 1, muted: false, soloed: false, inMaster: true, offset: 0, patternId: entry.id });
          }
          // Each track gets a clip of its own, even when tracks share a beat.
          for (const t of placed) {
            const clip = await renderPattern(entry.pattern, t.name || label);
            members.push({
              clip,
              gain: t.gain,
              muted: t.muted,
              soloed: t.soloed,
              inMaster: t.inMaster,
              offset: Math.max(0, t.offsetSecs),
              patternId: entry.id,
              fx: t.fx ?? undefined,
            });
          }
        }
        const start = Math.min(...members.map((track) => track.offset));
        members.forEach((track) => (track.offset -= start));
        const stemName = name.trim() || "Stem";
        const clip = await renderMix(members, stemName);
        const stem: Stem = { id: newStemId(), name: stemName, tracks: members };
        stemsRef.current = [...stemsRef.current, stem];
        setStems(stemsRef.current);
        return { clip, gain: 1, muted: false, soloed: false, inMaster: true, offset: offset + start, stemId: stem.id };
      } catch (err) {
        members.forEach((track) => void closeClip(track.clip.id));
        throw err;
      }
    },
    [adoptPattern],
  );

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
        } else if (item.kind === "stem") {
          track = await stemFromProject(item.project, offset);
        } else if (item.kind === "beatsStem") {
          track = await stemFromBeats(
            item.project || "beats file",
            item.name,
            item.patterns,
            item.tracks,
            offset,
          );
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
    [adoptPattern, stemFromProject, stemFromBeats],
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
      stems={stems}
      stemTrail={stemTrail.map(
        (level) => level.parentTracks.find((t) => t.clip.id === level.clipId)?.clip.name ?? "Stem",
      )}
      mixingStem={mixingStem}
      onMakeStem={makeStem}
      onOpenStem={(clipId) => void openStem(clipId)}
      onLeaveStem={(depth) => void leaveStems(depth)}
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
