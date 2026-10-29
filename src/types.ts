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
