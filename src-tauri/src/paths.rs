//! ノートフォルダ内の相対パス（区切りは常に "/"）と実パスの変換。
use std::path::{Component, Path, PathBuf};

/// 相対パスをノートフォルダの中の実パスに変換する。フォルダの外を指すものは拒否する。
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim_matches('/');
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains('\\') || part.contains(':') {
            return Err(format!("不正なパスです: {rel}"));
        }
        out.push(part);
    }
    // 念のため構成要素も確認
    if out
        .strip_prefix(root)
        .map(|p| p.components().any(|c| !matches!(c, Component::Normal(_))))
        .unwrap_or(true)
    {
        return Err(format!("不正なパスです: {rel}"));
    }
    Ok(out)
}

/// 実パスをノートフォルダからの相対パス（"/" 区切り）にする。
pub fn relative(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    Some(parts.join("/"))
}

/// Windows でファイル名に使えない文字を置き換える。
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        "無題".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_dir() {
        let root = Path::new("/notes");
        assert!(resolve(root, "../etc/passwd").is_err());
        assert!(resolve(root, "a/../../b").is_err());
        assert_eq!(resolve(root, "英語/単語.md").unwrap(), Path::new("/notes/英語/単語.md"));
    }

    #[test]
    fn sanitizes() {
        assert_eq!(sanitize_file_name("a:b?.png"), "a_b_.png");
        assert_eq!(sanitize_file_name("  "), "無題");
    }
}
