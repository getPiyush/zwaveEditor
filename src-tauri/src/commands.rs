//! Tauri commands: the whole surface the UI talks to.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::audio::engine::{AudioEngine, Preview, Track};
use crate::audio::export::BitDepth;
use crate::audio::master::MasterBus;
use crate::audio::pattern::{self, Pattern};
use crate::audio::recording::Recorder;
use crate::audio::{decode, edit, export, peaks, ClipEntry, ClipStore, Clipboard};
use crate::workspace::{self, ProjectSummary, ProjectTrack, TuneInfo, Workspace};

/// Everything the UI needs to describe an imported file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub sample_rate: u32,
    pub channel_count: usize,
    pub frame_count: usize,
    pub duration_secs: f64,
    pub codec: String,
    pub bits_per_sample: Option<u32>,
    pub file_size_bytes: u64,
    /// Bumped on every edit; the UI refetches peaks when it changes.
    pub version: u32,
    pub can_undo: bool,
}

fn clip_info(id: u64, entry: &ClipEntry) -> ClipInfo {
    ClipInfo {
        id,
        name: entry.name.clone(),
        path: entry.path.clone(),
        sample_rate: entry.audio.sample_rate,
        channel_count: entry.audio.channel_count(),
        frame_count: entry.audio.frame_count(),
        duration_secs: entry.audio.duration_secs(),
        codec: entry.audio.codec.clone(),
        bits_per_sample: entry.audio.bits_per_sample,
        file_size_bytes: entry.file_size_bytes,
        version: entry.version,
        can_undo: entry.can_undo(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakData {
    pub clip_id: u64,
    pub start_frame: usize,
    pub end_frame: usize,
    pub width: usize,
    /// One flat `[min, max, rms, ...]` array per channel.
    pub channels: Vec<Vec<f32>>,
}

/// One track's contribution to the mix, as the UI has it staged.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSetting {
    pub clip_id: u64,
    pub gain: f32,
    pub muted: bool,
    /// Where the track starts on the session timeline, in seconds.
    #[serde(default)]
    pub offset_secs: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportState {
    pub playing: bool,
    pub position_secs: f64,
    pub duration_secs: f64,
    /// False when no output device could be opened; `error` says why.
    pub ready: bool,
    pub error: Option<String>,
    pub output_sample_rate: u32,
}

/// Files given on the command line (`zwaveEditor a.wav b.wav`), pending pickup
/// by the UI on startup.
#[derive(Default)]
pub struct StartupFiles(pub Mutex<Vec<String>>);

impl StartupFiles {
    /// Reads argv, keeping the arguments that name files that exist.
    pub fn from_args() -> Self {
        let paths = std::env::args()
            .skip(1)
            .filter(|arg| !arg.starts_with('-') && Path::new(arg).is_file())
            .collect();
        StartupFiles(Mutex::new(paths))
    }
}

/// Returns the startup files once, then forgets them, so a reload does not
/// reopen everything.
#[tauri::command]
pub fn take_startup_files(startup: State<StartupFiles>) -> Vec<String> {
    std::mem::take(&mut *startup.0.lock().unwrap())
}

#[tauri::command]
pub fn import_audio(path: String, store: State<ClipStore>) -> Result<ClipInfo, String> {
    let path_buf = PathBuf::from(&path);
    let audio = decode::decode_file(&path_buf)?;
    let size = std::fs::metadata(&path_buf).map(|m| m.len()).unwrap_or(0);
    let id = store.insert(audio, file_name(&path_buf), path, size);
    store.with(id, |entry| clip_info(id, entry))
}

#[tauri::command]
pub fn get_peaks(
    clip_id: u64,
    start_frame: usize,
    end_frame: usize,
    width: usize,
    store: State<ClipStore>,
) -> Result<PeakData, String> {
    // Guard against a pathological width; the UI asks for roughly one bucket per pixel.
    let width = width.clamp(1, 8192);

    store.with(clip_id, |entry| {
        let total = entry.audio.frame_count();
        let start = start_frame.min(total);
        let end = end_frame.clamp(start, total);

        PeakData {
            clip_id,
            start_frame: start,
            end_frame: end,
            width,
            channels: entry
                .audio
                .channels
                .iter()
                .map(|samples| peaks::compute(samples, start, end, width))
                .collect(),
        }
    })
}

#[tauri::command]
pub fn close_clip(clip_id: u64, store: State<ClipStore>) {
    store.remove(clip_id);
}

/// Removes the selected span, closing the gap.
#[tauri::command]
pub fn delete_range(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::delete_range(audio, start, end)
        },
        |entry| clip_info(clip_id, entry),
    )
}

/// Keeps only the selected span.
#[tauri::command]
pub fn crop_range(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::crop_range(audio, start, end)
        },
        |entry| clip_info(clip_id, entry),
    )
}

