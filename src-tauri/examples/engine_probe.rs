//! Checks that this machine's audio output actually drives the mixer.
//!
//!     cargo run --example engine_probe -- some-file.wav
//!
//! The track is muted, so the probe is silent: what it proves is that the
//! device opened and that its callback advances the playhead in real time.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use zwave_editor_lib::audio::decode;
use zwave_editor_lib::audio::engine::{AudioEngine, Track};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: engine_probe <audio file>");

    let audio = Arc::new(decode::decode_file(Path::new(&path)).expect("failed to decode"));
    println!(
        "decoded {} — {:.3}s, {} ch, {} Hz",
        path,
        audio.duration_secs(),
        audio.channel_count(),
        audio.sample_rate
    );

    let engine = AudioEngine::new();

    // The device opens on its own thread; give it a moment to come up.
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && !engine.status().ready {
        if let Some(error) = engine.status().error {
            eprintln!("audio output unavailable: {error}");
            std::process::exit(1);
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let status = engine.status();
    if !status.ready {
        eprintln!("audio output did not start within 3s");
        std::process::exit(1);
    }
    println!("output stream open at {} Hz", status.sample_rate);

    engine.mixer.set_tracks(vec![Track {
        audio,
        gain: 1.0,
        muted: true, // silent probe
        offset_secs: 0.0,
    }]);

    engine.mixer.play();
    let started = Instant::now();
    std::thread::sleep(Duration::from_millis(600));
    let played = engine.mixer.position();
    let elapsed = started.elapsed().as_secs_f64();

    engine.mixer.pause();
    std::thread::sleep(Duration::from_millis(100));
    let after_pause = engine.mixer.position();

    println!("playhead after {elapsed:.3}s of wall clock: {played:.3}s");
    println!("playhead 100ms after pause: {after_pause:.3}s");

    let drift = (played - elapsed).abs();
    assert!(drift < 0.15, "playhead drifted {drift:.3}s from real time");
    assert!(
        (after_pause - played).abs() < 0.05,
        "playhead kept moving after pause"
    );
    println!("OK: output stream is live and the playhead tracks real time");
}
