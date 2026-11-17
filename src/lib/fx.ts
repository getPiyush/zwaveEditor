import type { TrackFx } from "../types";

/** The longest delay time offered. Mirrors `MAX_DELAY_SECONDS` in `fx.rs`. */
export const MAX_DELAY_SECONDS = 2;

/**
 * What the panel starts from: every effect off, with wet and feedback at
 * levels that sound right the moment a reverb or delay is turned up.
 */
export const DEFAULT_FX: TrackFx = {
  reverb: 0,
  delay: 0,
  feedback: 0.35,
  wet: 0.3,
  dry: 1,
};

/** Whether these settings change the sound. Mirrors `TrackFx::is_active`. */
export function fxIsActive(fx: TrackFx | undefined): boolean {
  if (!fx) return false;
  return (fx.wet > 0 && (fx.reverb > 0 || fx.delay > 0)) || fx.dry !== 1;
}
