//! ノートフォルダの読み書き。
use crate::paths::{relative, resolve};
use crate::watcher::VaultWatcher;
use crate::AppState;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

const APP_DIR: &str = ".studynote";
pub const IMAGE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

#[derive(Serialize)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct NoteFile {
    pub path: String,
    pub content: String,
}

pub fn root_of(state: &State<AppState>) -> Result<PathBuf, String> {
    state
        .root
        .lock()
        .map_err(|_| "内部エラー".to_string())?
        .clone()
        .ok_or_else(|| "ノートフォルダが開かれていません".to_string())
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub fn is_listed_file(p: &Path) -> bool {
    let e = ext_of(p);
    e == "md" || IMAGE_EXTS.contains(&e.as_str())
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

pub fn walk(root: &Path, dir: &Path, out: &mut Vec<Entry>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut items: Vec<_> = rd.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for item in items {
        let name = item.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let path = item.path();
        let Ok(ft) = item.file_type() else { continue };
        if ft.is_dir() {
            if let Some(rel) = relative(root, &path) {
                out.push(Entry { path: rel, name: name.clone(), is_dir: true });
            }
            walk(root, &path, out);
        } else if ft.is_file() && is_listed_file(&path) {
            if let Some(rel) = relative(root, &path) {
                out.push(Entry { path: rel, name, is_dir: false });
            }
        }
    }
}

/// 一時ファイルに書いてから置き換える（書き込み途中で落ちても元のファイルが壊れない）。
pub fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("フォルダを作れません: {e}"))?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp-studynote",
        path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    fs::write(&tmp, data).map_err(|e| format!("保存できません: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("保存できません: {e}")
    })
}

#[tauri::command]
pub fn vault_open(app: AppHandle, state: State<AppState>, path: String) -> Result<String, String> {
    let root = simplify(fs::canonicalize(&path).map_err(|e| format!("フォルダを開けません: {e}"))?);
    if !root.is_dir() {
        return Err("フォルダではありません".into());
    }
    // 画像表示のため、このフォルダを asset プロトコルで読めるようにする
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| e.to_string())?;
    let watcher = VaultWatcher::start(app.clone(), root.clone())?;
    *state.watcher.lock().map_err(|_| "内部エラー")? = Some(watcher);
    *state.root.lock().map_err(|_| "内部エラー")? = Some(root.clone());
    Ok(display_path(&root))
}

/// Windows の canonicalize が付ける "\\?\" を取り除く（ネットワークパスはそのまま）。
/// 付いたままだと、画像表示の許可範囲やごみ箱の処理で通常のパスと一致しないことがある。
fn simplify(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s)
}

#[tauri::command]
pub fn vault_list(state: State<AppState>) -> Result<Vec<Entry>, String> {
    let root = root_of(&state)?;
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    Ok(out)
}

#[tauri::command]
pub fn vault_read_all(state: State<AppState>) -> Result<Vec<NoteFile>, String> {
    let root = root_of(&state)?;
    let mut entries = Vec::new();
    walk(&root, &root, &mut entries);
    Ok(entries
        .into_iter()
        .filter(|e| !e.is_dir && e.path.to_lowercase().ends_with(".md"))
        .filter_map(|e| {
            let abs = resolve(&root, &e.path).ok()?;
            let content = fs::read_to_string(abs).ok()?;
            Some(NoteFile { path: e.path, content })
        })
        .collect())
}

#[tauri::command]
pub fn note_read(state: State<AppState>, path: String) -> Result<String, String> {
    let root = root_of(&state)?;
    fs::read_to_string(resolve(&root, &path)?).map_err(|e| format!("読み込めません: {e}"))
}

#[tauri::command]
pub fn note_write(state: State<AppState>, path: String, content: String) -> Result<(), String> {
    let root = root_of(&state)?;
    write_atomic(&resolve(&root, &path)?, content.as_bytes())
}

#[tauri::command]
pub fn note_create(state: State<AppState>, path: String, content: String) -> Result<(), String> {
    let root = root_of(&state)?;
    let abs = resolve(&root, &path)?;
    if abs.exists() {
        return Err("同じ名前のノートがすでにあります".into());
    }
    write_atomic(&abs, content.as_bytes())
}

