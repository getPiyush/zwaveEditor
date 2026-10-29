//! Built-in drum and bell voices, synthesised rather than sampled, so a beat
//! can be made with no sound files at all and nothing needs licensing.
//!
//! Every voice renders one mono hit at a given rate and is normalised to the
//! same peak, so a pattern's row volumes mean the same thing for each.

use std::f32::consts::TAU;

use serde::Deserialize;

/// Peak level each rendered hit is normalised to.
const HIT_PEAK: f32 = 0.9;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Voice {
    Kick,
    /// A tuned, long sine bass: the 808.
    Bass808,
    Snare,
    Clap,
    ClosedHat,
    OpenHat,
    /// An FM bell, tuned.
    Chime,
}

impl Voice {
    /// Whether the voice uses the row's note.
    pub fn is_tuned(self) -> bool {
        matches!(self, Voice::Bass808 | Voice::Chime)
    }
}

/// Converts a MIDI note number to Hz (A4 = 69 = 440 Hz).
pub fn note_to_hz(note: f32) -> f32 {
    440.0 * 2f32.powf((note - 69.0) / 12.0)
}

/// Renders one hit of `voice`. `note` is a MIDI note number and only matters
/// for tuned voices.
pub fn render(voice: Voice, note: f32, rate: u32) -> Vec<f32> {
    let rate = rate.max(8_000) as f32;
    let mut out = match voice {
        Voice::Kick => kick(rate),
        Voice::Bass808 => bass_808(note_to_hz(note), rate),
        Voice::Snare => snare(rate),
        Voice::Clap => clap(rate),
        Voice::ClosedHat => hat(rate, 0.09, 45.0),
        Voice::OpenHat => hat(rate, 0.5, 7.0),
        Voice::Chime => chime(note_to_hz(note), rate),
    };
    declick_tail(&mut out, rate);
    normalize(&mut out, HIT_PEAK);
    out
}

fn frames(seconds: f32, rate: f32) -> usize {
    (seconds * rate).round() as usize
}

/// A short linear attack, so a hit never starts on a step from silence.
fn attack(t: f32, seconds: f32) -> f32 {
    (t / seconds).min(1.0)
}

fn kick(rate: f32) -> Vec<f32> {
    let mut noise = Noise::new(0x4b1c);
    let mut phase = 0.0f32;
    (0..frames(0.5, rate))
        .map(|i| {
            let t = i as f32 / rate;
            // A fast pitch drop is what makes a sine sound like a kick.
            let freq = 48.0 + 120.0 * (-t / 0.035).exp();
            phase = (phase + TAU * freq / rate) % TAU;
            let body = phase.sin() * (-t * 7.5).exp();
            let click = noise.next() * (-t * 900.0).exp() * 0.35;
            ((body + click) * 1.6).tanh() * attack(t, 0.0008)
        })
        .collect()
}

fn bass_808(freq: f32, rate: f32) -> Vec<f32> {
    let mut phase = 0.0f32;
    (0..frames(1.6, rate))
        .map(|i| {
            let t = i as f32 / rate;
            // Starts a little sharp and glides to pitch, like a struck 808.
            let f = freq * (1.0 + 0.9 * (-t / 0.018).exp());
            phase = (phase + TAU * f / rate) % TAU;
            let amp = (-t * 2.0).exp() * attack(t, 0.002);
            // Gentle saturation adds the harmonics that let it read on small speakers.
            (phase.sin() * amp * 2.2).tanh()
        })
        .collect()
}

fn snare(rate: f32) -> Vec<f32> {
    let mut noise = Noise::new(0x5a2e);
    let mut highpass = Biquad::highpass(1_400.0, 0.7, rate);
    (0..frames(0.3, rate))
        .map(|i| {
            let t = i as f32 / rate;
            let tone = (TAU * 185.0 * t).sin() * (-t * 28.0).exp() * 0.55
                + (TAU * 330.0 * t).sin() * (-t * 34.0).exp() * 0.3;
            let rattle = highpass.process(noise.next()) * (-t * 16.0).exp();
            (tone + rattle) * attack(t, 0.0008)
        })
        .collect()
}

fn clap(rate: f32) -> Vec<f32> {
    let mut noise = Noise::new(0xc1a9);
    let mut band = Biquad::bandpass(1_250.0, 0.9, rate);
    // A clap is several hands a few milliseconds apart, then the room.
    let bursts = [0.0f32, 0.010, 0.021];
    (0..frames(0.35, rate))
        .map(|i| {
            let t = i as f32 / rate;
            let mut envelope: f32 = bursts
                .iter()
                .filter(|start| t >= **start)
                .map(|start| (-(t - start) * 260.0).exp())
                .sum();
            if t >= 0.03 {
                envelope += (-(t - 0.03) * 13.0).exp() * 0.7;
            }
            band.process(noise.next()) * envelope * attack(t, 0.0008)
        })
        .collect()
}

