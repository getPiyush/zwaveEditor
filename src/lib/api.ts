import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import type {
  BitDepth,
  ClipInfo,
  InputDeviceInfo,
  MasterBus,
  Pattern,
  PeakData,
  PreviewState,
  ProjectSummary,
  Track,
  TransportState,
  TuneInfo,
  WorkspaceInfo,
} from "../types";

/**
 * Containers symphonia can decode. Kept in one place so the file dialog, the
 * drop handler and the UI copy never drift apart.
 */
export const SUPPORTED_EXTENSIONS = [
  "wav",
  "wave",
  "mp3",
  "flac",
  "ogg",
  "oga",
  "m4a",
  "mp4",
  "aac",
  "alac",
  "aiff",
  "aif",
  "caf",
  "mkv",
  "webm",
];

export function isSupportedFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/** Opens the native file picker. Returns every file the user chose. */
export async function pickAudioFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Audio", extensions: SUPPORTED_EXTENSIONS }],
  });
  if (Array.isArray(selected)) return selected;
  return typeof selected === "string" ? [selected] : [];
}

export function importAudio(path: string): Promise<ClipInfo> {
  return invoke<ClipInfo>("import_audio", { path });
}

export function getPeaks(
  clipId: number,
  startFrame: number,
  endFrame: number,
  width: number,
): Promise<PeakData> {
  return invoke<PeakData>("get_peaks", {
    clipId,
    startFrame: Math.max(0, Math.floor(startFrame)),
    endFrame: Math.max(0, Math.ceil(endFrame)),
    width: Math.max(1, Math.round(width)),
  });
}

/** Files passed on the command line, if the app was launched with any. */
export function takeStartupFiles(): Promise<string[]> {
  return invoke<string[]>("take_startup_files");
}

export function closeClip(clipId: number): Promise<void> {
  return invoke("close_clip", { clipId });
}

/**
 * Resolves the staged track list into what the engine should actually hear.
 * A track is silent if it is muted, left out of the master, or another track
 * is soloed.
 */
function mixSettings(tracks: Track[]) {
  const anySoloed = tracks.some((track) => track.soloed);
  return tracks.map((track) => ({
    clipId: track.clip.id,
    gain: track.gain,
    muted: track.muted || !track.inMaster || (anySoloed && !track.soloed),
    offsetSecs: track.offset,
  }));
}

export function setMix(tracks: Track[]): Promise<void> {
  return invoke("set_mix", { tracks: mixSettings(tracks) });
}

export function deleteRange(clipId: number, start: number, end: number): Promise<ClipInfo> {
  return invoke<ClipInfo>("delete_range", { clipId, startSecs: start, endSecs: end });
}

export function cropRange(clipId: number, start: number, end: number): Promise<ClipInfo> {
  return invoke<ClipInfo>("crop_range", { clipId, startSecs: start, endSecs: end });
}

/** Copies a range to the clipboard, which lives in Rust. Returns its length in seconds. */
export function copyRange(clipId: number, start: number, end: number): Promise<number> {
  return invoke<number>("copy_range", { clipId, startSecs: start, endSecs: end });
}

/**
 * Replaces a range with the clipboard; pass `start === end` to insert.
 * `silence` seconds of blank filler go in just before the pasted audio.
 */
export function pasteRange(
  clipId: number,
  start: number,
  end: number,
  silence = 0,
): Promise<ClipInfo> {
  return invoke<ClipInfo>("paste_range", {
    clipId,
    startSecs: start,
    endSecs: end,
    silenceSecs: silence,
  });
}

/** Opens a new clip of `seconds` of silence, for a blank track. */
export function newBlankClip(seconds: number, name: string): Promise<ClipInfo> {
  return invoke<ClipInfo>("new_blank_clip", { seconds, name });
}

/** Opens what is on the clipboard as a new clip of its own. */
export function newClipFromClipboard(name: string): Promise<ClipInfo> {
  return invoke<ClipInfo>("new_clip_from_clipboard", { name });
}

export function undoEdit(clipId: number): Promise<ClipInfo> {
  return invoke<ClipInfo>("undo_edit", { clipId });
}

/** Asks where to save a single file. Returns null if the user cancelled. */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "WAV audio", extensions: ["wav"] }],
  });
  return path ?? null;
}

/** Asks for a folder. Returns null if the user cancelled. */
export async function pickDirectory(): Promise<string | null> {
  const directory = await open({ directory: true, multiple: false });
  return typeof directory === "string" ? directory : null;
}

/** Writes each selected track to its own WAV file. Returns the paths written. */
export function exportTracks(
  clipIds: number[],
  directory: string,
  bitDepth: BitDepth,
): Promise<string[]> {
  return invoke<string[]>("export_tracks", { clipIds, directory, bitDepth });
}

/** Mixes the selected tracks down to one stereo WAV. */
export function exportMaster(
  tracks: Track[],
  path: string,
  bitDepth: BitDepth,
  master?: MasterBus,
): Promise<string> {
  return invoke<string>("export_master", {
    tracks: mixSettings(tracks),
    path,
    bitDepth,
    master: master ?? null,
  });
}

/** Plays from the playhead; with `until`, stops there, as when playing a selection. */
export function transportPlay(until?: number): Promise<void> {
  return invoke("transport_play", { until: until ?? null });
}

export function transportPause(): Promise<void> {
  return invoke("transport_pause");
}

export function transportSeek(seconds: number): Promise<void> {
  return invoke("transport_seek", { seconds });
}

