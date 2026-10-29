import type {
  AppMode,
  BeatSettings,
  MasterBus,
  Pattern,
  PatternRow,
  RowSound,
  SnapDivision,
  SynthVoice,
} from "../types";

/** Everything here is 4/4: four beats to a bar, four sixteenths to a beat. */
export const BEATS_PER_BAR = 4;
export const STEPS_PER_BAR = 16;

export const DEFAULT_BEAT: BeatSettings = {
  bpm: 90,
  snap: "sixteenth",
  masterGain: 1,
  limiter: true,
};

/** What editor mode sends: the mix exactly as it was before the bus existed. */
export const TRANSPARENT_MASTER: MasterBus = { gain: 1, limiter: false };

export const MIN_BPM = 40;
export const MAX_BPM = 220;

export const SNAP_OPTIONS: { value: SnapDivision; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "bar", label: "Bar" },
  { value: "beat", label: "Beat" },
  { value: "eighth", label: "1/8" },
  { value: "sixteenth", label: "1/16" },
];

export function beatSeconds(bpm: number): number {
  return 60 / bpm;
}

export function barSeconds(bpm: number): number {
  return BEATS_PER_BAR * beatSeconds(bpm);
}

/** The snap interval in seconds, or null when snapping is off. */
export function gridSeconds(snap: SnapDivision, bpm: number): number | null {
  const beat = beatSeconds(bpm);
  switch (snap) {
    case "bar":
      return beat * BEATS_PER_BAR;
    case "beat":
      return beat;
    case "eighth":
      return beat / 2;
    case "sixteenth":
      return beat / 4;
    default:
      return null;
  }
}

/** Rounds a session time to the nearest grid line. */
export function snapTime(seconds: number, settings: BeatSettings): number {
  const grid = gridSeconds(settings.snap, settings.bpm);
  if (grid === null || !Number.isFinite(seconds)) return seconds;
  return Math.max(0, Math.round(seconds / grid) * grid);
}

/** The start of the bar a time falls in. */
export function floorToBar(seconds: number, bpm: number): number {
  const bar = barSeconds(bpm);
  // A hair of tolerance so a playhead sitting exactly on a bar line stays there.
  return Math.max(0, Math.floor(seconds / bar + 1e-6) * bar);
}

/** "bar.beat.sixteenth", 1-based, the way DAWs count. */
export function formatBarBeat(seconds: number, bpm: number): string {
  const sixteenths = Math.floor(Math.max(0, seconds) / (beatSeconds(bpm) / 4) + 1e-6);
  const bar = Math.floor(sixteenths / STEPS_PER_BAR) + 1;
  const beat = Math.floor((sixteenths % STEPS_PER_BAR) / 4) + 1;
  const sixteenth = (sixteenths % 4) + 1;
  return `${bar}.${beat}.${sixteenth}`;
}

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return DEFAULT_BEAT.bpm;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm * 10) / 10));
}

// ---------- Built-in voices ----------

export type VoiceGroup = "Drums" | "Instruments";

export interface VoiceInfo {
  voice: SynthVoice;
  label: string;
  group: VoiceGroup;
  /** Default MIDI note for tuned voices. */
  note: number;
  tuned: boolean;
  choke: boolean;
  /** Row volume a new row starts at, so sustained voices don't bury the drums. */
  gain: number;
  /** The notes offered, in the instrument's natural register. */
  range: [number, number];
}

const DRUM_RANGE: [number, number] = [36, 84];

export const VOICES: VoiceInfo[] = [
  { voice: "kick", label: "Kick", group: "Drums", note: 36, tuned: false, choke: false, gain: 0.9, range: DRUM_RANGE },
  { voice: "bass808", label: "808", group: "Drums", note: 33, tuned: true, choke: true, gain: 0.9, range: [24, 52] },
  { voice: "snare", label: "Snare", group: "Drums", note: 38, tuned: false, choke: false, gain: 0.9, range: DRUM_RANGE },
  { voice: "clap", label: "Clap", group: "Drums", note: 39, tuned: false, choke: false, gain: 0.9, range: DRUM_RANGE },
  { voice: "rim", label: "Rim", group: "Drums", note: 37, tuned: false, choke: false, gain: 0.6, range: DRUM_RANGE },
  { voice: "tom", label: "Tom", group: "Drums", note: 45, tuned: true, choke: false, gain: 0.75, range: [36, 60] },
  { voice: "closedHat", label: "Hat", group: "Drums", note: 42, tuned: false, choke: false, gain: 0.55, range: DRUM_RANGE },
  { voice: "openHat", label: "Open hat", group: "Drums", note: 46, tuned: false, choke: true, gain: 0.55, range: DRUM_RANGE },
  { voice: "shaker", label: "Shaker", group: "Drums", note: 70, tuned: false, choke: false, gain: 0.45, range: DRUM_RANGE },
  { voice: "cowbell", label: "Cowbell", group: "Drums", note: 56, tuned: false, choke: false, gain: 0.45, range: DRUM_RANGE },
  { voice: "piano", label: "Piano", group: "Instruments", note: 60, tuned: true, choke: false, gain: 0.55, range: [36, 96] },
  { voice: "electricPiano", label: "Electric piano", group: "Instruments", note: 60, tuned: true, choke: false, gain: 0.5, range: [36, 88] },
  { voice: "guitar", label: "Guitar", group: "Instruments", note: 52, tuned: true, choke: false, gain: 0.6, range: [40, 84] },
  { voice: "bass", label: "Bass guitar", group: "Instruments", note: 40, tuned: true, choke: true, gain: 0.8, range: [28, 55] },
  { voice: "organ", label: "Organ", group: "Instruments", note: 60, tuned: true, choke: true, gain: 0.4, range: [36, 88] },
  { voice: "strings", label: "Strings", group: "Instruments", note: 60, tuned: true, choke: false, gain: 0.4, range: [36, 88] },
  { voice: "brass", label: "Brass", group: "Instruments", note: 58, tuned: true, choke: true, gain: 0.45, range: [40, 80] },
  { voice: "flute", label: "Flute", group: "Instruments", note: 72, tuned: true, choke: true, gain: 0.45, range: [60, 96] },
  { voice: "marimba", label: "Marimba", group: "Instruments", note: 64, tuned: true, choke: false, gain: 0.55, range: [45, 96] },
  { voice: "synthLead", label: "Synth lead", group: "Instruments", note: 67, tuned: true, choke: true, gain: 0.35, range: [48, 91] },
  { voice: "chime", label: "Chime", group: "Instruments", note: 76, tuned: true, choke: false, gain: 0.45, range: [55, 96] },
];

