pub mod audio;
mod commands;

use std::sync::Mutex;

use audio::engine::AudioEngine;
use audio::recording::Recorder;
use audio::{ClipStore, Clipboard};
use commands::StartupFiles;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ClipStore::default())
        .manage(Clipboard::default())
        .manage(AudioEngine::new())
        .manage(StartupFiles::from_args())
        .manage(Mutex::new(Recorder::new().unwrap_or_default()))
        .invoke_handler(tauri::generate_handler![
            commands::import_audio,
            commands::get_peaks,
            commands::close_clip,
            commands::take_startup_files,
            commands::set_mix,
            commands::transport_play,
            commands::transport_pause,
            commands::transport_seek,
            commands::transport_state,
            commands::delete_range,
            commands::crop_range,
            commands::copy_range,
            commands::paste_range,
            commands::undo_edit,
            commands::export_tracks,
            commands::export_master,
            commands::probe_input_device,
            commands::start_recording,
            commands::stop_recording,
            commands::reverse_range,
            commands::invert_range,
            commands::repeat_range,
            commands::fill_range,
            commands::adjust_volume,
            commands::fade_in,
            commands::fade_out,
            commands::adjust_pitch,
            commands::adjust_time,
        ])
        .run(tauri::generate_context!())
        .expect("error while running zwaveEditor");
}
