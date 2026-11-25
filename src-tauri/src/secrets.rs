//! APIキーを Windows の資格情報マネージャーに保存する（Android 版は AI 機能なし）。
#[cfg(not(target_os = "android"))]
use keyring::Entry;

const SERVICE: &str = "StudyNotes";

#[cfg(target_os = "android")]
mod imp {
    pub fn get(_provider: &str) -> Result<String, String> {
        Err("スマホ版では AI 機能は使えません".into())
    }
    pub fn set(_provider: &str, _key: &str) -> Result<(), String> {
        Err("スマホ版では AI 機能は使えません".into())
    }
    pub fn delete(_provider: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    use super::*;

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| format!("資格情報を扱えません: {e}"))
}

pub fn get(provider: &str) -> Result<String, String> {
    entry(provider)?
        .get_password()
        .map_err(|_| "APIキーが設定されていません。設定画面で入力してください".to_string())
}

pub fn set(provider: &str, key: &str) -> Result<(), String> {
    entry(provider)?
        .set_password(key)
        .map_err(|e| format!("APIキーを保存できません: {e}"))
}

pub fn delete(provider: &str) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("APIキーを削除できません: {e}")),
    }
}
}

pub use imp::get;

#[tauri::command]
pub fn secret_set(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("APIキーが空です".into());
    }
    imp::set(&provider, key)
}

#[tauri::command]
pub fn secret_has(provider: String) -> bool {
    get(&provider).is_ok()
}

#[tauri::command]
pub fn secret_delete(provider: String) -> Result<(), String> {
    imp::delete(&provider)
}
