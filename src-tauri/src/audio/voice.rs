//! Voice enhancement: a small chain of processors tuned for speech and vocals.
//!
//! Like the edits in `edit.rs`, every function here returns new audio and only
//! touches the selected range. The chain runs in a fixed, conventional order —
//! rumble filter, noise reduction, de-esser, clarity EQ, leveller — and the
//! whole chain is one undo step.
//!
//! Everything is plain Rust with no extra crates: biquads from the RBJ audio EQ
//! cookbook, a radix-2 FFT for the noise reduction, and a feed-forward
//! compressor for levelling.

use std::f32::consts::PI;

use serde::Deserialize;

use super::decode::DecodedAudio;

/// Which stages to run. A missing (`None`/`false`) stage is skipped, so the UI
/// can send a single tool or the whole preset through the same command.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceChain {
    /// High-pass cutoff in Hz, removing rumble, handling noise and plosive thumps.
    pub high_pass_hz: Option<f32>,
    /// Noise reduction strength, 0..=1.
    pub denoise: Option<f32>,
    /// De-esser amount, 0..=1.
    pub de_ess: Option<f32>,
    /// Presence boost around 3.5 kHz, in dB.
    pub clarity_db: Option<f32>,
    /// Compress and normalise to an even, broadcast-style level.
    #[serde(default)]
    pub level: bool,
}

impl VoiceChain {
    /// The one-click "Enhance voice" settings.
    #[cfg(test)]
    pub fn preset() -> Self {
        Self {
            high_pass_hz: Some(80.0),
            denoise: Some(0.6),
            de_ess: Some(0.5),
            clarity_db: Some(3.0),
            level: true,
        }
    }

    fn is_empty(&self) -> bool {
        self.high_pass_hz.is_none()
            && self.denoise.is_none()
            && self.de_ess.is_none()
            && self.clarity_db.is_none()
            && !self.level
    }
}

