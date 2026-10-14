//! The workspace: one folder on disk that holds the quick-tunes library and
//! saved projects.
//!
//! ```text
//! <workspace>/
//!   tunes/                    files added to the quick-tunes panel
//!   projects/<name>/
//!     project.json            the track list and mixer settings
//!     audio/track-01.wav      each track's audio, edits included
//! ```
//!
//! Folders are created the first time something is written to them, so merely
//! pointing at a workspace leaves the disk alone.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::audio::decode::DecodedAudio;
use crate::audio::export::{self, BitDepth};

const TUNES_DIR: &str = "tunes";
const PROJECTS_DIR: &str = "projects";
const PROJECT_FILE: &str = "project.json";
const PROJECT_VERSION: u32 = 1;

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    /// The folder the user chose, or `None` to use the default.
    workspace: Option<PathBuf>,
}

/// Where the workspace is. The choice is remembered in a small settings file;
/// until one is made, a default folder is used.
pub struct Workspace {
    settings_path: PathBuf,
    default_root: PathBuf,
    custom_root: Mutex<Option<PathBuf>>,
}

impl Workspace {
    /// Reads the remembered choice, if there is one.
    pub fn load(settings_path: PathBuf, default_root: PathBuf) -> Self {
        let settings: Settings = std::fs::read_to_string(&settings_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Workspace {
            settings_path,
            default_root,
            custom_root: Mutex::new(settings.workspace),
        }
    }

    pub fn root(&self) -> PathBuf {
        self.custom_root
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| self.default_root.clone())
    }

    pub fn default_root(&self) -> &Path {
        &self.default_root
    }

    pub fn is_default(&self) -> bool {
        self.custom_root.lock().unwrap().is_none()
    }

    /// Points the workspace at `root`, or back at the default with `None`, and
    /// remembers the choice. Nothing is moved: each folder keeps its own
    /// tunes and projects.
    pub fn set_root(&self, root: Option<PathBuf>) -> Result<(), String> {
        if let Some(root) = &root {
            if !root.is_absolute() {
                return Err("the workspace must be an absolute path".to_string());
            }
            std::fs::create_dir_all(root)
                .map_err(|e| format!("could not use that folder as a workspace: {e}"))?;
        }

        let settings = Settings { workspace: root };
        if let Some(parent) = self.settings_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not save the workspace setting: {e}"))?;
        }
        let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(&self.settings_path, text)
            .map_err(|e| format!("could not save the workspace setting: {e}"))?;

        *self.custom_root.lock().unwrap() = settings.workspace;
        Ok(())
    }

    pub fn tunes_dir(&self) -> PathBuf {
        self.root().join(TUNES_DIR)
    }

    pub fn projects_dir(&self) -> PathBuf {
        self.root().join(PROJECTS_DIR)
    }
}

/// One file in the quick-tunes library.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TuneInfo {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

/// Every tune in `tunes_dir`, by name. A folder that does not exist yet is
/// simply an empty library.
pub fn list_tunes(tunes_dir: &Path) -> Vec<TuneInfo> {
    let Ok(entries) = std::fs::read_dir(tunes_dir) else {
        return Vec::new();
    };

    let mut tunes: Vec<TuneInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let name = entry.file_name().to_str()?.to_string();
            if !metadata.is_file() || name.starts_with('.') {
                return None;
            }
            Some(TuneInfo {
                name,
                path: entry.path().to_string_lossy().to_string(),
                size_bytes: metadata.len(),
            })
        })
        .collect();

    tunes.sort_by_key(|tune| tune.name.to_lowercase());
    tunes
}

/// Copies `source` into the library, creating the folder if need be. A file
/// that is already there is left alone; a different file with the same name
/// is kept alongside it as `name-2.ext`.
pub fn add_tune(tunes_dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "that file has no usable name".to_string())?;
    let size = std::fs::metadata(source)
        .map_err(|e| format!("could not read {name}: {e}"))?
        .len();

    std::fs::create_dir_all(tunes_dir)
        .map_err(|e| format!("could not create the tunes folder: {e}"))?;

    let target = tunes_dir.join(name);
    if let Ok(existing) = std::fs::metadata(&target) {
        if existing.len() == size {
            return Ok(target);
        }
    }

    let target = unique_path(target);
    std::fs::copy(source, &target).map_err(|e| format!("could not copy {name}: {e}"))?;
    Ok(target)
}

/// Resolves a tune's name to its file, refusing anything that is not a plain
/// file name — the name comes from the UI and must not escape the folder.
pub fn tune_path(tunes_dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !is_plain_name(name) {
        return Err(format!("{name:?} is not a tune name"));
    }
    let path = tunes_dir.join(name);
    if !path.is_file() {
        return Err(format!("{name} is no longer in the tunes folder"));
    }
    Ok(path)
}

/// Deletes a tune's file from the library.
pub fn remove_tune(tunes_dir: &Path, name: &str) -> Result<(), String> {
    let path = tune_path(tunes_dir, name)?;
    std::fs::remove_file(path).map_err(|e| format!("could not remove {name}: {e}"))
}

