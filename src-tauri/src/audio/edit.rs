//! Destructive edits over a clip's sample buffers.
//!
//! Every edit returns a new `DecodedAudio` rather than mutating in place: the
//! previous version goes on the clip's undo stack, and the file on disk is
//! never touched — what you hear is only committed by exporting.

use super::decode::DecodedAudio;
use super::engine::sample_at;

/// Converts a time span to a frame range, clamped to the clip.
pub fn frame_range(audio: &DecodedAudio, start_secs: f64, end_secs: f64) -> (usize, usize) {
    let total = audio.frame_count();
    let rate = audio.sample_rate as f64;
    let start = ((start_secs.max(0.0) * rate).round() as usize).min(total);
    let end = ((end_secs.max(0.0) * rate).round() as usize).clamp(start, total);
    (start, end)
}

/// Removes `[start, end)`, closing the gap.
pub fn delete_range(audio: &DecodedAudio, start: usize, end: usize) -> Result<DecodedAudio, String> {
    let total = audio.frame_count();
    if end <= start {
        return Err("nothing is selected".to_string());
    }
    if start == 0 && end >= total {
        return Err("that would delete the whole clip — remove the track instead".to_string());
    }

    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            let mut kept = Vec::with_capacity(samples.len() - (end - start));
            kept.extend_from_slice(&samples[..start]);
            kept.extend_from_slice(&samples[end.min(samples.len())..]);
            kept
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Keeps only `[start, end)`, discarding everything around it.
pub fn crop_range(audio: &DecodedAudio, start: usize, end: usize) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }

    let channels = audio
        .channels
        .iter()
        .map(|samples| samples[start.min(samples.len())..end.min(samples.len())].to_vec())
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Copies `[start, end)` out as a clip of its own, for the clipboard.
pub fn copy_range(audio: &DecodedAudio, start: usize, end: usize) -> Result<DecodedAudio, String> {
    crop_range(audio, start, end)
}

