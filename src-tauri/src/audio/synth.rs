//! Built-in drum and instrument voices, synthesised rather than sampled, so a beat
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
    /// A rim click: short, woody, cuts through a busy mix.
    Rim,
    /// A tuned floor-to-rack tom.
    Tom,
    Shaker,
    Cowbell,
    // Melodic instruments, all tuned.
    Piano,
    ElectricPiano,
    Guitar,
    Bass,
    Organ,
    Strings,
    Brass,
    Flute,
    Marimba,
    SynthLead,
}

impl Voice {
    /// Whether the voice uses the row's note.
    pub fn is_tuned(self) -> bool {
        !matches!(
            self,
            Voice::Kick
                | Voice::Snare
                | Voice::Clap
                | Voice::ClosedHat
                | Voice::OpenHat
                | Voice::Rim
                | Voice::Shaker
                | Voice::Cowbell
        )
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
        Voice::Rim => rim(rate),
        Voice::Tom => tom(note_to_hz(note), rate),
        Voice::Shaker => shaker(rate),
        Voice::Cowbell => cowbell(rate),
        Voice::Piano => piano(note_to_hz(note), rate),
        Voice::ElectricPiano => electric_piano(note_to_hz(note), rate),
        Voice::Guitar => pluck(note_to_hz(note), rate, 0.55, 2.0, 0x6b17),
        Voice::Bass => pluck(note_to_hz(note), rate, 0.2, 1.4, 0xba55),
        Voice::Organ => organ(note_to_hz(note), rate),
        Voice::Strings => strings(note_to_hz(note), rate),
        Voice::Brass => brass(note_to_hz(note), rate),
        Voice::Flute => flute(note_to_hz(note), rate),
        Voice::Marimba => marimba(note_to_hz(note), rate),
        Voice::SynthLead => synth_lead(note_to_hz(note), rate),
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

fn rim(rate: f32) -> Vec<f32> {
    let mut noise = Noise::new(0x7135);
    let mut band = Biquad::bandpass(2_200.0, 2.0, rate);
    (0..frames(0.12, rate))
        .map(|i| {
            let t = i as f32 / rate;
            let tone = (TAU * 1_700.0 * t).sin() * 0.6 + (TAU * 820.0 * t).sin() * 0.4;
            let click = band.process(noise.next()) * (-t * 400.0).exp();
            (tone * (-t * 60.0).exp() + click) * attack(t, 0.0005)
        })
        .collect()
}

fn tom(freq: f32, rate: f32) -> Vec<f32> {
    let mut noise = Noise::new(0x7033);
    let mut phase = 0.0f32;
    (0..frames(0.7, rate))
        .map(|i| {
            let t = i as f32 / rate;
            // Like the kick, but higher and with a gentler drop, so it sings.
            let f = freq * (1.0 + 0.6 * (-t / 0.05).exp());
            phase = (phase + TAU * f / rate) % TAU;
            let body = phase.sin() * (-t * 6.0).exp();
            let stick = noise.next() * (-t * 300.0).exp() * 0.25;
            ((body + stick) * 1.3).tanh() * attack(t, 0.001)
        })
        .collect()
}

fn shaker(rate: f32) -> Vec<f32> {
    let mut noise = Noise::new(0x5ac3);
    let mut highpass = Biquad::highpass(5_000.0, 0.7, rate);
    (0..frames(0.15, rate))
        .map(|i| {
            let t = i as f32 / rate;
            // Swells in, then falls away: beads moving, not a stick hitting.
            let envelope = attack(t, 0.02) * (-(t - 0.02).max(0.0) * 35.0).exp();
            highpass.process(noise.next()) * envelope
        })
        .collect()
}

fn cowbell(rate: f32) -> Vec<f32> {
    let mut band = Biquad::bandpass(800.0, 1.5, rate);
    (0..frames(0.4, rate))
        .map(|i| {
            let t = i as f32 / rate;
            // The 808 cowbell: two square waves a fifth-ish apart, band-passed.
            let square = |f: f32| if (TAU * f * t).sin() >= 0.0 { 1.0 } else { -1.0 };
            let raw = (square(540.0) + square(800.0)) * 0.5;
            let envelope = 0.6 * (-t * 40.0).exp() + 0.4 * (-t * 9.0).exp();
            band.process(raw) * envelope * attack(t, 0.0005)
        })
        .collect()
}

/// A gain that falls linearly to zero over the last `release` seconds of a
/// `length`-second note, so sustained voices end smoothly rather than cut.
fn release(t: f32, length: f32, release: f32) -> f32 {
    ((length - t) / release).clamp(0.0, 1.0)
}

fn piano(freq: f32, rate: f32) -> Vec<f32> {
    let mut noise = Noise::new(0x91a0);
    let mut hammer = Biquad::bandpass(2_500.0, 0.8, rate);
    let nyquist = rate * 0.45;
    // Stiff strings put the partials slightly sharp of whole multiples.
    let partials: Vec<(f32, f32, f32)> = (1..=10)
        .map(|n| {
            let n = n as f32;
            let f = freq * n * (1.0 + 0.0004 * n * n).sqrt();
            let amp = if f < nyquist { 1.0 / n.powf(1.3) } else { 0.0 };
            // Higher partials die away first, so the tone darkens as it rings.
            (f, amp, 1.2 + 0.7 * n + freq / 400.0)
        })
        .collect();
    (0..frames(2.5, rate))
        .map(|i| {
            let t = i as f32 / rate;
            let strings: f32 = partials
                .iter()
                .map(|(f, amp, decay)| (TAU * f * t).sin() * amp * (-t * decay).exp())
                .sum();
            let thump = hammer.process(noise.next()) * (-t * 120.0).exp() * 0.15;
            (strings + thump) * attack(t, 0.002) * release(t, 2.5, 0.3)
        })
        .collect()
}

fn electric_piano(freq: f32, rate: f32) -> Vec<f32> {
    (0..frames(2.0, rate))
        .map(|i| {
            let t = i as f32 / rate;
            // A 1:1 FM pair for the warm body, and a high, fast-fading tine
            // partial for the bell at the front of a Rhodes note.
            let index = 1.6 * (-t * 3.0).exp() + 0.2;
            let body = (TAU * freq * t + index * (TAU * freq * t).sin()).sin();
            let tine = (TAU * freq * 14.0 * t).sin() * (-t * 40.0).exp() * 0.25;
            let tremolo = 1.0 + 0.08 * (TAU * 4.5 * t).sin();
            (body * (-t * 1.6).exp() * tremolo + tine)
                * attack(t, 0.002)
                * release(t, 2.0, 0.3)
        })
        .collect()
}

/// Karplus-Strong plucked string: a burst of noise circulating through a
/// damped delay line one period long. `brightness` (0–1) sets how much top
/// the pluck starts with: a pick on a guitar, a thumb on a bass.
fn pluck(freq: f32, rate: f32, brightness: f32, seconds: f32, seed: u32) -> Vec<f32> {
    // The averaging filter in the loop adds half a sample of delay.
    let period = ((rate / freq) - 0.5).round().max(2.0) as usize;
    let mut noise = Noise::new(seed);
    let mut smooth = 0.0f32;
    let mut line: Vec<f32> = (0..period)
        .map(|_| {
            smooth += (noise.next() - smooth) * brightness;
            smooth
        })
        .collect();
    let mut body = Biquad::lowpass(freq * 6.0 + 800.0, 0.7, rate);
    let mut index = 0;
    (0..frames(seconds, rate))
        .map(|i| {
            let t = i as f32 / rate;
            let current = line[index];
            let next = line[(index + 1) % period];
            line[index] = (current + next) * 0.5 * 0.998;
            index = (index + 1) % period;
            body.process(current) * attack(t, 0.001) * release(t, seconds, 0.2)
        })
        .collect()
}

fn organ(freq: f32, rate: f32) -> Vec<f32> {
    // Drawbars: the fundamental and a few harmonics, held steady.
    const DRAWBARS: [(f32, f32); 5] = [(1.0, 1.0), (2.0, 0.6), (3.0, 0.45), (4.0, 0.3), (6.0, 0.15)];
    let nyquist = rate * 0.45;
    (0..frames(1.2, rate))
        .map(|i| {
            let t = i as f32 / rate;
            let vibrato = 1.0 + 0.003 * (TAU * 6.5 * t).sin();
            let tone: f32 = DRAWBARS
                .iter()
                .filter(|(ratio, _)| freq * ratio < nyquist)
                .map(|(ratio, level)| (TAU * freq * ratio * vibrato * t).sin() * level)
                .sum();
            // The percussive "key click" partial that fades straight away.
            let percussion = (TAU * freq * 3.0 * t).sin() * (-t * 12.0).exp() * 0.35;
            (tone + percussion) * attack(t, 0.005) * release(t, 1.2, 0.08)
        })
        .collect()
}

/// A naive sawtooth from a phase in 0..1. Aliasing is tamed by the filters
/// each voice runs it through.
fn saw(phase: f32) -> f32 {
    phase * 2.0 - 1.0
}

fn strings(freq: f32, rate: f32) -> Vec<f32> {
    // Three slightly detuned saws: the chorus of a section rather than one player.
    let detune = [0.997f32, 1.0, 1.0035];
    let mut phases = [0.0f32, 0.33, 0.67];
    let mut lowpass = Biquad::lowpass((freq * 5.0).clamp(1_200.0, 5_000.0), 0.7, rate);
    (0..frames(2.0, rate))
        .map(|i| {
            let t = i as f32 / rate;
            let vibrato = 1.0 + 0.004 * (TAU * 5.2 * t).sin() * attack(t, 0.4);
            let mut tone = 0.0;
            for (phase, d) in phases.iter_mut().zip(detune) {
                *phase = (*phase + freq * d * vibrato / rate).fract();
                tone += saw(*phase);
            }
            lowpass.process(tone / 3.0) * attack(t, 0.12) * release(t, 2.0, 0.6)
        })
        .collect()
}

fn brass(freq: f32, rate: f32) -> Vec<f32> {
    let mut phase = 0.0f32;
    let mut lowpass = Biquad::lowpass(freq * 2.0, 1.0, rate);
    (0..frames(1.0, rate))
        .map(|i| {
            let t = i as f32 / rate;
            phase = (phase + freq / rate).fract();
            // The filter opens as the player blows in, which is the "blat".
            let cutoff = freq * (2.0 + 6.0 * (1.0 - (-t * 18.0).exp()) * (-t * 1.5).exp() + 2.0);
            lowpass.set_lowpass(cutoff, 1.0, rate);
            lowpass.process(saw(phase)) * attack(t, 0.03) * release(t, 1.0, 0.15)
        })
        .collect()
}

fn flute(freq: f32, rate: f32) -> Vec<f32> {
    let mut noise = Noise::new(0xf107);
    let mut breath = Biquad::bandpass(freq * 2.0, 1.5, rate);
    let mut phase = 0.0f32;
    (0..frames(1.4, rate))
        .map(|i| {
            let t = i as f32 / rate;
            // Vibrato comes in after the note has settled, as a player's does.
            let vibrato = 1.0 + 0.006 * (TAU * 5.0 * t).sin() * attack(t, 0.3);
            phase = (phase + TAU * freq * vibrato / rate) % TAU;
            let tone = phase.sin() + (2.0 * phase).sin() * 0.15 + (3.0 * phase).sin() * 0.05;
            let air = breath.process(noise.next()) * (0.15 + 0.5 * (-t * 20.0).exp());
            (tone + air) * attack(t, 0.06) * release(t, 1.4, 0.25)
        })
        .collect()
}

fn marimba(freq: f32, rate: f32) -> Vec<f32> {
    let nyquist = rate * 0.45;
    // Marimba bars are carved so the strong overtones sit at 4x and ~10x.
    let partials = [(1.0f32, 1.0f32, 5.0f32), (4.0, 0.35, 18.0), (9.8, 0.12, 40.0)];
    (0..frames(1.0, rate))
        .map(|i| {
            let t = i as f32 / rate;
            let tone: f32 = partials
                .iter()
                .filter(|(ratio, _, _)| freq * ratio < nyquist)
                .map(|(ratio, amp, decay)| (TAU * freq * ratio * t).sin() * amp * (-t * decay).exp())
                .sum();
            tone * attack(t, 0.001)
        })
        .collect()
}

fn synth_lead(freq: f32, rate: f32) -> Vec<f32> {
    let mut phases = [0.0f32, 0.5];
    let mut lowpass = Biquad::lowpass((freq * 8.0).min(8_000.0), 1.4, rate);
    (0..frames(0.9, rate))
        .map(|i| {
            let t = i as f32 / rate;
            // A square and a slightly sharp saw: buzzy, and it cuts through.
            phases[0] = (phases[0] + freq / rate).fract();
            phases[1] = (phases[1] + freq * 1.005 / rate).fract();
            let square = if phases[0] < 0.5 { 1.0 } else { -1.0 };
            let tone = square * 0.6 + saw(phases[1]) * 0.4;
            lowpass.process(tone) * attack(t, 0.005) * release(t, 0.9, 0.12)
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

    fn lowpass(freq: f32, q: f32, rate: f32) -> Self {
        let (cos, alpha) = Self::params(freq, q, rate);
        Self::new(
            [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0],
            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        )
    }

    /// Retunes a lowpass in place, keeping its state, for a sweeping filter.
    fn set_lowpass(&mut self, freq: f32, q: f32, rate: f32) {
        let fresh = Self::lowpass(freq, q, rate);
        self.b0 = fresh.b0;
        self.b1 = fresh.b1;
        self.b2 = fresh.b2;
        self.a1 = fresh.a1;
        self.a2 = fresh.a2;
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

    const ALL: [Voice; 21] = [
        Voice::Kick,
        Voice::Bass808,
        Voice::Snare,
        Voice::Clap,
        Voice::ClosedHat,
        Voice::OpenHat,
        Voice::Chime,
        Voice::Rim,
        Voice::Tom,
        Voice::Shaker,
        Voice::Cowbell,
        Voice::Piano,
        Voice::ElectricPiano,
        Voice::Guitar,
        Voice::Bass,
        Voice::Organ,
        Voice::Strings,
        Voice::Brass,
        Voice::Flute,
        Voice::Marimba,
        Voice::SynthLead,
    ];

    const INSTRUMENTS: [Voice; 10] = [
        Voice::Piano,
        Voice::ElectricPiano,
        Voice::Guitar,
        Voice::Bass,
        Voice::Organ,
        Voice::Strings,
        Voice::Brass,
        Voice::Flute,
        Voice::Marimba,
        Voice::SynthLead,
    ];

    /// The fundamental of `samples` by autocorrelation: the first lag (shortest
    /// period) that correlates nearly as well as the best one, so a strong
    /// overtone or a doubled period can't fool it.
    fn pitch(samples: &[f32], rate: f32) -> f32 {
        let lags = (rate / 1_000.0) as usize..(rate / 40.0) as usize;
        let corr = |lag: usize| -> f32 {
            samples.iter().zip(&samples[lag..]).map(|(a, b)| a * b).sum()
        };
        let scores: Vec<(usize, f32)> = lags.map(|lag| (lag, corr(lag))).collect();
        let best = scores.iter().fold(0.0f32, |m, (_, c)| m.max(*c));
        let peak = scores
            .windows(3)
            .find(|w| w[1].1 >= 0.9 * best && w[1].1 >= w[0].1 && w[1].1 >= w[2].1)
            .map(|w| w[1].0)
            .unwrap();
        rate / peak as f32
    }

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
    fn instruments_play_the_note_asked_for() {
        // A3 = MIDI 57 = 220 Hz; E2 = 40 = 82.4 Hz for the bass.
        for voice in INSTRUMENTS {
            let (note, want) = if voice == Voice::Bass { (40.0, 82.41) } else { (57.0, 220.0) };
            let hit = render(voice, note, 44_100);
            let window = &hit[4_410..4_410 + 8_820]; // 0.1s – 0.3s
            let hz = pitch(window, 44_100.0);
            let cents = 1_200.0 * (hz / want).log2();
            assert!(cents.abs() < 25.0, "{voice:?} plays {hz} Hz, wanted {want}");
        }
    }

    #[test]
    fn only_untuned_percussion_ignores_the_note() {
        assert!(!Voice::Kick.is_tuned());
        assert!(!Voice::Shaker.is_tuned());
        assert!(Voice::Tom.is_tuned());
        assert!(INSTRUMENTS.iter().all(|v| v.is_tuned()));
    }

    #[test]
    fn note_numbers_map_to_concert_pitch() {
        assert!((note_to_hz(69.0) - 440.0).abs() < 1e-3);
        assert!((note_to_hz(57.0) - 220.0).abs() < 1e-3);
    }
}