export const VOICE_GROUPS: { group: VoiceGroup; voices: VoiceInfo[] }[] = (
  ["Drums", "Instruments"] as const
).map((group) => ({ group, voices: VOICES.filter((info) => info.group === group) }));

export function voiceInfo(voice: SynthVoice): VoiceInfo {
  return VOICES.find((info) => info.voice === voice) ?? VOICES[0];
}

export function soundLabel(sound: RowSound): string {
  return sound.kind === "synth" ? voiceInfo(sound.voice).label : sound.name;
}

/** Whether the row's note control does anything. */
export function rowIsTuned(row: PatternRow): boolean {
  return row.sound.kind === "sample" || voiceInfo(row.sound.voice).tuned;
}

/** The note range offered for a row: each voice's natural register. */
export function noteRange(row: PatternRow): [number, number] {
  if (row.sound.kind === "sample") return [36, 84];
  return voiceInfo(row.sound.voice).range;
}

/** The note a step plays: its own, or the row's. */
export function stepNote(row: PatternRow, index: number): number {
  return row.stepNotes?.[index] ?? row.note;
}

/** Moves every note in a row by `semitones`, so a melody survives a change of sound. */
export function transposeRow(row: PatternRow, semitones: number): Pick<PatternRow, "note" | "stepNotes"> {
  return {
    note: row.note + semitones,
    stepNotes: row.stepNotes?.map((note) => (note === null ? null : note + semitones)),
  };
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(note: number): string {
  return `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

let rowCounter = 0;

export function newRowId(): string {
  rowCounter += 1;
  return `row-${Date.now().toString(36)}-${rowCounter}`;
}

function steps(on: number[]): boolean[] {
  const row = Array<boolean>(STEPS_PER_BAR).fill(false);
  on.forEach((index) => (row[index] = true));
  return row;
}

export function synthRow(voice: SynthVoice, on: number[] = []): PatternRow {
  const info = voiceInfo(voice);
  return {
    id: newRowId(),
    sound: { kind: "synth", voice },
    steps: steps(on),
    gain: info.gain,
    note: info.note,
    choke: info.choke,
    muted: false,
  };
}

/** A boom-bap starting point: something playable the moment the editor opens. */
export function defaultPattern(bpm: number): Pattern {
  return {
    bpm,
    bars: 4,
    swing: 0.2,
    rows: [
      synthRow("kick", [0, 7, 10]),
      synthRow("bass808", [0, 10]),
      synthRow("snare", [4, 12]),
      synthRow("clap", []),
      synthRow("closedHat", [0, 2, 4, 6, 8, 10, 12, 14]),
      synthRow("openHat", []),
      synthRow("chime", []),
    ],
  };
}

// ---------- Remembered between launches ----------

const MODE_KEY = "zwave.mode";
const BEAT_KEY = "zwave.beat";

export function loadMode(): AppMode {
  try {
    return localStorage.getItem(MODE_KEY) === "beat" ? "beat" : "editor";
  } catch {
    return "editor";
  }
}

export function saveMode(mode: AppMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* Storage is unavailable; the mode just won't be remembered. */
  }
}

export function loadBeat(): BeatSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(BEAT_KEY) ?? "null") as Partial<BeatSettings> | null;
    if (!stored) return DEFAULT_BEAT;
    return {
      bpm: clampBpm(Number(stored.bpm ?? DEFAULT_BEAT.bpm)),
      snap: SNAP_OPTIONS.some((o) => o.value === stored.snap)
        ? (stored.snap as SnapDivision)
        : DEFAULT_BEAT.snap,
      masterGain: Math.min(1.5, Math.max(0, Number(stored.masterGain ?? 1) || 0)),
      limiter: stored.limiter ?? DEFAULT_BEAT.limiter,
    };
  } catch {
    return DEFAULT_BEAT;
  }
}

export function saveBeat(settings: BeatSettings) {
  try {
    localStorage.setItem(BEAT_KEY, JSON.stringify(settings));
  } catch {
    /* Not remembered; harmless. */
  }
}
