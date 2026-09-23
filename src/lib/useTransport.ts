import { useCallback, useEffect, useRef, useState } from "react";

import { transportState } from "./api";
import type { TransportState } from "../types";

const POLL_MS = 120;

const IDLE: TransportState = {
  playing: false,
  positionSecs: 0,
  durationSecs: 0,
  ready: false,
  error: null,
  outputSampleRate: 0,
};

/**
 * Follows the engine's transport.
 *
 * The engine is polled a few times a second, and the playhead is advanced
 * locally between polls — asking the backend on every frame would be a lot of
 * round trips for a number we can predict exactly.
 */
export function useTransport() {
  const [state, setState] = useState<TransportState>(IDLE);
  const [position, setPosition] = useState(0);
  const anchor = useRef({ position: 0, at: performance.now(), playing: false, duration: 0 });

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const next = await transportState();
        if (!active) return;
        setState(next);
        anchor.current = {
          position: next.positionSecs,
          at: performance.now(),
          playing: next.playing,
          duration: next.durationSecs,
        };
      } catch {
        /* Not running inside Tauri. */
      }
    };

    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const { position: base, at, playing, duration } = anchor.current;
      const elapsed = playing ? (performance.now() - at) / 1000 : 0;
      setPosition(Math.min(base + elapsed, duration || base + elapsed));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  /** Moves the local playhead immediately, without waiting for the next poll. */
  const anticipate = useCallback((seconds: number) => {
    anchor.current = { ...anchor.current, position: seconds, at: performance.now() };
    setPosition(seconds);
  }, []);

  return { state, position, anticipate };
}
