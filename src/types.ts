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
  | "chime";

export type RowSound =
  | { kind: "synth"; voice: SynthVoice }
  | { kind: "sample"; path: string; name: string };

export interface PatternRow {
  id: string;
  sound: RowSound;
  /** One per sixteenth note. */
  steps: boolean[];
  gain: number;
  /** MIDI note: pitch for the 808 and chime; for samples, 60 plays them as recorded. */
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
