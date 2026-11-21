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
  /** The project pattern this track was rendered from, so it can be reopened. */
  patternId?: string;
  /** Reverb, delay, wet and dry. Missing means the track plays as it is. */
  fx?: TrackFx;
  /** The stem this track is the mixdown of, so it can be opened. */
  stemId?: string;
}

/**
 * A stem: tracks mixed down into one track, which then plays, moves and mixes
 * like any other. Its tracks are kept, so it can be opened and changed, and
 * one of them may be a stem itself.
 */
export interface Stem {
  id: string;
  name: string;
  /** Offsets run from the start of the stem. */
  tracks: Track[];
}

/** A track's effects. Mirrors `TrackFx` in `fx.rs`. */
export interface TrackFx {
  /** Room size, 0–1; 0 is off. */
  reverb: number;
  /** Echo time in seconds; 0 is off. */
  delay: number;
  /** How much of each echo comes round again, 0–0.9. */
  feedback: number;
  /** Level of the reverb and echoes. */
  wet: number;
  /** Level of the track itself. */
  dry: number;
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

/** What an export is written as. Mirrors `ExportFormat` on the Rust side. */
export type ExportFormat =
  | { kind: "wav"; bitDepth: BitDepth }
  | { kind: "flac"; bitDepth: BitDepth }
  | { kind: "mp3"; kbps: number }
  | { kind: "aac"; kbps: number }
  | { kind: "ogg"; quality: number };

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

/** Where a take comes from: the default input, or everything the computer plays. */
export type RecordingSource = "microphone" | "system";

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
  | "synthLead"
  | "violin"
  | "viola"
  | "cello"
  | "contrabass"
  | "pizzicato"
  | "harp"
  | "oboe"
  | "clarinet"
  | "bassoon"
  | "trumpet"
  | "frenchHorn"
  | "trombone"
  | "tuba"
  | "timpani"
  | "glockenspiel"
  | "xylophone"
  | "celesta"
  | "sitar"
  | "sarod"
  | "veena"
  | "tanpura"
  | "sarangi"
  | "santoor"
  | "bansuri"
  | "shehnai"
  | "harmonium"
  | "tabla"
  | "bayan"
  | "mridangam"
  | "dhol"
  | "dholTilli"
  | "dholak"
  | "ghatam"
  | "kanjira"
  | "manjira"
  | "ektara"
  | "tumbi"
  | "nadaswaram"
  | "pungi"
  | "shankh";

export type RowSound =
  | { kind: "synth"; voice: SynthVoice }
  | { kind: "sample"; path: string; name: string };

export interface PatternRow {
  id: string;
  sound: RowSound;
  /** One per sixteenth note. */
  steps: boolean[];
  gain: number;
  /** Left/right balance: -1 is left only, 0 centred, 1 right only. Missing means centred. */
  pan?: number;
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
  /**
   * Stretches that play and gaps of silence, e.g. 2 bars, a 3-bar gap, 3 bars.
   * Each playing stretch starts the rows from the top. Missing means the whole
   * length plays; present, the sections add up to `bars`.
   */
  sections?: PatternSection[];
}

export interface PatternSection {
  bars: number;
  rest?: boolean;
}

/** A take saved as a file in the workspace, for a pattern row to play. */
export interface RecordedSample {
  path: string;
  name: string;
}

/** A pattern kept in the project, whether or not a track still uses it. */
export interface SavedPattern {
  id: string;
  name: string;
  pattern: Pattern;
}

/** One track of a saved project, listed before its audio is loaded. */
export interface ProjectTrackSummary {
  index: number;
  name: string;
  patternId?: string;
}

/** What a saved project holds, for bringing parts of it into this session. */
export interface ProjectContents {
  tracks: ProjectTrackSummary[];
  patterns: SavedPattern[];
}

/** One thing taken from another project: a track's audio, or a beat to render. */
export type ProjectItem =
  | { kind: "track"; project: string; track: ProjectTrackSummary; pattern?: SavedPattern }
  | { kind: "beat"; project: string; pattern: SavedPattern }
  | { kind: "stem"; project: string }
  /** Beats from a beats file, each rendered and all mixed down into one stem track named `name`. */
  | {
      kind: "beatsStem";
      project: string;
      name: string;
      patterns: SavedPattern[];
      /** The file's tracks, to place the beats where they were. */
      tracks: BeatTrack[];
    };

/** A beats file as read, before anything is rendered. Mirrors `BeatsFile` in `workspace.rs`. */
export interface BeatsFile {
  /** The project name the file was exported under. */
  name: string;
  /** The tracks made from the patterns, where they sat on the timeline. */
  tracks: BeatTrack[];
  patterns: SavedPattern[];
}

/** One track of a beats file. Mirrors `BeatTrack` in `workspace.rs`. */
export interface BeatTrack {
  name: string;
  patternId: string;
  gain: number;
  muted: boolean;
  soloed: boolean;
  inMaster: boolean;
  offsetSecs: number;
  fx?: TrackFx | null;
}

/** What importing a beats file hands back, ready to replace the session. */
export interface ImportedBeats extends OpenedProject {
  /** The project name the file was exported under. */
  name: string;
  /** Tracks that could not be rendered here, each with the reason. */
  skipped: string[];
}

/** What opening a project hands back, ready to replace the session. */
export interface OpenedProject {
  tracks: Track[];
  patterns: SavedPattern[];
  /** Missing for a beats file, which holds none. */
  stems?: Stem[];
}
