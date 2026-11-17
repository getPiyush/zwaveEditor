import type {
  AppMode,
  BeatSettings,
  MasterBus,
  Pattern,
  PatternRow,
  PatternSection,
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

export type VoiceGroup = "Drums" | "Instruments" | "Orchestra" | "Indian classical" | "Indian";

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
  { voice: "violin", label: "Violin", group: "Orchestra", note: 67, tuned: true, choke: true, gain: 0.4, range: [55, 100] },
  { voice: "viola", label: "Viola", group: "Orchestra", note: 60, tuned: true, choke: true, gain: 0.4, range: [48, 88] },
  { voice: "cello", label: "Cello", group: "Orchestra", note: 48, tuned: true, choke: true, gain: 0.45, range: [36, 76] },
  { voice: "contrabass", label: "Double bass", group: "Orchestra", note: 36, tuned: true, choke: true, gain: 0.55, range: [28, 60] },
  { voice: "pizzicato", label: "Pizzicato strings", group: "Orchestra", note: 55, tuned: true, choke: false, gain: 0.6, range: [36, 88] },
  { voice: "harp", label: "Harp", group: "Orchestra", note: 60, tuned: true, choke: false, gain: 0.55, range: [24, 103] },
  { voice: "oboe", label: "Oboe", group: "Orchestra", note: 69, tuned: true, choke: true, gain: 0.4, range: [58, 91] },
  { voice: "clarinet", label: "Clarinet", group: "Orchestra", note: 62, tuned: true, choke: true, gain: 0.4, range: [50, 94] },
  { voice: "bassoon", label: "Bassoon", group: "Orchestra", note: 46, tuned: true, choke: true, gain: 0.45, range: [34, 75] },
  { voice: "trumpet", label: "Trumpet", group: "Orchestra", note: 67, tuned: true, choke: true, gain: 0.4, range: [54, 84] },
  { voice: "frenchHorn", label: "French horn", group: "Orchestra", note: 53, tuned: true, choke: true, gain: 0.45, range: [41, 77] },
  { voice: "trombone", label: "Trombone", group: "Orchestra", note: 50, tuned: true, choke: true, gain: 0.45, range: [40, 72] },
  { voice: "tuba", label: "Tuba", group: "Orchestra", note: 36, tuned: true, choke: true, gain: 0.55, range: [28, 58] },
  { voice: "timpani", label: "Timpani", group: "Orchestra", note: 43, tuned: true, choke: false, gain: 0.75, range: [38, 60] },
  { voice: "glockenspiel", label: "Glockenspiel", group: "Orchestra", note: 79, tuned: true, choke: false, gain: 0.4, range: [67, 108] },
  { voice: "xylophone", label: "Xylophone", group: "Orchestra", note: 72, tuned: true, choke: false, gain: 0.5, range: [60, 96] },
  { voice: "celesta", label: "Celesta", group: "Orchestra", note: 72, tuned: true, choke: false, gain: 0.45, range: [60, 108] },
  { voice: "sitar", label: "Sitar", group: "Indian classical", note: 50, tuned: true, choke: false, gain: 0.55, range: [43, 84] },
  { voice: "sarod", label: "Sarod", group: "Indian classical", note: 48, tuned: true, choke: false, gain: 0.55, range: [40, 80] },
  { voice: "veena", label: "Veena", group: "Indian classical", note: 48, tuned: true, choke: false, gain: 0.55, range: [36, 76] },
  { voice: "tanpura", label: "Tanpura", group: "Indian classical", note: 48, tuned: true, choke: false, gain: 0.4, range: [36, 60] },
  { voice: "sarangi", label: "Sarangi", group: "Indian classical", note: 60, tuned: true, choke: true, gain: 0.4, range: [48, 84] },
  { voice: "santoor", label: "Santoor", group: "Indian classical", note: 62, tuned: true, choke: false, gain: 0.5, range: [48, 88] },
  { voice: "bansuri", label: "Bansuri", group: "Indian classical", note: 67, tuned: true, choke: true, gain: 0.45, range: [55, 86] },
  { voice: "shehnai", label: "Shehnai", group: "Indian classical", note: 67, tuned: true, choke: true, gain: 0.4, range: [57, 86] },
  { voice: "harmonium", label: "Harmonium", group: "Indian classical", note: 60, tuned: true, choke: true, gain: 0.4, range: [41, 89] },
  { voice: "tabla", label: "Tabla", group: "Indian classical", note: 62, tuned: true, choke: false, gain: 0.7, range: [55, 77] },
  { voice: "bayan", label: "Bayan (tabla bass)", group: "Indian classical", note: 41, tuned: true, choke: true, gain: 0.85, range: [33, 52] },
  { voice: "mridangam", label: "Mridangam", group: "Indian classical", note: 60, tuned: true, choke: false, gain: 0.7, range: [52, 72] },
  { voice: "dhol", label: "Dhol", group: "Indian", note: 36, tuned: false, choke: false, gain: 0.9, range: DRUM_RANGE },
  { voice: "dholTilli", label: "Dhol tilli", group: "Indian", note: 38, tuned: false, choke: false, gain: 0.7, range: DRUM_RANGE },
  { voice: "dholak", label: "Dholak", group: "Indian", note: 41, tuned: false, choke: false, gain: 0.8, range: DRUM_RANGE },
  { voice: "ghatam", label: "Ghatam", group: "Indian", note: 43, tuned: false, choke: false, gain: 0.7, range: DRUM_RANGE },
  { voice: "kanjira", label: "Kanjira", group: "Indian", note: 45, tuned: false, choke: false, gain: 0.65, range: DRUM_RANGE },
  { voice: "manjira", label: "Manjira", group: "Indian", note: 81, tuned: false, choke: false, gain: 0.45, range: DRUM_RANGE },
  { voice: "ektara", label: "Ektara", group: "Indian", note: 55, tuned: true, choke: true, gain: 0.6, range: [48, 72] },
  { voice: "tumbi", label: "Tumbi", group: "Indian", note: 72, tuned: true, choke: true, gain: 0.5, range: [64, 88] },
  { voice: "nadaswaram", label: "Nadaswaram", group: "Indian", note: 62, tuned: true, choke: true, gain: 0.4, range: [55, 84] },
  { voice: "pungi", label: "Pungi", group: "Indian", note: 62, tuned: true, choke: true, gain: 0.4, range: [57, 74] },
  { voice: "shankh", label: "Shankh (conch)", group: "Indian", note: 55, tuned: true, choke: true, gain: 0.5, range: [48, 64] },
];

