import { useState } from "react";
import { adjustVolume, fadeIn, fadeOut, adjustPitch, adjustTime, reverseRange, invertRange } from "../lib/api";
import type { Selection } from "../types";

import type { ClipInfo } from "../types";

interface Props {
  selection: Selection;
  onClipUpdated: (clipInfo: ClipInfo) => void;
  onClose: () => void;
}

export function AdjustWaveDialog({ selection, onClipUpdated, onClose }: Props) {
  const [volume, setVolume] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [time, setTime] = useState(1);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdjustVolume = async () => {
    try {
      setError(null);
      setProcessing(true);
      const updated = await adjustVolume(selection.clipId, selection.start, selection.end, volume);
      setVolume(1);
      setProcessing(false);
      onClipUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProcessing(false);
    }
  };

  const handleFadeIn = async () => {
    try {
      setError(null);
      setProcessing(true);
      const updated = await fadeIn(selection.clipId, selection.start, selection.end);
      setProcessing(false);
      onClipUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProcessing(false);
    }
  };

  const handleFadeOut = async () => {
    try {
      setError(null);
      setProcessing(true);
      const updated = await fadeOut(selection.clipId, selection.start, selection.end);
      setProcessing(false);
      onClipUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProcessing(false);
    }
  };

  const handleAdjustPitch = async () => {
    try {
      setError(null);
      setProcessing(true);
      const updated = await adjustPitch(selection.clipId, selection.start, selection.end, pitch);
      setPitch(1);
      setProcessing(false);
      onClipUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProcessing(false);
    }
  };

  const handleAdjustTime = async () => {
    try {
      setError(null);
      setProcessing(true);
      const updated = await adjustTime(selection.clipId, selection.start, selection.end, time);
      setTime(1);
      setProcessing(false);
      onClipUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProcessing(false);
    }
  };

  const handleReverse = async () => {
    try {
      setError(null);
      setProcessing(true);
      const updated = await reverseRange(selection.clipId, selection.start, selection.end);
      setProcessing(false);
      onClipUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProcessing(false);
    }
  };

  const handleInvert = async () => {
    try {
      setError(null);
      setProcessing(true);
      const updated = await invertRange(selection.clipId, selection.start, selection.end);
      setProcessing(false);
      onClipUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProcessing(false);
    }
  };

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Adjust Wave</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__body">
          {error && <p className="modal__error">{error}</p>}

          <div className="adjust-form">
            <div className="adjust-section">
              <label>
                Volume: {(volume * 100).toFixed(0)}%
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  disabled={processing}
                />
              </label>
              <button
                onClick={handleAdjustVolume}
                disabled={processing || volume === 1}
                className="btn btn--small"
              >
                Apply Volume
              </button>
            </div>

            <div className="adjust-section">
              <label>
                Pitch: {(pitch * 100).toFixed(0)}%
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={pitch}
                  onChange={(e) => setPitch(parseFloat(e.target.value))}
                  disabled={processing}
                />
              </label>
              <button
                onClick={handleAdjustPitch}
                disabled={processing || pitch === 1}
                className="btn btn--small"
              >
                Apply Pitch
              </button>
            </div>

            <div className="adjust-section">
              <label>
                Time: {(time * 100).toFixed(0)}%
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={time}
                  onChange={(e) => setTime(parseFloat(e.target.value))}
                  disabled={processing}
                />
              </label>
              <button
                onClick={handleAdjustTime}
                disabled={processing || time === 1}
                className="btn btn--small"
              >
                Apply Time
              </button>
            </div>

            <div className="adjust-section adjust-section--fades">
              <button
                onClick={handleFadeIn}
                disabled={processing}
                className="btn btn--secondary btn--small"
              >
                Fade In
              </button>
              <button
                onClick={handleFadeOut}
                disabled={processing}
                className="btn btn--secondary btn--small"
              >
                Fade Out
              </button>
            </div>

            <div className="adjust-buttons">
              <button
                onClick={handleReverse}
                disabled={processing}
                className="btn btn--secondary btn--small"
                title="Play audio backwards"
              >
                Reverse
              </button>
              <button
                onClick={handleInvert}
                disabled={processing}
                className="btn btn--secondary btn--small"
                title="Flip waveform vertically"
              >
                Invert
              </button>
              <button onClick={onClose} disabled={processing} className="btn btn--primary">
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
