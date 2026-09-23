//! Playback: one output stream that mixes every loaded track at a shared
//! playhead, so all files play in parallel and stay in sync.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::decode::DecodedAudio;

/// Length of the fade applied when starting and stopping, in seconds.
/// Without it, cutting the signal mid-cycle is audible as a click.
const RAMP_SECONDS: f32 = 0.008;

pub struct Track {
    pub audio: Arc<DecodedAudio>,
    pub gain: f32,
    pub muted: bool,
    /// Where the track starts on the session timeline, in seconds.
    pub offset_secs: f64,
}

impl Track {
    /// Where the track ends on the session timeline, in seconds.
    pub fn end_secs(&self) -> f64 {
        self.offset_secs + self.audio.duration_secs()
    }
}

/// Everything the audio callback reads. Lock-free by design: the callback must
/// never wait on the UI thread.
#[derive(Default)]
pub struct Mixer {
    tracks: ArcSwap<Vec<Track>>,
    playing: AtomicBool,
    /// Playhead in seconds, as `f64::to_bits`.
    position_bits: AtomicU64,
    /// Latest track end in seconds, as `f64::to_bits`.
    duration_bits: AtomicU64,
}

impl Mixer {
    pub fn set_tracks(&self, tracks: Vec<Track>) {
        let duration = tracks
            .iter()
            .map(Track::end_secs)
            .fold(0.0f64, f64::max);
        self.duration_bits.store(duration.to_bits(), Ordering::Relaxed);
        self.tracks.store(Arc::new(tracks));

        // A shorter session must not leave the playhead stranded past the end.
        if self.position() > duration {
            self.seek(duration);
        }
    }

    pub fn play(&self) {
        // Restarting from the very end is more useful than playing silence.
        if self.position() >= self.duration() - 1e-6 {
            self.seek(0.0);
        }
        self.playing.store(true, Ordering::Relaxed);
    }

    pub fn pause(&self) {
        self.playing.store(false, Ordering::Relaxed);
    }

    /// Moves the playhead. It may land past the current end: an edit can seek
    /// ahead of the mix that makes the session long enough, and `set_tracks`
    /// pulls it back if that mix never comes.
    pub fn seek(&self, seconds: f64) {
        let clamped = if seconds.is_finite() { seconds.max(0.0) } else { 0.0 };
        self.position_bits.store(clamped.to_bits(), Ordering::Relaxed);
    }

    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }

    pub fn position(&self) -> f64 {
        f64::from_bits(self.position_bits.load(Ordering::Relaxed))
    }

    pub fn duration(&self) -> f64 {
        f64::from_bits(self.duration_bits.load(Ordering::Relaxed))
    }

    /// Writes one buffer of interleaved output. Called from the audio thread.
    ///
    /// `ramp` carries the fade level between calls, so a fade started in one
    /// buffer finishes in the next.
    pub fn fill(&self, data: &mut [f32], out_channels: usize, rate: f64, ramp: &mut f32) {
        let tracks = self.tracks.load();
        let playing = self.playing.load(Ordering::Relaxed);
        let target = if playing { 1.0f32 } else { 0.0f32 };
        let ramp_step = 1.0 / (RAMP_SECONDS * rate as f32).max(1.0);

        // Fully stopped and fully faded: nothing to mix.
        if !playing && *ramp <= 0.0 {
            data.fill(0.0);
            return;
        }

        let duration = self.duration();
        let mut position = self.position();
        let delta = 1.0 / rate;

        for frame in data.chunks_mut(out_channels.max(1)) {
            *ramp = if *ramp < target {
                (*ramp + ramp_step).min(target)
            } else {
                (*ramp - ramp_step).max(target)
            };

            let mut left = 0.0f32;
            let mut right = 0.0f32;

            for track in tracks.iter() {
                if track.muted || track.gain <= 0.0 {
                    continue;
                }
                // Before its offset a track reads a negative position, which is silence.
                let source_pos = (position - track.offset_secs) * track.audio.sample_rate as f64;
                let channels = &track.audio.channels;
                let l = sample_at(&channels[0], source_pos);
                // A mono track feeds both sides; extra channels are ignored for now.
                let r = if channels.len() > 1 {
                    sample_at(&channels[1], source_pos)
                } else {
                    l
                };
                left += l * track.gain;
                right += r * track.gain;
            }

            left *= *ramp;
            right *= *ramp;

            match out_channels {
                0 => {}
                1 => frame[0] = clip((left + right) * 0.5),
                _ => {
                    frame[0] = clip(left);
                    frame[1] = clip(right);
                    for extra in frame.iter_mut().skip(2) {
                        *extra = 0.0;
                    }
                }
            }

            if playing {
                position += delta;
            }
        }

        if playing && position >= duration {
            position = duration;
            self.playing.store(false, Ordering::Relaxed);
        }
        self.position_bits.store(position.to_bits(), Ordering::Relaxed);
    }
}