#[tauri::command]
pub fn folder_create(state: State<AppState>, path: String) -> Result<(), String> {
    let root = root_of(&state)?;
    let abs = resolve(&root, &path)?;
    if abs.exists() {
        return Err("同じ名前のフォルダがすでにあります".into());
    }
    fs::create_dir_all(abs).map_err(|e| format!("フォルダを作れません: {e}"))
}

#[tauri::command]
pub fn entry_rename(state: State<AppState>, from: String, to: String) -> Result<(), String> {
    let root = root_of(&state)?;
    let a = resolve(&root, &from)?;
    let b = resolve(&root, &to)?;
    if !a.exists() {
        return Err("元のファイルが見つかりません".into());
    }
    // Windows は大文字小文字を区別しないので、表記だけ変える場合は同一とみなす
    let same = a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase();
    if b.exists() && !same {
        return Err("同じ名前がすでにあります".into());
    }
    if let Some(parent) = b.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(a, b).map_err(|e| format!("名前を変更できません: {e}"))
}

#[tauri::command]
pub fn entry_delete(state: State<AppState>, path: String) -> Result<(), String> {
    let root = root_of(&state)?;
    let abs = resolve(&root, &path)?;
    if abs == root {
        return Err("ノートフォルダ自体は削除できません".into());
    }
    trash::delete(&abs).map_err(|e| format!("ごみ箱に移せません: {e}"))
}

/// ノートフォルダ内のファイル（画像など）を Windows に関連付けられたアプリで開く
#[tauri::command]
pub fn open_in_default_app(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let root = root_of(&state)?;
    let abs = resolve(&root, &path)?;
    if !abs.is_file() {
        return Err("ファイルが見つかりません".into());
    }
    app.opener()
        .open_path(display_path(&abs), None::<&str>)
        .map_err(|e| format!("アプリで開けません: {e}"))
}

#[tauri::command]
pub fn abs_path(state: State<AppState>, path: String) -> Result<String, String> {
    let root = root_of(&state)?;
    Ok(display_path(&resolve(&root, &path)?))
}

#[tauri::command]
pub fn workspace_load(state: State<AppState>) -> Result<Option<String>, String> {
    let root = root_of(&state)?;
    Ok(fs::read_to_string(root.join(APP_DIR).join("workspace.json")).ok())
}

#[tauri::command]
pub fn workspace_save(state: State<AppState>, json: String) -> Result<(), String> {
    let root = root_of(&state)?;
    write_atomic(&root.join(APP_DIR).join("workspace.json"), json.as_bytes())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json"))
}

#[tauri::command]
pub fn settings_load(app: AppHandle) -> Result<Option<String>, String> {
    Ok(fs::read_to_string(settings_path(&app)?).ok())
}

#[tauri::command]
pub fn settings_save(app: AppHandle, json: String) -> Result<(), String> {
    write_atomic(&settings_path(&app)?, json.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walk_lists_notes_and_images_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("英語")).unwrap();
        fs::create_dir_all(root.join(".studynote")).unwrap();
        fs::write(root.join("英語/単語.md"), "# a").unwrap();
        fs::write(root.join("memo.txt"), "x").unwrap();
        fs::write(root.join("図.PNG"), "x").unwrap();
        fs::write(root.join(".studynote/workspace.json"), "{}").unwrap();
        let mut out = Vec::new();
        walk(root, root, &mut out);
        let paths: Vec<_> = out.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["図.PNG", "英語", "英語/単語.md"]);
    }

    #[test]
    fn simplifies_verbatim_paths() {
        assert_eq!(simplify(PathBuf::from(r"\\?\C:\Notes")), PathBuf::from(r"C:\Notes"));
        assert_eq!(simplify(PathBuf::from(r"\\?\UNC\srv\share")), PathBuf::from(r"\\?\UNC\srv\share"));
        assert_eq!(simplify(PathBuf::from("/tmp/x")), PathBuf::from("/tmp/x"));
    }

    #[test]
    fn atomic_write_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a/b.md");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");
        assert_eq!(fs::read_dir(dir.path().join("a")).unwrap().count(), 1);
    }
}
