//! Live audio recording, from an input device or from what the computer plays.

use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use serde::Deserialize;

use super::decode::DecodedAudio;

/// Quieter than this, relative to full scale, a whole take counts as silence.
const SILENT_PEAK: f32 = 0.001;
/// What counts as sound when trimming, relative to the take's own peak.
const TRIM_THRESHOLD: f32 = 0.02;
/// Kept before the first sound, so its attack isn't cut.
const TRIM_LEAD_SECONDS: f64 = 0.005;
/// Kept after the last sound, so its tail isn't cut.
const TRIM_TAIL_SECONDS: f64 = 0.02;

/// Where a take comes from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordingSource {
    /// The default input device, usually the microphone.
    #[default]
    Microphone,
    /// Everything the default output device plays: other apps, the browser,
    /// this app's own playback. Windows records it as WASAPI loopback; macOS
    /// (14.6 or later) through a Core Audio process tap.
    System,
}

/// The format a source records in.
#[derive(Debug, Clone, Copy)]
pub struct SourceFormat {
    pub sample_rate: u32,
    pub channel_count: usize,
}

/// The thread holding an open stream. It is opened and dropped on the same
/// thread, which some backends need, and lives there until told to stop.
struct Session {
    stop: Sender<()>,
    thread: JoinHandle<()>,
    format: SourceFormat,
}

/// Captures audio from a [`RecordingSource`] into an in-memory buffer.
#[derive(Default)]
pub struct Recorder {
    buffer: Arc<Mutex<Vec<f32>>>,
    session: Option<Session>,
}

impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The format `source` would record in now. Fails when there is no such
    /// device.
    pub fn probe(source: RecordingSource) -> Result<SourceFormat, String> {
        let (_, config) = device_and_config(source)?;
        Ok(SourceFormat {
            sample_rate: config.sample_rate(),
            channel_count: config.channels() as usize,
        })
    }

    pub fn start(&mut self, source: RecordingSource) -> Result<(), String> {
        if self.session.is_some() {
            return Err("already recording".to_string());
        }
        self.buffer.lock().unwrap().clear();

        let buffer = Arc::clone(&self.buffer);
        let (ready_tx, ready_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let thread = std::thread::spawn(move || match open_stream(source, buffer) {
            Ok((stream, format)) => {
                let _ = ready_tx.send(Ok(format));
                let _ = stop_rx.recv();
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        });

        let format = ready_rx
            .recv()
            .map_err(|_| "the recording thread stopped unexpectedly".to_string())??;

        self.session = Some(Session { stop: stop_tx, thread, format });
        Ok(())
    }

    pub fn stop(&mut self) -> Result<DecodedAudio, String> {
        let Some(format) = self.close_stream() else {
            return Err("not recording".to_string());
        };

        let buffer = std::mem::take(&mut *self.buffer.lock().unwrap());
        if buffer.is_empty() {
            return Err("no audio recorded".to_string());
        }

        // Split interleaved buffer into separate channels
        let channels = (0..format.channel_count)
            .map(|ch| {
                buffer
                    .iter()
                    .skip(ch)
                    .step_by(format.channel_count)
                    .copied()
                    .collect()
            })
            .collect();

        Ok(DecodedAudio {
            channels,
            sample_rate: format.sample_rate,
            codec: "recorded".to_string(),
            bits_per_sample: Some(32),
        })
    }

    /// Stops recording, if it is, and throws the take away.
    pub fn cancel(&mut self) {
        self.close_stream();
        self.buffer.lock().unwrap().clear();
    }

    /// Lets go of the stream. Returns the format it recorded in, if one was open.
    fn close_stream(&mut self) -> Option<SourceFormat> {
        let session = self.session.take()?;
        let _ = session.stop.send(());
        let _ = session.thread.join();
        Some(session.format)
    }
}

/// The device behind `source` and the format to open it in.
fn device_and_config(
    source: RecordingSource,
) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let host = cpal::default_host();
    match source {
        RecordingSource::Microphone => {
            let device = host
                .default_input_device()
                .ok_or_else(|| "no input device available".to_string())?;
            let config = device
                .default_input_config()
                .map_err(|e| format!("could not get input config: {e}"))?;
            Ok((device, config))
        }
        RecordingSource::System => {
            if !SYSTEM_CAPTURE_SUPPORTED {
                return Err(
                    "recording system audio isn't supported here. Route it through a loopback \
                     input device and record that as the microphone."
                        .to_string(),
                );
            }
            let device = host
                .default_output_device()
                .ok_or_else(|| "no output device to record from".to_string())?;
            // An output device opened for input records what it plays.
            let config = device
                .default_output_config()
                .map_err(|e| format!("could not get output config: {e}"))?;
            Ok((device, config))
        }
    }
}

/// Whether cpal's default host can record what an output device plays.
const SYSTEM_CAPTURE_SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// Opens `source` and starts it writing into `buffer`.
fn open_stream(
    source: RecordingSource,
    buffer: Arc<Mutex<Vec<f32>>>,
) -> Result<(cpal::Stream, SourceFormat), String> {
    let (device, config) = device_and_config(source)?;
    let format = SourceFormat {
        sample_rate: config.sample_rate(),
        channel_count: config.channels() as usize,
    };
    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();

    use cpal::SampleFormat as F;
    let stream = match sample_format {
        F::F32 => build::<f32>(&device, stream_config, buffer),
        F::F64 => build::<f64>(&device, stream_config, buffer),
        F::I8 => build::<i8>(&device, stream_config, buffer),
        F::I16 => build::<i16>(&device, stream_config, buffer),
        F::I32 => build::<i32>(&device, stream_config, buffer),
        F::U8 => build::<u8>(&device, stream_config, buffer),
        F::U16 => build::<u16>(&device, stream_config, buffer),
        F::U32 => build::<u32>(&device, stream_config, buffer),
        other => return Err(format!("unsupported input sample format: {other:?}")),
    }
    .map_err(|e| match source {
        RecordingSource::Microphone => format!("could not open the microphone: {e}"),
        RecordingSource::System => format!(
            "could not record system audio: {e}. On macOS this needs 14.6 or later and the \
             System Audio Recording permission."
        ),
    })?;
    stream.play().map_err(|e| format!("failed to start recording: {e}"))?;
    Ok((stream, format))
}

/// An input stream that converts whatever `T` the device delivers to f32.
fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    buffer: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mut buffer = buffer.lock().unwrap();
            buffer.extend(data.iter().map(|&s| s.to_sample::<f32>()));
        },
        |err| eprintln!("recording error: {err}"),
        None,
    )
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
        return Err(
            "no sound was picked up. Check that something is playing, or the microphone and its permission."
                .to_string(),
        );
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