/// Replaces `[start, end)` with `insert`, which is first converted to this
/// clip's sample rate and channel count. An empty range is a plain insert.
pub fn paste_range(
    audio: &DecodedAudio,
    start: usize,
    end: usize,
    insert: &DecodedAudio,
) -> Result<DecodedAudio, String> {
    if insert.frame_count() == 0 {
        return Err("the clipboard is empty".to_string());
    }
    let total = audio.frame_count();
    let start = start.min(total);
    let end = end.clamp(start, total);
    let pasted = conform(insert, audio.sample_rate, audio.channel_count());

    let channels = audio
        .channels
        .iter()
        .zip(pasted)
        .map(|(samples, middle)| {
            let mut joined = Vec::with_capacity(samples.len() - (end - start) + middle.len());
            joined.extend_from_slice(&samples[..start.min(samples.len())]);
            joined.extend_from_slice(&middle);
            joined.extend_from_slice(&samples[end.min(samples.len())..]);
            joined
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Adjusts the volume of a range by a gain factor.
pub fn adjust_volume(
    audio: &DecodedAudio,
    start: usize,
    end: usize,
    gain: f32,
) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }
    if gain < 0.0 {
        return Err("gain must be non-negative".to_string());
    }

    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            samples
                .iter()
                .enumerate()
                .map(|(i, &sample)| {
                    if i >= start && i < end {
                        (sample * gain).clamp(-1.0, 1.0)
                    } else {
                        sample
                    }
                })
                .collect()
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Applies a fade in (linear ramp from 0 to 1) over the range.
pub fn fade_in(audio: &DecodedAudio, start: usize, end: usize) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }

    let fade_len = end - start;
    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            samples
                .iter()
                .enumerate()
                .map(|(i, &sample)| {
                    if i >= start && i < end {
                        let fade = (i - start) as f32 / fade_len as f32;
                        sample * fade
                    } else {
                        sample
                    }
                })
                .collect()
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Applies a fade out (linear ramp from 1 to 0) over the range.
pub fn fade_out(audio: &DecodedAudio, start: usize, end: usize) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }

    let fade_len = end - start;
    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            samples
                .iter()
                .enumerate()
                .map(|(i, &sample)| {
                    if i >= start && i < end {
                        let fade = 1.0 - ((i - start) as f32 / fade_len as f32);
                        sample * fade
                    } else {
                        sample
                    }
                })
                .collect()
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Changes pitch/speed by resampling. Factor > 1 speeds up (higher pitch), < 1 slows down (lower pitch).
pub fn adjust_pitch(
    audio: &DecodedAudio,
    start: usize,
    end: usize,
    factor: f32,
) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }
    if factor <= 0.0 {
        return Err("pitch factor must be positive".to_string());
    }

    let selected_len = (end - start) as f32 / factor;
    let new_len = selected_len.round() as usize;
    if new_len == 0 {
        return Err("result would be empty".to_string());
    }

    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            let mut result = Vec::new();
            result.extend_from_slice(&samples[..start]);

            // Resample the selected range
            for i in 0..new_len {
                let orig_pos = (i as f32 / factor) as f64;
                result.push(sample_at(&samples[start..end.min(samples.len())], orig_pos));
            }

            result.extend_from_slice(&samples[end.min(samples.len())..]);
            result
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Changes the time/duration by resampling. Factor > 1 makes it longer (slower), < 1 makes it shorter (faster).
pub fn adjust_time(
    audio: &DecodedAudio,
    start: usize,
    end: usize,
    factor: f32,
) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }
    if factor <= 0.0 {
        return Err("time factor must be positive".to_string());
    }

    let selected_len = (end - start) as f32 * factor;
    let new_len = selected_len.round() as usize;
    if new_len == 0 {
        return Err("result would be empty".to_string());
    }

    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            let mut result = Vec::new();
            result.extend_from_slice(&samples[..start]);

            // Resample the selected range (inverse of pitch: lower factor = slower)
            for i in 0..new_len {
                let orig_pos = (i as f32 / factor) as f64;
                result.push(sample_at(&samples[start..end.min(samples.len())], orig_pos));
            }

            result.extend_from_slice(&samples[end.min(samples.len())..]);
            result
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Reverses the audio in the range `[start, end)`, playing it backwards.
pub fn reverse_range(audio: &DecodedAudio, start: usize, end: usize) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }

    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            let mut result = samples.to_vec();
            let selected: Vec<f32> = samples[start..end.min(samples.len())].to_vec();
            let reversed: Vec<f32> = selected.iter().rev().copied().collect();
            result.splice(start..end.min(samples.len()), reversed);
            result
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Inverts the amplitude of the audio in the range (flips the waveform vertically).
pub fn invert_range(audio: &DecodedAudio, start: usize, end: usize) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }

    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            samples
                .iter()
                .enumerate()
                .map(|(i, &sample)| {
                    if i >= start && i < end {
                        -sample
                    } else {
                        sample
                    }
                })
                .collect()
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Repeats the range `[start, end)` a given number of times, replacing it in the clip.
pub fn repeat_range(
    audio: &DecodedAudio,
    start: usize,
    end: usize,
    count: u32,
) -> Result<DecodedAudio, String> {
    if end <= start {
        return Err("nothing is selected".to_string());
    }
    if count == 0 {
        return Err("repeat count must be at least 1".to_string());
    }

    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            let selected: Vec<f32> = samples[start.min(samples.len())..end.min(samples.len())]
                .to_vec();
            let mut repeated = Vec::with_capacity(selected.len() * count as usize);
            for _ in 0..count {
                repeated.extend_from_slice(&selected);
            }

            let mut result = Vec::with_capacity(samples.len() - (end - start) + repeated.len());
            result.extend_from_slice(&samples[..start.min(samples.len())]);
            result.extend_from_slice(&repeated);
            result.extend_from_slice(&samples[end.min(samples.len())..]);
            result
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Fills the gap `[fill_start, fill_end)` by repeating audio from `[source_start, source_end)`.
pub fn fill_range(
    audio: &DecodedAudio,
    fill_start: usize,
    fill_end: usize,
    source_start: usize,
    source_end: usize,
) -> Result<DecodedAudio, String> {
    if fill_end <= fill_start {
        return Err("fill range is empty".to_string());
    }
    if source_end <= source_start {
        return Err("source range is empty".to_string());
    }

    let total = audio.frame_count();
    let fill_start = fill_start.min(total);
    let fill_end = fill_end.clamp(fill_start, total);
    let source_start = source_start.min(total);
    let source_end = source_end.clamp(source_start, total);

    let gap_len = fill_end - fill_start;
    let source_len = source_end - source_start;

    let channels = audio
        .channels
        .iter()
        .map(|samples| {
            let source = &samples[source_start..source_end.min(samples.len())];

            let mut filled = Vec::with_capacity(gap_len);
            for i in 0..gap_len {
                filled.push(source[i % source_len]);
            }

            let mut result =
                Vec::with_capacity(samples.len() - (fill_end - fill_start) + filled.len());
            result.extend_from_slice(&samples[..fill_start.min(samples.len())]);
            result.extend_from_slice(&filled);
            result.extend_from_slice(&samples[fill_end.min(samples.len())..]);
            result
        })
        .collect();

    Ok(DecodedAudio {
        channels,
        sample_rate: audio.sample_rate,
        codec: audio.codec.clone(),
        bits_per_sample: audio.bits_per_sample,
    })
}

/// Reshapes a clip to `sample_rate` and `channel_count`, so audio copied from
/// one file can be pasted into another. Mono spreads to every channel, many
/// channels fold down to mono by averaging, and anything else maps channel to
/// channel, repeating the last one if the target has more.
fn conform(audio: &DecodedAudio, sample_rate: u32, channel_count: usize) -> Vec<Vec<f32>> {
    let source_count = audio.channel_count();
    let mapped: Vec<Vec<f32>> = if channel_count == 1 && source_count > 1 {
        let frames = audio.frame_count();
        vec![(0..frames)
            .map(|i| audio.channels.iter().map(|c| c[i]).sum::<f32>() / source_count as f32)
            .collect()]
    } else {
        (0..channel_count)
            .map(|c| audio.channels[c.min(source_count - 1)].clone())
            .collect()
    };

    if audio.sample_rate == sample_rate {
        return mapped;
    }

    let ratio = audio.sample_rate as f64 / sample_rate as f64;
    let frames = (audio.frame_count() as f64 / ratio).round() as usize;
    mapped
        .iter()
        .map(|samples| (0..frames).map(|i| sample_at(samples, i as f64 * ratio)).collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(frames: usize) -> DecodedAudio {
        let samples: Vec<f32> = (0..frames).map(|i| i as f32).collect();
        DecodedAudio {
            channels: vec![samples.clone(), samples],
            sample_rate: 1000,
            codec: "test".into(),
            bits_per_sample: None,
        }
    }

    #[test]
    fn delete_closes_the_gap_on_every_channel() {
        let edited = delete_range(&ramp(10), 3, 6).unwrap();
        assert_eq!(edited.frame_count(), 7);
        assert_eq!(edited.channels[0], vec![0.0, 1.0, 2.0, 6.0, 7.0, 8.0, 9.0]);
        assert_eq!(edited.channels[1], edited.channels[0]);
    }

    #[test]
    fn crop_keeps_only_the_selection() {
        let edited = crop_range(&ramp(10), 4, 7).unwrap();
        assert_eq!(edited.frame_count(), 3);
        assert_eq!(edited.channels[0], vec![4.0, 5.0, 6.0]);
    }

    #[test]
    fn an_empty_selection_is_rejected() {
        assert!(delete_range(&ramp(10), 5, 5).is_err());
        assert!(crop_range(&ramp(10), 5, 5).is_err());
    }

    #[test]
    fn deleting_everything_is_refused_rather_than_leaving_an_empty_clip() {
        assert!(delete_range(&ramp(10), 0, 10).is_err());
    }

    #[test]
    fn paste_inserts_or_replaces_on_every_channel() {
        let clip = copy_range(&ramp(10), 7, 9).unwrap();
        assert_eq!(clip.channels[0], vec![7.0, 8.0]);

        let inserted = paste_range(&ramp(5), 2, 2, &clip).unwrap();
        assert_eq!(inserted.channels[0], vec![0.0, 1.0, 7.0, 8.0, 2.0, 3.0, 4.0]);
        assert_eq!(inserted.channels[1], inserted.channels[0]);

        let replaced = paste_range(&ramp(5), 1, 4, &clip).unwrap();
        assert_eq!(replaced.channels[0], vec![0.0, 7.0, 8.0, 4.0]);
    }

    #[test]
    fn paste_converts_rate_and_channels_to_the_target() {
        let target = ramp(4); // stereo at 1 kHz
        let mono_at_2k = DecodedAudio {
            channels: vec![vec![0.5; 8]],
            sample_rate: 2000,
            codec: "test".into(),
            bits_per_sample: None,
        };

        let pasted = paste_range(&target, 4, 4, &mono_at_2k).unwrap();
        assert_eq!(pasted.channel_count(), 2);
        assert_eq!(pasted.frame_count(), 8, "8 frames at 2 kHz is 4 frames at 1 kHz");
        assert_eq!(pasted.channels[1][6], 0.5);

        let mut mono_target = ramp(2);
        mono_target.channels.truncate(1);
        let stereo = DecodedAudio {
            channels: vec![vec![1.0; 2], vec![0.0; 2]],
            sample_rate: 1000,
            codec: "test".into(),
            bits_per_sample: None,
        };
        let folded = paste_range(&mono_target, 0, 0, &stereo).unwrap();
        assert_eq!(folded.channels, vec![vec![0.5, 0.5, 0.0, 1.0]]);
    }

    #[test]
    fn time_maps_to_frames_and_stays_inside_the_clip() {
        let audio = ramp(1000); // 1s at 1 kHz
        assert_eq!(frame_range(&audio, 0.25, 0.75), (250, 750));
        assert_eq!(frame_range(&audio, -5.0, 99.0), (0, 1000));
    }

    #[test]
    fn repeat_range_repeats_selection() {
        let audio = ramp(5); // [0, 1, 2, 3, 4]
        let repeated = repeat_range(&audio, 1, 3, 2).unwrap(); // repeat [1, 2] twice
        assert_eq!(repeated.channels[0], vec![0.0, 1.0, 2.0, 1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn repeat_range_rejects_empty_selection() {
        let audio = ramp(5);
        assert!(repeat_range(&audio, 2, 2, 1).is_err());
    }

    #[test]
    fn repeat_range_rejects_zero_count() {
        let audio = ramp(5);
        assert!(repeat_range(&audio, 1, 3, 0).is_err());
    }

    #[test]
    fn fill_range_fills_gap_with_repeated_source() {
        let audio = ramp(10); // [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        let filled = fill_range(&audio, 2, 5, 0, 2).unwrap(); // fill [2,5) with [0,2) repeated
        assert_eq!(filled.channels[0], vec![0.0, 1.0, 0.0, 1.0, 0.0, 5.0, 6.0, 7.0, 8.0, 9.0]);
    }

    #[test]
    fn fill_range_rejects_empty_gap() {
        let audio = ramp(5);
        assert!(fill_range(&audio, 2, 2, 0, 2).is_err());
    }

    #[test]
    fn fill_range_rejects_empty_source() {
        let audio = ramp(5);
        assert!(fill_range(&audio, 1, 3, 2, 2).is_err());
    }
}
