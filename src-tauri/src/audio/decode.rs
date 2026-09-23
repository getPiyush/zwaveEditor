//! Decoding of arbitrary audio files into planar f32 sample buffers.
//!
//! Everything downstream (peaks, playback, editing) works on planar f32, so this
//! is the single place that has to know about container and codec specifics.

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// A fully decoded audio file held in memory, one `Vec<f32>` per channel.
pub struct DecodedAudio {
    pub channels: Vec<Vec<f32>>,
    pub sample_rate: u32,
    pub codec: String,
    pub bits_per_sample: Option<u32>,
}

impl DecodedAudio {
    pub fn frame_count(&self) -> usize {
        self.channels.first().map_or(0, |c| c.len())
    }

    pub fn channel_count(&self) -> usize {
        self.channels.len()
    }

    pub fn duration_secs(&self) -> f64 {
        if self.sample_rate == 0 {
            return 0.0;
        }
        self.frame_count() as f64 / self.sample_rate as f64
    }
}

pub fn decode_file(path: &Path) -> Result<DecodedAudio, String> {
    let file = File::open(path).map_err(|e| format!("could not open file: {e}"))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    // The extension is only a hint; symphonia still probes the actual bytes.
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("unsupported or corrupt audio file: {e}"))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "file contains no decodable audio track".to_string())?;

    let track_id = track.id;
    let params = track.codec_params.clone();

    let codec = symphonia::default::get_codecs()
        .get_codec(params.codec)
        .map(|d| d.short_name.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| format!("no decoder available for this format: {e}"))?;

    let mut sample_rate = params.sample_rate.unwrap_or(0);
    let mut channels: Vec<Vec<f32>> = Vec::new();
    // Reused across packets; allocated once the first decoded frame reveals the spec.
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Clean end of stream.
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("error reading audio stream: {e}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                if sample_rate == 0 {
                    sample_rate = spec.rate;
                }
                if channels.is_empty() {
                    channels = vec![Vec::new(); spec.channels.count()];
                }

                let buf = sample_buf.get_or_insert_with(|| {
                    SampleBuffer::<f32>::new(decoded.capacity() as u64, spec)
                });
                buf.copy_interleaved_ref(decoded);

                let n = channels.len();
                for (i, sample) in buf.samples().iter().enumerate() {
                    channels[i % n].push(*sample);
                }
            }
            // Recoverable: a damaged packet should not sink the whole import.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(e) => return Err(format!("error decoding audio: {e}")),
        }
    }

    if channels.is_empty() || channels[0].is_empty() {
        return Err("file decoded to zero audio frames".to_string());
    }

    Ok(DecodedAudio {
        channels,
        sample_rate,
        codec,
        bits_per_sample: params.bits_per_sample,
    })
}