/// Closed and open hats differ only in length and decay.
fn hat(rate: f32, seconds: f32, decay: f32) -> Vec<f32> {
    // The 808's six detuned square oscillators give the metallic ring.
    const METAL: [f32; 6] = [263.0, 400.0, 421.0, 474.0, 587.0, 845.0];
    let mut noise = Noise::new(0x4a75);
    let mut highpass = Biquad::highpass(7_000.0, 0.7, rate);
    let mut band = Biquad::bandpass(10_000.0, 1.2, rate);
    (0..frames(seconds, rate))
        .map(|i| {
            let t = i as f32 / rate;
            let metal: f32 = METAL
                .iter()
                .map(|f| if (TAU * f * 1.7 * t).sin() >= 0.0 { 1.0 } else { -1.0 })
                .sum::<f32>()
                / METAL.len() as f32;
            let raw = metal * 0.55 + noise.next() * 0.45;
            band.process(highpass.process(raw)) * (-t * decay).exp() * attack(t, 0.0005)
        })
        .collect()
}

fn chime(freq: f32, rate: f32) -> Vec<f32> {
    (0..frames(1.8, rate))
        .map(|i| {
            let t = i as f32 / rate;
            // FM: a modulator at a non-integer ratio gives the inharmonic,
            // bell-like spectrum, and its index fading makes the tone mellow out.
            let index = 3.0 * (-t * 5.0).exp() + 0.3;
            let modulator = (TAU * freq * 3.5 * t).sin();
            let carrier = (TAU * freq * t + index * modulator).sin();
            let partial = (TAU * freq * 2.76 * t).sin() * (-t * 6.0).exp() * 0.3;
            // Decays in well under a bar at hip hop tempos, so repeated hits
            // stay distinct instead of smearing into a drone.
            (carrier * (-t * 3.2).exp() + partial) * attack(t, 0.002)
        })
        .collect()
}

/// Fades the last few milliseconds so a hit never ends on a jump.
fn declick_tail(samples: &mut [f32], rate: f32) {
    let fade = frames(0.004, rate).min(samples.len());
    let len = samples.len();
    for (k, sample) in samples[len - fade..].iter_mut().enumerate() {
        *sample *= 1.0 - (k as f32 + 1.0) / fade as f32;
    }
}

fn normalize(samples: &mut [f32], target: f32) {
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if peak > 1e-9 {
        let scale = target / peak;
        samples.iter_mut().for_each(|s| *s *= scale);
    }
}

/// xorshift32: deterministic white noise, so every render of a pattern is
/// identical and no `rand` dependency is needed.
struct Noise(u32);

impl Noise {
    fn new(seed: u32) -> Self {
        Self(seed.max(1))
    }

    fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

/// A direct-form-I biquad (RBJ cookbook coefficients).
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn new(b: [f32; 3], a: [f32; 3]) -> Self {
        Self {
            b0: b[0] / a[0],
            b1: b[1] / a[0],
            b2: b[2] / a[0],
            a1: a[1] / a[0],
            a2: a[2] / a[0],
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn params(freq: f32, q: f32, rate: f32) -> (f32, f32) {
        let w0 = TAU * freq.min(rate * 0.45) / rate;
        (w0.cos(), w0.sin() / (2.0 * q))
    }

    fn highpass(freq: f32, q: f32, rate: f32) -> Self {
        let (cos, alpha) = Self::params(freq, q, rate);
        Self::new(
            [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0],
            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        )
    }

    fn bandpass(freq: f32, q: f32, rate: f32) -> Self {
        let (cos, alpha) = Self::params(freq, q, rate);
        Self::new([alpha, 0.0, -alpha], [1.0 + alpha, -2.0 * cos, 1.0 - alpha])
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Voice; 7] = [
        Voice::Kick,
        Voice::Bass808,
        Voice::Snare,
        Voice::Clap,
        Voice::ClosedHat,
        Voice::OpenHat,
        Voice::Chime,
    ];

    #[test]
    fn every_voice_renders_a_clean_normalised_hit() {
        for voice in ALL {
            let hit = render(voice, 45.0, 44_100);
            assert!(!hit.is_empty(), "{voice:?} is empty");
            assert!(hit.iter().all(|s| s.is_finite()), "{voice:?} has NaN/inf");
            let peak = hit.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            assert!((peak - HIT_PEAK).abs() < 1e-4, "{voice:?} peaks at {peak}");
            assert!(hit[0].abs() < 0.05, "{voice:?} starts with a click: {}", hit[0]);
            assert!(hit.last().unwrap().abs() < 1e-3, "{voice:?} ends with a click");
        }
    }

    #[test]
    fn renders_are_deterministic() {
        for voice in ALL {
            assert_eq!(render(voice, 60.0, 44_100), render(voice, 60.0, 44_100));
        }
    }

    #[test]
    fn the_808_is_tuned_to_its_note() {
        // A1 = MIDI 33 = 55 Hz. Count zero crossings over the steady part.
        let hit = render(Voice::Bass808, 33.0, 44_100);
        let window = &hit[22_050..44_100]; // 0.5s – 1.0s, after the glide
        let crossings = window
            .windows(2)
            .filter(|w| (w[0] < 0.0) != (w[1] < 0.0))
            .count();
        let hz = crossings as f32 / 2.0 / 0.5;
        assert!((hz - 55.0).abs() < 2.0, "measured {hz} Hz");
    }

    #[test]
    fn note_numbers_map_to_concert_pitch() {
        assert!((note_to_hz(69.0) - 440.0).abs() < 1e-3);
        assert!((note_to_hz(57.0) - 220.0).abs() < 1e-3);
    }
}
