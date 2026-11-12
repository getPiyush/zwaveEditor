import { useEffect, useState } from "react";

import {
  listProjects,
  listTunes,
  previewPause,
  previewPlay,
  previewPattern,
  previewProjectTrack,
  previewState,
  projectContents,
  projectPreviewKey,
  stopPatternPreview,
} from "../lib/api";
import { formatTime } from "../lib/format";
import type {
  PreviewState,
  ProjectContents,
  ProjectItem,
  ProjectSummary,
  TuneInfo,
} from "../types";

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
  /** The project this session was opened from or saved as, if any. */
  currentProject: string | null;
  /** Beats (patterns) can only be rendered and edited in Beat mode. */
  beatMode: boolean;
  onProject: (item: ProjectItem) => Promise<void>;
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
  currentProject,
  beatMode,
  onProject,
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

  // Null until the saved projects have been listed.
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectName, setProjectName] = useState("");
  const [contents, setContents] = useState<ProjectContents | null>(null);
  const [contentsError, setContentsError] = useState<string | null>(null);
  // "track:<index>" or "beat:<pattern id>".
  const [itemKey, setItemKey] = useState("");

  useEffect(() => {
    listProjects()
      .then((found) => {
        setProjects(found);
        // Another project is the likelier source than this one.
        const first = found.find((p) => p.name !== currentProject) ?? found[0];
        if (first) setProjectName(first.name);
      })
      .catch(() => setProjects([]));
    // Only the projects there were when the dialog opened.
  }, []);

  useEffect(() => {
    if (!projectName) return;
    let active = true;
    setContents(null);
    setContentsError(null);
    setItemKey("");
    projectContents(projectName)
      .then((found) => {
        if (!active) return;
        setContents(found);
        const first = found.tracks[0]
          ? `track:${found.tracks[0].index}`
          : beatMode && found.patterns[0]
            ? `beat:${found.patterns[0].id}`
            : "";
        setItemKey(first);
      })
      .catch((err) => active && setContentsError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [projectName, beatMode]);

  const projectItem = (): ProjectItem | null => {
    if (!contents) return null;
    const split = itemKey.indexOf(":");
    const kind = itemKey.slice(0, split);
    const id = itemKey.slice(split + 1);
    if (kind === "track") {
      const track = contents.tracks.find((t) => String(t.index) === id);
      if (!track) return null;
      const pattern = contents.patterns.find((p) => p.id === track.patternId);
      return { kind: "track", project: projectName, track, pattern };
    }
    const pattern = contents.patterns.find((p) => p.id === id);
    return kind === "beat" && pattern ? { kind: "beat", project: projectName, pattern } : null;
  };
  const selectedItem = projectItem();

  // The beat whose loop is playing, if any. Tracks use the preview player below.
  const [beatPreviewId, setBeatPreviewId] = useState<string | null>(null);
  const [itemPreviewLoading, setItemPreviewLoading] = useState(false);
  const [itemPreviewError, setItemPreviewError] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewing = !!tune && preview?.name === tune.name && preview.playing;
  const trackKey =
    selectedItem?.kind === "track" ? projectPreviewKey(projectName, selectedItem.track.index) : null;
  const itemPreviewing =
    selectedItem?.kind === "beat"
      ? beatPreviewId === selectedItem.pattern.id
      : !!trackKey && preview?.name === trackKey && preview.playing;
  const projectTrackPlaying = !!preview?.playing && !!preview.name?.startsWith("project/");

  // Choosing something else stops what was being previewed from the project.
  useEffect(() => {
    setItemPreviewError(null);
    if (beatPreviewId !== null) {
      void stopPatternPreview().catch(() => {});
      setBeatPreviewId(null);
    }
    if (projectTrackPlaying) {
      previewPause().catch(() => {});
      setPreview((current) => current && { ...current, playing: false });
    }
    // Only on a change of selection, not of what is playing.
  }, [projectName, itemKey]);

  // The beat loop, like the preview player, stops with the dialog.
  useEffect(() => () => void stopPatternPreview().catch(() => {}), []);

  const toggleItemPreview = async () => {
    if (!selectedItem) return;
    setItemPreviewError(null);
    try {
      if (itemPreviewing) {
        if (selectedItem.kind === "beat") {
          await stopPatternPreview();
          setBeatPreviewId(null);
        } else {
          await previewPause();
          setPreview((current) => current && { ...current, playing: false });
        }
        return;
      }
      setItemPreviewLoading(true);
      if (selectedItem.kind === "beat") {
        // One thing at a time: silence the preview player first.
        await previewPause();
        setPreview((current) => current && { ...current, playing: false });
        await previewPattern(selectedItem.pattern.pattern);
        setBeatPreviewId(selectedItem.pattern.id);
      } else {
        await stopPatternPreview();
        setBeatPreviewId(null);
        await previewProjectTrack(projectName, selectedItem.track.index);
        setPreview(await previewState());
      }
    } catch (err) {
      setItemPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setItemPreviewLoading(false);
    }
  };

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
      if (beatPreviewId !== null) {
        await stopPatternPreview();
        setBeatPreviewId(null);
      }
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
                <h3>From another project</h3>
                {projects === null ? (
                  <p>Reading projects…</p>
                ) : projects.length === 0 ? (
                  <p>No saved projects yet.</p>
                ) : (
                  <>
                    <p>
                      {beatMode
                        ? "A track comes as it was saved; a beat is rendered fresh at its own tempo and can be edited here."
                        : "A track comes as it was saved, edits and all."}{" "}
                      It starts at the playhead.
                    </p>
                    <div className="add-track__tune-row add-track__project-row">
                      <select
                        className="add-track__tune"
                        value={projectName}
                        onChange={(e) => setProjectName(e.target.value)}
                        disabled={processing}
                        aria-label="Project"
                      >
                        {projects.map((p) => (
                          <option key={p.name} value={p.name}>
                            {p.name}
                            {p.name === currentProject ? " (this project, as saved)" : ""}
                          </option>
                        ))}
                      </select>
                      {contentsError ? (
                        <span className="add-track__error">{contentsError}</span>
                      ) : contents === null ? (
                        <span className="add-track__time">Reading…</span>
                      ) : contents.tracks.length === 0 && (!beatMode || contents.patterns.length === 0) ? (
                        <span className="add-track__time">Nothing to add</span>
                      ) : (
                        <select
                          className="add-track__tune"
                          value={itemKey}
                          onChange={(e) => setItemKey(e.target.value)}
                          disabled={processing}
                          aria-label="Track or beat"
                        >
                          {contents.tracks.length > 0 && (
                            <optgroup label="Tracks">
                              {contents.tracks.map((t) => (
                                <option key={t.index} value={`track:${t.index}`}>
                                  {t.name}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {beatMode && contents.patterns.length > 0 && (
                            <optgroup label="Beats">
                              {contents.patterns.map((p) => (
                                <option key={p.id} value={`beat:${p.id}`}>
                                  {p.name} · {p.pattern.bpm} BPM
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      )}
                      {selectedItem && (
                        <button
                          type="button"
                          className="btn btn--small"
                          onClick={() => void toggleItemPreview()}
                          disabled={processing || itemPreviewLoading}
                          title={
                            itemPreviewing
                              ? "Stop the preview"
                              : selectedItem.kind === "beat"
                                ? "Loop this beat before adding it"
                                : "Hear this track before adding it"
                          }
                        >
                          {itemPreviewLoading ? "…" : itemPreviewing ? "Stop" : "Preview"}
                        </button>
                      )}
                      {itemPreviewing && selectedItem?.kind === "track" && preview && (
                        <span className="add-track__time">
                          {formatTime(preview.positionSecs)} / {formatTime(preview.durationSecs)}
                        </span>
                      )}
                    </div>
                    {itemPreviewError && <p className="add-track__error">{itemPreviewError}</p>}
                  </>
                )}
              </div>
              <button
                className="btn btn--primary"
                onClick={() => {
                  if (selectedItem) void run(() => onProject(selectedItem));
                }}
                disabled={processing || isImporting || !selectedItem}
              >
                {processing && selectedItem ? "Adding…" : "Add from project"}
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
