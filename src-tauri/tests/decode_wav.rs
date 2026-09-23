//! End-to-end check: a real file on disk decodes to the samples we expect.

use std::f32::consts::PI;
use std::io::Write;

use zwave_editor_lib::audio::{decode, peaks};

/// Writes a 16-bit stereo WAV: left is a 1 kHz sine, right is silence.
fn write_test_wav(path: &std::path::Path, frames: usize, rate: u32) {
    let data_len = (frames * 2 * 2) as u32;
    let mut file = std::fs::File::create(path).unwrap();

    file.write_all(b"RIFF").unwrap();
    file.write_all(&(36 + data_len).to_le_bytes()).unwrap();
    file.write_all(b"WAVEfmt ").unwrap();
    file.write_all(&16u32.to_le_bytes()).unwrap();
    file.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
    file.write_all(&2u16.to_le_bytes()).unwrap(); // channels
    file.write_all(&rate.to_le_bytes()).unwrap();
    file.write_all(&(rate * 4).to_le_bytes()).unwrap(); // byte rate
    file.write_all(&4u16.to_le_bytes()).unwrap(); // block align
    file.write_all(&16u16.to_le_bytes()).unwrap(); // bits per sample
    file.write_all(b"data").unwrap();
    file.write_all(&data_len.to_le_bytes()).unwrap();

    for i in 0..frames {
        let t = i as f32 / rate as f32;
        let left = (2.0 * PI * 1000.0 * t).sin() * 0.8;
        file.write_all(&((left * 32767.0) as i16).to_le_bytes()).unwrap();
        file.write_all(&0i16.to_le_bytes()).unwrap();
    }
}

#[test]
fn decodes_wav_into_planar_channels_and_peaks() {
    let dir = std::env::temp_dir().join("zwave-editor-tests");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tone.wav");
    write_test_wav(&path, 44_100, 44_100);

    let audio = decode::decode_file(&path).expect("wav should decode");

    assert_eq!(audio.channel_count(), 2);
    assert_eq!(audio.sample_rate, 44_100);
    assert_eq!(audio.frame_count(), 44_100);
    assert!((audio.duration_secs() - 1.0).abs() < 1e-6);

    // Left holds the tone at roughly 0.8 peak; right was written silent.
    let left = peaks::compute(&audio.channels[0], 0, audio.frame_count(), 10);
    assert!(left[1] > 0.7 && left[1] <= 0.81, "unexpected peak {}", left[1]);
    assert!(left[0] < -0.7);

    let right = peaks::compute(&audio.channels[1], 0, audio.frame_count(), 10);
    assert!(right.iter().all(|v| v.abs() < 1e-6));

    std::fs::remove_file(&path).ok();
}

#[test]
fn rejects_a_file_that_is_not_audio() {
    let dir = std::env::temp_dir().join("zwave-editor-tests");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("not-audio.wav");
    std::fs::write(&path, b"this is definitely not a wav file").unwrap();

    assert!(decode::decode_file(&path).is_err());
    std::fs::remove_file(&path).ok();
}
