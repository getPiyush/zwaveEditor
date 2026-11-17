import { useEffect, useRef, useState } from "react";
import { cancelRecording, probeInputDevice, startRecording } from "../lib/api";
import type { InputDeviceInfo, RecordingSource } from "../types";

const SOURCE_KEY = "zwave.recordingSource";

const SOURCES: { value: RecordingSource; label: string; title: string }[] = [
  { value: "microphone", label: "Microphone", title: "The default input device" },
  { value: "system", label: "System audio", title: "Everything the computer plays" },
];

function savedSource(): RecordingSource {
  try {
    return localStorage.getItem(SOURCE_KEY) === "system" ? "system" : "microphone";
  } catch {
    return "microphone";
  }
}

interface Props {
  title?: string;
  /** Shown above the controls, e.g. what happens to the take. */
  hint?: string;
  onClose: () => void;
  /** Ends the take and does something with it. A failure keeps the dialog open. */
  onStop: () => Promise<void>;
}

export function RecordingDialog({ title = "Record Audio", hint, onClose, onStop }: Props) {
  // Closing the dialog mid-take throws the take away, so the mic isn't left open.
  const inTake = useRef(false);
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (inTake.current) void cancelRecording().catch(() => {});
    };
  }, []);

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [source, setSource] = useState<RecordingSource>(savedSource);
  const [deviceInfo, setDeviceInfo] = useState<InputDeviceInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setDeviceInfo(null);
    setError(null);
    probeInputDevice(source)
      .then((info) => current && setDeviceInfo(info))
      .catch((err) => current && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      current = false;
    };
  }, [source]);

  const chooseSource = (next: RecordingSource) => {
    setSource(next);
    try {
      localStorage.setItem(SOURCE_KEY, next);
    } catch {
      // Not remembered; still used for this take.
    }
  };

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
      await startRecording(source);
      if (closed.current) {
        void cancelRecording().catch(() => {});
        return;
      }
      inTake.current = true;
      setRecording(true);
      setElapsed(0);
      setStarting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };

  const handleStop = async () => {
    try {
      inTake.current = false;
      setRecording(false);
      await onStop();
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
          <h2>{title}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__body">
          {error && <p className="modal__error">{error}</p>}
          {hint && <p className="recording-hint">{hint}</p>}

          <div className="recording-source" role="radiogroup" aria-label="Record from">
            {SOURCES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={source === option.value}
                className={`recording-source__option${
                  source === option.value ? " recording-source__option--on" : ""
                }`}
                onClick={() => chooseSource(option.value)}
                disabled={recording || starting}
                title={option.title}
              >
                {option.label}
              </button>
            ))}
          </div>
          {source === "system" && (
            <p className="recording-hint recording-hint--dim">
              Records everything your computer plays, this app included. Start the sound once
              recording has begun.
            </p>
          )}

          {deviceInfo && (
            <div className="recording-info">
              <p>
                {source === "system" ? "System output" : "Input"}: {deviceInfo.channels} channel{deviceInfo.channels !== 1 ? "s" : ""} @{" "}
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
