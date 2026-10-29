//! The master bus: a gain stage and an optional limiter applied to the summed
//! mix, shared by live playback and the master export so they sound the same.
//!
//! The defaults (unity gain, limiter off) leave the signal untouched, which is
//! exactly how the mixer behaved before the bus existed.

use serde::Deserialize;

/// Where the limiter holds peaks: -0.5 dBFS, a little under full scale so the
/// final hard clip never engages.
pub const LIMIT_THRESHOLD: f32 = 0.944;

/// How quickly the limiter lets go after a peak, in seconds.
const RELEASE_SECONDS: f32 = 0.15;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MasterBus {
    pub gain: f32,
    pub limiter: bool,
}

impl Default for MasterBus {
    fn default() -> Self {
        Self {
            gain: 1.0,
            limiter: false,
        }
    }
}

impl MasterBus {
    /// Keeps the gain finite and inside the range the UI offers.
    pub fn sanitized(self) -> Self {
        let gain = if self.gain.is_finite() {
            self.gain.clamp(0.0, 4.0)
        } else {
            1.0
        };
        Self { gain, ..self }
    }
}

/// A stereo-linked peak limiter with instant attack and exponential release.
///
/// The envelope jumps straight to any new peak, so the output can never
/// exceed the threshold; there is no lookahead, which costs a little
/// transient softness but keeps playback latency at zero.
#[derive(Debug, Clone)]
pub struct Limiter {
    envelope: f32,
    release: f32,
}

impl Limiter {
    pub fn new(sample_rate: f64) -> Self {
        let rate = sample_rate.max(1.0) as f32;
        Self {
            envelope: 0.0,
            release: (-1.0 / (RELEASE_SECONDS * rate)).exp(),
        }
    }

    pub fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        let peak = left.abs().max(right.abs());
        self.envelope = if peak >= self.envelope {
            peak
        } else {
            peak + (self.envelope - peak) * self.release
        };
        if self.envelope > LIMIT_THRESHOLD {
            let reduction = LIMIT_THRESHOLD / self.envelope;
            (left * reduction, right * reduction)
        } else {
            (left, right)
        }
    }
}

impl MasterBus {
    /// Runs one stereo frame through the bus.
    #[inline]
    pub fn apply(&self, left: f32, right: f32, limiter: &mut Limiter) -> (f32, f32) {
        let left = left * self.gain;
        let right = right * self.gain;
        if self.limiter {
            limiter.process(left, right)
        } else {
            (left, right)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_bus_is_transparent() {
        let bus = MasterBus::default();
        let mut limiter = Limiter::new(48_000.0);
        for value in [-1.7f32, -0.3, 0.0, 0.42, 2.5] {
            assert_eq!(bus.apply(value, -value, &mut limiter), (value, -value));
        }
    }

    #[test]
    fn limiter_never_lets_a_peak_through() {
        let bus = MasterBus {
            gain: 1.0,
            limiter: true,
        };
        let mut limiter = Limiter::new(48_000.0);
        for i in 0..48_000 {
            let value = (i as f32 * 0.05).sin() * 3.0;
            let (l, r) = bus.apply(value, value * 0.5, &mut limiter);
            assert!(l.abs() <= LIMIT_THRESHOLD + 1e-6, "frame {i} peaked at {l}");
            assert!(r.abs() <= LIMIT_THRESHOLD + 1e-6);
        }
    }

    #[test]
    fn limiter_leaves_quiet_signals_alone() {
        let bus = MasterBus {
            gain: 1.0,
            limiter: true,
        };
        let mut limiter = Limiter::new(48_000.0);
        let (l, r) = bus.apply(0.5, -0.25, &mut limiter);
        assert_eq!((l, r), (0.5, -0.25));
    }

    #[test]
    fn gain_scales_before_the_limiter() {
        let bus = MasterBus {
            gain: 0.5,
            limiter: false,
        };
        let mut limiter = Limiter::new(48_000.0);
        assert_eq!(bus.apply(0.8, -0.8, &mut limiter), (0.4, -0.4));
    }
}