/// Linearly interpolated read, which also resamples tracks whose rate differs
/// from the output device's. Shared with offline rendering so that an export
/// sounds like what was played.
pub fn sample_at(samples: &[f32], position: f64) -> f32 {
    if position < 0.0 {
        return 0.0;
    }
    let index = position.floor() as usize;
    if index + 1 >= samples.len() {
        return samples.get(index).copied().unwrap_or(0.0);
    }
    let fraction = (position - index as f64) as f32;
    samples[index] * (1.0 - fraction) + samples[index + 1] * fraction
}

fn clip(value: f32) -> f32 {
    value.clamp(-1.0, 1.0)
}

/// Owns the output stream. The stream itself is not `Send` on every platform,
/// so it lives on its own thread and is driven purely through `Mixer`.
pub struct AudioEngine {
    pub mixer: Arc<Mixer>,
    status: Arc<Mutex<EngineStatus>>,
}

#[derive(Clone, Default)]
pub struct EngineStatus {
    pub ready: bool,
    pub error: Option<String>,
    pub sample_rate: u32,
}

impl AudioEngine {
    pub fn new() -> Self {
        let mixer = Arc::new(Mixer::default());
        let status = Arc::new(Mutex::new(EngineStatus::default()));

        {
            let mixer = Arc::clone(&mixer);
            let status = Arc::clone(&status);
            std::thread::Builder::new()
                .name("zwave-audio".into())
                .spawn(move || match start_stream(mixer) {
                    Ok((stream, rate)) => {
                        *status.lock().unwrap() = EngineStatus {
                            ready: true,
                            error: None,
                            sample_rate: rate,
                        };
                        // The stream stops the moment it is dropped, so this
                        // thread must outlive playback.
                        std::thread::park();
                        drop(stream);
                    }
                    Err(err) => {
                        *status.lock().unwrap() = EngineStatus {
                            ready: false,
                            error: Some(err),
                            sample_rate: 0,
                        };
                    }
                })
                .expect("failed to spawn audio thread");
        }

        Self { mixer, status }
    }

    pub fn status(&self) -> EngineStatus {
        self.status.lock().unwrap().clone()
    }
}

