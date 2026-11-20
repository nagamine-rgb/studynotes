// [[ノート名]] 形式のリンクに関する純粋関数

export interface ParsedLink {
  target: string; // ノート名（フォルダ付きも可）
  heading: string | null;
  alias: string | null; // 表示名 または 画像の幅
}

export const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

export function parseLink(inner: string): ParsedLink {
  const bar = inner.indexOf("|");
  const main = bar >= 0 ? inner.slice(0, bar) : inner;
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() : null;
  const hash = main.indexOf("#");
  const target = (hash >= 0 ? main.slice(0, hash) : main).trim();
  const heading = hash >= 0 ? main.slice(hash + 1).trim() || null : null;
  return { target, heading, alias: alias || null };
}

/** ノート本文からリンク先（埋め込みを除く）を取り出す */
export function extractLinks(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    if (m[1] === "!") continue;
    const t = parseLink(m[2]).target;
    if (t) out.push(t);
  }
  return out;
}

export function fileName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

/** "英語/単語.md" → "単語" */
export function noteName(path: string): string {
  return fileName(path).replace(/\.md$/i, "");
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * リンク先のノートを探す。ファイル名（拡張子なし、大文字小文字は区別しない）で照合し、
 * 同名が複数あれば リンク元と同じフォルダ → 浅い階層 → パス順 で選ぶ。
 */
export function resolveLink(target: string, fromPath: string | null, notePaths: Iterable<string>): string | null {
  let t = target.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!t) return null;
  if (!/\.md$/i.test(t)) t = `${t}.md`;
  const lowerT = t.toLowerCase();
  const hasDir = t.includes("/");
  const candidates: string[] = [];
  for (const p of notePaths) {
    const lp = p.toLowerCase();
    if (hasDir ? lp === lowerT || lp.endsWith(`/${lowerT}`) : fileName(lp) === lowerT) candidates.push(p);
  }
  if (candidates.length === 0) return null;
  const fromDir = fromPath ? dirName(fromPath).toLowerCase() : null;
  candidates.sort((a, b) => {
    const sa = fromDir !== null && dirName(a).toLowerCase() === fromDir ? 0 : 1;
    const sb = fromDir !== null && dirName(b).toLowerCase() === fromDir ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const da = a.split("/").length;
    const db = b.split("/").length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
  return candidates[0];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ノート名の変更に合わせて本文中のリンクを書き換える。
 * [[旧名]] [[旧名|表示]] [[旧名#見出し]] [[フォルダ/旧名]] に対応。埋め込み ![[...]] は対象外。
 */
export function renameLinks(content: string, oldName: string, newName: string): string {
  const re = new RegExp(`(?<!!)\\[\\[((?:[^\\[\\]\\n|#]*/)?)(${escapeRe(oldName)})(\\.md)?(?=[\\]|#])`, "gi");
  return content.replace(re, (_m, dir: string, _name: string, ext: string | undefined) => `[[${dir}${newName}${ext ?? ""}`);
}

/** 画像の埋め込みファイル名を書き換える（attachments の名前変更用） */
export function renameEmbeds(content: string, oldFile: string, newFile: string): string {
  const re = new RegExp(`!\\[\\[(${escapeRe(oldFile)})(?=[\\]|])`, "gi");
  return content.replace(re, `![[${newFile}`);
}
