import { useEffect, useState } from "react";

import { listProjects, openProject, saveProject } from "../lib/api";
import type { ProjectSummary, Track, WorkspaceInfo } from "../types";
import { WorkspaceBar } from "./WorkspaceBar";

interface Props {
  mode: "save" | "open";
  tracks: Track[];
  /** The project this session was last saved as or opened from, if any. */
  currentName: string | null;
  workspace: WorkspaceInfo | null;
  onWorkspaceChange: (path: string | null) => Promise<void>;
  onSaved: (name: string) => void;
  onOpened: (name: string, tracks: Track[]) => void;
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
  currentName,
  workspace,
  onWorkspaceChange,
  onSaved,
  onOpened,
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
      const folder = await saveProject(trimmed, tracks);
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
            ? `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}, with edits and mixer settings.`
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
                disabled={busy || !trimmed || tracks.length === 0}
              >
                {replaces ? "Replace saved project" : "Save"}
              </button>
            </div>
          </>
        ) : projects.length === 0 ? (
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
