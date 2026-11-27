// 表の読み書き（純粋関数）
// ・結合のない表は普通の Markdown の表（| a | b |）で保存する
// ・セルを結合した表だけ HTML の <table>（rowspan / colspan）で保存する
// セルの中身は Markdown の行内書式のまま持つ。改行は "\n"（保存時は <br>）。

export type Align = "" | "left" | "center" | "right";

export interface Merge {
  r: number;
  c: number;
  rs: number; // 縦に何マス
  cs: number; // 横に何マス
}

export interface TableModel {
  /** すべてのマス（結合で隠れたマスは ""）。1行目は見出し行 */
  cells: string[][];
  aligns: Align[];
  merges: Merge[];
}

export interface TableBlock {
  /** 行番号（1始まり、両端を含む） */
  startLine: number;
  endLine: number;
  model: TableModel;
  kind: "md" | "html";
}

// ---------- Markdown の表 ----------

const SEP_CELL = /^\s*:?-{1,}:?\s*$/;

/** "| a | b\|c |" → ["a", "b|c"]（\| は文字としての |） */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim().replace(/<br\s*\/?>/gi, "\n"));
}

export function isTableRow(line: string): boolean {
  return /^\s*\|/.test(line);
}

export function isSeparator(line: string): boolean {
  if (!isTableRow(line) && !line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => SEP_CELL.test(c));
}

function alignOf(sep: string): Align {
  const s = sep.trim();
  const l = s.startsWith(":");
  const r = s.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : "";
}

export function parseMarkdownTable(lines: string[]): TableModel | null {
  if (lines.length < 2 || !isTableRow(lines[0]) || !isSeparator(lines[1])) return null;
  const head = splitRow(lines[0]);
  const n = head.length;
  const aligns = splitRow(lines[1]).map(alignOf);
  const fit = <T>(a: T[], fill: T) => (a.length >= n ? a.slice(0, n) : [...a, ...Array<T>(n - a.length).fill(fill)]);
  const cells = [fit(head, ""), ...lines.slice(2).map((l) => fit(splitRow(l), ""))];
  return { cells, aligns: fit(aligns, "" as Align), merges: [] };
}

function escapeCellMd(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function toMarkdown(t: TableModel): string {
  const row = (cells: string[]) => `| ${cells.map((c) => escapeCellMd(c.trim())).join(" | ")} |`;
  const sep = t.aligns.map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---"));
  return [row(t.cells[0]), `| ${sep.join(" | ")} |`, ...t.cells.slice(1).map(row)].join("\n");
}

// ---------- HTML の表 ----------

function decodeEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function encodeEntities(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

export function parseHtmlTable(src: string): TableModel | null {
  if (!/^\s*<table[\s>]/i.test(src) || !/<\/table>\s*$/i.test(src)) return null;
  const rows: { text: string; rs: number; cs: number; align: Align }[][] = [];
  for (const tr of src.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row: { text: string; rs: number; cs: number; align: Align }[] = [];
    for (const td of tr[1].matchAll(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const attr = td[2];
      const num = (name: string) => {
        const m = new RegExp(`${name}\\s*=\\s*"?(\\d+)`, "i").exec(attr);
        return m ? Math.max(1, Math.min(100, Number(m[1]))) : 1;
      };
      const am = /text-align\s*:\s*(left|center|right)/i.exec(attr) ?? /align\s*=\s*"?(left|center|right)/i.exec(attr);
      row.push({ text: decodeEntities(td[3].trim()), rs: num("rowspan"), cs: num("colspan"), align: (am?.[1].toLowerCase() ?? "") as Align });
    }
    rows.push(row);
  }
  if (!rows.length || !rows.some((r) => r.length)) return null;
  // マスに並べる（上の行の rowspan で埋まっているマスは飛ばす）
  const grid: (string | null)[][] = [];
  const merges: Merge[] = [];
  const aligns: Align[] = [];
  let width = 0;
  rows.forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of row) {
      while (grid[r][c] !== undefined) c++;
      for (let i = 0; i < cell.rs; i++) {
        grid[r + i] ??= [];
        for (let j = 0; j < cell.cs; j++) grid[r + i][c + j] = i === 0 && j === 0 ? cell.text : "";
      }
      if (cell.rs > 1 || cell.cs > 1) merges.push({ r, c, rs: cell.rs, cs: cell.cs });
      if (cell.align && aligns[c] === undefined) aligns[c] = cell.align;
      c += cell.cs;
      width = Math.max(width, c);
    }
  });
  const height = rows.length;
  const cells: string[][] = [];
  for (let r = 0; r < height; r++) {
    cells.push(Array.from({ length: width }, (_, c) => grid[r]?.[c] ?? ""));
  }
  // 表の外にはみ出した結合は切り詰める
  const fixed = merges
    .map((m) => ({ ...m, rs: Math.min(m.rs, height - m.r), cs: Math.min(m.cs, width - m.c) }))
    .filter((m) => m.rs > 1 || m.cs > 1);
  return { cells, aligns: Array.from({ length: width }, (_, c) => aligns[c] ?? ""), merges: fixed };
}