export const VOICE_GROUPS: { group: VoiceGroup; voices: VoiceInfo[] }[] = (
  ["Drums", "Instruments", "Orchestra", "Indian classical", "Indian"] as const
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

/** How long a row can run before it loops. Eight bars fits the preview loop. */
export const ROW_BAR_OPTIONS = [1, 2, 4, 8] as const;

/** How many bars a row runs before it comes round again. */
export function rowBars(row: PatternRow): number {
  return Math.max(1, Math.ceil(row.steps.length / STEPS_PER_BAR));
}

/** The most bars any row in the pattern runs before looping. */
export function longestRowBars(pattern: Pattern): number {
  return pattern.rows.reduce((most, row) => Math.max(most, rowBars(row)), 1);
}

/**
 * Makes a row `bars` long. Growing it repeats what is there, so the new bars
 * start as copies to change; shrinking it drops the bars past the end.
 */
export function resizeRow(row: PatternRow, bars: number): Pick<PatternRow, "steps" | "stepNotes"> {
  const length = bars * STEPS_PER_BAR;
  const from = row.steps.length || 1;
  const steps = Array.from({ length }, (_, i) => row.steps[i % from] ?? false);
  const stepNotes = row.stepNotes
    ? Array.from({ length }, (_, i) => row.stepNotes?.[i % from] ?? null)
    : undefined;
  return { steps, stepNotes };
}

/**
 * Reads a length such as "4" or "2+3gap+3": bar counts joined by "+", with
 * "gap" (or "g", "rest", "r") after the ones that are silent. Returns null for
 * anything it can't read.
 */
export function parseLength(text: string): { bars: number; sections?: PatternSection[] } | null {
  const parts = text.toLowerCase().replace(/\s+/g, "").split("+");
  const sections: PatternSection[] = [];
  for (const part of parts) {
    const match = /^(\d+)(gap|g|rest|r|bars?|b)?$/.exec(part);
    if (!match) return null;
    const bars = Number(match[1]);
    if (bars < 1) return null;
    const rest = match[2] !== undefined && !match[2].startsWith("b");
    sections.push(rest ? { bars, rest } : { bars });
  }
  if (!sections.some((section) => !section.rest)) return null;
  const bars = sections.reduce((sum, section) => sum + section.bars, 0);
  // A single playing stretch is just a length.
  return sections.length === 1 ? { bars } : { bars, sections };
}

/** The length as it is typed: "4", or "2+3gap+3". */
export function formatLength(pattern: Pick<Pattern, "bars" | "sections">): string {
  if (!pattern.sections?.length) return String(pattern.bars);
  return pattern.sections.map((s) => `${s.bars}${s.rest ? "gap" : ""}`).join("+");
}

/** The longest stretch of the pattern that plays without a gap. */
export function longestPlayingBars(pattern: Pick<Pattern, "bars" | "sections">): number {
  if (!pattern.sections?.length) return pattern.bars;
  return pattern.sections.reduce((most, s) => (s.rest ? most : Math.max(most, s.bars)), 0);
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

export function newPatternId(): string {
  return `pattern-${newRowId()}`;
}

/** Whether two patterns would render the same. */
export function samePattern(a: Pattern, b: Pattern): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
