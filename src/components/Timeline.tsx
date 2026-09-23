import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
import type { Selection, Track, ViewRange } from "../types";
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
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const [rootWidth, setRootWidth] = useState(0);
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
    const observer = new ResizeObserver(([entry]) =>
      setRootWidth(Math.floor(entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = rulerRef.current;
    if (!canvas || laneWidth <= 0) return;
    const ctx = prepareCanvas(canvas, laneWidth, RULER_HEIGHT);
    if (!ctx) return;

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
  }, [view, laneWidth]);

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
        const offset = Math.max(0, track.offset + (move.clientX - startX) * perPixel);
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
      const from = startTime - track.offset;
      const to = timeAtClientX(move.clientX) - track.offset;
      onSelectionChange({
        clipId: track.clip.id,
        start: Math.max(0, Math.min(from, to)),
        end: Math.min(track.clip.durationSecs, Math.max(from, to)),
      });
    };

    const onUp = () => {
      if (!dragged) {
        onSelectionChange(null);
        onSeek(startTime);
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
