//! ノートフォルダの外部変更を監視し、画面に "vault-changed" イベントで知らせる。
//!
//! 注意：ファイルを「開いた・読んだ」だけの通知（Access）や属性の変更（Metadata）は無視する。
//! これを拾うと、アプリ自身の読み込みが変更通知を生み、読み込み→通知→読み込み…と無限に続いてしまう。
use crate::paths::relative;
use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(300);

pub struct VaultWatcher {
    // 破棄すると送信側が閉じ、待機スレッドも終了する
    _watcher: RecommendedWatcher,
}

/// 内容・名前・存在が変わる種類の通知だけを対象にする
pub fn is_relevant(kind: &EventKind) -> bool {
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) => true,
        EventKind::Modify(ModifyKind::Metadata(_)) => false,
        EventKind::Modify(_) => true,
        EventKind::Access(_) | EventKind::Other | EventKind::Any => false,
    }
}

/// 画面に知らせるパスか（隠しフォルダ・一時ファイルを除く）
pub fn changed_path(root: &Path, abs: &Path) -> Option<String> {
    let rel = relative(root, abs)?;
    if rel.is_empty() || rel.split('/').any(|seg| seg.starts_with('.')) || rel.ends_with(".tmp-studynote") {
        return None;
    }
    Some(rel)
}

impl VaultWatcher {
    pub fn start(app: AppHandle, root: PathBuf) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(tx).map_err(|e| format!("フォルダの監視を開始できません: {e}"))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("フォルダの監視を開始できません: {e}"))?;

        std::thread::spawn(move || {
            let collect = |res: notify::Result<Event>, out: &mut BTreeSet<String>| {
                if let Ok(ev) = res {
                    if is_relevant(&ev.kind) {
                        out.extend(ev.paths.iter().filter_map(|p| changed_path(&root, p)));
                    }
                }
            };
            // 最初の通知を待ち、そこから一定時間に来た通知をまとめて1回知らせる
            while let Ok(first) = rx.recv() {
                let mut changed = BTreeSet::new();
                collect(first, &mut changed);
                let deadline = Instant::now() + DEBOUNCE;
                loop {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(left) {
                        Ok(res) => collect(res, &mut changed),
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                if !changed.is_empty() {
                    let _ = app.emit("vault-changed", changed.into_iter().collect::<Vec<_>>());
                }
            }
        });
        Ok(Self { _watcher: watcher })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange, MetadataKind, RenameMode};

    #[test]
    fn ignores_reads_and_metadata() {
        assert!(!is_relevant(&EventKind::Access(AccessKind::Any)));
        assert!(!is_relevant(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime))));
        assert!(is_relevant(&EventKind::Modify(ModifyKind::Data(DataChange::Content))));
        assert!(is_relevant(&EventKind::Modify(ModifyKind::Name(RenameMode::Both))));
        assert!(is_relevant(&EventKind::Create(CreateKind::File)));
    }

    #[test]
    fn filters_paths() {
        let root = Path::new("/v");
        assert_eq!(changed_path(root, Path::new("/v/英語/単語.md")).as_deref(), Some("英語/単語.md"));
        assert_eq!(changed_path(root, Path::new("/v/.studynote/workspace.json")), None);
        assert_eq!(changed_path(root, Path::new("/v/a.md.tmp-studynote")), None);
    }

    /// 実際のフォルダで：読むだけでは通知されず、書くと通知される
    #[test]
    fn real_watcher_ignores_reads() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.md"), "x").unwrap();
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut w = notify::recommended_watcher(tx).unwrap();
        w.watch(&root, RecursiveMode::Recursive).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let relevant = |rx: &mpsc::Receiver<notify::Result<Event>>| {
            let mut n = 0;
            while let Ok(Ok(ev)) = rx.recv_timeout(Duration::from_millis(400)) {
                if is_relevant(&ev.kind) {
                    n += 1;
                }
            }
            n
        };
        for _ in 0..5 {
            let _ = std::fs::read_to_string(root.join("a.md")).unwrap();
            let _ = std::fs::read_dir(&root).unwrap().count();
        }
        assert_eq!(relevant(&rx), 0, "読み込みで変更通知が出てはいけない");
        std::fs::write(root.join("a.md"), "y").unwrap();
        assert!(relevant(&rx) > 0, "書き込みは通知される");
    }
}