/// Runs `chain` over `[start, end)`. The processed range is crossfaded into
/// the untouched audio over a few milliseconds at each edge so there is no click.
pub fn enhance(
    audio: &DecodedAudio,
    start: usize,
    end: usize,
    chain: &VoiceChain,
) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }
    if chain.is_empty() {
        return Err("no voice tool was chosen".to_string());
    }
    let rate = audio.sample_rate as f32;
    if rate <= 0.0 {
        return Err("clip has no sample rate".to_string());
    }

    let mut segment: Vec<Vec<f32>> =
        audio.channels.iter().map(|c| c[start..end].to_vec()).collect();

    if let Some(hz) = chain.high_pass_hz {
        // Two cascaded Butterworth sections: 24 dB/octave, steep enough to
        // remove rumble without thinning the voice above the cutoff.
        let hz = hz.clamp(20.0, 400.0);
        for ch in &mut segment {
            Biquad::high_pass(rate, hz, 0.541).run(ch);
            Biquad::high_pass(rate, hz, 1.307).run(ch);
        }
    }
    if let Some(strength) = chain.denoise {
        let strength = strength.clamp(0.0, 1.0);
        for ch in &mut segment {
            denoise(ch, rate, strength);
        }
    }
    if let Some(amount) = chain.de_ess {
        de_ess(&mut segment, rate, amount.clamp(0.0, 1.0));
    }
    if let Some(db) = chain.clarity_db {
        let db = db.clamp(-12.0, 12.0);
        for ch in &mut segment {
            Biquad::peaking(rate, 3500.0, 0.8, db).run(ch);
            // A little "air" alongside the presence, half as much.
            Biquad::high_shelf(rate, 10_000.0, db * 0.5).run(ch);
        }
    }
    if chain.level {
        level(&mut segment, rate);
    }

    let fade = ((rate * 0.005) as usize).min((end - start) / 2);
    let channels = audio
        .channels
        .iter()
        .zip(segment)
        .map(|(orig, processed)| {
            let mut out = orig.clone();
            let len = processed.len();
            for (i, &p) in processed.iter().enumerate() {
                let edge = i.min(len - 1 - i);
                let mix = if edge < fade { edge as f32 / fade as f32 } else { 1.0 };
                let dry = orig[start + i];
                out[start + i] = (dry + (p - dry) * mix).clamp(-1.0, 1.0);
            }
            out
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

// ---------------------------------------------------------------------------
// Biquad filters (RBJ cookbook), transposed direct form II.

struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn normalised(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0.0, z2: 0.0 }
    }

    fn omega(rate: f32, hz: f32) -> (f32, f32) {
        let w = 2.0 * PI * (hz / rate).min(0.49);
        (w.cos(), w.sin())
    }

    fn high_pass(rate: f32, hz: f32, q: f32) -> Self {
        let (cos, sin) = Self::omega(rate, hz);
        let alpha = sin / (2.0 * q);
        Self::normalised(
            (1.0 + cos) / 2.0,
            -(1.0 + cos),
            (1.0 + cos) / 2.0,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        )
    }

    fn peaking(rate: f32, hz: f32, q: f32, db: f32) -> Self {
        let (cos, sin) = Self::omega(rate, hz);
        let a = 10f32.powf(db / 40.0);
        let alpha = sin / (2.0 * q);
        Self::normalised(
            1.0 + alpha * a,
            -2.0 * cos,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cos,
            1.0 - alpha / a,
        )
    }

    fn high_shelf(rate: f32, hz: f32, db: f32) -> Self {
        let (cos, sin) = Self::omega(rate, hz);
        let a = 10f32.powf(db / 40.0);
        let alpha = sin / 2.0 * 2f32.sqrt(); // shelf slope S = 1
        let sq = 2.0 * a.sqrt() * alpha;
        Self::normalised(
            a * ((a + 1.0) + (a - 1.0) * cos + sq),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
            a * ((a + 1.0) + (a - 1.0) * cos - sq),
            (a + 1.0) - (a - 1.0) * cos + sq,
            2.0 * ((a - 1.0) - (a + 1.0) * cos),
            (a + 1.0) - (a - 1.0) * cos - sq,
        )
    }

    fn tick(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    fn run(mut self, samples: &mut [f32]) {
        for s in samples {
            *s = self.tick(*s);
        }
    }
}

// ---------------------------------------------------------------------------
// Noise reduction: spectral gating.
//
// The noise floor is learned from the selection itself: for every frequency
// bin, the quietest ~10% of frames are taken to be "noise only" (the gaps
// between words). Bins that don't rise clearly above that floor are turned
// down. Gains are smoothed over time so the residual doesn't warble.

const FFT_SIZE: usize = 2048;
const HOP: usize = FFT_SIZE / 4;

fn denoise(samples: &mut [f32], _rate: f32, strength: f32) {
    let n = samples.len();
    if n < FFT_SIZE || strength <= 0.0 {
        return;
    }
    let bins = FFT_SIZE / 2 + 1;
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / FFT_SIZE as f32).cos())
        .collect();

    // Pad so every sample is covered by a full set of overlapping frames.
    let mut padded = vec![0.0f32; FFT_SIZE];
    padded.extend_from_slice(samples);
    padded.resize(padded.len() + 2 * FFT_SIZE, 0.0);
    let frames = (padded.len() - FFT_SIZE) / HOP + 1;

    // Analysis.
    let mut spectra: Vec<Vec<(f32, f32)>> = Vec::with_capacity(frames);
    let mut buf = vec![(0.0f32, 0.0f32); FFT_SIZE];
    for f in 0..frames {
        let off = f * HOP;
        for i in 0..FFT_SIZE {
            buf[i] = (padded[off + i] * window[i], 0.0);
        }
        fft(&mut buf, false);
        spectra.push(buf[..bins].to_vec());
    }

    // Noise floor per bin: 10th percentile of magnitude across frames that
    // actually contain signal (padding frames are pure zeros and excluded).
    let live: Vec<usize> = (0..frames)
        .filter(|&f| spectra[f].iter().any(|&(re, im)| re != 0.0 || im != 0.0))
        .collect();
    if live.is_empty() {
        return;
    }
    let mut floor = vec![0.0f32; bins];
    let mut mags = Vec::with_capacity(live.len());
    for (k, fl) in floor.iter_mut().enumerate() {
        mags.clear();
        mags.extend(live.iter().map(|&f| {
            let (re, im) = spectra[f][k];
            (re * re + im * im).sqrt()
        }));
        let idx = (mags.len() / 10).min(mags.len() - 1);
        mags.select_nth_unstable_by(idx, |a, b| a.total_cmp(b));
        *fl = mags[idx];
    }

    // Gating. Threshold sits a few dB above the floor; strength sets both how
    // far above and how deep the cut goes (up to -30 dB).
    // For noise, magnitudes are roughly Rayleigh distributed, so the mean is
    // about 2.7x the 10th percentile. Gate from 1.3x to 2x that mean.
    let over = 2.7 * (1.3 + 0.7 * strength);
    let min_gain = 10f32.powf(-30.0 * strength / 20.0);
    let mut prev = vec![1.0f32; bins];
    let mut out = vec![0.0f32; padded.len()];
    let mut norm = vec![0.0f32; padded.len()];
    let mut raw = vec![0.0f32; bins];
    for (f, spec) in spectra.iter().enumerate() {
        for k in 0..bins {
            let (re, im) = spec[k];
            let mag = (re * re + im * im).sqrt();
            let thresh = floor[k] * over;
            raw[k] = if mag <= 1e-12 {
                min_gain
            } else {
                // Soft knee: ramps from min_gain at the threshold to 1 at 2x.
                let r = ((mag - thresh) / thresh.max(1e-12)).clamp(0.0, 1.0);
                min_gain + (1.0 - min_gain) * r
            };
        }
        for k in 0..bins {
            // Smooth across neighbouring bins: isolated noise spikes that pass
            // the gate on their own are what cause "musical noise".
            let lo = k.saturating_sub(2);
            let hi = (k + 2).min(bins - 1);
            let target = raw[lo..=hi].iter().sum::<f32>() / (hi - lo + 1) as f32;
            // Fast to open, slower to close, so word onsets stay crisp.
            let g = if target > prev[k] { target } else { prev[k] * 0.6 + target * 0.4 };
            prev[k] = g;
            let (re, im) = spec[k];
            buf[k] = (re * g, im * g);
        }
        // Hermitian mirror for a real inverse transform.
        for k in 1..FFT_SIZE / 2 {
            let (re, im) = buf[k];
            buf[FFT_SIZE - k] = (re, -im);
        }
        fft(&mut buf, true);
        let off = f * HOP;
        for i in 0..FFT_SIZE {
            out[off + i] += buf[i].0 * window[i];
            norm[off + i] += window[i] * window[i];
        }
    }
    for (i, s) in samples.iter_mut().enumerate() {
        let j = i + FFT_SIZE;
        if norm[j] > 1e-6 {
            *s = out[j] / norm[j];
        }
    }
}

