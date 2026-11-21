import { newRowId } from "./beat";
import type { Stem, Track } from "../types";

export function newStemId(): string {
  return `stem-${newRowId()}`;
}

/** The next free "Stem N" name. */
export function nextStemName(stems: Stem[]): string {
  const taken = new Set(stems.map((stem) => stem.name));
  let n = stems.length + 1;
  while (taken.has(`Stem ${n}`)) n++;
  return `Stem ${n}`;
}

/** A stem's id with the ids of every stem nested inside it, at any depth. */
export function stemFamily(id: string, stems: Stem[], found = new Set<string>()): Set<string> {
  if (found.has(id)) return found;
  found.add(id);
  stems
    .find((stem) => stem.id === id)
    ?.tracks.forEach((track) => track.stemId && stemFamily(track.stemId, stems, found));
  return found;
}

/** The stems these tracks are made of, nested ones included. */
export function stemsUsedBy(tracks: Track[], stems: Stem[]): Stem[] {
  const used = new Set<string>();
  tracks.forEach((track) => track.stemId && stemFamily(track.stemId, stems, used));
  return stems.filter((stem) => used.has(stem.id));
}

/** Everything about a stem's tracks that changes how its mixdown sounds. */
export function mixKey(tracks: Track[]): string {
  return JSON.stringify(
    tracks.map((track) => [
      track.clip.id,
      track.clip.version,
      track.gain,
      track.muted,
      track.soloed,
      track.inMaster,
      track.offset,
      track.fx,
    ]),
  );
}
