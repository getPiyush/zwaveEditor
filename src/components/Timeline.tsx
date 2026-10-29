import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { barSeconds, beatSeconds, gridSeconds, snapTime } from "../lib/beat";
import { formatTime } from "../lib/format";
import {
  niceTickInterval,
  panView,
  prepareCanvas,
  secondsPerPixel,
  timeToX,
  trackColors,
  WAVE_COLORS,
  xToTime,
  zoomView,
} from "../lib/waveform";
import type { BeatSettings, Selection, Track, ViewRange } from "../types";
import { TrackHeader } from "./TrackHeader";
import { TrackWaveform } from "./TrackWaveform";

/** Width of the track-header column. Shared with the CSS through a variable. */
const GUTTER = 208;
const RULER_HEIGHT = 26;
const TRACK_HEIGHT = 104;

interface Props {
  tracks: Track[];
  view: ViewRange;
  duration: number;
  playhead: number;
  onViewChange: (view: ViewRange) => void;
  onSeek: (seconds: number) => void;
  onTrackChange: (clipId: number, changes: Partial<Track>) => void;
  onTrackRemove: (clipId: number) => void;
  onTrackUndo: (clipId: number) => void;
  onHoverTimeChange: (seconds: number | null) => void;
  selection: Selection | null;
  onSelectionChange: (selection: Selection | null) => void;
  /** The track paste lands on when nothing is selected. */
  activeClipId: number | null;
  onActiveTrackChange: (clipId: number) => void;
  /** Beat mode only: draws the bar grid and snaps edits to it. */
  beat?: BeatSettings;
  /** Beat mode only: reopens a track made in the pattern editor. */
  onTrackEditPattern?: (clipId: number) => void;
}

/** Below this many pixels a drag is treated as a click, not a selection. */
const DRAG_THRESHOLD = 3;

