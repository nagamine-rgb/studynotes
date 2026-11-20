// フロントマター、あいまい検索、キーワード化（==）などの純粋関数

export interface Frontmatter {
  data: Record<string, string>;
  /** 本文の開始位置（フロントマターの直後） */
  bodyStart: number;
}

export function parseFrontmatter(content: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { data: {}, bodyStart: 0 };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) data[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { data, bodyStart: m[0].length };
}

export interface MaskTargets {
  highlight: boolean;
  cloze: boolean;
  bold: boolean;
}

/** フロントマターの mask: を設定値より優先する */
export function maskTargetsFor(content: string, defaults: MaskTargets): MaskTargets {
  const v = parseFrontmatter(content).data["mask"];
  if (v === undefined) return defaults;
  const set = new Set(
    v
      .replace(/[\[\]]/g, "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (set.has("none")) return { highlight: false, cloze: false, bold: false };
  return { highlight: set.has("highlight"), cloze: set.has("cloze"), bold: set.has("bold") };
}

/** あいまい一致。一致しなければ -1、一致すれば点数（大きいほど良い） */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 - (t.length - q.length) * 0.1 + (idx === 0 ? 200 : 0);
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
  /** 編集後の選択範囲 */
  selFrom: number;
  selTo: number;
}

/**
 * 選択範囲を ==…== で囲む／外す（Ctrl+H）。
 * 選択が空でカーソルが ==…== の中にあれば外す。
 */
export function toggleHighlight(doc: string, from: number, to: number): Edit | null {
  // 選択がすでに ==…== を含んでいる
  const sel = doc.slice(from, to);
  if (sel.length >= 4 && sel.startsWith("==") && sel.endsWith("==")) {
    const inner = sel.slice(2, -2);
    return { from, to, insert: inner, selFrom: from, selTo: from + inner.length };
  }
  // 選択の外側が == で囲まれている
  if (doc.slice(from - 2, from) === "==" && doc.slice(to, to + 2) === "==" && to > from) {
    return { from: from - 2, to: to + 2, insert: sel, selFrom: from - 2, selTo: to - 2 };
  }
  // カーソルを含む ==…== を探す（同じ行の中だけ）
  const lineStart = doc.lastIndexOf("\n", from - 1) + 1;
  const lineEndIdx = doc.indexOf("\n", to);
  const lineEnd = lineEndIdx < 0 ? doc.length : lineEndIdx;
  const line = doc.slice(lineStart, lineEnd);
  for (const m of line.matchAll(/==([^=\n]+)==/g)) {
    const s = lineStart + (m.index ?? 0);
    const e = s + m[0].length;
    if (from >= s && to <= e) {
      return { from: s, to: e, insert: m[1], selFrom: s, selTo: s + m[1].length };
    }
  }
  if (from === to) return null;
  if (sel.includes("\n")) return null;
  return { from, to, insert: `==${sel}==`, selFrom: from + 2, selTo: to + 2 };
}

/** 全文検索：行ごとの一致を返す */
export function searchLines(content: string, query: string, limit = 5): { line: number; text: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: { line: number; text: string }[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    if (lines[i].toLowerCase().includes(q)) out.push({ line: i, text: lines[i].trim().slice(0, 120) });
  }
  return out;
}

export function timestampName(prefix: string, ext: string, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}
