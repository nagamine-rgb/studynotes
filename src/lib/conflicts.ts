// 同期アプリが作る「競合コピー」を見つける

export interface Conflict {
  /** 競合コピーのパス */
  path: string;
  /** 元のファイルのパス（見つからなければ null） */
  original: string | null;
  /** どの同期アプリの形式か（表示用） */
  source: string;
}

function split(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { dir, stem: name.slice(0, dot), ext: name.slice(dot) } : { dir, stem: name, ext: "" };
}

/** 競合コピーの名前から、元の名前（拡張子なし）を取り出す */
function originalStem(stem: string, _ext: string): { stem: string; source: string; strict: boolean } | null {
  let m: RegExpExecArray | null;
  // Syncthing: ノート.sync-conflict-20261126-123456-ABCDEFG.md
  if ((m = /^(.*)\.sync-conflict-\d{8}-\d{6}(-[A-Z0-9]+)?$/.exec(stem))) return { stem: m[1], source: "Syncthing", strict: true };
  // Dropbox: ノート (Taro's conflicted copy 2026-11-26).md ／ ノート (Taro の競合コピー 2026-11-26).md
  if ((m = /^(.*?)\s*[(（][^()（）]*(conflicted copy|競合コピー|競合したコピー)[^()（）]*[)）]$/i.exec(stem)))
    return { stem: m[1], source: "Dropbox", strict: true };
  // 名前に conflict / 競合 を含むもの（FolderSync など）
  if ((m = /^(.*?)[\s._-]*[(（\[]?[^()（）\[\]]*(conflict|競合)[^()（）\[\]]*[)）\]]?$/i.exec(stem)) && m[1])
    return { stem: m[1], source: "同期アプリ", strict: true };
  return null;
}

/** OneDrive 形式の末尾（PC名）らしいか：DESKTOP-ABC123、LAPTOP-XY99、数字を含む大文字の名前など */
function looksLikePcName(s: string): boolean {
  if (!/^[A-Z0-9][A-Z0-9-]{3,}$/.test(s) || !/[A-Z]/.test(s)) return false;
  return /^(DESKTOP|LAPTOP|PC|NOTEBOOK|SURFACE|MACBOOK|IMAC|MSI|ASUS|LENOVO|DELL|HP)(-|$)/.test(s) || /\d/.test(s);
}

/** OneDrive: ノート-DESKTOP-ABC123.md（末尾にPC名。同じフォルダに元のファイルがある場合だけ） */
function oneDriveOriginal(dir: string, stem: string, ext: string, lower: Map<string, string>): string | null {
  for (let i = stem.indexOf("-"); i > 0; i = stem.indexOf("-", i + 1)) {
    if (!looksLikePcName(stem.slice(i + 1))) continue;
    const hit = lower.get(`${dir}${stem.slice(0, i)}${ext}`.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/**
 * ファイル一覧から競合コピーを探す。
 * OneDrive 形式のように紛らわしいものは、同じフォルダに元のファイルがあるときだけ競合とみなす。
 */
export function findConflicts(paths: string[]): Conflict[] {
  const lower = new Map(paths.map((p) => [p.toLowerCase(), p]));
  const out: Conflict[] = [];
  for (const p of paths) {
    const { dir, stem, ext } = split(p);
    const o = originalStem(stem, ext);
    if (!o) {
      const od = ext ? oneDriveOriginal(dir, stem, ext, lower) : null;
      if (od) out.push({ path: p, original: od, source: "OneDrive" });
      continue;
    }
    const original = lower.get(`${dir}${o.stem}${ext}`.toLowerCase()) ?? null;
    if (!original && !o.strict) continue;
    if (original === p) continue;
    out.push({ path: p, original, source: o.source });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, "ja"));
}
