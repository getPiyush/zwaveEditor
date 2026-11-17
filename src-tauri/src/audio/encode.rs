//! Compressed and lossless export formats: FLAC, MP3, AAC and Ogg Vorbis.
//!
//! Every encoder takes planar `f32` channels in -1..1, like `write_wav`.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::num::{NonZeroU32, NonZeroU8};
use std::path::Path;

use serde::Deserialize;

use super::engine::sample_at;
use super::export::{write_wav, BitDepth};

/// What an export is written as. Sent by the UI as `{ kind, ... }`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExportFormat {
    Wav { bit_depth: BitDepth },
    /// Lossless. 32-bit float is written as 24-bit, FLAC has no float samples.
    Flac { bit_depth: BitDepth },
    /// Constant bitrate, in kbit/s.
    Mp3 { kbps: u32 },
    /// AAC-LC in an ADTS stream, constant bitrate in kbit/s.
    Aac { kbps: u32 },
    /// Ogg Vorbis, quality-based VBR. `quality` runs from -0.1 to 1.0.
    Ogg { quality: f32 },
}

impl ExportFormat {
    /// The file extension, without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Wav { .. } => "wav",
            ExportFormat::Flac { .. } => "flac",
            ExportFormat::Mp3 { .. } => "mp3",
            ExportFormat::Aac { .. } => "aac",
            ExportFormat::Ogg { .. } => "ogg",
        }
    }
}

/// Writes `channels` to `path` in `format`.
pub fn write_audio(
    path: &Path,
    channels: &[Vec<f32>],
    sample_rate: u32,
    format: ExportFormat,
) -> Result<(), String> {
    if channels.is_empty() || channels[0].is_empty() {
        return Err("there is no audio to write".to_string());
    }
    match format {
        ExportFormat::Wav { bit_depth } => write_wav(path, channels, sample_rate, bit_depth),
        ExportFormat::Flac { bit_depth } => write_flac(path, channels, sample_rate, bit_depth),
        ExportFormat::Mp3 { kbps } => write_mp3(path, &at_most_stereo(channels), sample_rate, kbps),
        ExportFormat::Aac { kbps } => write_aac(path, &at_most_stereo(channels), sample_rate, kbps),
        ExportFormat::Ogg { quality } => write_ogg(path, channels, sample_rate, quality),
    }
}

/// MP3 and AAC only carry mono or stereo; anything wider keeps its first two channels.
fn at_most_stereo(channels: &[Vec<f32>]) -> Vec<Vec<f32>> {
    let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    channels
        .iter()
        .take(2)
        .map(|c| c[..frames].to_vec())
        .collect()
}

/// Linear-interpolation resample, for rates an encoder cannot take.
fn resample(channels: &[Vec<f32>], from: u32, to: u32) -> Vec<Vec<f32>> {
    if from == to {
        return channels.to_vec();
    }
    let frames = channels[0].len();
    let out_frames = (frames as f64 * to as f64 / from as f64).round() as usize;
    let step = from as f64 / to as f64;
    channels
        .iter()
        .map(|c| (0..out_frames).map(|i| sample_at(c, i as f64 * step)).collect())
        .collect()
}

fn create(path: &Path) -> Result<BufWriter<File>, String> {
    File::create(path)
        .map(BufWriter::new)
        .map_err(|e| format!("could not create file: {e}"))
}

fn write_err(e: std::io::Error) -> String {
    format!("could not write audio: {e}")
}

fn write_flac(
    path: &Path,
    channels: &[Vec<f32>],
    sample_rate: u32,
    depth: BitDepth,
) -> Result<(), String> {
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;

    let (bits, scale) = match depth {
        BitDepth::Int16 => (16, i16::MAX as f32),
        BitDepth::Int24 | BitDepth::Float32 => (24, 8_388_607.0),
    };
    let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    let mut interleaved = Vec::with_capacity(frames * channels.len());
    for frame in 0..frames {
        for channel in channels {
            interleaved.push((channel[frame].clamp(-1.0, 1.0) * scale) as i32);
        }
    }

    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|(_, e)| format!("could not set up the FLAC encoder: {e:?}"))?;
    let source = flacenc::source::MemSource::from_samples(
        &interleaved,
        channels.len(),
        bits,
        sample_rate as usize,
    );
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| format!("could not encode FLAC: {e:?}"))?;

    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|e| format!("could not encode FLAC: {e:?}"))?;
    let mut bytes = sink.as_slice().to_vec();
    // flacenc records the short final block as the minimum block size, which
    // the spec says to leave out and which decoders such as Symphonia reject.
    // Blocks are fixed-size, so minimum = maximum. STREAMINFO follows the
    // 4-byte "fLaC" marker and a 4-byte block header.
    if bytes.len() >= 12 && &bytes[..4] == b"fLaC" {
        let (min, max) = bytes[8..12].split_at_mut(2);
        min.copy_from_slice(max);
    }
    std::fs::write(path, bytes).map_err(write_err)
}

