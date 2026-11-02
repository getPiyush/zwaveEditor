//! Live audio recording from input device.

use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::decode::DecodedAudio;

/// Quieter than this, relative to full scale, a whole take counts as silence.
const SILENT_PEAK: f32 = 0.001;
/// What counts as sound when trimming, relative to the take's own peak.
const TRIM_THRESHOLD: f32 = 0.02;
/// Kept before the first sound, so its attack isn't cut.
const TRIM_LEAD_SECONDS: f64 = 0.005;
/// Kept after the last sound, so its tail isn't cut.
const TRIM_TAIL_SECONDS: f64 = 0.02;

/// The thread holding an open input stream. A cpal stream can't move between
/// threads, so it lives on its own until told to stop.
struct Session {
    stop: Sender<()>,
    thread: JoinHandle<()>,
}

/// Captures audio from the default input device into an in-memory buffer.
pub struct Recorder {
    buffer: Arc<Mutex<Vec<f32>>>,
    session: Option<Session>,
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
            session: None,
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
        if self.session.is_some() {
            return Err("already recording".to_string());
        }
        self.buffer.lock().unwrap().clear();

        let buffer = Arc::clone(&self.buffer);
        let (ready_tx, ready_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let thread = std::thread::spawn(move || match open_stream(buffer) {
            Ok((stream, sample_rate, channel_count)) => {
                let _ = ready_tx.send(Ok((sample_rate, channel_count)));
                let _ = stop_rx.recv();
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        });

        let (sample_rate, channel_count) = ready_rx
            .recv()
            .map_err(|_| "the recording thread stopped unexpectedly".to_string())??;

        // The default device may have changed since the last take.
        self.sample_rate = sample_rate;
        self.channel_count = channel_count;
        self.session = Some(Session { stop: stop_tx, thread });
        Ok(())
    }

    pub fn stop(&mut self) -> Result<DecodedAudio, String> {
        if !self.close_stream() {
            return Err("not recording".to_string());
        }

        let buffer = std::mem::take(&mut *self.buffer.lock().unwrap());
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

    /// Stops recording, if it is, and throws the take away.
    pub fn cancel(&mut self) {
        self.close_stream();
        self.buffer.lock().unwrap().clear();
    }

    /// Lets go of the input stream. Returns whether one was open.
    fn close_stream(&mut self) -> bool {
        let Some(session) = self.session.take() else {
            return false;
        };
        let _ = session.stop.send(());
        let _ = session.thread.join();
        true
    }
}

impl Default for Recorder {
    fn default() -> Self {
        Self::new().unwrap_or_else(|_| Recorder {
            buffer: Arc::new(Mutex::new(Vec::new())),
            session: None,
            sample_rate: 48000,
            channel_count: 2,
        })
    }
}

/// Opens the default input device and starts it writing into `buffer`.
fn open_stream(buffer: Arc<Mutex<Vec<f32>>>) -> Result<(cpal::Stream, u32, usize), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no input device available".to_string())?;

    let config = device
        .default_input_config()
        .map_err(|e| format!("could not get input config: {e}"))?;

    let sample_rate = config.sample_rate().0;
    let channel_count = config.channels() as usize;
    let sample_format = config.sample_format();
    let on_error = |err| eprintln!("recording error: {}", err);
    let stream_config: cpal::StreamConfig = config.into();

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _| {
                buffer.lock().unwrap().extend_from_slice(data);
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _| {
                let converted: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                buffer.lock().unwrap().extend_from_slice(&converted);
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _| {
                let converted: Vec<f32> =
                    data.iter().map(|&s| (s as f32 / 32768.0) - 1.0).collect();
                buffer.lock().unwrap().extend_from_slice(&converted);
            },
            on_error,
            None,
        ),
        _ => return Err("unsupported input sample format".to_string()),
    };

    let stream = stream.map_err(|e| format!("failed to build stream: {e}"))?;
    stream.play().map_err(|e| format!("failed to play stream: {e}"))?;
    Ok((stream, sample_rate, channel_count))
}

/// Cuts the silence around a take, so a recorded hit lands right on its step.
/// Fails if the whole take is silent, which usually means no microphone access.
pub fn trim_silence(audio: DecodedAudio) -> Result<DecodedAudio, String> {
    let peak = audio
        .channels
        .iter()
        .flatten()
        .fold(0.0f32, |m, s| m.max(s.abs()));
    if peak < SILENT_PEAK {
        return Err("no sound was picked up. Check the microphone and its permission.".to_string());
    }

    let threshold = peak * TRIM_THRESHOLD;
    let frames = audio.frame_count();
    let loud = |frame: usize| audio.channels.iter().any(|ch| ch[frame].abs() >= threshold);
    let first = (0..frames).find(|&f| loud(f)).unwrap_or(0);
    let last = (0..frames).rfind(|&f| loud(f)).unwrap_or(frames - 1);

    let rate = audio.sample_rate as f64;
    let start = first.saturating_sub((TRIM_LEAD_SECONDS * rate) as usize);
    let end = (last + 1 + (TRIM_TAIL_SECONDS * rate) as usize).min(frames);

    Ok(DecodedAudio {
        channels: audio.channels.iter().map(|ch| ch[start..end].to_vec()).collect(),
        ..audio
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn take(samples: Vec<f32>) -> DecodedAudio {
        DecodedAudio {
            channels: vec![samples.clone(), samples],
            sample_rate: 1_000,
            codec: "recorded".into(),
            bits_per_sample: Some(32),
        }
    }

    #[test]
    fn trimming_cuts_the_silence_around_a_sound_but_keeps_a_margin() {
        let mut samples = vec![0.0f32; 1_000];
        samples[400..500].fill(0.5);

        let trimmed = trim_silence(take(samples)).unwrap();

        // 5 frames of lead and 20 of tail at 1 kHz, around the 100 of sound.
        assert_eq!(trimmed.frame_count(), 125);
        assert_eq!(trimmed.channels[1][4], 0.0);
        assert_eq!(trimmed.channels[1][5], 0.5);
    }

    #[test]
    fn trimming_treats_noise_far_below_the_peak_as_silence() {
        let mut samples = vec![0.001f32; 1_000];
        samples[500] = 0.9;
        assert_eq!(trim_silence(take(samples)).unwrap().frame_count(), 26);
    }

    #[test]
    fn a_silent_take_is_an_error() {
        assert!(trim_silence(take(vec![0.0; 1_000])).is_err());
    }
}
