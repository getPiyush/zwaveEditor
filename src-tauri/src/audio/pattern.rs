//! Step patterns: a grid of sixteenth notes rendered into an ordinary clip,
//! which then lives on the timeline like any imported file.
//!
//! Rendering is a plain function from a `Pattern` to a `DecodedAudio`, in the
//! same shape as the edits in `edit.rs`, so it is testable without a device.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

use super::decode::{self, DecodedAudio};
use super::engine::sample_at;
use super::synth::{self, Voice};

/// Patterns are rendered at this rate; the mixer resamples as it does for any clip.
pub const PATTERN_RATE: u32 = 44_100;

/// The longest pattern. At 90 BPM this is about 9 minutes of audio.
const MAX_BARS: u32 = 200;

/// The most a preview renders. The grid only repeats, so a loop this long sounds
/// the same as the whole pattern, and edits stay quick however long it is.
pub const PREVIEW_BARS: u32 = 8;

/// One row of the grid is a sixteenth note per step.
const STEPS_PER_BEAT: f64 = 4.0;

/// A bar of 4/4 in sixteenth-note steps.
pub const STEPS_PER_BAR: usize = 16;

/// The longest a single row can be before it loops: eight bars, so a melody
/// fits inside the preview loop.
pub const MAX_ROW_STEPS: usize = STEPS_PER_BAR * PREVIEW_BARS as usize;

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
    /// Drum rows are usually one bar, while a melody can run several bars
    /// before it comes round again.
    pub steps: Vec<bool>,
    #[serde(default = "unity")]
    pub gain: f32,
    /// Left/right balance: -1 is left only, 0 both as they are, 1 right only.
    #[serde(default)]
    pub pan: f32,
    /// MIDI note number, for tuned voices and for repitching samples (60 = as recorded).
    #[serde(default = "middle_c")]
    pub note: f32,
    /// A note per step, for melodies. A missing or null entry plays `note`.
    #[serde(default)]
    pub step_notes: Vec<Option<f32>>,
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
    /// How long the rendered clip is, in bars of 4/4. Each row loops on its
    /// own length within it.
    pub bars: u32,
    /// 0 is straight; 1 pushes every off-beat sixteenth halfway to the next step.
    #[serde(default)]
    pub swing: f32,
    pub rows: Vec<PatternRow>,
    /// Splits the clip into stretches that play and stretches of silence, such
    /// as 2 bars, a 3-bar gap, then 3 bars. Each playing stretch starts every
    /// row from its beginning. Empty means the whole clip plays; otherwise the
    /// sections add up to `bars`.
    #[serde(default)]
    pub sections: Vec<Section>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub bars: u32,
    /// A gap: nothing starts in it, though sounds already ringing carry on.
    #[serde(default)]
    pub rest: bool,
}

impl Pattern {
    pub fn step_seconds(&self) -> f64 {
        60.0 / self.bpm / STEPS_PER_BEAT
    }

    pub fn duration_secs(&self) -> f64 {
        self.step_seconds() * self.total_steps() as f64
    }

    fn total_steps(&self) -> usize {
        STEPS_PER_BAR * self.bars as usize
    }

    /// The pattern cut to its first `bars` bars, sections and all.
    pub fn truncated(&self, bars: u32) -> Pattern {
        let mut left = bars.min(self.bars);
        let mut sections = Vec::new();
        for section in &self.sections {
            if left == 0 {
                break;
            }
            let take = section.bars.min(left);
            sections.push(Section { bars: take, ..*section });
            left -= take;
        }
        Pattern {
            bars: bars.min(self.bars),
            sections,
            ..self.clone()
        }
    }

    /// For each step of the clip, the step within its playing section, or
    /// None in a gap.
    fn section_steps(&self) -> Vec<Option<usize>> {
        if self.sections.is_empty() {
            return (0..self.total_steps()).map(Some).collect();
        }
        self.sections
            .iter()
            .flat_map(|section| {
                let steps = STEPS_PER_BAR * section.bars as usize;
                (0..steps).map(move |i| (!section.rest).then_some(i))
            })
            .collect()
    }

