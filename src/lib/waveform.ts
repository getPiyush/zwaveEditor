import type { Track, ViewRange } from "../types";

export const VALUES_PER_BUCKET = 3; // min, max, rms

export const WAVE_COLORS = {
  centerLine: "#2a3346",
  rulerText: "#7d8aa3",
  rulerTick: "#3a465c",
};

/** Per-track colours, so parallel tracks stay tellable apart. */
export const TRACK_COLORS = [
  { peak: "#3d8bfd", rms: "#8ab9ff" },
  { peak: "#37b98a", rms: "#83e0bd" },
  { peak: "#c77dff", rms: "#e0b9ff" },
  { peak: "#e8a33d", rms: "#f5cd8c" },
  { peak: "#ec6a8a", rms: "#f7a9bd" },
  { peak: "#4ec5d8", rms: "#9ce6f0" },
];

export function trackColors(index: number) {
  return TRACK_COLORS[index % TRACK_COLORS.length];
}

/** Where a track ends on the session timeline, in seconds. */
export function trackEnd(track: Track): number {
  return track.offset + track.clip.durationSecs;
}

/** Zooming stops here — roughly nine samples at 44.1 kHz. */
const MIN_VISIBLE_SECONDS = 0.0002;

export function clampView(view: ViewRange, duration: number): ViewRange {
  const maxSpan = Math.max(duration, MIN_VISIBLE_SECONDS);
  const span = Math.min(Math.max(view.end - view.start, MIN_VISIBLE_SECONDS), maxSpan);
  const start = Math.max(0, Math.min(view.start, maxSpan - span));
  return { start, end: start + span };
}

/**
 * Zooms by `factor` (>1 zooms out) keeping the moment under `anchorRatio`
 * (0 = left edge, 1 = right edge) pinned in place.
 */
export function zoomView(
  view: ViewRange,
  factor: number,
  anchorRatio: number,
  duration: number,
): ViewRange {
  const span = view.end - view.start;
  const anchor = view.start + span * anchorRatio;
  const nextSpan = span * factor;
  return clampView(
    { start: anchor - nextSpan * anchorRatio, end: anchor + nextSpan * (1 - anchorRatio) },
    duration,
  );
}

export function panView(view: ViewRange, deltaSecs: number, duration: number): ViewRange {
  return clampView({ start: view.start + deltaSecs, end: view.end + deltaSecs }, duration);
}

/** Seconds of audio represented by one pixel. */
export function secondsPerPixel(view: ViewRange, width: number): number {
  return width > 0 ? (view.end - view.start) / width : 0;
}

export function timeToX(seconds: number, view: ViewRange, width: number): number {
  const span = view.end - view.start;
  return span > 0 ? ((seconds - view.start) / span) * width : 0;
}

export function xToTime(x: number, view: ViewRange, width: number): number {
  const span = view.end - view.start;
  return width > 0 ? view.start + (x / width) * span : view.start;
}

/**
 * Sizes a canvas to its CSS box at the current device pixel ratio and returns a
 * context already scaled to CSS pixels.
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Draws one channel's peaks into `rect`.
 *
 * Above roughly one sample per pixel each bucket is a vertical min/max bar with
 * an RMS core; below it the samples are drawn as a continuous line, which is
 * what you want when inspecting a waveform up close.
 */
export function drawChannel(
  ctx: CanvasRenderingContext2D,
  peaks: number[],
  rect: Rect,
  samplesPerPixel: number,
  colors: { peak: string; rms: string },
) {
  const mid = rect.y + rect.height / 2;
  const scale = rect.height / 2 - 1;
  const buckets = Math.floor(peaks.length / VALUES_PER_BUCKET);

  ctx.fillStyle = WAVE_COLORS.centerLine;
  ctx.fillRect(rect.x, Math.round(mid), rect.width, 1);
  if (buckets === 0 || rect.width <= 0) return;

  const columnWidth = rect.width / buckets;

  if (samplesPerPixel < 1.5) {
    // Zoomed in: a single continuous trace reads better than stacked bars.
    ctx.strokeStyle = colors.rms;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < buckets; i++) {
      const value = peaks[i * VALUES_PER_BUCKET + 1];
      const x = rect.x + i * columnWidth + columnWidth / 2;
      const y = mid - value * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return;
  }

  ctx.fillStyle = colors.peak;
  for (let i = 0; i < buckets; i++) {
    const min = peaks[i * VALUES_PER_BUCKET];
    const max = peaks[i * VALUES_PER_BUCKET + 1];
    const x = rect.x + i * columnWidth;
    const top = mid - max * scale;
    const bottom = mid - min * scale;
    ctx.fillRect(x, top, Math.max(columnWidth, 1), Math.max(bottom - top, 1));
  }

  ctx.fillStyle = colors.rms;
  for (let i = 0; i < buckets; i++) {
    const rms = peaks[i * VALUES_PER_BUCKET + 2];
    const x = rect.x + i * columnWidth;
    const top = mid - rms * scale;
    const bottom = mid + rms * scale;
    ctx.fillRect(x, top, Math.max(columnWidth, 1), Math.max(bottom - top, 1));
  }
}

const TICK_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
  900, 1800, 3600,
];

/** Picks a tick interval (seconds) giving at least `minPixels` between ticks. */
export function niceTickInterval(visibleSeconds: number, width: number, minPixels = 80): number {
  const pixelsPerSecond = width / Math.max(visibleSeconds, 1e-9);
  for (const step of TICK_STEPS) {
    if (step * pixelsPerSecond >= minPixels) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}
