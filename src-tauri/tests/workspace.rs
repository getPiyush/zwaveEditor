//! The workspace on disk: the tunes library, and saving and reopening projects.

use std::path::PathBuf;
use std::sync::Arc;

use zwave_editor_lib::audio::decode::{self, DecodedAudio};
use zwave_editor_lib::workspace::{self, ProjectTrack, Workspace};

/// A fresh, empty directory for one test.
fn test_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("zwave-editor-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn track(name: &str, offset_secs: f64) -> ProjectTrack {
    ProjectTrack {
        name: name.to_string(),
        file: String::new(),
        gain: 0.5,
        muted: false,
        soloed: false,
        in_master: true,
        offset_secs,
    }
}

fn ramp(frames: usize, rate: u32) -> Arc<DecodedAudio> {
    let samples: Vec<f32> = (0..frames).map(|i| i as f32 / frames as f32 - 0.5).collect();
    Arc::new(DecodedAudio {
        channels: vec![samples.clone(), samples],
        sample_rate: rate,
        codec: "test".into(),
        bits_per_sample: None,
    })
}

#[test]
fn the_workspace_defaults_until_one_is_chosen_and_remembers_the_choice() {
    let dir = test_dir("workspace-setting");
    let settings = dir.join("config").join("settings.json");
    let default_root = dir.join("default");
    let chosen = dir.join("chosen");

    let workspace = Workspace::load(settings.clone(), default_root.clone());
    assert!(workspace.is_default());
    assert_eq!(workspace.tunes_dir(), default_root.join("tunes"));
    assert!(!default_root.exists(), "pointing at a workspace creates nothing");

    workspace.set_root(Some(chosen.clone())).unwrap();
    assert_eq!(workspace.root(), chosen);

    let reloaded = Workspace::load(settings.clone(), default_root.clone());
    assert!(!reloaded.is_default());
    assert_eq!(reloaded.projects_dir(), chosen.join("projects"));

    reloaded.set_root(None).unwrap();
    assert!(Workspace::load(settings, default_root).is_default());
}

#[test]
fn tunes_are_copied_in_listed_and_removed() {
    let dir = test_dir("tunes");
    let tunes = dir.join("workspace").join("tunes");
    let source = dir.join("loop.mp3");
    std::fs::write(&source, b"first").unwrap();

    assert!(workspace::list_tunes(&tunes).is_empty());

    let copied = workspace::add_tune(&tunes, &source).unwrap();
    assert_eq!(copied, tunes.join("loop.mp3"));
    // Adding the same file again does not duplicate it...
    assert_eq!(workspace::add_tune(&tunes, &source).unwrap(), copied);

    // ...but a different file of the same name is kept beside it.
    std::fs::write(&source, b"a second, longer file").unwrap();
    assert_eq!(workspace::add_tune(&tunes, &source).unwrap(), tunes.join("loop-2.mp3"));

    let names: Vec<String> = workspace::list_tunes(&tunes).into_iter().map(|t| t.name).collect();
    assert_eq!(names, ["loop-2.mp3", "loop.mp3"]);

    workspace::remove_tune(&tunes, "loop.mp3").unwrap();
    assert!(!copied.exists());
    assert!(source.exists(), "the original is never touched");
    assert!(workspace::remove_tune(&tunes, "../loop.mp3").is_err());
    assert!(workspace::remove_tune(&tunes, "loop.mp3").is_err());
}

#[test]
fn a_project_round_trips_and_saving_again_replaces_it() {
    let projects = test_dir("projects").join("projects");

    let saved = workspace::save_project(
        &projects,
        "  my: song ",
        vec![(track("drums.mp3", 0.0), ramp(4_410, 44_100)), (track("take 2", 1.5), ramp(480, 48_000))],
    )
    .unwrap();
    assert_eq!(saved, projects.join("my- song"));

    let listed = workspace::list_projects(&projects);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "my- song");
    assert_eq!(listed[0].track_count, 2);

    let (project, dir) = workspace::read_project(&projects, "my- song").unwrap();
    assert_eq!(project.tracks[1].name, "take 2");
    assert_eq!(project.tracks[1].offset_secs, 1.5);
    assert_eq!(project.tracks[1].gain, 0.5);

    let original = ramp(4_410, 44_100);
    let audio = decode::decode_file(&dir.join(&project.tracks[0].file)).unwrap();
    assert_eq!(audio.sample_rate, 44_100);
    assert_eq!(audio.channels, original.channels, "float WAV keeps every sample");

    workspace::save_project(&projects, "my- song", vec![(track("only", 0.0), ramp(480, 48_000))])
        .unwrap();
    let (project, dir) = workspace::read_project(&projects, "my- song").unwrap();
    assert_eq!(project.tracks.len(), 1);
    assert!(!dir.join("audio/track-02.wav").exists(), "the old audio is gone");
    assert_eq!(workspace::list_projects(&projects).len(), 1, "no staging folder is left behind");

    assert!(workspace::save_project(&projects, " .. ", vec![(track("x", 0.0), ramp(8, 8_000))]).is_err());
    assert!(workspace::read_project(&projects, "../my- song").is_err());
}
