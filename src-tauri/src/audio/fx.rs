//! Per-track effects: a reverb and a feedback delay, mixed back in with a wet
//! and a dry level. Live playback and the master export run the same code, so
//! an export sounds like what was played.
//!
//! The reverb is a Freeverb-style network (eight damped combs into four
//! allpasses per side). The delay is a stereo echo whose repeats darken a
//! little each time round, as tape and analogue delays do.

use serde::{Deserialize, Serialize};

/// The longest delay time offered, in seconds.
pub const MAX_DELAY_SECONDS: f32 = 2.0;

/// The most a delay feeds back. Below 1 so the repeats always die away.
const MAX_FEEDBACK: f32 = 0.9;

/// Freeverb's tunings, in samples at 44.1 kHz; scaled for other rates.
const COMB_TUNING: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING: [usize; 4] = [556, 441, 341, 225];
/// The right side's delays run this much longer, which is what makes it wide.
const STEREO_SPREAD: usize = 23;
const TUNING_RATE: f64 = 44_100.0;

/// How much input reaches the combs: low, because eight of them sum.
const REVERB_INPUT: f32 = 0.015;
/// Brings the reverb back up to roughly the level of the dry signal.
const REVERB_OUTPUT: f32 = 3.0;
const REVERB_DAMPING: f32 = 0.2;
const ALLPASS_FEEDBACK: f32 = 0.5;
/// How much each delay repeat is darkened: a one-pole low-pass in the loop.
const DELAY_DAMPING: f32 = 0.3;

/// The longest tail added after a track's end, so a huge reverb doesn't make
/// the session minutes long.
const MAX_TAIL_SECONDS: f64 = 12.0;

/// A track's effect settings, as the UI sends and the project stores them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackFx {
    /// Room size, 0 to 1. 0 turns the reverb off.
    #[serde(default)]
    pub reverb: f32,
    /// Echo time in seconds. 0 turns the delay off.
    #[serde(default)]
    pub delay: f32,
    /// How much of each echo comes round again, 0 to 0.9.
    #[serde(default)]
    pub feedback: f32,
    /// Level of the reverb and echoes.
    #[serde(default)]
    pub wet: f32,
    /// Level of the track as it is.
    #[serde(default = "unity")]
    pub dry: f32,
}

fn unity() -> f32 {
    1.0
}

fn finite(value: f32, low: f32, high: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(low, high)
    } else {
        fallback
    }
}

impl TrackFx {
    /// Keeps every setting finite and inside the range the UI offers.
    pub fn sanitized(self) -> Self {
        Self {
            reverb: finite(self.reverb, 0.0, 1.0, 0.0),
            delay: finite(self.delay, 0.0, MAX_DELAY_SECONDS, 0.0),
            feedback: finite(self.feedback, 0.0, MAX_FEEDBACK, 0.0),
            wet: finite(self.wet, 0.0, 1.5, 0.0),
            dry: finite(self.dry, 0.0, 1.5, 1.0),
        }
    }

    fn has_reverb(&self) -> bool {
        self.wet > 0.0 && self.reverb > 0.0
    }

    fn has_delay(&self) -> bool {
        self.wet > 0.0 && self.delay > 0.0
    }

    /// Whether these settings change the sound at all. When they don't, the
    /// track plays exactly as it would with no effects.
    pub fn is_active(&self) -> bool {
        self.has_reverb() || self.has_delay() || self.dry != 1.0
    }

    fn comb_feedback(&self) -> f32 {
        0.7 + 0.28 * self.reverb
    }

    /// How long the effects ring on after the track's last sound, in seconds.
    pub fn tail_secs(&self) -> f64 {
        let mut tail = 0.0f64;
        if self.has_reverb() {
            // Time for the longest comb to fall 60 dB.
            let longest = *COMB_TUNING.last().unwrap() as f64 / TUNING_RATE;
            let g = self.comb_feedback() as f64;
            tail = tail.max(longest * 3.0 / -g.log10());
        }
        if self.has_delay() {
            let time = self.delay as f64;
            let repeats = if self.feedback > 0.0 {
                (0.001f64.ln() / (self.feedback as f64).ln()).max(1.0)
            } else {
                1.0
            };
            tail = tail.max(time * (repeats + 1.0));
        }
        tail.min(MAX_TAIL_SECONDS)
    }
}

struct Comb {
    buffer: Vec<f32>,
    index: usize,
    filter: f32,
}

