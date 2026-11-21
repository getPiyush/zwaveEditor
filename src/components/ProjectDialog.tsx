import { useEffect, useState } from "react";

import {
  exportBeats,
  importBeats,
  listProjects,
  openProject,
  pickBeatsFile,
  pickSavePath,
  saveProject,
} from "../lib/api";
import type {
  ImportedBeats,
  OpenedProject,
  ProjectSummary,
  SavedPattern,
  Stem,
  Track,
  WorkspaceInfo,
} from "../types";
import { WorkspaceBar } from "./WorkspaceBar";

interface Props {
  mode: "save" | "open";
  tracks: Track[];
  patterns: SavedPattern[];
  /** The stems the tracks are made of, saved with their own tracks. */
  stems: Stem[];
  /** The project this session was last saved as or opened from, if any. */
  currentName: string | null;
  workspace: WorkspaceInfo | null;
  onWorkspaceChange: (path: string | null) => Promise<void>;
  onSaved: (name: string) => void;
  onOpened: (name: string, project: OpenedProject) => void;
  /** A beats file replaced the session. It is not a saved project until saved. */
  onImported: (beats: ImportedBeats) => void;
  onClose: () => void;
}

function savedOn(project: ProjectSummary): string {
  return new Date(project.savedAt * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Saves the session into the workspace, or opens a project saved there. */
export function ProjectDialog({
  mode,
  tracks,
  patterns,
  stems,
  currentName,
  workspace,
  onWorkspaceChange,
  onSaved,
  onOpened,
  onImported,
  onClose,
}: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState(currentName ?? "Untitled");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  // Each workspace has projects of its own.
  const workspacePath = workspace?.path;
  useEffect(() => {
    let active = true;
    listProjects()
      .then((list) => {
        if (active) setProjects(list);
      })
      .catch(() => {
        /* Not running inside Tauri. */
      });
    return () => {
      active = false;
    };
  }, [workspacePath]);

  const trimmed = name.trim();
  const replaces = projects.some((project) => project.name === trimmed);

  const save = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const folder = await saveProject(trimmed, tracks, patterns, stems);
      // The folder is named after the project, minus anything a path cannot hold.
      onSaved(folder.split(/[\\/]/).pop() ?? trimmed);
      setResult(`Saved to ${folder}`);
      setProjects(await listProjects());
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const open = async (project: ProjectSummary) => {
    setBusy(true);
    setError(null);
    try {
      onOpened(project.name, await openProject(project.name));
      onClose();
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const beatTracks = tracks.filter((track) => track.patternId !== undefined).length;
  const audioTracks = tracks.length - beatTracks;

  const exportJson = async () => {
    setError(null);
    setResult(null);
    try {
      const path = await pickSavePath(`${trimmed || "Untitled"} beats.json`, {
        name: "zwaveEditor beats",
        extension: "json",
      });
      if (!path) return;
      setBusy(true);
      await exportBeats(path, trimmed || "Untitled", tracks, patterns);
      setResult(
        `Exported ${plural(patterns.length, "pattern")} and ${plural(beatTracks, "beat track")} to ${path}` +
          (audioTracks > 0 ? `. ${plural(audioTracks, "audio track")} left out.` : "."),
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const importJson = async () => {
    setError(null);
    try {
      const path = await pickBeatsFile();
      if (!path) return;
      setBusy(true);
      const beats = await importBeats(path);
      onImported(beats);
      if (beats.skipped.length === 0) {
        onClose();
        return;
      }
      setError(
        `Imported, but ${plural(beats.skipped.length, "track")} could not be rendered here ` +
          `(their patterns are in the Patterns menu): ${beats.skipped.join("; ")}`,
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={mode === "save" ? "Save project" : "Open project"}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title">{mode === "save" ? "Save project" : "Open project"}</h2>
        <p className="modal__subtitle">
          {mode === "save"
            ? `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}, with edits and mixer settings${
                patterns.length > 0
                  ? `, and ${patterns.length} ${patterns.length === 1 ? "pattern" : "patterns"}`
                  : ""
              }.`
            : tracks.length > 0
              ? "Opening a project closes the tracks that are open now."
              : "Projects saved in this workspace."}
        </p>

        {mode === "save" ? (
          <>
            <label className="modal__field">
              <span>Name</span>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && trimmed && !busy) void save();
                }}
                disabled={busy}
                autoFocus
              />
            </label>
            <div className="modal__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void save()}
                disabled={busy || !trimmed || (tracks.length === 0 && patterns.length === 0)}
              >
                {replaces ? "Replace saved project" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => void exportJson()}
                disabled={busy || patterns.length === 0}
                title="Every pattern and the tracks made from them, as one small JSON file. No audio."
              >
                Export beats (JSON)…
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal__actions">
              <button
                type="button"
                onClick={() => void importJson()}
                disabled={busy}
                title="Opens a beats file exported from zwaveEditor and renders its tracks."
              >
                Import beats (JSON)…
              </button>
            </div>
            {projects.length === 0 ? (
              <p className="modal__note">No projects are saved in this workspace yet.</p>
            ) : (
              <ul className="project-list">
                {projects.map((project) => (
                  <li key={project.name}>
                    <button type="button" onClick={() => void open(project)} disabled={busy}>
                      <span className="project-list__name">{project.name}</span>
                      <span className="project-list__meta">
                        {project.trackCount} {project.trackCount === 1 ? "track" : "tracks"} ·{" "}
                        {savedOn(project)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {busy && <p className="modal__note">{mode === "save" ? "Writing…" : "Opening…"}</p>}
        {result && <p className="modal__note modal__note--ok">{result}</p>}
        {error && <p className="modal__note modal__note--error">{error}</p>}

        <div className="modal__workspace">
          <WorkspaceBar workspace={workspace} onChange={onWorkspaceChange} />
        </div>

        <div className="modal__footer">
          <button type="button" onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
