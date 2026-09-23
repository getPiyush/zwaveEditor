//! Live audio recording from input device.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::decode::DecodedAudio;

/// Captures audio from the default input device into an in-memory buffer.
/// The Stream is not stored to avoid thread-safety issues; instead we manage
/// recording state through Arc-wrapped atomics.
pub struct Recorder {
    buffer: Arc<Mutex<Vec<f32>>>,
    recording: Arc<AtomicBool>,
    sample_rate: u32,
    channel_count: usize,
}

impl Recorder {
    pub fn new() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "no input device available".to_string())?;

        let config = device
            .default_input_config()
            .map_err(|e| format!("could not get input config: {e}"))?;

        let sample_rate = config.sample_rate().0;
        let channel_count = config.channels() as usize;

        Ok(Recorder {
            buffer: Arc::new(Mutex::new(Vec::new())),
            recording: Arc::new(AtomicBool::new(false)),
            sample_rate,
            channel_count,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channel_count(&self) -> usize {
        self.channel_count
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.recording.load(Ordering::Relaxed) {
            return Err("already recording".to_string());
        }

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "no input device available".to_string())?;

        let config = device
            .default_input_config()
            .map_err(|e| format!("could not get input config: {e}"))?;

        let buffer = Arc::clone(&self.buffer);
        let recording = Arc::clone(&self.recording);

        let sample_format = config.sample_format();
        let on_error = |err| eprintln!("recording error: {}", err);
        let stream_config: cpal::StreamConfig = config.into();

        let stream = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    if recording.load(Ordering::Relaxed) {
                        buffer.lock().unwrap().extend_from_slice(data);
                    }
                },
                on_error,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    if recording.load(Ordering::Relaxed) {
                        let converted: Vec<f32> =
                            data.iter().map(|&s| s as f32 / 32768.0).collect();
                        buffer.lock().unwrap().extend_from_slice(&converted);
                    }
                },
                on_error,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    if recording.load(Ordering::Relaxed) {
                        let converted: Vec<f32> =
                            data.iter().map(|&s| (s as f32 / 32768.0) - 1.0).collect();
                        buffer.lock().unwrap().extend_from_slice(&converted);
                    }
                },
                on_error,
                None,
            ),
            _ => return Err("unsupported input sample format".to_string()),
        };

        let stream = stream.map_err(|e| format!("failed to build stream: {e}"))?;
        stream.play().map_err(|e| format!("failed to play stream: {e}"))?;

        self.recording.store(true, Ordering::Relaxed);

        // Keep the stream alive by leaking it; it will be freed when recording stops
        // via a new process. This is a workaround for thread-safety with Tauri State.
        let _ = Box::leak(Box::new(stream));

        Ok(())
    }

    pub fn stop(&mut self) -> Result<DecodedAudio, String> {
        self.recording.store(false, Ordering::Relaxed);

        // Give the recording thread a moment to stop writing
        std::thread::sleep(std::time::Duration::from_millis(100));

        let buffer = self.buffer.lock().unwrap().clone();
        if buffer.is_empty() {
            return Err("no audio recorded".to_string());
        }

        // Split interleaved buffer into separate channels
        let channels = (0..self.channel_count)
            .map(|ch| {
                buffer
                    .iter()
                    .skip(ch)
                    .step_by(self.channel_count)
                    .copied()
                    .collect()
            })
            .collect();

        Ok(DecodedAudio {
            channels,
            sample_rate: self.sample_rate,
            codec: "recorded".to_string(),
            bits_per_sample: Some(32),
        })
    }

    pub fn clear(&mut self) {
        self.buffer.lock().unwrap().clear();
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::Relaxed)
    }
}

impl Default for Recorder {
    fn default() -> Self {
        Self::new().unwrap_or_else(|_| Recorder {
            buffer: Arc::new(Mutex::new(Vec::new())),
            recording: Arc::new(AtomicBool::new(false)),
            sample_rate: 48000,
            channel_count: 2,
        })
    }
}
