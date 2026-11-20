mod ai;
mod attachments;
mod paths;
mod secrets;
mod vault;
mod watcher;

use std::sync::Mutex;

pub struct AppState {
    pub root: Mutex<Option<std::path::PathBuf>>,
    pub watcher: Mutex<Option<watcher::VaultWatcher>>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            root: Mutex::new(None),
            watcher: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_open,
            vault::vault_list,
            vault::vault_read_all,
            vault::note_read,
            vault::note_write,
            vault::note_create,
            vault::folder_create,
            vault::entry_rename,
            vault::entry_delete,
            vault::abs_path,
            vault::workspace_load,
            vault::workspace_save,
            vault::settings_load,
            vault::settings_save,
            attachments::attachment_save,
            secrets::secret_set,
            secrets::secret_has,
            secrets::secret_delete,
            ai::ai_check,
            ai::ai_list_models,
        ])
        .run(tauri::generate_context!())
        .expect("StudyNotes の起動に失敗しました");
}
