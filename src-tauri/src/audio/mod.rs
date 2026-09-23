pub mod decode;
pub mod edit;
pub mod engine;
pub mod export;
pub mod peaks;
pub mod recording;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use decode::DecodedAudio;

/// How many edits back a clip can be undone. Each step holds a whole copy of
/// the clip, so this is deliberately bounded.
const MAX_HISTORY: usize = 12;

/// One open clip: its current audio, where it came from, and its undo stack.
pub struct ClipEntry {
    pub audio: Arc<DecodedAudio>,
    pub name: String,
    pub path: String,
    pub file_size_bytes: u64,
    /// Bumped on every edit, so the UI knows its cached peaks are stale.
    pub version: u32,
    history: Vec<Arc<DecodedAudio>>,
}

impl ClipEntry {
    pub fn can_undo(&self) -> bool {
        !self.history.is_empty()
    }
}

/// Audio copied out of a clip, waiting to be pasted. It is a copy, so it
/// survives edits to, or closing of, the clip it came from.
#[derive(Default)]
pub struct Clipboard(pub Mutex<Option<Arc<DecodedAudio>>>);

/// Every clip the session has open, keyed by the id handed to the frontend.
///
/// Decoded audio stays on the Rust side: the UI only ever pulls the peaks it
/// needs to draw, and the mixer shares the very same buffers by `Arc`, so
/// playing a file costs no extra memory.
#[derive(Default)]
pub struct ClipStore {
    clips: Mutex<HashMap<u64, ClipEntry>>,
    next_id: AtomicU64,
}

impl ClipStore {
    pub fn insert(&self, audio: DecodedAudio, name: String, path: String, size: u64) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.clips.lock().unwrap().insert(
            id,
            ClipEntry {
                audio: Arc::new(audio),
                name,
                path,
                file_size_bytes: size,
                version: 0,
                history: Vec::new(),
            },
        );
        id
    }

    pub fn remove(&self, id: u64) {
        self.clips.lock().unwrap().remove(&id);
    }

    pub fn audio(&self, id: u64) -> Option<Arc<DecodedAudio>> {
        self.clips.lock().unwrap().get(&id).map(|e| Arc::clone(&e.audio))
    }

    /// Run `f` against a clip, or fail if it is no longer open.
    pub fn with<T>(&self, id: u64, f: impl FnOnce(&ClipEntry) -> T) -> Result<T, String> {
        let clips = self.clips.lock().unwrap();
        let entry = clips
            .get(&id)
            .ok_or_else(|| format!("clip {id} is not open"))?;
        Ok(f(entry))
    }

    /// Replaces a clip's audio with the result of `f`, keeping the old version
    /// for undo. The clip is left untouched if `f` fails.
    pub fn edit<T>(
        &self,
        id: u64,
        f: impl FnOnce(&DecodedAudio) -> Result<DecodedAudio, String>,
        then: impl FnOnce(&ClipEntry) -> T,
    ) -> Result<T, String> {
        let mut clips = self.clips.lock().unwrap();
        let entry = clips
            .get_mut(&id)
            .ok_or_else(|| format!("clip {id} is not open"))?;

        let edited = f(&entry.audio)?;

        entry.history.push(Arc::clone(&entry.audio));
        if entry.history.len() > MAX_HISTORY {
            entry.history.remove(0);
        }
        entry.audio = Arc::new(edited);
        entry.version += 1;

        Ok(then(entry))
    }

    pub fn undo<T>(&self, id: u64, then: impl FnOnce(&ClipEntry) -> T) -> Result<T, String> {
        let mut clips = self.clips.lock().unwrap();
        let entry = clips
            .get_mut(&id)
            .ok_or_else(|| format!("clip {id} is not open"))?;

        let previous = entry
            .history
            .pop()
            .ok_or_else(|| "there is nothing to undo".to_string())?;
        entry.audio = previous;
        entry.version += 1;

        Ok(then(entry))
    }
}