/// Copies the selected span to the clipboard. Returns its length in seconds.
#[tauri::command]
pub fn copy_range(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    store: State<ClipStore>,
    clipboard: State<Clipboard>,
) -> Result<f64, String> {
    let copied = store.with(clip_id, |entry| {
        let (start, end) = edit::frame_range(&entry.audio, start_secs, end_secs);
        edit::copy_range(&entry.audio, start, end)
    })??;
    let duration = copied.duration_secs();
    *clipboard.0.lock().unwrap() = Some(std::sync::Arc::new(copied));
    Ok(duration)
}

/// Replaces the span with the clipboard; an empty span inserts at that point.
#[tauri::command]
pub fn paste_range(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    store: State<ClipStore>,
    clipboard: State<Clipboard>,
) -> Result<ClipInfo, String> {
    let copied = clipboard
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "nothing has been copied yet".to_string())?;
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::paste_range(audio, start, end, &copied)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[tauri::command]
pub fn undo_edit(clip_id: u64, store: State<ClipStore>) -> Result<ClipInfo, String> {
    store.undo(clip_id, |entry| clip_info(clip_id, entry))
}

/// Writes each clip to its own WAV file inside `directory`, at its native rate
/// and channel count. Returns the paths written.
#[tauri::command]
pub fn export_tracks(
    clip_ids: Vec<u64>,
    directory: String,
    bit_depth: BitDepth,
    store: State<ClipStore>,
) -> Result<Vec<String>, String> {
    if clip_ids.is_empty() {
        return Err("no tracks are selected for the master".to_string());
    }

    let mut written = Vec::new();
    for clip_id in clip_ids {
        let (audio, name) = store.with(clip_id, |entry| {
            (std::sync::Arc::clone(&entry.audio), entry.name.clone())
        })?;

        let stem = Path::new(&name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("track");
        let path = unique_path(Path::new(&directory).join(format!("{stem}.wav")));

        export::write_wav(&path, &audio.channels, audio.sample_rate, bit_depth)?;
        written.push(path.to_string_lossy().to_string());
    }

    Ok(written)
}

/// Mixes the selected tracks down to a single stereo WAV.
#[tauri::command]
pub fn export_master(
    tracks: Vec<TrackSetting>,
    path: String,
    bit_depth: BitDepth,
    master: Option<MasterBus>,
    store: State<ClipStore>,
) -> Result<String, String> {
    let mut sources = Vec::new();
    let mut sample_rate = 0;

    for setting in tracks {
        if setting.muted {
            continue;
        }
        let audio = store
            .audio(setting.clip_id)
            .ok_or_else(|| format!("clip {} is not open", setting.clip_id))?;
        // Render at the highest rate present, so nothing is downsampled.
        sample_rate = sample_rate.max(audio.sample_rate);
        sources.push((audio, setting.gain, start_offset(setting.offset_secs)));
    }

    if sources.is_empty() {
        return Err("no tracks are selected for the master".to_string());
    }

    let rendered = export::render_master_with(&sources, sample_rate, master.unwrap_or_default());
    let path_buf = PathBuf::from(&path);
    export::write_wav(&path_buf, &rendered, sample_rate, bit_depth)?;
    Ok(path)
}

/// Replaces the whole mix. The UI sends the full track list whenever anything
/// changes, which keeps the two sides from drifting out of step.
#[tauri::command]
pub fn set_mix(
    tracks: Vec<TrackSetting>,
    store: State<ClipStore>,
    engine: State<AudioEngine>,
) -> Result<(), String> {
    let mut resolved = Vec::with_capacity(tracks.len());
    for setting in tracks {
        let audio = store
            .audio(setting.clip_id)
            .ok_or_else(|| format!("clip {} is not open", setting.clip_id))?;
        resolved.push(Track {
            audio,
            gain: setting.gain.clamp(0.0, 4.0),
            muted: setting.muted,
            offset_secs: start_offset(setting.offset_secs),
        });
    }
    engine.mixer.set_tracks(resolved);
    Ok(())
}

#[tauri::command]
pub fn transport_play(engine: State<AudioEngine>) {
    // The session and a tune preview would only talk over each other.
    engine.mixer.pause_preview();
    engine.mixer.play();
}

#[tauri::command]
pub fn transport_pause(engine: State<AudioEngine>) {
    engine.mixer.pause();
}

#[tauri::command]
pub fn transport_seek(seconds: f64, engine: State<AudioEngine>) {
    engine.mixer.seek(seconds);
}

#[tauri::command]
pub fn transport_state(engine: State<AudioEngine>) -> TransportState {
    let status = engine.status();
    TransportState {
        playing: engine.mixer.is_playing(),
        position_secs: engine.mixer.position(),
        duration_secs: engine.mixer.duration(),
        ready: status.ready,
        error: status.error,
        output_sample_rate: status.sample_rate,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDeviceInfo {
    pub sample_rate: u32,
    pub channels: usize,
}

#[tauri::command]
pub fn probe_input_device(recorder: State<Mutex<Recorder>>) -> Result<InputDeviceInfo, String> {
    let rec = recorder.lock().unwrap();
    Ok(InputDeviceInfo {
        sample_rate: rec.sample_rate(),
        channels: rec.channel_count(),
    })
}

#[tauri::command]
pub fn start_recording(recorder: State<Mutex<Recorder>>) -> Result<(), String> {
    recorder.lock().unwrap().start()
}

#[tauri::command]
pub fn stop_recording(
    recorder: State<Mutex<Recorder>>,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    let audio = recorder.lock().unwrap().stop()?;
    let name = format!("Recording-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs());
    let size = audio.channels.iter().map(|ch| ch.len()).sum::<usize>() as u64 * 4; // f32 = 4 bytes
    let id = store.insert(audio, name.clone(), format!("recording://{}", name), size);
    store.with(id, |entry| clip_info(id, entry))
}

#[tauri::command]
pub fn reverse_range(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::reverse_range(audio, start, end)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[tauri::command]
pub fn invert_range(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::invert_range(audio, start, end)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[tauri::command]
pub fn repeat_range(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    count: u32,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::repeat_range(audio, start, end, count)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[tauri::command]
pub fn fill_range(
    clip_id: u64,
    fill_start_secs: f64,
    fill_end_secs: f64,
    source_start_secs: f64,
    source_end_secs: f64,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (fill_start, fill_end) = edit::frame_range(audio, fill_start_secs, fill_end_secs);
            let (source_start, source_end) =
                edit::frame_range(audio, source_start_secs, source_end_secs);
            edit::fill_range(audio, fill_start, fill_end, source_start, source_end)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[tauri::command]
pub fn adjust_volume(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    gain: f32,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::adjust_volume(audio, start, end, gain)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[tauri::command]
pub fn fade_in(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::fade_in(audio, start, end)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[tauri::command]
pub fn fade_out(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::fade_out(audio, start, end)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[tauri::command]
pub fn adjust_pitch(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    factor: f32,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::adjust_pitch(audio, start, end, factor)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[tauri::command]
pub fn adjust_time(
    clip_id: u64,
    start_secs: f64,
    end_secs: f64,
    factor: f32,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    store.edit(
        clip_id,
        |audio| {
            let (start, end) = edit::frame_range(audio, start_secs, end_secs);
            edit::adjust_time(audio, start, end, factor)
        },
        |entry| clip_info(clip_id, entry),
    )
}

/// Joins a whole audio file onto a clip: after its end, or before its start.
#[tauri::command(async)]
pub fn insert_audio_file(
    clip_id: u64,
    path: String,
    at_end: bool,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    let insert = decode::decode_file(Path::new(&path))?;
    store.edit(
        clip_id,
        |audio| {
            let at = if at_end { audio.frame_count() } else { 0 };
            edit::paste_range(audio, at, at, &insert)
        },
        |entry| clip_info(clip_id, entry),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub is_default: bool,
    pub default_path: String,
}

fn workspace_info(workspace: &Workspace) -> WorkspaceInfo {
    WorkspaceInfo {
        path: workspace.root().to_string_lossy().to_string(),
        is_default: workspace.is_default(),
        default_path: workspace.default_root().to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub fn get_workspace(workspace: State<Workspace>) -> WorkspaceInfo {
    workspace_info(&workspace)
}

/// Points the workspace at a folder, or back at the default with no path.
#[tauri::command]
pub fn set_workspace(
    path: Option<String>,
    workspace: State<Workspace>,
    engine: State<AudioEngine>,
) -> Result<WorkspaceInfo, String> {
    workspace.set_root(path.map(PathBuf::from))?;
    // The loaded preview belongs to the tunes folder that was just left.
    engine.mixer.clear_preview();
    Ok(workspace_info(&workspace))
}

#[tauri::command]
pub fn list_tunes(workspace: State<Workspace>) -> Vec<TuneInfo> {
    workspace::list_tunes(&workspace.tunes_dir())
}

/// Copies files into the workspace's tunes folder. Returns the library as it
/// now stands, so the files that did make it show up even when one did not.
#[tauri::command(async)]
pub fn add_tunes(paths: Vec<String>, workspace: State<Workspace>) -> AddedTunes {
    let tunes_dir = workspace.tunes_dir();
    let failures = paths
        .iter()
        .filter_map(|path| workspace::add_tune(&tunes_dir, Path::new(path)).err())
        .collect();
    AddedTunes {
        tunes: workspace::list_tunes(&tunes_dir),
        failures,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedTunes {
    pub tunes: Vec<TuneInfo>,
    pub failures: Vec<String>,
}

/// Deletes a tune's file from the tunes folder.
#[tauri::command]
pub fn remove_tune(
    name: String,
    workspace: State<Workspace>,
    engine: State<AudioEngine>,
) -> Result<Vec<TuneInfo>, String> {
    let tunes_dir = workspace.tunes_dir();
    if engine.mixer.preview_name().as_deref() == Some(name.as_str()) {
        engine.mixer.clear_preview();
    }
    workspace::remove_tune(&tunes_dir, &name)?;
    Ok(workspace::list_tunes(&tunes_dir))
}

/// Plays a tune from the tunes folder: resuming it if it is the one already
/// loaded, otherwise starting it from the top.
#[tauri::command(async)]
pub fn preview_play(
    name: String,
    workspace: State<Workspace>,
    engine: State<AudioEngine>,
) -> Result<(), String> {
    engine.mixer.pause();
    if engine.mixer.preview_name().as_deref() == Some(name.as_str())
        && engine.mixer.resume_preview()
    {
        return Ok(());
    }

    engine.mixer.pause_preview();
    let path = workspace::tune_path(&workspace.tunes_dir(), &name)?;
    let audio = decode::decode_file(&path)?;
    engine.mixer.start_preview(Preview {
        name,
        audio: std::sync::Arc::new(audio),
    });
    Ok(())
}

#[tauri::command]
pub fn preview_pause(engine: State<AudioEngine>) {
    engine.mixer.pause_preview();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    /// The tune that is loaded, playing or paused.
    pub name: Option<String>,
    pub playing: bool,
    pub position_secs: f64,
    pub duration_secs: f64,
}

#[tauri::command]
pub fn preview_state(engine: State<AudioEngine>) -> PreviewState {
    PreviewState {
        name: engine.mixer.preview_name(),
        playing: engine.mixer.is_preview_playing(),
        position_secs: engine.mixer.preview_position(),
        duration_secs: engine.mixer.preview_duration(),
    }
}

/// One track of a project being saved: which clip, and how it is staged.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrackSetting {
    pub clip_id: u64,
    pub gain: f32,
    pub muted: bool,
    pub soloed: bool,
    pub in_master: bool,
    #[serde(default)]
    pub offset_secs: f64,
}

/// One track of a project that was opened, shaped like the UI's own `Track`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedTrack {
    pub clip: ClipInfo,
    pub gain: f32,
    pub muted: bool,
    pub soloed: bool,
    pub in_master: bool,
    pub offset: f64,
}

/// Saves the session into the workspace as a project. Returns its folder.
#[tauri::command(async)]
pub fn save_project(
    name: String,
    tracks: Vec<ProjectTrackSetting>,
    workspace: State<Workspace>,
    store: State<ClipStore>,
) -> Result<String, String> {
    let mut resolved = Vec::with_capacity(tracks.len());
    for setting in tracks {
        let (audio, track_name) = store.with(setting.clip_id, |entry| {
            (std::sync::Arc::clone(&entry.audio), entry.name.clone())
        })?;
        resolved.push((
            ProjectTrack {
                name: track_name,
                file: String::new(),
                gain: setting.gain,
                muted: setting.muted,
                soloed: setting.soloed,
                in_master: setting.in_master,
                offset_secs: start_offset(setting.offset_secs),
            },
            audio,
        ));
    }

    let dir = workspace::save_project(&workspace.projects_dir(), &name, resolved)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_projects(workspace: State<Workspace>) -> Vec<ProjectSummary> {
    workspace::list_projects(&workspace.projects_dir())
}

/// Loads a project's tracks as new clips. Nothing is opened if any track fails.
#[tauri::command(async)]
pub fn open_project(
    name: String,
    workspace: State<Workspace>,
    store: State<ClipStore>,
) -> Result<Vec<OpenedTrack>, String> {
    let (project, dir) = workspace::read_project(&workspace.projects_dir(), &name)?;

    let mut decoded = Vec::with_capacity(project.tracks.len());
    for track in project.tracks {
        let path = dir.join(&track.file);
        let audio = decode::decode_file(&path).map_err(|e| format!("{}: {e}", track.name))?;
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        decoded.push((track, audio, path, size));
    }

    decoded
        .into_iter()
        .map(|(track, audio, path, size)| {
            let id = store.insert(audio, track.name, path.to_string_lossy().to_string(), size);
            Ok(OpenedTrack {
                clip: store.with(id, |entry| clip_info(id, entry))?,
                gain: track.gain,
                muted: track.muted,
                soloed: track.soloed,
                in_master: track.in_master,
                offset: start_offset(track.offset_secs),
            })
        })
        .collect()
}

/// Sets the master bus: gain on the summed mix, and whether to limit it.
#[tauri::command]
pub fn set_master(master: MasterBus, engine: State<AudioEngine>) {
    engine.mixer.set_master(master);
}

/// Renders a step pattern into a new clip, ready to be added as a track.
#[tauri::command]
pub fn render_pattern(
    pattern: Pattern,
    name: String,
    store: State<ClipStore>,
) -> Result<ClipInfo, String> {
    let audio = pattern::render(&pattern)?;
    let size = (audio.frame_count() * audio.channel_count() * 4) as u64;
    let name = if name.trim().is_empty() { "Pattern".to_string() } else { name };
    let id = store.insert(audio, name.clone(), format!("pattern://{name}"), size);
    store.with(id, |entry| clip_info(id, entry))
}

/// Loops a pattern on its own, outside the timeline, so it can be heard while
/// it is edited. Calling it again swaps the loop without restarting it.
#[tauri::command]
pub fn preview_pattern(pattern: Pattern, engine: State<AudioEngine>) -> Result<(), String> {
    let audio = pattern::render(&pattern)?;
    engine.mixer.set_pattern_loop(Some(std::sync::Arc::new(audio)));
    Ok(())
}

#[tauri::command]
pub fn stop_pattern_preview(engine: State<AudioEngine>) {
    engine.mixer.set_pattern_loop(None);
}

/// A track cannot start before the session does.
fn start_offset(seconds: f64) -> f64 {
    if seconds.is_finite() {
        seconds.max(0.0)
    } else {
        0.0
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("untitled")
        .to_string()
}

/// Never silently overwrite: `mix.wav` becomes `mix-2.wav` if it is taken.
fn unique_path(candidate: PathBuf) -> PathBuf {
    if !candidate.exists() {
        return candidate;
    }
    let stem = candidate
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .to_string();
    let parent = candidate.parent().map(Path::to_path_buf).unwrap_or_default();

    for suffix in 2..1000 {
        let next = parent.join(format!("{stem}-{suffix}.wav"));
        if !next.exists() {
            return next;
        }
    }
    candidate
}
