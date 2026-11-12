pub mod audio;
mod commands;
pub mod workspace;

use std::sync::Mutex;

use audio::engine::AudioEngine;
use audio::recording::Recorder;
use audio::{ClipStore, Clipboard};
use commands::StartupFiles;
use tauri::Manager;
use workspace::Workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ClipStore::default())
        .manage(Clipboard::default())
        .manage(AudioEngine::new())
        .manage(StartupFiles::from_args())
        .manage(Mutex::new(Recorder::new().unwrap_or_default()))
        .setup(|app| {
            // Until the user picks a workspace, it lives in their documents.
            let default_root = app
                .path()
                .document_dir()
                .or_else(|_| app.path().home_dir())?
                .join("zwaveEditor");
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            app.manage(Workspace::load(settings_path, default_root));
            #[cfg(target_os = "macos")]
            route_quit_through_the_window(app)?;
            Ok(())
        })
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
            commands::new_blank_clip,
            commands::new_clip_from_clipboard,
            commands::undo_edit,
            commands::rename_clip,
            commands::export_tracks,
            commands::export_master,
            commands::probe_input_device,
            commands::start_recording,
            commands::stop_recording,
            commands::stop_recording_as_sample,
            commands::cancel_recording,
            commands::reverse_range,
            commands::invert_range,
            commands::repeat_range,
            commands::fill_range,
            commands::adjust_volume,
            commands::fade_in,
            commands::fade_out,
            commands::adjust_pitch,
            commands::adjust_time,
            commands::enhance_voice,
            commands::insert_audio_file,
            commands::get_workspace,
            commands::set_workspace,
            commands::list_tunes,
            commands::add_tunes,
            commands::remove_tune,
            commands::preview_play,
            commands::preview_pause,
            commands::preview_state,
            commands::save_project,
            commands::list_projects,
            commands::open_project,
            commands::project_contents,
            commands::import_project_track,
            commands::preview_project_track,
            commands::set_master,
            commands::render_pattern,
            commands::preview_pattern,
            commands::stop_pattern_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running zwaveEditor");
}

/// The stock Quit item ends the app on the spot, so ⌘Q would skip the check for
/// unsaved work. This one asks the window to close instead, which the UI hears.
#[cfg(target_os = "macos")]
fn route_quit_through_the_window(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    const QUIT_ID: &str = "quit-with-check";

    let menu = Menu::default(app.handle())?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        for item in app_menu.items()? {
            let is_quit = match &item {
                MenuItemKind::Predefined(predefined) => predefined.text()?.starts_with("Quit"),
                _ => false,
            };
            if is_quit {
                let label = format!("Quit {}", app.package_info().name);
                let quit = MenuItem::with_id(app, QUIT_ID, label, true, Some("CmdOrCtrl+Q"))?;
                app_menu.remove(&item)?;
                app_menu.append(&quit)?;
                break;
            }
        }
    }
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        if event.id() == QUIT_ID {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
    });
    Ok(())
}
