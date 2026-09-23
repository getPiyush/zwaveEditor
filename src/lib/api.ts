import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import type { BitDepth, ClipInfo, InputDeviceInfo, PeakData, Track, TransportState } from "../types";

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

/** Replaces a range with the clipboard; pass `start === end` to insert. */
export function pasteRange(clipId: number, start: number, end: number): Promise<ClipInfo> {
  return invoke<ClipInfo>("paste_range", { clipId, startSecs: start, endSecs: end });
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
): Promise<string> {
  return invoke<string>("export_master", { tracks: mixSettings(tracks), path, bitDepth });
}

export function transportPlay(): Promise<void> {
  return invoke("transport_play");
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