impl Comb {
    fn new(size: usize) -> Self {
        Self {
            buffer: vec![0.0; size.max(1)],
            index: 0,
            filter: 0.0,
        }
    }

    fn process(&mut self, input: f32, feedback: f32) -> f32 {
        let out = self.buffer[self.index];
        self.filter = out * (1.0 - REVERB_DAMPING) + self.filter * REVERB_DAMPING;
        self.buffer[self.index] = input + self.filter * feedback;
        self.index = (self.index + 1) % self.buffer.len();
        out
    }

    fn clear(&mut self) {
        self.buffer.fill(0.0);
        self.filter = 0.0;
    }
}

struct Allpass {
    buffer: Vec<f32>,
    index: usize,
}

impl Allpass {
    fn new(size: usize) -> Self {
        Self {
            buffer: vec![0.0; size.max(1)],
            index: 0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let delayed = self.buffer[self.index];
        let out = delayed - input;
        self.buffer[self.index] = input + delayed * ALLPASS_FEEDBACK;
        self.index = (self.index + 1) % self.buffer.len();
        out
    }

    fn clear(&mut self) {
        self.buffer.fill(0.0);
    }
}

struct ReverbSide {
    combs: Vec<Comb>,
    allpasses: Vec<Allpass>,
}

impl ReverbSide {
    fn new(scale: f64, spread: usize) -> Self {
        let size = |tuning: usize| ((tuning + spread) as f64 * scale).round() as usize;
        Self {
            combs: COMB_TUNING.iter().map(|&t| Comb::new(size(t))).collect(),
            allpasses: ALLPASS_TUNING.iter().map(|&t| Allpass::new(size(t))).collect(),
        }
    }

    fn process(&mut self, input: f32, feedback: f32) -> f32 {
        let mut out = 0.0;
        for comb in &mut self.combs {
            out += comb.process(input, feedback);
        }
        for allpass in &mut self.allpasses {
            out = allpass.process(out);
        }
        out
    }

    fn clear(&mut self) {
        self.combs.iter_mut().for_each(Comb::clear);
        self.allpasses.iter_mut().for_each(Allpass::clear);
    }
}

/// The running state of one track's effects: its reverb and delay lines. It
/// carries over from one audio buffer to the next, so tails ring on smoothly.
pub struct FxState {
    rate: f64,
    reverb: [ReverbSide; 2],
    delay: [Vec<f32>; 2],
    delay_write: usize,
    delay_filter: [f32; 2],
    /// Which `Mixer` epoch these lines belong to; a seek starts a new one.
    pub epoch: u64,
}

impl FxState {
    /// Allocates every line up front, at their longest, so changing a setting
    /// never allocates inside the audio callback.
    pub fn new(rate: f64) -> Self {
        let rate = if rate.is_finite() && rate > 0.0 { rate } else { 48_000.0 };
        let scale = rate / TUNING_RATE;
        let delay_len = (MAX_DELAY_SECONDS as f64 * rate).ceil() as usize + 2;
        Self {
            rate,
            reverb: [ReverbSide::new(scale, 0), ReverbSide::new(scale, STEREO_SPREAD)],
            delay: [vec![0.0; delay_len], vec![0.0; delay_len]],
            delay_write: 0,
            delay_filter: [0.0; 2],
            epoch: 0,
        }
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }

    /// Silences every line, as after a jump to somewhere else in the session.
    pub fn clear(&mut self) {
        self.reverb.iter_mut().for_each(ReverbSide::clear);
        self.delay.iter_mut().for_each(|line| line.fill(0.0));
        self.delay_filter = [0.0; 2];
    }

