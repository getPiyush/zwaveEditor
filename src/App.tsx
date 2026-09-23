import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import {
  closeClip,
  copyRange,
  cropRange,
  deleteRange,
  importAudio,
  isSupportedFile,
  pasteRange,
  pickAudioFiles,
  setMix,
  takeStartupFiles,
  undoEdit,
} from "./lib/api";
import { ImportScreen } from "./components/ImportScreen";
import { SessionScreen } from "./components/SessionScreen";
import type { ClipInfo, Selection, Track } from "./types";

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards against a second import batch starting while one is in flight.
  const busy = useRef(false);

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
    async (target: Selection) => {
      try {
        replaceClip(await pasteRange(target.clipId, target.start, target.end));
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

  const addRecording = useCallback((clip: ClipInfo) => {
    setTracks((current) => [
      ...current,
      { clip, gain: 1, muted: false, soloed: false, inMaster: true, offset: 0 },
    ]);
  }, []);

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
        /* Not running inside Tauri; the browse button still works. */
      });

    return () => unlisten?.();
  }, [openPaths]);

  if (tracks.length > 0) {
    return (
      <SessionScreen
        tracks={tracks}
        onAddFiles={browse}
        onTrackChange={changeTrack}
        onTrackRemove={removeTrack}
        onCloseAll={closeAll}
        onEditSelection={editSelection}
        onCopySelection={copySelection}
        onPaste={pasteInto}
        onUndoTrack={undoTrack}
        onRecordingComplete={addRecording}
        isImporting={importing !== null}
        error={error}
      />
    );
  }

  return (
    <ImportScreen
      onBrowse={browse}
      isDragging={isDragging}
      isImporting={importing !== null}
      importingName={importing}
      error={error}
    />
  );
}
