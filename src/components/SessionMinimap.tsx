import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { getPeaks } from "../lib/api";
import { clampView, drawChannel, prepareCanvas, trackColors } from "../lib/waveform";
import type { Track, ViewRange } from "../types";

const HEIGHT = 54;
const BAND_GAP = 2;

interface Props {
  tracks: Track[];
  view: ViewRange;
  duration: number;
  onViewChange: (view: ViewRange) => void;
}

/** The whole session at a glance: one band per track, with the visible window. */
export function SessionMinimap({ tracks, view, duration, onViewChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [peaksByClip, setPeaksByClip] = useState<Record<number, number[]>>({});

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (width <= 0 || duration <= 0) return;
    let cancelled = false;
    const dpr = window.devicePixelRatio || 1;

    Promise.all(
      tracks.map(async ({ clip }) => {
        const trackWidth = Math.max(1, (clip.durationSecs / duration) * width);
        const data = await getPeaks(clip.id, 0, clip.frameCount, Math.round(trackWidth * dpr));
        return [clip.id, data.channels[0] ?? []] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setPeaksByClip(Object.fromEntries(entries));
      })
      .catch(() => {
        /* A track was closed mid-flight; the next render will refetch. */
      });

    return () => {
      cancelled = true;
    };
  }, [tracks, width, duration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ctx = prepareCanvas(canvas, width, HEIGHT);
    if (!ctx || tracks.length === 0 || duration <= 0) return;

    const bandHeight = (HEIGHT - BAND_GAP * (tracks.length - 1)) / tracks.length;

    tracks.forEach((track, index) => {
      const peaks = peaksByClip[track.clip.id];
      if (!peaks) return;
      drawChannel(
        ctx,
        peaks,
        {
          x: (track.offset / duration) * width,
          y: index * (bandHeight + BAND_GAP),
          width: (track.clip.durationSecs / duration) * width,
          height: bandHeight,
        },
        1000, // always far above one sample per pixel here
        trackColors(index),
      );
    });
  }, [peaksByClip, tracks, width, duration]);

  const centerOn = (clientX: number) => {
    const element = containerRef.current;
    if (!element || width <= 0) return;
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - rect.left) / width, 0), 1);
    const span = view.end - view.start;
    const center = ratio * duration;
    onViewChange(clampView({ start: center - span / 2, end: center + span / 2 }, duration));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    centerOn(event.clientX);

    const onMove = (move: PointerEvent) => centerOn(move.clientX);
    const onUp = () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
  };

  const left = duration > 0 ? (view.start / duration) * 100 : 0;
  const windowWidth = duration > 0 ? ((view.end - view.start) / duration) * 100 : 100;

  return (
    <div
      ref={containerRef}
      className="minimap"
      style={{ height: HEIGHT }}
      onPointerDown={handlePointerDown}
    >
      <canvas ref={canvasRef} className="minimap__canvas" style={{ height: HEIGHT }} />
      <div
        className="minimap__window"
        style={{ left: `${left}%`, width: `${Math.max(windowWidth, 0.4)}%` }}
      />
    </div>
  );
}
