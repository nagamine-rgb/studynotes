//! 画像の保存。attachments/ 1か所に保存し、上書きは絶対にしない。
//! 1. 同じ名前がなければそのまま
//! 2. 同じ名前で中身も同じなら既存ファイルを使う
//! 3. 同じ名前で中身が違えば「名前 (2).拡張子」…と空き番号を付ける
use crate::paths::sanitize_file_name;
use crate::vault::{root_of, write_atomic, IMAGE_EXTS};
use crate::AppState;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use tauri::State;

pub const ATTACH_DIR: &str = "attachments";

fn hash(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn split_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// 保存先のファイル名を決める。戻り値は（ファイル名, 新しく書く必要があるか）。
pub fn choose_name(dir: &Path, desired: &str, data: &[u8]) -> (String, bool) {
    let (stem, ext) = split_name(desired);
    let digest = hash(data);
    let mut n = 1;
    loop {
        let candidate = if n == 1 { format!("{stem}{ext}") } else { format!("{stem} ({n}){ext}") };
        let p = dir.join(&candidate);
        if !p.exists() {
            return (candidate, true);
        }
        if let Ok(existing) = fs::read(&p) {
            if hash(&existing) == digest {
                return (candidate, false);
            }
        }
        n += 1;
    }
}

#[tauri::command]
pub fn attachment_save(state: State<AppState>, name: String, data_base64: String) -> Result<String, String> {
    let root = root_of(&state)?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| "画像データを読み取れません".to_string())?;
    let mut desired = sanitize_file_name(&name);
    let ext = split_name(&desired).1.trim_start_matches('.').to_lowercase();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        if ext.is_empty() {
            desired.push_str(".png");
        } else {
            return Err(format!("この形式の画像には対応していません: .{ext}"));
        }
    }
    let dir = root.join(ATTACH_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("attachments フォルダを作れません: {e}"))?;
    let (file, needs_write) = choose_name(&dir, &desired, &data);
    if needs_write {
        write_atomic(&dir.join(&file), &data)?;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naming_rules() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        // 1. 空いていればそのまま
        assert_eq!(choose_name(d, "001.jpg", b"A"), ("001.jpg".into(), true));
        fs::write(d.join("001.jpg"), b"A").unwrap();
        // 2. 中身が同じなら既存を使う
        assert_eq!(choose_name(d, "001.jpg", b"A"), ("001.jpg".into(), false));
        // 3. 中身が違えば番号付き
        assert_eq!(choose_name(d, "001.jpg", b"B"), ("001 (2).jpg".into(), true));
        fs::write(d.join("001 (2).jpg"), b"B").unwrap();
        assert_eq!(choose_name(d, "001.jpg", b"B"), ("001 (2).jpg".into(), false));
        assert_eq!(choose_name(d, "001.jpg", b"C"), ("001 (3).jpg".into(), true));
    }
}
