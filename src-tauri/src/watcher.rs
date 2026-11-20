//! ノートフォルダの外部変更を監視し、画面に "vault-changed" イベントで知らせる。
use crate::paths::relative;
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct VaultWatcher {
    _debouncer: Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>,
}

impl VaultWatcher {
    pub fn start(app: AppHandle, root: PathBuf) -> Result<Self, String> {
        let root_for_cb = root.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut changed: Vec<String> = events
                .iter()
                .filter_map(|ev| relative(&root_for_cb, &ev.path))
                .filter(|rel| !rel.is_empty())
                .filter(|rel| !rel.split('/').any(|seg| seg.starts_with('.')))
                .filter(|rel| !rel.ends_with(".tmp-studynote"))
                .collect();
            changed.sort();
            changed.dedup();
            if !changed.is_empty() {
                let _ = app.emit("vault-changed", changed);
            }
        })
        .map_err(|e| format!("フォルダの監視を開始できません: {e}"))?;
        debouncer
            .watcher()
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("フォルダの監視を開始できません: {e}"))?;
        Ok(Self { _debouncer: debouncer })
    }
}