export function Timeline({
  tracks,
  view,
  duration,
  playhead,
  onViewChange,
  onSeek,
  onTrackChange,
  onTrackRemove,
  onTrackUndo,
  onHoverTimeChange,
  selection,
  onSelectionChange,
  activeClipId,
  onActiveTrackChange,
  beat,
  onTrackEditPattern,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const [rootWidth, setRootWidth] = useState(0);
  const [rootHeight, setRootHeight] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const laneWidth = Math.max(0, rootWidth - GUTTER);

  // The wheel listener is attached once, so current state comes from refs.
  const viewRef = useRef(view);
  viewRef.current = view;
  const laneWidthRef = useRef(laneWidth);
  laneWidthRef.current = laneWidth;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setRootWidth(Math.floor(entry.contentRect.width));
      setRootHeight(Math.floor(entry.contentRect.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = rulerRef.current;
    if (!canvas || laneWidth <= 0) return;
    const ctx = prepareCanvas(canvas, laneWidth, RULER_HEIGHT);
    if (!ctx) return;

    if (beat) {
      drawBeatRuler(ctx, view, laneWidth, beat.bpm);
      return;
    }

    const visible = view.end - view.start;
    const step = niceTickInterval(visible, laneWidth);
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 3;

    ctx.font = "11px ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace";
    ctx.textBaseline = "alphabetic";

    let tick = Math.ceil(view.start / step) * step;
    while (tick <= view.end) {
      const x = Math.round(((tick - view.start) / visible) * laneWidth) + 0.5;
      ctx.fillStyle = WAVE_COLORS.rulerTick;
      ctx.fillRect(x, RULER_HEIGHT - 7, 1, 7);
      ctx.fillStyle = WAVE_COLORS.rulerText;
      ctx.fillText(formatTime(tick, decimals), x + 4, RULER_HEIGHT - 11);
      tick += step;
    }
  }, [view, laneWidth, beat]);

  // Beat mode: bar, beat and snap lines behind the playhead, across every lane.
  const gridHeight = Math.max(0, rootHeight - RULER_HEIGHT);
  useEffect(() => {
    const canvas = gridRef.current;
    if (!canvas || !beat || laneWidth <= 0 || gridHeight <= 0) return;
    const ctx = prepareCanvas(canvas, laneWidth, gridHeight);
    if (!ctx) return;
    drawBeatGrid(ctx, view, laneWidth, gridHeight, beat);
  }, [view, laneWidth, gridHeight, beat]);

  // Snapping is beat mode's; in editor mode times pass through untouched.
  const snap = useCallback((seconds: number) => (beat ? snapTime(seconds, beat) : seconds), [beat]);

  const timeAtClientX = useCallback((clientX: number) => {
    const element = rootRef.current;
    const width = laneWidthRef.current;
    if (!element || width <= 0) return 0;
    const rect = element.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left - GUTTER, 0), width);
    return xToTime(x, viewRef.current, width);
  }, []);

  // Wheel: zoom with ⌘/Ctrl, pan with shift or a horizontal gesture. A plain
  // vertical wheel is left alone so the track list can scroll.
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      const width = laneWidthRef.current;
      if (width <= 0) return;
      const rect = element.getBoundingClientRect();
      if (event.clientX - rect.left < GUTTER) return;

      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const ratio = Math.min(
          Math.max((event.clientX - rect.left - GUTTER) / width, 0),
          1,
        );
        onViewChange(zoomView(current, Math.exp(event.deltaY * 0.005), ratio, durationRef.current));
        return;
      }

      const horizontal = event.shiftKey
        ? event.deltaY
        : Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : 0;
      if (horizontal !== 0) {
        event.preventDefault();
        onViewChange(
          panView(current, horizontal * secondsPerPixel(current, width), durationRef.current),
        );
      }
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [onViewChange]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.button !== 0 || event.clientX - rect.left < GUTTER) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);

    // Alt-drag slides the view; a plain drag selects; a click without a drag seeks.
    if (event.altKey) {
      const startX = event.clientX;
      const startView = viewRef.current;
      const onMove = (move: PointerEvent) => {
        const delta =
          (startX - move.clientX) * secondsPerPixel(startView, laneWidthRef.current);
        onViewChange(panView(startView, delta, durationRef.current));
      };
      const onUp = () => {
        element.removeEventListener("pointermove", onMove);
        element.removeEventListener("pointerup", onUp);
      };
      element.addEventListener("pointermove", onMove);
      element.addEventListener("pointerup", onUp);
      return;
    }

    // Which track was hit? The ruler and the empty space below the tracks have none.
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-clip-id]");
    const clipId = row ? Number(row.dataset.clipId) : null;
    const track = clipId === null ? null : tracks.find((t) => t.clip.id === clipId) ?? null;
    if (track) onActiveTrackChange(track.clip.id);

    // ⌘/Ctrl-drag slides the track along the timeline, changing where it starts.
    if (track && (event.metaKey || event.ctrlKey)) {
      const startX = event.clientX;
      // Measured once: the view may refit as the session grows mid-drag.
      const perPixel = secondsPerPixel(viewRef.current, laneWidthRef.current);
      const onMove = (move: PointerEvent) => {
        const offset = Math.max(0, snap(track.offset + (move.clientX - startX) * perPixel));
        onTrackChange(track.clip.id, { offset });
      };
      const onUp = () => {
        element.removeEventListener("pointermove", onMove);
        element.removeEventListener("pointerup", onUp);
      };
      element.addEventListener("pointermove", onMove);
      element.addEventListener("pointerup", onUp);
      return;
    }

    const startX = event.clientX;
    const startTime = timeAtClientX(event.clientX);
    let dragged = false;

    const onMove = (move: PointerEvent) => {
      if (!dragged && Math.abs(move.clientX - startX) < DRAG_THRESHOLD) return;
      dragged = true;
      if (!track) return;

      // Selections are kept in clip time, which is what the edits work in.
      const from = snap(startTime) - track.offset;
      const to = snap(timeAtClientX(move.clientX)) - track.offset;
      onSelectionChange({
        clipId: track.clip.id,
        start: Math.max(0, Math.min(from, to)),
        end: Math.min(track.clip.durationSecs, Math.max(from, to)),
      });
    };

    const onUp = () => {
      if (!dragged) {
        onSelectionChange(null);
        onSeek(snap(startTime));
      }
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
    };

    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - GUTTER;
    if (x < 0 || x > laneWidth) {
      setHoverX(null);
      onHoverTimeChange(null);
      return;
    }
    setHoverX(x);
    onHoverTimeChange(timeAtClientX(event.clientX));
  };

  const handlePointerLeave = () => {
    setHoverX(null);
    onHoverTimeChange(null);
  };

  const playheadX = timeToX(playhead, view, laneWidth);
  const playheadVisible = playhead >= view.start && playhead <= view.end;
  const anySoloed = tracks.some((track) => track.soloed);

  return (
    <div
      ref={rootRef}
      className="timeline"
      style={{ ["--gutter" as string]: `${GUTTER}px` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <div className="timeline__ruler-row">
        <div className="timeline__gutter-cell" />
        <canvas ref={rulerRef} className="timeline__ruler" style={{ height: RULER_HEIGHT }} />
      </div>

      <div className="timeline__tracks">
        {tracks.map((track, index) => {
          const colors = trackColors(index);
          return (
            <div
              key={track.clip.id}
              className={`track${track.clip.id === activeClipId ? " track--active" : ""}`}
              style={{ height: TRACK_HEIGHT }}
              data-clip-id={track.clip.id}
            >
              <TrackHeader
                track={track}
                colors={colors}
                index={index}
                onChange={(changes) => onTrackChange(track.clip.id, changes)}
                onRemove={() => onTrackRemove(track.clip.id)}
                onUndo={() => onTrackUndo(track.clip.id)}
                onEditPattern={
                  onTrackEditPattern && track.pattern
                    ? () => onTrackEditPattern(track.clip.id)
                    : undefined
                }
              />
              <div className="track__lane">
                <TrackWaveform
                  clip={track.clip}
                  offset={track.offset}
                  view={view}
                  width={laneWidth}
                  height={TRACK_HEIGHT - 2}
                  colors={colors}
                  dimmed={!track.inMaster || track.muted || (anySoloed && !track.soloed)}
                />
                {selection?.clipId === track.clip.id && (
                  <div
                    className="track__selection"
                    style={{
                      left: timeToX(track.offset + selection.start, view, laneWidth),
                      width: Math.max(
                        1,
                        timeToX(track.offset + selection.end, view, laneWidth) -
                          timeToX(track.offset + selection.start, view, laneWidth),
                      ),
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="timeline__overlay">
        {beat && (
          <canvas
            ref={gridRef}
            className="timeline__grid"
            style={{ top: RULER_HEIGHT, height: gridHeight }}
          />
        )}
        {hoverX !== null && (
          <div className="timeline__hover-line" style={{ transform: `translateX(${hoverX}px)` }} />
        )}
        {playheadVisible && (
          <div className="timeline__playhead" style={{ transform: `translateX(${playheadX}px)` }}>
            <span className="timeline__playhead-cap" />
          </div>
        )}
      </div>
    </div>
  );
}

/** Pixels between labels on the beat ruler, at the least. */
const BAR_LABEL_MIN_PX = 44;

/** Bars numbered from 1, with beat ticks once there is room for them. */
function drawBeatRuler(
  ctx: CanvasRenderingContext2D,
  view: ViewRange,
  width: number,
  bpm: number,
) {
  const visible = view.end - view.start;
  if (visible <= 0) return;
  const pxPerSecond = width / visible;
  const bar = barSeconds(bpm);
  const beat = beatSeconds(bpm);
  const pxPerBar = bar * pxPerSecond;
  const pxPerBeat = beat * pxPerSecond;

  // Label every 1, 2, 4, 8… bars, whatever leaves room for the numbers.
  let labelEvery = 1;
  while (labelEvery * pxPerBar < BAR_LABEL_MIN_PX && labelEvery < 4096) labelEvery *= 2;

  ctx.font = "11px ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace";
  ctx.textBaseline = "alphabetic";

  if (pxPerBeat >= 8) {
    ctx.fillStyle = WAVE_COLORS.rulerTick;
    let index = Math.ceil(view.start / beat);
    for (let t = index * beat; t <= view.end; t = ++index * beat) {
      const x = Math.round((t - view.start) * pxPerSecond) + 0.5;
      ctx.fillRect(x, RULER_HEIGHT - 4, 1, 4);
      // Zoomed right in, beats get their own bar.beat label.
      if (pxPerBeat >= 56 && index % 4 !== 0) {
        ctx.fillStyle = WAVE_COLORS.rulerText;
        ctx.globalAlpha = 0.6;
        ctx.fillText(`${Math.floor(index / 4) + 1}.${(index % 4) + 1}`, x + 3, RULER_HEIGHT - 11);
        ctx.globalAlpha = 1;
        ctx.fillStyle = WAVE_COLORS.rulerTick;
      }
    }
  }

  let barIndex = Math.ceil(view.start / bar);
  for (let t = barIndex * bar; t <= view.end; t = ++barIndex * bar) {
    if (barIndex % labelEvery !== 0) continue;
    const x = Math.round((t - view.start) * pxPerSecond) + 0.5;
    ctx.fillStyle = WAVE_COLORS.rulerTick;
    ctx.fillRect(x, RULER_HEIGHT - 10, 1, 10);
    ctx.fillStyle = WAVE_COLORS.rulerText;
    ctx.fillText(String(barIndex + 1), x + 4, RULER_HEIGHT - 11);
  }
}

/** Vertical lines for bars, beats and the snap division, faintest last. */
function drawBeatGrid(
  ctx: CanvasRenderingContext2D,
  view: ViewRange,
  width: number,
  height: number,
  settings: BeatSettings,
) {
  const visible = view.end - view.start;
  if (visible <= 0) return;
  const pxPerSecond = width / visible;

  const layer = (step: number | null, color: string, minPx: number) => {
    if (step === null || step * pxPerSecond < minPx) return;
    ctx.fillStyle = color;
    let index = Math.ceil(view.start / step);
    for (let t = index * step; t <= view.end; t = ++index * step) {
      ctx.fillRect(Math.round((t - view.start) * pxPerSecond), 0, 1, height);
    }
  };

  const snap = gridSeconds(settings.snap, settings.bpm);
  const beat = beatSeconds(settings.bpm);
  if (snap !== null && snap < beat) layer(snap, "rgba(255, 255, 255, 0.025)", 6);
  layer(beat, "rgba(255, 255, 255, 0.05)", 6);
  layer(barSeconds(settings.bpm), "rgba(138, 185, 255, 0.16)", 4);
}