    fn validate(&self) -> Result<(), String> {
        if !self.bpm.is_finite() || !(20.0..=400.0).contains(&self.bpm) {
            return Err(format!("tempo must be between 20 and 400 BPM, not {}", self.bpm));
        }
        if self.bars == 0 || self.bars > MAX_BARS {
            return Err(format!("a pattern must be between 1 and {MAX_BARS} bars long"));
        }
        if !self.sections.is_empty() {
            if self.sections.iter().any(|s| s.bars == 0) {
                return Err("every section of the length needs at least 1 bar".to_string());
            }
            let sum: u32 = self.sections.iter().map(|s| s.bars).sum();
            if sum != self.bars {
                return Err(format!(
                    "the sections add up to {sum} bars but the pattern is {} bars",
                    self.bars
                ));
            }
        }
        if self.rows.is_empty() {
            return Err("the pattern has no rows".to_string());
        }
        if self.rows.iter().any(|r| r.steps.len() > MAX_ROW_STEPS) {
            return Err(format!(
                "a row can be at most {} bars long",
                MAX_ROW_STEPS / STEPS_PER_BAR
            ));
        }
        Ok(())
    }
}

/// Renders the pattern to a stereo clip, `bars` bars long.
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
    let section_steps = pattern.section_steps();

    let mut left = vec![0.0f32; total];
    let mut right = vec![0.0f32; total];

    for row in &pattern.rows {
        if row.muted || row.gain <= 0.0 || !row.steps.iter().any(|on| *on) {
            continue;
        }
        let gain = row.gain.clamp(0.0, 2.0);
        // A balance, not a pan law: the far side drops and the near side stays
        // put, so a centred row sounds exactly as it does without one.
        let pan = row.pan.clamp(-1.0, 1.0);
        let (left_gain, right_gain) = ((1.0 - pan).min(1.0), (1.0 + pan).min(1.0));

        // Every onset in the whole clip, in frames, with the note it plays.
        // The row loops on its own length, so a one-bar drum row and a
        // four-bar melody run side by side; a row longer than the clip is cut.
        // Gaps start nothing, and each playing section starts the row afresh.
        let mut starts: Vec<(usize, f32)> = Vec::new();
        for (step_index, local) in section_steps.iter().enumerate() {
            let Some(local) = local else { continue };
            let index = local % row.steps.len();
            if !row.steps[index] {
                continue;
            }
            let swung = if step_index % 2 == 1 { swing * step * 0.5 } else { 0.0 };
            let seconds = step_index as f64 * step + swung;
            let note = row.step_notes.get(index).copied().flatten().unwrap_or(row.note);
            starts.push((((seconds * rate).round() as usize) % total, note));
        }
        starts.sort_unstable_by_key(|(start, _)| *start);
        starts.dedup_by_key(|(start, _)| *start);

        // Each distinct note is rendered (or decoded and repitched) once.
        let mut hits: HashMap<u32, Hit> = HashMap::new();
        let fade = (CHOKE_FADE_SECONDS * rate) as usize;
        for (k, &(start, note)) in starts.iter().enumerate() {
            let hit = match hits.entry(note.to_bits()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => entry.insert(row_hit(row, note)?),
            };
            // A choked hit plays until the next onset (wrapping), then fades.
            let limit = if row.choke && starts.len() > 1 {
                let next = starts.get(k + 1).map(|(s, _)| *s).unwrap_or(starts[0].0 + total);
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
                left[at] += hit.left[i] * level * left_gain;
                right[at] += hit.right[i] * level * right_gain;
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

fn row_hit(row: &PatternRow, note: f32) -> Result<Hit, String> {
    match &row.sound {
        RowSound::Synth { voice } => {
            let mono = synth::render(*voice, note, PATTERN_RATE);
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
            Ok(resample_hit(&audio, note))
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
            pan: 0.0,
            note: 45.0,
            step_notes: Vec::new(),
            choke: false,
            muted: false,
        }
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }

    #[test]
    fn balance_moves_a_row_between_the_channels() {
        let render_at = |pan: f32| {
            let mut snare = row(Voice::Snare, &[0]);
            snare.gain = 0.5;
            snare.pan = pan;
            render(&pattern(vec![snare], 1)).unwrap()
        };

        let centre = render_at(0.0);
        assert_eq!(centre.channels[0], centre.channels[1]);

        let left = render_at(-1.0);
        assert_eq!(left.channels[0], centre.channels[0], "the near side is untouched");
        assert_eq!(peak(&left.channels[1]), 0.0);

        let right = render_at(1.0);
        assert_eq!(peak(&right.channels[0]), 0.0);
        assert_eq!(right.channels[1], centre.channels[1]);

        let leaning = render_at(0.5);
        assert!((peak(&leaning.channels[0]) - peak(&centre.channels[0]) * 0.5).abs() < 1e-5);
        assert_eq!(leaning.channels[1], centre.channels[1]);
    }

    #[test]
    fn balance_applies_to_one_row_only() {
        let mut hard_left = row(Voice::Snare, &[0]);
        hard_left.gain = 0.5;
        hard_left.pan = -1.0;
        let mut centred = row(Voice::Kick, &[0]);
        centred.gain = 0.5;

        let both = render(&pattern(vec![hard_left, centred.clone()], 1)).unwrap();
        let kick = render(&pattern(vec![centred], 1)).unwrap();
        assert_eq!(both.channels[1], kick.channels[1], "only the kick reaches the right");
        assert_ne!(both.channels[0], kick.channels[0]);
    }

    fn pattern(rows: Vec<PatternRow>, bars: u32) -> Pattern {
        Pattern {
            bpm: 90.0,
            bars,
            swing: 0.0,
            rows,
            sections: Vec::new(),
        }
    }

    fn sections(list: &[(u32, bool)]) -> Vec<Section> {
        list.iter().map(|&(bars, rest)| Section { bars, rest }).collect()
    }

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|x| x * x).sum()
    }

    #[test]
    fn gaps_are_silent_and_each_section_starts_the_rows_afresh() {
        // 2 bars, a 3-bar gap, then 3 bars of a two-bar melody.
        let mut p = pattern(vec![melody(&[57.0, 64.0])], 8);
        p.sections = sections(&[(2, false), (3, true), (3, false)]);
        let audio = render(&p).unwrap();
        let bar = bar_frames();
        assert_eq!(audio.frame_count(), 8 * bar);
        let ch = &audio.channels[0];

        // The last bar of the gap is silent once the tail of bar 2 has died away.
        assert_eq!(energy(&ch[4 * bar..5 * bar]), 0.0);
        // The second section opens with the melody's first bar, not its second.
        assert!(worst_difference(&ch[5 * bar..5 * bar + 4000], &ch[..4000]) < 1e-5);
    }

    #[test]
    fn sections_must_add_up_to_the_length() {
        let mut p = pattern(vec![row(Voice::Kick, &[0])], 8);
        p.sections = sections(&[(2, false), (3, true)]);
        assert!(p.validate().is_err());
        p.sections = sections(&[(2, false), (0, true), (6, false)]);
        assert!(p.validate().is_err());
        p.sections = sections(&[(2, false), (6, true)]);
        assert!(p.validate().is_ok());
    }

    #[test]
    fn truncating_keeps_the_sections_that_fit() {
        let mut p = pattern(vec![row(Voice::Kick, &[0])], 12);
        p.sections = sections(&[(2, false), (3, true), (7, false)]);
        let short = p.truncated(8);
        assert_eq!(short.bars, 8);
        assert_eq!(short.sections, sections(&[(2, false), (3, true), (3, false)]));
        assert!(short.validate().is_ok());
    }

    fn first_onset(samples: &[f32]) -> usize {
        samples.iter().position(|s| s.abs() > 1e-3).unwrap()
    }

    #[test]
    fn length_goes_up_to_200_bars() {
        assert!(pattern(vec![row(Voice::Kick, &[0])], 200).validate().is_ok());
        assert!(pattern(vec![row(Voice::Kick, &[0])], 201).validate().is_err());
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
                 "steps": [false,true]},
                {"sound": {"kind": "synth", "voice": "piano"},
                 "steps": [true,true], "note": 60, "stepNotes": [null, 64]}
            ]
        }"#;
        let p: Pattern = serde_json::from_str(json).unwrap();
        assert_eq!(p.rows.len(), 3);
        assert!(matches!(p.rows[0].sound, RowSound::Synth { voice: Voice::Kick }));
        assert!(matches!(p.rows[1].sound, RowSound::Sample { .. }));
        assert_eq!(p.rows[1].note, 60.0);
        assert_eq!(p.rows[2].step_notes, vec![None, Some(64.0)]);
    }

    /// A row `bars` long with one hit at the start of each bar, on the given notes.
    fn melody(notes: &[f32]) -> PatternRow {
        let mut r = row(Voice::Marimba, &[]);
        r.gain = 0.3;
        r.steps = vec![false; STEPS_PER_BAR * notes.len()];
        r.step_notes = vec![None; r.steps.len()];
        for (bar, note) in notes.iter().enumerate() {
            r.steps[bar * STEPS_PER_BAR] = true;
            r.step_notes[bar * STEPS_PER_BAR] = Some(*note);
        }
        r
    }

    fn bar_frames() -> usize {
        (4.0 * 60.0 / 90.0 * PATTERN_RATE as f64).round() as usize
    }

    fn worst_difference(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()))
    }

    #[test]
    fn length_is_set_by_bars_not_by_the_longest_row() {
        let audio = render(&pattern(vec![row(Voice::Kick, &[0]), melody(&[57.0, 60.0, 64.0, 67.0])], 2)).unwrap();
        assert_eq!(audio.frame_count(), 2 * bar_frames());
    }

    #[test]
    fn a_long_row_changes_its_tune_while_a_short_row_repeats() {
        // A four-bar melody over a one-bar beat...
        let mut beat = row(Voice::Kick, &[0, 8]);
        beat.gain = 0.3;
        let notes = [57.0, 60.0, 64.0, 67.0];
        let whole = render(&pattern(vec![beat.clone(), melody(&notes)], 4)).unwrap();

        // ...is the same as a four-bar beat with each bar's note on a row of its own.
        let mut long_beat = beat.clone();
        long_beat.steps = beat.steps.repeat(4);
        let mut rows = vec![long_beat];
        for (n, note) in notes.iter().enumerate() {
            let mut only = melody(&[0.0; 4]);
            only.steps = vec![false; 4 * STEPS_PER_BAR];
            only.step_notes = vec![None; 4 * STEPS_PER_BAR];
            only.steps[n * STEPS_PER_BAR] = true;
            only.note = *note;
            rows.push(only);
        }
        let apart = render(&pattern(rows, 4)).unwrap();
        assert!(worst_difference(&whole.channels[0], &apart.channels[0]) < 1e-5);

        // And the bars really do differ.
        let bar = bar_frames();
        let first = &whole.channels[0][..4000];
        let second = &whole.channels[0][bar..bar + 4000];
        assert!(worst_difference(first, second) > 1e-3);
    }

    #[test]
    fn a_row_shorter_than_the_clip_loops() {
        let two_bars = render(&pattern(vec![melody(&[57.0, 64.0])], 4)).unwrap();
        let bar = bar_frames();
        let (a, b) = (&two_bars.channels[0][..2 * bar], &two_bars.channels[0][2 * bar..]);
        assert!(worst_difference(&a[bar / 2..], &b[bar / 2..]) < 1e-5);
    }

    #[test]
    fn rows_are_at_most_eight_bars() {
        let mut r = row(Voice::Piano, &[0]);
        r.steps = vec![false; MAX_ROW_STEPS];
        r.steps[0] = true;
        assert!(pattern(vec![r.clone()], 8).validate().is_ok());
        r.steps.push(false);
        assert!(pattern(vec![r], 8).validate().is_err());
    }

    #[test]
    fn each_step_plays_its_own_note() {
        let quiet = |mut r: PatternRow| {
            r.gain = 0.3;
            r
        };
        let mut melody = quiet(row(Voice::Marimba, &[0, 8]));
        melody.note = 57.0;
        melody.step_notes = vec![None; 16];
        melody.step_notes[8] = Some(69.0);

        let mut first = quiet(row(Voice::Marimba, &[0]));
        first.note = 57.0;
        let mut second = quiet(row(Voice::Marimba, &[8]));
        second.note = 69.0;

        let both = render(&pattern(vec![melody], 1)).unwrap();
        let apart = render(&pattern(vec![first, second], 1)).unwrap();
        let worst = both.channels[0]
            .iter()
            .zip(&apart.channels[0])
            .fold(0.0f32, |m, (a, b)| m.max((a - b).abs()));
        assert!(worst < 1e-5, "differs by {worst}");
    }
}
