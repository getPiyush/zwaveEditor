import { useEffect, useState } from "react";
import { probeInputDevice, startRecording, stopRecording } from "../lib/api";
import type { ClipInfo, InputDeviceInfo } from "../types";

interface Props {
  onClose: () => void;
  onRecordingComplete: (clip: ClipInfo) => void;
}

export function RecordingDialog({ onClose, onRecordingComplete }: Props) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [deviceInfo, setDeviceInfo] = useState<InputDeviceInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    probeInputDevice()
      .then(setDeviceInfo)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!recording) return;

    const timer = window.setInterval(() => {
      setElapsed((e) => e + 0.1);
    }, 100);

    return () => clearInterval(timer);
  }, [recording]);

  const handleStart = async () => {
    try {
      setError(null);
      setStarting(true);
      await startRecording();
      setRecording(true);
      setElapsed(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };

  const handleStop = async () => {
    try {
      setRecording(false);
      const clip = await stopRecording();
      onRecordingComplete(clip);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRecording(false);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Record Audio</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__body">
          {error && <p className="modal__error">{error}</p>}

          {deviceInfo && (
            <div className="recording-info">
              <p>
                Input: {deviceInfo.channels} channel{deviceInfo.channels !== 1 ? "s" : ""} @{" "}
                {deviceInfo.sampleRate} Hz
              </p>
              <p className="recording-time">{formatTime(elapsed)}</p>
            </div>
          )}

          <div className="recording-controls">
            {!recording ? (
              <button
                onClick={handleStart}
                disabled={starting}
                className="recording-btn recording-btn--start"
              >
                Start Recording
              </button>
            ) : (
              <button onClick={handleStop} className="recording-btn recording-btn--stop">
                Stop Recording
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
