//! APIキーを Windows の資格情報マネージャーに保存する。
use keyring::Entry;

const SERVICE: &str = "StudyNotes";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| format!("資格情報を扱えません: {e}"))
}

pub fn get(provider: &str) -> Result<String, String> {
    entry(provider)?
        .get_password()
        .map_err(|_| "APIキーが設定されていません。設定画面で入力してください".to_string())
}

#[tauri::command]
pub fn secret_set(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("APIキーが空です".into());
    }
    entry(&provider)?
        .set_password(key)
        .map_err(|e| format!("APIキーを保存できません: {e}"))
}

#[tauri::command]
pub fn secret_has(provider: String) -> bool {
    get(&provider).is_ok()
}

#[tauri::command]
pub fn secret_delete(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("APIキーを削除できません: {e}")),
    }
}
