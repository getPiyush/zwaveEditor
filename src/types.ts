export interface ClipInfo {
  id: number;
  name: string;
  path: string;
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  durationSecs: number;
  codec: string;
  bitsPerSample: number | null;
  fileSizeBytes: number;
  /** Bumped on every edit; cached peaks are stale when it changes. */
  version: number;
  canUndo: boolean;
}

export interface PeakData {
  clipId: number;
  startFrame: number;
  endFrame: number;
  width: number;
  /** One flat `[min, max, rms, ...]` array per channel. */
  channels: number[][];
}

/** A clip as the session has it staged: one row in the mixer. */
export interface Track {
  clip: ClipInfo;
  gain: number;
  muted: boolean;
  soloed: boolean;
  /** Whether this file is part of the master track, and so of an export. */
  inMaster: boolean;
  /** Where the track starts on the session timeline, in seconds. */
  offset: number;
  /** Set when the track was made in the pattern editor, so it can be reopened. */
  pattern?: Pattern;
}

/** A range selected on one track, in seconds from the start of the clip. */
/** What a track made from scratch starts out holding. */
export type NewTrackSource = { kind: "blank"; seconds: number } | { kind: "clipboard" };

export interface Selection {
  clipId: number;
  start: number;
  end: number;
}

export type BitDepth = "int16" | "int24" | "float32";

export interface TransportState {
  playing: boolean;
  positionSecs: number;
  durationSecs: number;
  ready: boolean;
  error: string | null;
  outputSampleRate: number;
}

/** The visible slice of the session timeline, in seconds. */
export interface ViewRange {
  start: number;
  end: number;
}

export interface InputDeviceInfo {
  sampleRate: number;
  channels: number;
}

/** The folder that holds the tunes library and saved projects. */
export interface WorkspaceInfo {
  path: string;
  /** True until the user picks a folder of their own. */
  isDefault: boolean;
  defaultPath: string;
}

/** One file in the workspace's tunes folder. */
export interface TuneInfo {
  name: string;
  path: string;
  sizeBytes: number;
}

/** The tune being auditioned from the quick-tunes panel, if any. */
export interface PreviewState {
  name: string | null;
  playing: boolean;
  positionSecs: number;
  durationSecs: number;
}

/** Where a tune dragged out of the panel would land. */
export type TuneDrop =
  | { kind: "new" }
  | { kind: "before" | "after"; clipId: number; trackName: string };

export interface ProjectSummary {
  name: string;
  trackCount: number;
  /** Seconds since the Unix epoch. */
  savedAt: number;
}

/** Editor is the original app; Beat adds tempo, grid, master bus and patterns. */
export type AppMode = "editor" | "beat";

export type SnapDivision = "off" | "bar" | "beat" | "eighth" | "sixteenth";

export interface BeatSettings {
  bpm: number;
  snap: SnapDivision;
  masterGain: number;
  limiter: boolean;
}

export interface MasterBus {
  gain: number;
  limiter: boolean;
}

export type SynthVoice =
  | "kick"
  | "bass808"
  | "snare"
  | "clap"
  | "closedHat"
  | "openHat"
  | "chime"
  | "rim"
  | "tom"
  | "shaker"
  | "cowbell"
  | "piano"
  | "electricPiano"
  | "guitar"
  | "bass"
  | "organ"
  | "strings"
  | "brass"
  | "flute"
  | "marimba"
  | "synthLead";

export type RowSound =
  | { kind: "synth"; voice: SynthVoice }
  | { kind: "sample"; path: string; name: string };

export interface PatternRow {
  id: string;
  sound: RowSound;
  /** One per sixteenth note. */
  steps: boolean[];
  gain: number;
  /**
   * A note per step, for melodies on tuned rows. A missing or null entry
   * plays `note`.
   */
  stepNotes?: (number | null)[];
  /** MIDI note: pitch for tuned voices (808, tom, instruments); for samples, 60 plays them as recorded. */
  note: number;
  /** Each hit cuts off the one before. */
  choke: boolean;
  muted: boolean;
}

export interface Pattern {
  bpm: number;
  bars: number;
  /** 0 straight, 1 fully swung. */
  swing: number;
  rows: PatternRow[];
}
