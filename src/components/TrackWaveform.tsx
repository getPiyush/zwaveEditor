import { useEffect, useRef, useState } from "react";

import { getPeaks } from "../lib/api";
import { drawChannel, prepareCanvas, timeToX } from "../lib/waveform";
import type { ClipInfo, PeakData, ViewRange } from "../types";

const CHANNEL_GAP = 3;

interface Props {
  clip: ClipInfo;
  /** Where the clip starts on the session timeline, in seconds. */
  offset: number;
  view: ViewRange;
  width: number;
  height: number;
  colors: { peak: string; rms: string };
  dimmed: boolean;
}

/**
 * One track's waveform, drawn at its true position on the session timeline —
 * a shorter file simply stops where it ends.
 */
export function TrackWaveform({ clip, offset, view, width, height, colors, dimmed }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<PeakData | null>(null);

  // The part of this clip that falls inside the visible range, in session time.
  const visibleStart = Math.max(view.start, offset);
  const visibleEnd = Math.min(view.end, offset + clip.durationSecs);
  const xStart = timeToX(visibleStart, view, width);
  const spanPixels = Math.max(0, timeToX(visibleEnd, view, width) - xStart);
  const hasAudioOnScreen = visibleEnd > visibleStart && spanPixels >= 1;

  useEffect(() => {
    if (!hasAudioOnScreen || width <= 0) {
      setPeaks(null);
      return;
    }
    let cancelled = false;

    const buckets = Math.round(spanPixels * (window.devicePixelRatio || 1));
    getPeaks(
      clip.id,
      (visibleStart - offset) * clip.sampleRate,
      (visibleEnd - offset) * clip.sampleRate,
      buckets,
    )
      .then((data) => {
        if (!cancelled) setPeaks(data);
      })
      .catch(() => {
        if (!cancelled) setPeaks(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    clip.id,
    clip.version,
    clip.sampleRate,
    offset,
    visibleStart,
    visibleEnd,
    spanPixels,
    hasAudioOnScreen,
    width,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const ctx = prepareCanvas(canvas, width, height);
    if (!ctx) return;
    if (!peaks || !hasAudioOnScreen) return;

    ctx.globalAlpha = dimmed ? 0.35 : 1;

    // A faint bed makes the clip's extent obvious when it is shorter than the session.
    ctx.fillStyle = "rgba(255, 255, 255, 0.025)";
    ctx.fillRect(xStart, 0, spanPixels, height);

    const bandHeight =
      (height - CHANNEL_GAP * (peaks.channels.length - 1)) / peaks.channels.length;
    const samplesPerPixel = ((visibleEnd - visibleStart) * clip.sampleRate) / spanPixels;

    peaks.channels.forEach((channelPeaks, index) => {
      drawChannel(
        ctx,
        channelPeaks,
        {
          x: xStart,
          y: index * (bandHeight + CHANNEL_GAP),
          width: spanPixels,
          height: bandHeight,
        },
        samplesPerPixel,
        colors,
      );
    });

    ctx.globalAlpha = 1;
  }, [
    peaks,
    width,
    height,
    xStart,
    spanPixels,
    hasAudioOnScreen,
    visibleStart,
    visibleEnd,
    clip.sampleRate,
    colors,
    dimmed,
  ]);

  return <canvas ref={canvasRef} className="track__canvas" style={{ height }} />;
}