export function toHtml(t: TableModel): string {
  const covered = coveredSet(t);
  const lines = ["<table>"];
  t.cells.forEach((row, r) => {
    const tag = r === 0 ? "th" : "td";
    let s = "<tr>";
    row.forEach((text, c) => {
      if (covered.has(`${r},${c}`)) return;
      const m = mergeAt(t, r, c);
      let attrs = "";
      if (m && m.r === r && m.c === c) {
        if (m.rs > 1) attrs += ` rowspan="${m.rs}"`;
        if (m.cs > 1) attrs += ` colspan="${m.cs}"`;
      }
      const a = t.aligns[c];
      if (a) attrs += ` style="text-align:${a}"`;
      s += `<${tag}${attrs}>${encodeEntities(text)}</${tag}>`;
    });
    lines.push(`${s}</tr>`);
  });
  lines.push("</table>");
  return lines.join("\n");
}

/** 結合があれば HTML、なければ Markdown */
export function serialize(t: TableModel): string {
  return t.merges.length ? toHtml(t) : toMarkdown(t);
}

// ---------- 文書の中から表を探す ----------

/** 文書の行の配列から表を探す（コードブロックの中は除く） */
export function findTables(lines: string[]): TableBlock[] {
  const out: TableBlock[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (isTableRow(text) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) j++;
      const model = parseMarkdownTable(lines.slice(i, j));
      if (model) {
        out.push({ startLine: i + 1, endLine: j, model, kind: "md" });
        i = j - 1;
        continue;
      }
    }
    if (/^\s*<table[\s>]/i.test(text)) {
      let j = i;
      while (j < lines.length && !/<\/table>\s*$/i.test(lines[j])) j++;
      if (j < lines.length) {
        const model = parseHtmlTable(lines.slice(i, j + 1).join("\n"));
        if (model) {
          out.push({ startLine: i + 1, endLine: j + 1, model, kind: "html" });
          i = j;
        }
      }
    }
  }
  return out;
}

// ---------- 編集の操作 ----------

export function emptyTable(rows: number, cols: number): TableModel {
  return {
    cells: Array.from({ length: rows }, () => Array<string>(cols).fill("")),
    aligns: Array<Align>(cols).fill(""),
    merges: [],
  };
}

function clone(t: TableModel): TableModel {
  return { cells: t.cells.map((r) => [...r]), aligns: [...t.aligns], merges: t.merges.map((m) => ({ ...m })) };
}

export function mergeAt(t: TableModel, r: number, c: number): Merge | null {
  return t.merges.find((m) => r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs) ?? null;
}

/** 結合で隠れているマス "r,c" の集合 */
export function coveredSet(t: TableModel): Set<string> {
  const s = new Set<string>();
  for (const m of t.merges) {
    for (let i = 0; i < m.rs; i++) for (let j = 0; j < m.cs; j++) if (i || j) s.add(`${m.r + i},${m.c + j}`);
  }
  return s;
}

