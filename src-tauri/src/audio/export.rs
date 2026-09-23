//! Writing audio back out to disk.

use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;

use super::decode::DecodedAudio;
use super::engine::sample_at;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BitDepth {
    Int16,
    Int24,
    Float32,
}

impl BitDepth {
    fn spec(self) -> (u16, hound::SampleFormat) {
        match self {
            BitDepth::Int16 => (16, hound::SampleFormat::Int),
            BitDepth::Int24 => (24, hound::SampleFormat::Int),
            BitDepth::Float32 => (32, hound::SampleFormat::Float),
        }
    }
}

/// Writes planar channels as an interleaved WAV file.
pub fn write_wav(
    path: &Path,
    channels: &[Vec<f32>],
    sample_rate: u32,
    depth: BitDepth,
) -> Result<(), String> {
    if channels.is_empty() || channels[0].is_empty() {
        return Err("there is no audio to write".to_string());
    }

    let (bits, format) = depth.spec();
    let spec = hound::WavSpec {
        channels: channels.len() as u16,
        sample_rate,
        bits_per_sample: bits,
        sample_format: format,
    };

    let mut writer =
        hound::WavWriter::create(path, spec).map_err(|e| format!("could not create file: {e}"))?;
    let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);

    for frame in 0..frames {
        for channel in channels {
            let value = channel[frame].clamp(-1.0, 1.0);
            let result = match depth {
                BitDepth::Float32 => writer.write_sample(value),
                BitDepth::Int16 => writer.write_sample((value * i16::MAX as f32) as i16),
                // hound writes the low 24 bits of an i32 when bits_per_sample is 24.
                BitDepth::Int24 => writer.write_sample((value * 8_388_607.0) as i32),
            };
            result.map_err(|e| format!("could not write audio: {e}"))?;
        }
    }

    writer
        .finalize()
        .map_err(|e| format!("could not finish the file: {e}"))?;
    Ok(())
}

/// One track going into the master: its audio, gain and start offset in seconds.
pub type MasterSource = (Arc<DecodedAudio>, f32, f64);

/// Sums tracks into one stereo buffer at `sample_rate`, exactly as the mixer
/// would play them: each starting at its offset, resampled to the target rate.
pub fn render_master(tracks: &[MasterSource], sample_rate: u32) -> Vec<Vec<f32>> {
    let duration = tracks
        .iter()
        .map(|(audio, _, offset)| offset + audio.duration_secs())
        .fold(0.0f64, f64::max);
    let frames = (duration * sample_rate as f64).round() as usize;

    let mut left = vec![0.0f32; frames];
    let mut right = vec![0.0f32; frames];

    for (audio, gain, offset) in tracks {
        let source_rate = audio.sample_rate as f64;
        // Nothing to read before the track starts.
        let first = ((offset * sample_rate as f64).floor() as usize).min(frames);
        for frame in first..frames {
            let position = (frame as f64 / sample_rate as f64 - offset) * source_rate;
            let l = sample_at(&audio.channels[0], position);
            let r = if audio.channels.len() > 1 {
                sample_at(&audio.channels[1], position)
            } else {
                l
            };
            left[frame] += l * gain;
            right[frame] += r * gain;
        }
    }

    for sample in left.iter_mut().chain(right.iter_mut()) {
        *sample = sample.clamp(-1.0, 1.0);
    }

    vec![left, right]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant(value: f32, secs: f64, rate: u32) -> Arc<DecodedAudio> {
        let frames = (secs * rate as f64) as usize;
        Arc::new(DecodedAudio {
            channels: vec![vec![value; frames], vec![value; frames]],
            sample_rate: rate,
            codec: "test".into(),
            bits_per_sample: None,
        })
    }

    #[test]
    fn master_sums_tracks_and_spans_the_longest_one() {
        let rendered = render_master(
            &[
                (constant(0.25, 1.0, 44_100), 1.0, 0.0),
                (constant(0.25, 2.0, 48_000), 1.0, 0.0),
            ],
            48_000,
        );

        assert_eq!(rendered.len(), 2);
        assert_eq!(rendered[0].len(), 96_000, "should span the 2s track");
        // Both playing in the first second, only the longer one after.
        assert!((rendered[0][1000] - 0.5).abs() < 1e-3);
        assert!((rendered[0][90_000] - 0.25).abs() < 1e-3);
    }

    #[test]
    fn master_applies_gain_and_clamps_the_sum() {
        let rendered = render_master(
            &[
                (constant(1.0, 0.1, 48_000), 1.0, 0.0),
                (constant(1.0, 0.1, 48_000), 1.0, 0.0),
            ],
            48_000,
        );
        assert!((rendered[0][10] - 1.0).abs() < 1e-6, "summed peaks must clamp");

        let quiet = render_master(&[(constant(1.0, 0.1, 48_000), 0.25, 0.0)], 48_000);
        assert!((quiet[0][10] - 0.25).abs() < 1e-6);
    }

    #[test]
    fn master_places_each_track_at_its_offset() {
        let rendered = render_master(&[(constant(0.25, 1.0, 48_000), 1.0, 0.5)], 48_000);

        assert_eq!(rendered[0].len(), 72_000, "0.5s offset + 1s of audio");
        assert_eq!(rendered[0][10_000], 0.0, "silent before the offset");
        assert!((rendered[0][30_000] - 0.25).abs() < 1e-3);
        assert!((rendered[0][71_000] - 0.25).abs() < 1e-3);
    }

    #[test]
    fn written_wav_reads_back_with_the_same_shape_and_values() {
        let dir = std::env::temp_dir().join("zwave-editor-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("export.wav");

        let channels = vec![vec![0.5f32; 2000], vec![-0.5f32; 2000]];
        write_wav(&path, &channels, 44_100, BitDepth::Int16).unwrap();

        let decoded = super::super::decode::decode_file(&path).unwrap();
        assert_eq!(decoded.sample_rate, 44_100);
        assert_eq!(decoded.channel_count(), 2);
        assert_eq!(decoded.frame_count(), 2000);
        assert!((decoded.channels[0][100] - 0.5).abs() < 1e-3);
        assert!((decoded.channels[1][100] + 0.5).abs() < 1e-3);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn float_export_round_trips_too() {
        let dir = std::env::temp_dir().join("zwave-editor-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("export-float.wav");

        let channels = vec![vec![0.123_456_79f32; 500]];
        write_wav(&path, &channels, 48_000, BitDepth::Float32).unwrap();

        let decoded = super::super::decode::decode_file(&path).unwrap();
        assert_eq!(decoded.channel_count(), 1);
        assert!((decoded.channels[0][10] - 0.123_456_79).abs() < 1e-6);

        std::fs::remove_file(&path).ok();
    }
}