/// One track as a project file records it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrack {
    pub name: String,
    /// The track's audio, relative to the project folder.
    pub file: String,
    pub gain: f32,
    pub muted: bool,
    pub soloed: bool,
    pub in_master: bool,
    pub offset_secs: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub version: u32,
    /// Seconds since the Unix epoch.
    pub saved_at: u64,
    pub tracks: Vec<ProjectTrack>,
}

/// A saved project, as the open dialog lists it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub name: String,
    pub track_count: usize,
    pub saved_at: u64,
}

/// Turns what the user typed into a folder name, or fails if nothing usable
/// is left.
pub fn project_dir_name(name: &str) -> Result<String, String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        return Err("give the project a name".to_string());
    }
    Ok(cleaned.to_string())
}

/// Writes a project: its settings, and every track's audio as it stands, edits
/// included. `file` on each track is filled in here. Saving over an existing
/// project replaces it only once the new one is completely written.
pub fn save_project(
    projects_dir: &Path,
    name: &str,
    tracks: Vec<(ProjectTrack, Arc<DecodedAudio>)>,
) -> Result<PathBuf, String> {
    if tracks.is_empty() {
        return Err("there are no tracks to save".to_string());
    }
    let dir_name = project_dir_name(name)?;
    let target = projects_dir.join(&dir_name);
    let staging = projects_dir.join(format!(".{dir_name}.saving"));

    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| format!("could not save: {e}"))?;
    }
    std::fs::create_dir_all(staging.join("audio"))
        .map_err(|e| format!("could not create the project folder: {e}"))?;

    let written = write_project(&staging, tracks).and_then(|()| {
        if target.exists() {
            std::fs::remove_dir_all(&target)
                .map_err(|e| format!("could not replace the old project: {e}"))?;
        }
        std::fs::rename(&staging, &target).map_err(|e| format!("could not save: {e}"))
    });

    if written.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    written.map(|()| target)
}

fn write_project(dir: &Path, tracks: Vec<(ProjectTrack, Arc<DecodedAudio>)>) -> Result<(), String> {
    let mut saved = Vec::with_capacity(tracks.len());
    for (index, (mut track, audio)) in tracks.into_iter().enumerate() {
        track.file = format!("audio/track-{:02}.wav", index + 1);
        // Float keeps the samples exactly as they are in memory.
        export::write_wav(
            &dir.join(&track.file),
            &audio.channels,
            audio.sample_rate,
            BitDepth::Float32,
        )
        .map_err(|e| format!("{}: {e}", track.name))?;
        saved.push(track);
    }

    let project = ProjectFile {
        version: PROJECT_VERSION,
        saved_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        tracks: saved,
    };
    let text = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(PROJECT_FILE), text)
        .map_err(|e| format!("could not write the project file: {e}"))
}

/// Every project in `projects_dir`, most recently saved first.
pub fn list_projects(projects_dir: &Path) -> Vec<ProjectSummary> {
    let Ok(entries) = std::fs::read_dir(projects_dir) else {
        return Vec::new();
    };

    let mut projects: Vec<ProjectSummary> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            if name.starts_with('.') {
                return None;
            }
            let project = read_project_file(&entry.path()).ok()?;
            Some(ProjectSummary {
                name,
                track_count: project.tracks.len(),
                saved_at: project.saved_at,
            })
        })
        .collect();

    projects.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then_with(|| a.name.cmp(&b.name)));
    projects
}

/// Reads a project's settings. Returns them with the folder its audio files
/// are relative to.
pub fn read_project(projects_dir: &Path, name: &str) -> Result<(ProjectFile, PathBuf), String> {
    if !is_plain_name(name) {
        return Err(format!("{name:?} is not a project name"));
    }
    let dir = projects_dir.join(name);
    let project = read_project_file(&dir)?;
    if project.tracks.iter().any(|track| !is_inside(&track.file)) {
        return Err("the project file points outside its own folder".to_string());
    }
    Ok((project, dir))
}

fn read_project_file(dir: &Path) -> Result<ProjectFile, String> {
    let text = std::fs::read_to_string(dir.join(PROJECT_FILE))
        .map_err(|e| format!("could not read the project: {e}"))?;
    let project: ProjectFile =
        serde_json::from_str(&text).map_err(|e| format!("the project file is damaged: {e}"))?;
    if project.version > PROJECT_VERSION {
        return Err("this project was saved by a newer version of zwaveEditor".to_string());
    }
    Ok(project)
}

/// True for a single ordinary path component: no separators, no `..`.
fn is_plain_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

/// True for a relative path that stays below where it starts.
fn is_inside(relative: &str) -> bool {
    let mut components = Path::new(relative).components().peekable();
    components.peek().is_some() && components.all(|c| matches!(c, Component::Normal(_)))
}

/// Never silently overwrite: `loop.mp3` becomes `loop-2.mp3` if it is taken.
fn unique_path(candidate: PathBuf) -> PathBuf {
    if !candidate.exists() {
        return candidate;
    }
    let stem = candidate
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("tune")
        .to_string();
    let extension = candidate
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let parent = candidate.parent().map(Path::to_path_buf).unwrap_or_default();

    for suffix in 2..1000 {
        let next = parent.join(format!("{stem}-{suffix}{extension}"));
        if !next.exists() {
            return next;
        }
    }
    candidate
}