/** 結合のかたまりを（はみ出さないように）広げた長方形 */
export function expandRect(t: TableModel, r1: number, c1: number, r2: number, c2: number): { r1: number; c1: number; r2: number; c2: number } {
  let a = { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of t.merges) {
      const hit = m.r <= a.r2 && m.r + m.rs - 1 >= a.r1 && m.c <= a.c2 && m.c + m.cs - 1 >= a.c1;
      if (!hit) continue;
      const b = { r1: Math.min(a.r1, m.r), c1: Math.min(a.c1, m.c), r2: Math.max(a.r2, m.r + m.rs - 1), c2: Math.max(a.c2, m.c + m.cs - 1) };
      if (b.r1 !== a.r1 || b.c1 !== a.c1 || b.r2 !== a.r2 || b.c2 !== a.c2) {
        a = b;
        changed = true;
      }
    }
  }
  return a;
}

export function setCell(t: TableModel, r: number, c: number, text: string): TableModel {
  const n = clone(t);
  n.cells[r][c] = text;
  return n;
}

export function insertRow(t: TableModel, at: number): TableModel {
  const n = clone(t);
  n.cells.splice(at, 0, Array<string>(n.aligns.length).fill(""));
  for (const m of n.merges) {
    if (m.r >= at) m.r++;
    else if (m.r + m.rs > at) m.rs++; // 結合の途中に入れたら結合を伸ばす
  }
  return n;
}

export function deleteRow(t: TableModel, at: number): TableModel {
  if (t.cells.length <= 1) return t;
  const n = clone(t);
  // 結合の先頭行を消すときは、中身を次の行へ移す
  for (const m of n.merges) {
    if (m.r === at && m.rs > 1) n.cells[at + 1][m.c] = n.cells[at][m.c];
  }
  n.cells.splice(at, 1);
  n.merges = n.merges
    .map((m) => {
      if (m.r > at) return { ...m, r: m.r - 1 };
      if (m.r + m.rs > at) return { ...m, rs: m.rs - 1 };
      return m;
    })
    .filter((m) => m.rs > 0 && (m.rs > 1 || m.cs > 1));
  return n;
}

export function insertCol(t: TableModel, at: number): TableModel {
  const n = clone(t);
  for (const row of n.cells) row.splice(at, 0, "");
  n.aligns.splice(at, 0, "");
  for (const m of n.merges) {
    if (m.c >= at) m.c++;
    else if (m.c + m.cs > at) m.cs++;
  }
  return n;
}

export function deleteCol(t: TableModel, at: number): TableModel {
  if (t.aligns.length <= 1) return t;
  const n = clone(t);
  for (const m of n.merges) {
    if (m.c === at && m.cs > 1) n.cells[m.r][at + 1] = n.cells[m.r][at];
  }
  for (const row of n.cells) row.splice(at, 1);
  n.aligns.splice(at, 1);
  n.merges = n.merges
    .map((m) => {
      if (m.c > at) return { ...m, c: m.c - 1 };
      if (m.c + m.cs > at) return { ...m, cs: m.cs - 1 };
      return m;
    })
    .filter((m) => m.cs > 0 && (m.rs > 1 || m.cs > 1));
  return n;
}

/** 長方形のマスを1つに結合する（中身は改行でつなぐ） */
export function mergeCells(t: TableModel, r1: number, c1: number, r2: number, c2: number): TableModel {
  const a = expandRect(t, r1, c1, r2, c2);
  if (a.r1 === a.r2 && a.c1 === a.c2) return t;
  const n = clone(t);
  const texts: string[] = [];
  for (let r = a.r1; r <= a.r2; r++) {
    for (let c = a.c1; c <= a.c2; c++) {
      const v = n.cells[r][c].trim();
      if (v) texts.push(v);
      n.cells[r][c] = "";
    }
  }
  n.cells[a.r1][a.c1] = texts.join("\n");
  n.merges = n.merges.filter((m) => !(m.r >= a.r1 && m.r <= a.r2 && m.c >= a.c1 && m.c <= a.c2));
  n.merges.push({ r: a.r1, c: a.c1, rs: a.r2 - a.r1 + 1, cs: a.c2 - a.c1 + 1 });
  return n;
}

export function unmergeCell(t: TableModel, r: number, c: number): TableModel {
  const m = mergeAt(t, r, c);
  if (!m) return t;
  const n = clone(t);
  n.merges = n.merges.filter((x) => !(x.r === m.r && x.c === m.c));
  return n;
}

export function setAlign(t: TableModel, c: number, align: Align): TableModel {
  const n = clone(t);
  n.aligns[c] = align;
  return n;
}