impl Default for AudioEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn start_stream(mixer: Arc<Mixer>) -> Result<(cpal::Stream, u32), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "no audio output device found".to_string())?;
    let config = device
        .default_output_config()
        .map_err(|e| format!("could not read output device config: {e}"))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();

    let on_error = |err| eprintln!("audio output error: {err}");
    let mut ramp = 0.0f32;

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &stream_config,
            move |data: &mut [f32], _| {
                mixer.fill(data, channels, sample_rate as f64, &mut ramp);
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => {
            let mut scratch: Vec<f32> = Vec::new();
            device.build_output_stream(
                &stream_config,
                move |data: &mut [i16], _| {
                    scratch.resize(data.len(), 0.0);
                    mixer.fill(&mut scratch, channels, sample_rate as f64, &mut ramp);
                    for (out, value) in data.iter_mut().zip(scratch.iter()) {
                        *out = (value * i16::MAX as f32) as i16;
                    }
                },
                on_error,
                None,
            )
        }
        other => return Err(format!("unsupported output sample format: {other:?}")),
    }
    .map_err(|e| format!("could not open audio output: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("could not start audio output: {e}"))?;

    Ok((stream, sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant_track(value: f32, frames: usize, rate: u32, gain: f32) -> Track {
        Track {
            audio: Arc::new(DecodedAudio {
                channels: vec![vec![value; frames], vec![value; frames]],
                sample_rate: rate,
                codec: "test".into(),
                bits_per_sample: None,
            }),
            gain,
            muted: false,
            offset_secs: 0.0,
        }
    }

    #[test]
    fn sums_tracks_and_advances_the_playhead() {
        let mixer = Mixer::default();
        mixer.set_tracks(vec![
            constant_track(0.25, 48_000, 48_000, 1.0),
            constant_track(0.25, 48_000, 48_000, 1.0),
        ]);
        mixer.play();

        let mut ramp = 1.0; // skip the fade-in for a clean reading
        let mut data = vec![0.0f32; 480 * 2];
        mixer.fill(&mut data, 2, 48_000.0, &mut ramp);

        assert!((data[0] - 0.5).abs() < 1e-4, "two tracks should sum: {}", data[0]);
        assert!((mixer.position() - 0.01).abs() < 1e-6, "480 frames at 48k = 10ms");
    }

    #[test]
    fn muted_and_gain_staged_tracks_are_honoured() {
        let mixer = Mixer::default();
        let mut quiet = constant_track(1.0, 48_000, 48_000, 0.5);
        quiet.muted = false;
        let mut silent = constant_track(1.0, 48_000, 48_000, 1.0);
        silent.muted = true;
        mixer.set_tracks(vec![quiet, silent]);
        mixer.play();

        let mut ramp = 1.0;
        let mut data = vec![0.0f32; 64];
        mixer.fill(&mut data, 2, 48_000.0, &mut ramp);

        assert!((data[0] - 0.5).abs() < 1e-4, "expected only the 0.5-gain track");
    }

    #[test]
    fn paused_output_is_silent_and_the_playhead_holds() {
        let mixer = Mixer::default();
        mixer.set_tracks(vec![constant_track(1.0, 48_000, 48_000, 1.0)]);
        mixer.seek(0.5);

        let mut ramp = 0.0;
        let mut data = vec![1.0f32; 64];
        mixer.fill(&mut data, 2, 48_000.0, &mut ramp);

        assert!(data.iter().all(|s| *s == 0.0));
        assert_eq!(mixer.position(), 0.5);
    }

    #[test]
    fn playback_stops_at_the_end_of_the_longest_track() {
        let mixer = Mixer::default();
        mixer.set_tracks(vec![
            constant_track(0.5, 480, 48_000, 1.0),  // 10 ms
            constant_track(0.5, 960, 48_000, 1.0),  // 20 ms
        ]);
        assert!((mixer.duration() - 0.02).abs() < 1e-9);

        mixer.play();
        let mut ramp = 1.0;
        let mut data = vec![0.0f32; 4800 * 2]; // 100 ms, well past the end
        mixer.fill(&mut data, 2, 48_000.0, &mut ramp);

        assert!(!mixer.is_playing());
        assert!((mixer.position() - 0.02).abs() < 1e-6);
    }

    #[test]
    fn an_offset_track_is_silent_until_it_starts_and_extends_the_session() {
        let mixer = Mixer::default();
        let mut late = constant_track(0.5, 480, 48_000, 1.0); // 10 ms long
        late.offset_secs = 0.01;
        mixer.set_tracks(vec![late]);
        assert!((mixer.duration() - 0.02).abs() < 1e-9, "10 ms offset + 10 ms of audio");

        mixer.play();
        let mut ramp = 1.0;
        let mut data = vec![0.0f32; 960 * 2]; // 20 ms
        mixer.fill(&mut data, 2, 48_000.0, &mut ramp);

        assert_eq!(data[100 * 2], 0.0, "before the offset");
        assert!((data[700 * 2] - 0.5).abs() < 1e-4, "after the offset: {}", data[700 * 2]);
    }

    #[test]
    fn different_sample_rates_land_at_the_same_point_in_time() {
        // A ramp signal at two rates: reading 0.5s in should give the same value.
        let make = |rate: u32| {
            let frames = rate as usize;
            let samples: Vec<f32> = (0..frames).map(|i| i as f32 / frames as f32).collect();
            Track {
                audio: Arc::new(DecodedAudio {
                    channels: vec![samples.clone(), samples],
                    sample_rate: rate,
                    codec: "test".into(),
                    bits_per_sample: None,
                }),
                gain: 1.0,
                muted: false,
                offset_secs: 0.0,
            }
        };

        for rate in [44_100u32, 48_000, 22_050] {
            let mixer = Mixer::default();
            mixer.set_tracks(vec![make(rate)]);
            mixer.seek(0.5);
            mixer.play();

            let mut ramp = 1.0;
            let mut data = vec![0.0f32; 2];
            mixer.fill(&mut data, 2, 48_000.0, &mut ramp);

            assert!(
                (data[0] - 0.5).abs() < 1e-3,
                "rate {rate} read {} at the halfway point",
                data[0]
            );
        }
    }
}