fn mp3_bitrate(kbps: u32) -> mp3lame_encoder::Bitrate {
    use mp3lame_encoder::Bitrate::*;
    match kbps {
        0..=96 => Kbps96,
        97..=128 => Kbps128,
        129..=160 => Kbps160,
        161..=192 => Kbps192,
        193..=256 => Kbps256,
        _ => Kbps320,
    }
}

fn write_mp3(path: &Path, channels: &[Vec<f32>], sample_rate: u32, kbps: u32) -> Result<(), String> {
    use mp3lame_encoder::{Builder, DualPcm, FlushNoGap, MonoPcm, Quality};

    // MP3 tops out at 48 kHz.
    let (channels, sample_rate) = if sample_rate > 48_000 {
        let target = if sample_rate.is_multiple_of(44_100) { 44_100 } else { 48_000 };
        (resample(channels, sample_rate, target), target)
    } else {
        (channels.to_vec(), sample_rate)
    };

    let fail = |e: mp3lame_encoder::BuildError| format!("could not set up the MP3 encoder: {e}");
    let mut encoder = Builder::new()
        .ok_or("could not set up the MP3 encoder")?
        .with_num_channels(channels.len() as u8)
        .map_err(fail)?
        .with_sample_rate(sample_rate)
        .map_err(fail)?
        .with_brate(mp3_bitrate(kbps))
        .map_err(fail)?
        .with_quality(Quality::NearBest)
        .map_err(fail)?
        .build()
        .map_err(fail)?;

    let mut out = create(path)?;
    let mut buffer = Vec::new();
    const CHUNK: usize = 1152 * 32;
    let frames = channels[0].len();
    let mut start = 0;
    while start < frames {
        let end = (start + CHUNK).min(frames);
        buffer.clear();
        buffer.reserve(mp3_buffer_size(end - start));
        let result = if channels.len() == 1 {
            encoder.encode_to_vec(MonoPcm(&channels[0][start..end]), &mut buffer)
        } else {
            let input = DualPcm {
                left: &channels[0][start..end],
                right: &channels[1][start..end],
            };
            encoder.encode_to_vec(input, &mut buffer)
        };
        result.map_err(|e| format!("could not encode MP3: {e}"))?;
        out.write_all(&buffer).map_err(write_err)?;
        start = end;
    }

    buffer.clear();
    buffer.reserve(mp3_buffer_size(0));
    encoder
        .flush_to_vec::<FlushNoGap>(&mut buffer)
        .map_err(|e| format!("could not encode MP3: {e}"))?;
    out.write_all(&buffer).map_err(write_err)?;
    out.flush().map_err(write_err)
}

/// LAME's documented worst case: 1.25 × samples + 7200 bytes.
fn mp3_buffer_size(samples: usize) -> usize {
    samples * 5 / 4 + 7200
}