/// In-place iterative radix-2 FFT. `inverse` also scales by 1/N.
fn fft(buf: &mut [(f32, f32)], inverse: bool) {
    let n = buf.len();
    debug_assert!(n.is_power_of_two());
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            buf.swap(i, j);
        }
    }
    let sign = if inverse { 1.0 } else { -1.0 };
    let mut len = 2;
    while len <= n {
        let ang = sign * 2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (ang.cos() as f32, ang.sin() as f32);
        for chunk in buf.chunks_mut(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            let half = len / 2;
            for k in 0..half {
                let (ar, ai) = chunk[k];
                let (br, bi) = chunk[k + half];
                let tr = br * cr - bi * ci;
                let ti = br * ci + bi * cr;
                chunk[k] = (ar + tr, ai + ti);
                chunk[k + half] = (ar - tr, ai - ti);
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
        len <<= 1;
    }
    if inverse {
        let s = 1.0 / n as f32;
        for v in buf {
            v.0 *= s;
            v.1 *= s;
        }
    }
}

// ---------------------------------------------------------------------------
// De-esser: split at ~5.5 kHz, and when the top band gets loud relative to the
// whole signal (an "s" or "sh"), turn just the top band down. The split is
// complementary (low = x - high), so with no reduction the audio is unchanged.

fn de_ess(channels: &mut [Vec<f32>], rate: f32, amount: f32) {
    if amount <= 0.0 || channels.is_empty() || rate < 16_000.0 {
        return;
    }
    let len = channels[0].len();
    let highs: Vec<Vec<f32>> = channels
        .iter()
        .map(|ch| {
            // Forward then backward: zero phase, so `x - high` is a clean
            // low band with no sibilance leaking through.
            let mut hp = ch.clone();
            Biquad::high_pass(rate, 5500.0, 0.707).run(&mut hp);
            hp.reverse();
            Biquad::high_pass(rate, 5500.0, 0.707).run(&mut hp);
            hp.reverse();
            hp
        })
        .collect();

    let attack = (-1.0 / (0.001 * rate)).exp();
    let release = (-1.0 / (0.060 * rate)).exp();
    let (mut env_hi, mut env_all) = (0.0f32, 0.0f32);
    // Sibilance is flagged when the top band holds more than this share of the
    // level; more amount means a lower threshold and deeper cut.
    let ratio_thresh = 0.55 - 0.25 * amount;
    let max_cut = 10f32.powf(-12.0 * amount / 20.0);

    for i in 0..len {
        // Linked across channels so the stereo image doesn't shift.
        let hi = highs.iter().map(|h| h[i].abs()).fold(0.0, f32::max);
        let all = channels.iter().map(|c| c[i].abs()).fold(0.0, f32::max);
        let follow = |env: f32, x: f32| {
            let c = if x > env { attack } else { release };
            c * env + (1.0 - c) * x
        };
        env_hi = follow(env_hi, hi);
        env_all = follow(env_all, all);

        let share = if env_all > 1e-5 { env_hi / env_all } else { 0.0 };
        let gain = if share > ratio_thresh {
            (ratio_thresh / share).max(max_cut)
        } else {
            1.0
        };
        for (ch, h) in channels.iter_mut().zip(&highs) {
            let low = ch[i] - h[i];
            ch[i] = low + h[i] * gain;
        }
    }
}

// ---------------------------------------------------------------------------
// Leveller: a gentle 3:1 compressor followed by peak normalisation to -1 dBFS.
// Evens out loud and quiet words, then brings the result up to a full level.

fn level(channels: &mut [Vec<f32>], rate: f32) {
    if channels.is_empty() {
        return;
    }
    let len = channels[0].len();
    let thresh_db = -24.0f32;
    let ratio = 3.0f32;
    let attack = (-1.0 / (0.010 * rate)).exp();
    let release = (-1.0 / (0.150 * rate)).exp();
    let mut env = 0.0f32;

    for i in 0..len {
        let x = channels.iter().map(|c| c[i].abs()).fold(0.0, f32::max);
        let c = if x > env { attack } else { release };
        env = c * env + (1.0 - c) * x;
        let env_db = 20.0 * env.max(1e-6).log10();
        let over = env_db - thresh_db;
        let gain_db = if over > 0.0 { -over * (1.0 - 1.0 / ratio) } else { 0.0 };
        let g = 10f32.powf(gain_db / 20.0);
        for ch in channels.iter_mut() {
            ch[i] *= g;
        }
    }

    let peak = channels
        .iter()
        .flat_map(|c| c.iter())
        .fold(0.0f32, |m, &s| m.max(s.abs()));
    if peak > 1e-5 {
        let target = 10f32.powf(-1.0 / 20.0);
        let g = target / peak;
        for ch in channels.iter_mut() {
            for s in ch.iter_mut() {
                *s *= g;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(channels: Vec<Vec<f32>>, rate: u32) -> DecodedAudio {
        DecodedAudio { channels, sample_rate: rate, codec: "pcm".into(), bits_per_sample: None }
    }

    fn rms(s: &[f32]) -> f32 {
        (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt()
    }

    fn sine(hz: f32, rate: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * PI * hz * i as f32 / rate).sin()).collect()
    }

    /// Deterministic white-ish noise.
    fn noise(n: usize, amp: f32) -> Vec<f32> {
        let mut x: u32 = 0x1234_5678;
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                amp * ((x as f32 / u32::MAX as f32) * 2.0 - 1.0)
            })
            .collect()
    }

    #[test]
    fn fft_round_trips() {
        let orig: Vec<(f32, f32)> = (0..64).map(|i| ((i as f32 * 0.37).sin(), 0.0)).collect();
        let mut buf = orig.clone();
        fft(&mut buf, false);
        fft(&mut buf, true);
        for (a, b) in orig.iter().zip(&buf) {
            assert!((a.0 - b.0).abs() < 1e-4 && b.1.abs() < 1e-4);
        }
    }

    #[test]
    fn high_pass_removes_rumble_keeps_voice() {
        let rate = 48_000.0;
        let n = 48_000;
        let audio = clip(vec![sine(30.0, rate, n, 0.5)], 48_000);
        let chain = VoiceChain { high_pass_hz: Some(80.0), ..Default::default() };
        let out = enhance(&audio, 0, n, &chain).unwrap();
        assert!(rms(&out.channels[0][4800..]) < 0.05 * rms(&audio.channels[0][4800..]));

        let audio = clip(vec![sine(400.0, rate, n, 0.5)], 48_000);
        let out = enhance(&audio, 0, n, &chain).unwrap();
        let ratio = rms(&out.channels[0][4800..]) / rms(&audio.channels[0][4800..]);
        assert!(ratio > 0.95, "ratio {ratio}");
    }

    #[test]
    fn denoise_quietens_gaps_and_keeps_speech() {
        let rate = 48_000.0;
        let n = 96_000;
        // "Speech" (a tone) in the second half only; noise throughout.
        let mut s = noise(n, 0.02);
        let tone = sine(300.0, rate, n, 0.3);
        for i in n / 2..n {
            s[i] += tone[i];
        }
        let audio = clip(vec![s.clone()], 48_000);
        let chain = VoiceChain { denoise: Some(0.8), ..Default::default() };
        let out = enhance(&audio, 0, n, &chain).unwrap();
        let gap_before = rms(&s[4800..n / 2 - 4800]);
        let gap_after = rms(&out.channels[0][4800..n / 2 - 4800]);
        assert!(gap_after < gap_before * 0.3, "{gap_after} vs {gap_before}");
        let speech_before = rms(&s[n / 2 + 4800..n - 4800]);
        let speech_after = rms(&out.channels[0][n / 2 + 4800..n - 4800]);
        assert!(speech_after > speech_before * 0.9, "{speech_after} vs {speech_before}");
    }

    #[test]
    fn de_ess_tames_sibilance_only() {
        let rate = 48_000.0;
        let n = 48_000;
        let hiss = sine(7000.0, rate, n, 0.4);
        let audio = clip(vec![hiss.clone()], 48_000);
        let chain = VoiceChain { de_ess: Some(1.0), ..Default::default() };
        let out = enhance(&audio, 0, n, &chain).unwrap();
        assert!(rms(&out.channels[0][4800..]) < 0.7 * rms(&hiss[4800..]));

        let voice = sine(250.0, rate, n, 0.4);
        let audio = clip(vec![voice.clone()], 48_000);
        let out = enhance(&audio, 0, n, &chain).unwrap();
        let ratio = rms(&out.channels[0][4800..]) / rms(&voice[4800..]);
        assert!((ratio - 1.0).abs() < 0.05, "ratio {ratio}");
    }

    #[test]
    fn level_normalises_to_minus_one_db() {
        let n = 48_000;
        let audio = clip(vec![sine(220.0, 48_000.0, n, 0.05)], 48_000);
        let chain = VoiceChain { level: true, ..Default::default() };
        let out = enhance(&audio, 0, n, &chain).unwrap();
        let peak = out.channels[0].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((peak - 10f32.powf(-1.0 / 20.0)).abs() < 0.01, "peak {peak}");
    }

    #[test]
    fn preset_leaves_outside_selection_untouched() {
        let n = 48_000;
        let s = noise(n, 0.1);
        let audio = clip(vec![s.clone(), s.clone()], 48_000);
        let out = enhance(&audio, 10_000, 30_000, &VoiceChain::preset()).unwrap();
        for ch in &out.channels {
            assert_eq!(&ch[..10_000], &s[..10_000]);
            assert_eq!(&ch[30_000..], &s[30_000..]);
        }
    }

    #[test]
    fn rejects_empty_chain_and_selection() {
        let audio = clip(vec![vec![0.0; 100]], 48_000);
        assert!(enhance(&audio, 0, 100, &VoiceChain::default()).is_err());
        assert!(enhance(&audio, 50, 50, &VoiceChain::preset()).is_err());
    }
}
