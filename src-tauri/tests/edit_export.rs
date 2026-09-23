//! End-to-end: import a file, edit it, undo, and export the result back to disk.

use std::f32::consts::PI;
use std::io::Write;
use std::path::{Path, PathBuf};

use zwave_editor_lib::audio::export::BitDepth;
use zwave_editor_lib::audio::{decode, edit, export, ClipStore};

fn test_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("zwave-editor-tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Writes one second of a 16-bit stereo 1 kHz tone at 44.1 kHz.
fn write_tone(path: &Path) {
    let rate = 44_100u32;
    let frames = rate as usize;
    let data_len = (frames * 2 * 2) as u32;
    let mut file = std::fs::File::create(path).unwrap();

    file.write_all(b"RIFF").unwrap();
    file.write_all(&(36 + data_len).to_le_bytes()).unwrap();
    file.write_all(b"WAVEfmt ").unwrap();
    file.write_all(&16u32.to_le_bytes()).unwrap();
    file.write_all(&1u16.to_le_bytes()).unwrap();
    file.write_all(&2u16.to_le_bytes()).unwrap();
    file.write_all(&rate.to_le_bytes()).unwrap();
    file.write_all(&(rate * 4).to_le_bytes()).unwrap();
    file.write_all(&4u16.to_le_bytes()).unwrap();
    file.write_all(&16u16.to_le_bytes()).unwrap();
    file.write_all(b"data").unwrap();
    file.write_all(&data_len.to_le_bytes()).unwrap();

    for i in 0..frames {
        let value = ((2.0 * PI * 1000.0 * i as f32 / rate as f32).sin() * 0.8 * 32767.0) as i16;
        file.write_all(&value.to_le_bytes()).unwrap();
        file.write_all(&value.to_le_bytes()).unwrap();
    }
}

#[test]
fn edit_then_undo_then_export() {
    let dir = test_dir();
    let source = dir.join("edit-source.wav");
    write_tone(&source);

    let store = ClipStore::default();
    let audio = decode::decode_file(&source).expect("decode");
    let id = store.insert(
        audio,
        "edit-source.wav".to_string(),
        source.to_string_lossy().to_string(),
        0,
    );

    // Delete the middle half second.
    let after_delete = store
        .edit(
            id,
            |audio| {
                let (start, end) = edit::frame_range(audio, 0.25, 0.75);
                edit::delete_range(audio, start, end)
            },
            |entry| entry.audio.duration_secs(),
        )
        .expect("delete should apply");
    assert!((after_delete - 0.5).abs() < 0.01, "got {after_delete}s");
    assert!(store.with(id, |entry| entry.can_undo()).unwrap());
    assert_eq!(store.with(id, |entry| entry.version).unwrap(), 1);

    // Crop what is left down to its first 0.2s.
    let after_crop = store
        .edit(
            id,
            |audio| {
                let (start, end) = edit::frame_range(audio, 0.0, 0.2);
                edit::crop_range(audio, start, end)
            },
            |entry| entry.audio.duration_secs(),
        )
        .expect("crop should apply");
    assert!((after_crop - 0.2).abs() < 0.01, "got {after_crop}s");

    // Undo puts the deleted-only version back.
    let after_undo = store
        .undo(id, |entry| entry.audio.duration_secs())
        .expect("undo should apply");
    assert!((after_undo - 0.5).abs() < 0.01, "got {after_undo}s");

    // Export the edited clip and read it back off disk.
    let destination = dir.join("edit-export.wav");
    let clip = store.audio(id).unwrap();
    export::write_wav(&destination, &clip.channels, clip.sample_rate, BitDepth::Int16)
        .expect("export should write");

    let reimported = decode::decode_file(&destination).expect("exported file should decode");
    assert_eq!(reimported.sample_rate, 44_100);
    assert_eq!(reimported.channel_count(), 2);
    assert!(
        (reimported.duration_secs() - 0.5).abs() < 0.01,
        "exported {}s",
        reimported.duration_secs()
    );

    std::fs::remove_file(&source).ok();
    std::fs::remove_file(&destination).ok();
}

#[test]
fn undo_fails_cleanly_when_there_is_no_history() {
    let dir = test_dir();
    let source = dir.join("no-history.wav");
    write_tone(&source);

    let store = ClipStore::default();
    let audio = decode::decode_file(&source).unwrap();
    let id = store.insert(audio, "no-history.wav".into(), String::new(), 0);

    assert!(store.undo(id, |_| ()).is_err());
    std::fs::remove_file(&source).ok();
}

#[test]
fn a_failed_edit_leaves_the_clip_untouched() {
    let dir = test_dir();
    let source = dir.join("untouched.wav");
    write_tone(&source);

    let store = ClipStore::default();
    let audio = decode::decode_file(&source).unwrap();
    let id = store.insert(audio, "untouched.wav".into(), String::new(), 0);

    // Deleting everything is refused.
    let result = store.edit(
        id,
        |audio| {
            let (start, end) = edit::frame_range(audio, 0.0, 10.0);
            edit::delete_range(audio, start, end)
        },
        |entry| entry.audio.duration_secs(),
    );
    assert!(result.is_err());

    let (duration, version, can_undo) = store
        .with(id, |entry| {
            (entry.audio.duration_secs(), entry.version, entry.can_undo())
        })
        .unwrap();
    assert!((duration - 1.0).abs() < 0.01);
    assert_eq!(version, 0, "a rejected edit must not bump the version");
    assert!(!can_undo, "a rejected edit must not push history");

    std::fs::remove_file(&source).ok();
}