fn write_aac(path: &Path, channels: &[Vec<f32>], sample_rate: u32, kbps: u32) -> Result<(), String> {
    use fdk_aac::enc::{AudioObjectType, BitRate, ChannelMode, Encoder, EncoderParams, Transport};

    // AAC tops out at 96 kHz.
    let (channels, sample_rate) = if sample_rate > 96_000 {
        let target = if sample_rate.is_multiple_of(44_100) { 88_200 } else { 96_000 };
        (resample(channels, sample_rate, target), target)
    } else {
        (channels.to_vec(), sample_rate)
    };
    let count = channels.len();

    let encoder = Encoder::new(EncoderParams {
        bit_rate: BitRate::Cbr(kbps.clamp(32, 320) * 1000),
        sample_rate,
        transport: Transport::Adts,
        channels: if count == 1 { ChannelMode::Mono } else { ChannelMode::Stereo },
        audio_object_type: AudioObjectType::Mpeg4LowComplexity,
    })
    .map_err(|e| format!("could not set up the AAC encoder at {sample_rate} Hz: {e}"))?;
    let info = encoder
        .info()
        .map_err(|e| format!("could not set up the AAC encoder: {e}"))?;
    let frame_length = info.frameLength as usize;

    // The wrapper cannot signal end-of-stream, so pad with enough silence to
    // push the encoder's look-ahead and the last partial frame out.
    let padding = info.nDelay as usize + 2 * frame_length;
    let frames = channels[0].len();
    let mut pcm = Vec::with_capacity((frames + padding) * count);
    for frame in 0..frames {
        for channel in &channels {
            pcm.push((channel[frame].clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
        }
    }
    pcm.resize((frames + padding) * count, 0);

    let mut out = create(path)?;
    let mut buffer = vec![0u8; (info.maxOutBufBytes as usize).max(8192)];
    let chunk = frame_length * count;
    let mut position = 0;
    while position < pcm.len() {
        let end = (position + chunk).min(pcm.len());
        let result = encoder
            .encode(&pcm[position..end], &mut buffer)
            .map_err(|e| format!("could not encode AAC: {e}"))?;
        out.write_all(&buffer[..result.output_size]).map_err(write_err)?;
        if result.input_consumed == 0 && result.output_size == 0 {
            break;
        }
        position += result.input_consumed;
    }
    out.flush().map_err(write_err)
}

fn write_ogg(path: &Path, channels: &[Vec<f32>], sample_rate: u32, quality: f32) -> Result<(), String> {
    use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};

    let rate = NonZeroU32::new(sample_rate).ok_or("the sample rate is zero")?;
    let count = NonZeroU8::new(channels.len().min(255) as u8).ok_or("there is no audio to write")?;
    let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);

    let mut encoder = VorbisEncoderBuilder::new(rate, count, create(path)?)
        .map_err(|e| format!("could not set up the Ogg Vorbis encoder: {e}"))?
        .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
            target_quality: quality.clamp(-0.1, 1.0),
        })
        .build()
        .map_err(|e| format!("could not set up the Ogg Vorbis encoder: {e}"))?;

    const CHUNK: usize = 4096;
    let mut start = 0;
    while start < frames {
        let end = (start + CHUNK).min(frames);
        let block: Vec<&[f32]> = channels.iter().map(|c| &c[start..end]).collect();
        encoder
            .encode_audio_block(&block)
            .map_err(|e| format!("could not encode Ogg Vorbis: {e}"))?;
        start = end;
    }
    let mut sink = encoder
        .finish()
        .map_err(|e| format!("could not finish the file: {e}"))?;
    sink.flush().map_err(write_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::decode::decode_file;

    fn sine(rate: u32, secs: f64, channels: usize) -> Vec<Vec<f32>> {
        let frames = (rate as f64 * secs) as usize;
        let tone: Vec<f32> = (0..frames)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5)
            .collect();
        vec![tone; channels]
    }

    fn round_trip(name: &str, format: ExportFormat, rate: u32, channels: usize) {
        let dir = std::env::temp_dir().join("zwave-editor-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.{}", format.extension()));

        write_audio(&path, &sine(rate, 1.0, channels), rate, format).unwrap();
        let decoded = decode_file(&path).unwrap();
        assert_eq!(decoded.channel_count(), channels, "{name}: channels");
        let secs = decoded.duration_secs();
        assert!((0.9..1.2).contains(&secs), "{name}: decoded {secs}s, wanted ~1s");
        let peak = decoded.channels[0].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((0.35..0.65).contains(&peak), "{name}: peak {peak}, wanted ~0.5");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn flac_round_trips() {
        round_trip("flac16", ExportFormat::Flac { bit_depth: BitDepth::Int16 }, 44_100, 2);
        round_trip("flac24", ExportFormat::Flac { bit_depth: BitDepth::Float32 }, 48_000, 1);
    }

    #[test]
    fn mp3_round_trips() {
        round_trip("mp3", ExportFormat::Mp3 { kbps: 192 }, 44_100, 2);
        round_trip("mp3-mono", ExportFormat::Mp3 { kbps: 128 }, 48_000, 1);
        // Above MP3's top rate, so it is resampled first.
        round_trip("mp3-96k", ExportFormat::Mp3 { kbps: 320 }, 96_000, 2);
    }

    #[test]
    fn aac_round_trips() {
        round_trip("aac", ExportFormat::Aac { kbps: 192 }, 44_100, 2);
        round_trip("aac-mono", ExportFormat::Aac { kbps: 96 }, 48_000, 1);
    }

    #[test]
    fn ogg_round_trips() {
        round_trip("ogg", ExportFormat::Ogg { quality: 0.5 }, 44_100, 2);
        round_trip("ogg-mono", ExportFormat::Ogg { quality: 0.3 }, 48_000, 1);
    }

    #[test]
    fn format_parses_from_the_ui_shape() {
        let format: ExportFormat =
            serde_json::from_str(r#"{"kind":"flac","bitDepth":"int24"}"#).unwrap();
        assert!(matches!(format, ExportFormat::Flac { bit_depth: BitDepth::Int24 }));
        let format: ExportFormat = serde_json::from_str(r#"{"kind":"mp3","kbps":256}"#).unwrap();
        assert_eq!(format.extension(), "mp3");
    }
}
