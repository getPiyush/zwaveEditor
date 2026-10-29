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

export interface VoiceInfo {
  voice: SynthVoice;
  label: string;
  /** Default MIDI note for tuned voices. */
  note: number;
  tuned: boolean;
  choke: boolean;
}

export const VOICES: VoiceInfo[] = [
  { voice: "kick", label: "Kick", note: 36, tuned: false, choke: false },
  { voice: "bass808", label: "808", note: 33, tuned: true, choke: true },
  { voice: "snare", label: "Snare", note: 38, tuned: false, choke: false },
  { voice: "clap", label: "Clap", note: 39, tuned: false, choke: false },
  { voice: "closedHat", label: "Hat", note: 42, tuned: false, choke: false },
  { voice: "openHat", label: "Open hat", note: 46, tuned: false, choke: true },
  { voice: "chime", label: "Chime", note: 76, tuned: true, choke: false },
];

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

/** The note range offered for a row: bass register for the 808, bells up high. */
export function noteRange(row: PatternRow): [number, number] {
  if (row.sound.kind === "sample") return [36, 84];
  if (row.sound.voice === "bass808") return [24, 52];
  return [55, 96];
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
    gain: voice === "closedHat" || voice === "openHat" ? 0.55 : voice === "chime" ? 0.45 : 0.9,
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