    /// Runs one stereo frame through the effects: the dry signal at `dry`,
    /// plus the reverb and echoes at `wet`.
    pub fn process(&mut self, fx: &TrackFx, left: f32, right: f32) -> (f32, f32) {
        let mut wet_left = 0.0;
        let mut wet_right = 0.0;

        // The delay line always runs, so turning it on mid-play has nothing
        // stale in it and turning it off lets nothing build up.
        let len = self.delay[0].len();
        let delay_frames = ((fx.delay as f64 * self.rate).round() as usize).clamp(1, len - 1);
        let read = (self.delay_write + len - delay_frames) % len;
        let feedback = if fx.has_delay() { fx.feedback } else { 0.0 };
        for (side, input) in [left, right].into_iter().enumerate() {
            let echo = self.delay[side][read];
            let filter = &mut self.delay_filter[side];
            *filter = echo * (1.0 - DELAY_DAMPING) + *filter * DELAY_DAMPING;
            let incoming = if fx.has_delay() { input } else { 0.0 };
            self.delay[side][self.delay_write] = incoming + *filter * feedback;
            if fx.has_delay() {
                if side == 0 {
                    wet_left += echo;
                } else {
                    wet_right += echo;
                }
            }
        }
        self.delay_write = (self.delay_write + 1) % len;

        if fx.has_reverb() {
            let input = (left + right) * REVERB_INPUT;
            let feedback = fx.comb_feedback();
            wet_left += self.reverb[0].process(input, feedback) * REVERB_OUTPUT;
            wet_right += self.reverb[1].process(input, feedback) * REVERB_OUTPUT;
        }

        (
            left * fx.dry + wet_left * fx.wet,
            right * fx.dry + wet_right * fx.wet,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48_000.0;

    fn fx(reverb: f32, delay: f32, feedback: f32, wet: f32, dry: f32) -> TrackFx {
        TrackFx {
            reverb,
            delay,
            feedback,
            wet,
            dry,
        }
    }

    /// Feeds one click, then `frames` of silence, returning the left output.
    fn impulse(fx: &TrackFx, frames: usize) -> Vec<f32> {
        let mut state = FxState::new(RATE);
        (0..frames)
            .map(|i| {
                let x = if i == 0 { 1.0 } else { 0.0 };
                state.process(fx, x, x).0
            })
            .collect()
    }

    #[test]
    fn dry_only_passes_the_signal_through() {
        let out = impulse(&fx(0.0, 0.0, 0.0, 0.0, 0.5), 1000);
        assert_eq!(out[0], 0.5);
        assert!(out[1..].iter().all(|s| *s == 0.0));
        assert!(!fx(0.0, 0.0, 0.0, 0.0, 1.0).is_active());
        assert!(!fx(0.8, 0.3, 0.5, 0.0, 1.0).is_active(), "no wet, nothing changes");
    }

    #[test]
    fn delay_echoes_at_its_time_and_repeats_quieter() {
        let out = impulse(&fx(0.0, 0.25, 0.5, 1.0, 0.0), 40_000);
        let at = (0.25 * RATE) as usize;
        assert!(out[at].abs() > 0.9, "first echo at 250 ms: {}", out[at]);
        assert!(out[1..at].iter().all(|s| *s == 0.0), "nothing before the echo");
        let second = out[2 * at..2 * at + 4].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(second > 0.1 && second < out[at].abs(), "second echo {second}");
    }

    #[test]
    fn reverb_rings_on_and_dies_away() {
        let out = impulse(&fx(0.5, 0.0, 0.0, 1.0, 0.0), (RATE * 4.0) as usize);
        let energy = |range: std::ops::Range<usize>| out[range].iter().map(|s| s * s).sum::<f32>();
        let early = energy(2_000..12_000);
        let late = energy(150_000..160_000);
        assert!(early > 1e-4, "the reverb should be heard: {early}");
        assert!(late < early * 1e-3, "and fade: {late} vs {early}");
    }

    #[test]
    fn clearing_silences_the_tail() {
        let settings = fx(0.9, 0.3, 0.6, 1.0, 1.0);
        let mut state = FxState::new(RATE);
        for i in 0..5_000 {
            let x = if i == 0 { 1.0 } else { 0.0 };
            state.process(&settings, x, x);
        }
        state.clear();
        for _ in 0..(RATE as usize) {
            assert_eq!(state.process(&settings, 0.0, 0.0), (0.0, 0.0));
        }
    }

    #[test]
    fn tails_grow_with_the_settings_and_are_bounded() {
        assert_eq!(fx(0.0, 0.0, 0.0, 1.0, 1.0).tail_secs(), 0.0);
        assert!(fx(0.9, 0.0, 0.0, 1.0, 1.0).tail_secs() > fx(0.3, 0.0, 0.0, 1.0, 1.0).tail_secs());
        assert!(fx(0.0, 0.5, 0.8, 1.0, 1.0).tail_secs() > fx(0.0, 0.5, 0.2, 1.0, 1.0).tail_secs());
        assert!(fx(1.0, 2.0, 0.9, 1.0, 1.0).tail_secs() <= MAX_TAIL_SECONDS);
    }

    #[test]
    fn nonsense_is_tamed() {
        let wild = fx(f32::NAN, 99.0, 5.0, -1.0, f32::INFINITY).sanitized();
        assert_eq!(wild, fx(0.0, MAX_DELAY_SECONDS, MAX_FEEDBACK, 0.0, 1.0));
    }
}