export function transportState(): Promise<TransportState> {
  return invoke<TransportState>("transport_state");
}

export function probeInputDevice(): Promise<InputDeviceInfo> {
  return invoke<InputDeviceInfo>("probe_input_device");
}

export function startRecording(): Promise<void> {
  return invoke("start_recording");
}

export function stopRecording(): Promise<ClipInfo> {
  return invoke<ClipInfo>("stop_recording");
}

export function repeatRange(
  clipId: number,
  start: number,
  end: number,
  count: number,
): Promise<ClipInfo> {
  return invoke<ClipInfo>("repeat_range", {
    clipId,
    startSecs: start,
    endSecs: end,
    count,
  });
}

export function fillRange(
  clipId: number,
  fillStart: number,
  fillEnd: number,
  sourceStart: number,
  sourceEnd: number,
): Promise<ClipInfo> {
  return invoke<ClipInfo>("fill_range", {
    clipId,
    fillStartSecs: fillStart,
    fillEndSecs: fillEnd,
    sourceStartSecs: sourceStart,
    sourceEndSecs: sourceEnd,
  });
}

export function adjustVolume(
  clipId: number,
  start: number,
  end: number,
  gain: number,
): Promise<ClipInfo> {
  return invoke<ClipInfo>("adjust_volume", {
    clipId,
    startSecs: start,
    endSecs: end,
    gain,
  });
}

export function fadeIn(clipId: number, start: number, end: number): Promise<ClipInfo> {
  return invoke<ClipInfo>("fade_in", { clipId, startSecs: start, endSecs: end });
}

export function fadeOut(clipId: number, start: number, end: number): Promise<ClipInfo> {
  return invoke<ClipInfo>("fade_out", { clipId, startSecs: start, endSecs: end });
}

export function adjustPitch(
  clipId: number,
  start: number,
  end: number,
  factor: number,
): Promise<ClipInfo> {
  return invoke<ClipInfo>("adjust_pitch", {
    clipId,
    startSecs: start,
    endSecs: end,
    factor,
  });
}

export function adjustTime(
  clipId: number,
  start: number,
  end: number,
  factor: number,
): Promise<ClipInfo> {
  return invoke<ClipInfo>("adjust_time", {
    clipId,
    startSecs: start,
    endSecs: end,
    factor,
  });
}

export function reverseRange(clipId: number, start: number, end: number): Promise<ClipInfo> {
  return invoke<ClipInfo>("reverse_range", { clipId, startSecs: start, endSecs: end });
}

export function invertRange(clipId: number, start: number, end: number): Promise<ClipInfo> {
  return invoke<ClipInfo>("invert_range", { clipId, startSecs: start, endSecs: end });
}

/** Joins a whole audio file onto a clip, before its start or after its end. */
export function insertAudioFile(clipId: number, path: string, atEnd: boolean): Promise<ClipInfo> {
  return invoke<ClipInfo>("insert_audio_file", { clipId, path, atEnd });
}

export function getWorkspace(): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("get_workspace");
}

/** Points the workspace at a folder; pass null to go back to the default. */
export function setWorkspace(path: string | null): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("set_workspace", { path });
}

export function listTunes(): Promise<TuneInfo[]> {
  return invoke<TuneInfo[]>("list_tunes");
}

/** Copies files into the workspace's tunes folder. Returns the whole library. */
export function addTunes(paths: string[]): Promise<{ tunes: TuneInfo[]; failures: string[] }> {
  return invoke("add_tunes", { paths });
}

/** Deletes a tune from the tunes folder. Returns what is left. */
export function removeTune(name: string): Promise<TuneInfo[]> {
  return invoke<TuneInfo[]>("remove_tune", { name });
}

/** Plays a tune, resuming it if it is the one that was paused. */
export function previewPlay(name: string): Promise<void> {
  return invoke("preview_play", { name });
}

export function previewPause(): Promise<void> {
  return invoke("preview_pause");
}

export function previewState(): Promise<PreviewState> {
  return invoke<PreviewState>("preview_state");
}

/** Saves the session into the workspace. Returns the project's folder. */
export function saveProject(name: string, tracks: Track[]): Promise<string> {
  return invoke<string>("save_project", {
    name,
    tracks: tracks.map((track) => ({
      clipId: track.clip.id,
      gain: track.gain,
      muted: track.muted,
      soloed: track.soloed,
      inMaster: track.inMaster,
      offsetSecs: track.offset,
    })),
  });
}

export function listProjects(): Promise<ProjectSummary[]> {
  return invoke<ProjectSummary[]>("list_projects");
}

/** Loads a project's tracks as new clips, ready to replace the session. */
export function openProject(name: string): Promise<Track[]> {
  return invoke<Track[]>("open_project", { name });
}

/** Gain and limiter on the summed mix. Unity gain with no limiter is the original sound. */
export function setMaster(master: MasterBus): Promise<void> {
  return invoke("set_master", { master });
}

/** Renders a step pattern into a new clip on the Rust side. */
export function renderPattern(pattern: Pattern, name: string): Promise<ClipInfo> {
  return invoke<ClipInfo>("render_pattern", { pattern, name });
}

/** Loops a pattern on its own, outside the timeline. Call again to update it in place. */
export function previewPattern(pattern: Pattern): Promise<void> {
  return invoke("preview_pattern", { pattern });
}

/** Silences the pattern loop started by `previewPattern`. */
export function stopPatternPreview(): Promise<void> {
  return invoke("stop_pattern_preview");
}
