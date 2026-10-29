//! Step patterns: a grid of sixteenth notes rendered into an ordinary clip,
//! which then lives on the timeline like any imported file.
//!
//! Rendering is a plain function from a `Pattern` to a `DecodedAudio`, in the
//! same shape as the edits in `edit.rs`, so it is testable without a device.

use std::path::Path;

use serde::Deserialize;

use super::decode::{self, DecodedAudio};
use super::engine::sample_at;
use super::synth::{self, Voice};

/// Patterns are rendered at this rate; the mixer resamples as it does for any clip.
pub const PATTERN_RATE: u32 = 44_100;

/// One row of the grid is a sixteenth note per step.
const STEPS_PER_BEAT: f64 = 4.0;

/// Where a summed pattern is pulled back to if the rows add up past it.
const PATTERN_CEILING: f32 = 0.98;

/// How long a choked hit takes to fade out when the next one cuts it off.
const CHOKE_FADE_SECONDS: f64 = 0.006;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowSound {
    /// One of the built-in voices.
    Synth { voice: Voice },
    /// A one-shot loaded from a file.
    Sample { path: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternRow {
    pub sound: RowSound,
    /// One entry per sixteenth note; the row repeats every `steps.len()` steps.
    pub steps: Vec<bool>,
    #[serde(default = "unity")]
    pub gain: f32,
    /// MIDI note number, for tuned voices and for repitching samples (60 = as recorded).
    #[serde(default = "middle_c")]
    pub note: f32,
    /// Each hit cuts the previous one off, like a single 808 or an open hat.
    #[serde(default)]
    pub choke: bool,
    #[serde(default)]
    pub muted: bool,
}

fn unity() -> f32 {
    1.0
}

fn middle_c() -> f32 {
    60.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pattern {
    pub bpm: f64,
    /// How many times the grid plays through. The rendered clip is this many
    /// grid-lengths long.
    pub bars: u32,
    /// 0 is straight; 1 pushes every off-beat sixteenth halfway to the next step.
    #[serde(default)]
    pub swing: f32,
    pub rows: Vec<PatternRow>,
}

impl Pattern {
    fn steps_per_cycle(&self) -> usize {
        self.rows.iter().map(|r| r.steps.len()).max().unwrap_or(16).max(1)
    }

    pub fn step_seconds(&self) -> f64 {
        60.0 / self.bpm / STEPS_PER_BEAT
    }

    pub fn duration_secs(&self) -> f64 {
        self.step_seconds() * (self.steps_per_cycle() * self.bars as usize) as f64
    }

    fn validate(&self) -> Result<(), String> {
        if !self.bpm.is_finite() || !(20.0..=400.0).contains(&self.bpm) {
            return Err(format!("tempo must be between 20 and 400 BPM, not {}", self.bpm));
        }
        if self.bars == 0 || self.bars > 64 {
            return Err("a pattern must be between 1 and 64 bars long".to_string());
        }
        if self.rows.is_empty() {
            return Err("the pattern has no rows".to_string());
        }
        if self.steps_per_cycle() > 256 {
            return Err("a row can have at most 256 steps".to_string());
        }
        Ok(())
    }
}

/// Renders the pattern to a stereo clip, `bars` cycles long.
///
/// Sounds that ring past the end wrap round to the start, so the clip loops
/// seamlessly — repeat it or paste it end to end and every tail carries over.
pub fn render(pattern: &Pattern) -> Result<DecodedAudio, String> {
    pattern.validate()?;

    let rate = PATTERN_RATE as f64;
    let total = (pattern.duration_secs() * rate).round() as usize;
    if total == 0 {
        return Err("the pattern is too short to render".to_string());
    }
    let step = pattern.step_seconds();
    let swing = pattern.swing.clamp(0.0, 1.0) as f64;
    let cycle = pattern.steps_per_cycle();

    let mut left = vec![0.0f32; total];
    let mut right = vec![0.0f32; total];

    for row in &pattern.rows {
        if row.muted || row.gain <= 0.0 || !row.steps.iter().any(|on| *on) {
            continue;
        }
        let hit = row_hit(row)?;
        let gain = row.gain.clamp(0.0, 2.0);

        // Every onset in the whole clip, in frames.
        let mut starts: Vec<usize> = Vec::new();
        for repeat in 0..pattern.bars as usize {
            for (index, on) in row.steps.iter().enumerate() {
                if !on {
                    continue;
                }
                let step_index = repeat * cycle + index;
                let swung = if index % 2 == 1 { swing * step * 0.5 } else { 0.0 };
                let seconds = step_index as f64 * step + swung;
                starts.push(((seconds * rate).round() as usize) % total);
            }
        }
        starts.sort_unstable();
        starts.dedup();

        let fade = (CHOKE_FADE_SECONDS * rate) as usize;
        for (k, &start) in starts.iter().enumerate() {
            // A choked hit plays until the next onset (wrapping), then fades.
            let limit = if row.choke && starts.len() > 1 {
                let next = starts.get(k + 1).copied().unwrap_or(starts[0] + total);
                (next - start + fade).min(hit.frames())
            } else if row.choke {
                hit.frames().min(total)
            } else {
                hit.frames()
            };
            let cut_from = if row.choke { limit.saturating_sub(fade) } else { usize::MAX };

            for i in 0..limit {
                let mut level = gain;
                if i >= cut_from {
                    level *= 1.0 - (i - cut_from) as f32 / fade.max(1) as f32;
                }
                let at = (start + i) % total;
                left[at] += hit.left[i] * level;
                right[at] += hit.right[i] * level;
            }
        }
    }

    // Rows can sum past full scale; pull the whole pattern down rather than clip.
    let peak = left
        .iter()
        .chain(right.iter())
        .fold(0.0f32, |m, s| m.max(s.abs()));
    if peak > PATTERN_CEILING {
        let scale = PATTERN_CEILING / peak;
        left.iter_mut().chain(right.iter_mut()).for_each(|s| *s *= scale);
    }

    Ok(DecodedAudio {
        channels: vec![left, right],
        sample_rate: PATTERN_RATE,
        codec: "pattern".into(),
        bits_per_sample: None,
    })
}

/// One stereo hit for a row, at the pattern rate.
struct Hit {
    left: Vec<f32>,
    right: Vec<f32>,
}

impl Hit {
    fn frames(&self) -> usize {
        self.left.len()
    }
}

fn row_hit(row: &PatternRow) -> Result<Hit, String> {
    match &row.sound {
        RowSound::Synth { voice } => {
            let mono = synth::render(*voice, row.note, PATTERN_RATE);
            Ok(Hit {
                left: mono.clone(),
                right: mono,
            })
        }
        RowSound::Sample { path } => {
            let audio = decode::decode_file(Path::new(path)).map_err(|e| {
                let name = Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone());
                format!("could not load {name}: {e}")
            })?;
            Ok(resample_hit(&audio, row.note))
        }
    }
}

/// Converts a sample to the pattern rate, repitched so that note 60 plays it
/// as recorded and each semitone up plays it faster (and shorter).
fn resample_hit(audio: &DecodedAudio, note: f32) -> Hit {
    let pitch = 2f64.powf((note as f64 - 60.0) / 12.0).clamp(0.125, 8.0);
    let step = audio.sample_rate as f64 / PATTERN_RATE as f64 * pitch;
    let frames = (audio.frame_count() as f64 / step).floor() as usize;
    let read = |channel: &[f32]| -> Vec<f32> {
        (0..frames).map(|i| sample_at(channel, i as f64 * step)).collect()
    };
    let left = read(&audio.channels[0]);
    let right = if audio.channels.len() > 1 {
        read(&audio.channels[1])
    } else {
        left.clone()
    };
    Hit { left, right }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(voice: Voice, on: &[usize]) -> PatternRow {
        let mut steps = vec![false; 16];
        for i in on {
            steps[*i] = true;
        }
        PatternRow {
            sound: RowSound::Synth { voice },
            steps,
            gain: 1.0,
            note: 45.0,
            choke: false,
            muted: false,
        }
    }

    fn pattern(rows: Vec<PatternRow>, bars: u32) -> Pattern {
        Pattern {
            bpm: 90.0,
            bars,
            swing: 0.0,
            rows,
        }
    }

    fn first_onset(samples: &[f32]) -> usize {
        samples.iter().position(|s| s.abs() > 1e-3).unwrap()
    }

    #[test]
    fn length_is_exactly_the_bars_asked_for() {
        // 90 BPM: a bar of 4/4 is 2.6667s.
        let audio = render(&pattern(vec![row(Voice::Kick, &[0])], 4)).unwrap();
        let expected = (4.0 * 4.0 * 60.0 / 90.0 * PATTERN_RATE as f64).round() as usize;
        assert_eq!(audio.frame_count(), expected);
        assert_eq!(audio.channel_count(), 2);
    }

    #[test]
    fn hits_land_on_their_steps() {
        let audio = render(&pattern(vec![row(Voice::Snare, &[4])], 1)).unwrap();
        // Step 4 = beat 2 = 60/90 s in.
        let expected = (60.0 / 90.0 * PATTERN_RATE as f64).round() as usize;
        let onset = first_onset(&audio.channels[0]);
        assert!(onset >= expected && onset < expected + 64, "onset {onset}, want {expected}");
    }

    #[test]
    fn swing_delays_only_the_offbeat_sixteenths() {
        let mut swung = pattern(vec![row(Voice::ClosedHat, &[1])], 1);
        swung.swing = 0.5;
        let straight = render(&pattern(vec![row(Voice::ClosedHat, &[1])], 1)).unwrap();
        let swung = render(&swung).unwrap();
        let step = 60.0 / 90.0 / 4.0 * PATTERN_RATE as f64;
        let shift = first_onset(&swung.channels[0]) as f64 - first_onset(&straight.channels[0]) as f64;
        assert!((shift - step * 0.25).abs() < 4.0, "shifted {shift} frames");

        // An on-beat step does not move.
        let mut on_beat = pattern(vec![row(Voice::ClosedHat, &[2])], 1);
        on_beat.swing = 0.5;
        let a = first_onset(&render(&on_beat).unwrap().channels[0]);
        let b = first_onset(&render(&pattern(vec![row(Voice::ClosedHat, &[2])], 1)).unwrap().channels[0]);
        assert_eq!(a, b);
    }

    #[test]
    fn tails_wrap_round_so_the_clip_loops() {
        // A chime on the last step rings well past the end of a short bar.
        let audio = render(&pattern(vec![row(Voice::Chime, &[15])], 1)).unwrap();
        assert!(audio.channels[0][100].abs() > 1e-3, "the tail should carry into the start");
    }

    #[test]
    fn choke_cuts_each_hit_at_the_next() {
        let mut bass = row(Voice::Bass808, &[0, 8]);
        bass.choke = true;
        let choked = render(&pattern(vec![bass.clone()], 1)).unwrap();
        bass.choke = false;
        let open = render(&pattern(vec![bass], 1)).unwrap();
        // Just before the second hit the choked 808 has faded out, the open one rings on.
        let second = (2.0 * 60.0 / 90.0 * PATTERN_RATE as f64).round() as usize;
        let just_after = second + (CHOKE_FADE_SECONDS * PATTERN_RATE as f64) as usize + 10;
        // Compare energy just after the second onset: the open version has two 808s stacked.
        let energy = |s: &[f32]| s[just_after..just_after + 2000].iter().map(|x| x * x).sum::<f32>();
        assert!(energy(&open.channels[0]) != energy(&choked.channels[0]));
    }

    #[test]
    fn a_full_kit_never_clips() {
        let rows = vec![
            row(Voice::Kick, &[0, 3, 8, 10]),
            row(Voice::Bass808, &[0, 3, 8, 10]),
            row(Voice::Snare, &[4, 12]),
            row(Voice::Clap, &[4, 12]),
            row(Voice::ClosedHat, &[0, 2, 4, 6, 8, 10, 12, 14]),
            row(Voice::Chime, &[0, 8]),
        ];
        let audio = render(&pattern(rows, 2)).unwrap();
        let peak = audio.channels[0].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak <= PATTERN_CEILING + 1e-6, "peak {peak}");
    }

    #[test]
    fn muted_and_empty_rows_add_nothing() {
        let mut muted = row(Voice::Kick, &[0]);
        muted.muted = true;
        let audio = render(&pattern(vec![muted, row(Voice::Snare, &[])], 1)).unwrap();
        assert!(audio.channels[0].iter().all(|s| *s == 0.0));
    }

    #[test]
    fn rejects_nonsense() {
        let mut p = pattern(vec![row(Voice::Kick, &[0])], 1);
        p.bpm = 0.0;
        assert!(render(&p).is_err());
        let mut p = pattern(vec![row(Voice::Kick, &[0])], 0);
        p.bars = 0;
        assert!(render(&p).is_err());
        assert!(render(&pattern(vec![], 1)).is_err());
    }

    #[test]
    fn deserialises_what_the_ui_sends() {
        let json = r#"{
            "bpm": 92, "bars": 2, "swing": 0.3,
            "rows": [
                {"id": "r1", "label": "Kick", "sound": {"kind": "synth", "voice": "kick"},
                 "steps": [true,false,false,false], "gain": 0.9, "note": 36, "choke": false},
                {"sound": {"kind": "sample", "path": "/tmp/x.wav", "name": "x.wav"},
                 "steps": [false,true]}
            ]
        }"#;
        let p: Pattern = serde_json::from_str(json).unwrap();
        assert_eq!(p.rows.len(), 2);
        assert!(matches!(p.rows[0].sound, RowSound::Synth { voice: Voice::Kick }));
        assert!(matches!(p.rows[1].sound, RowSound::Sample { .. }));
        assert_eq!(p.rows[1].note, 60.0);
    }
}
