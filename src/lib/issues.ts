// AIの指摘を本文中の位置に対応づける

export type IssueKind = "typo" | "style" | "fact";

export interface Issue {
  kind: IssueKind;
  original: string;
  suggestion: string;
  reason: string;
}

export interface LocatedIssue extends Issue {
  id: number;
  from: number;
  to: number;
  status: "open" | "accepted" | "ignored" | "lost";
}

const SYNTAX_TOKENS = ["==", "[[", "]]", "![[", "{{", "}}", "**", "|", "#"];

function count(s: string, token: string): number {
  let n = 0;
  let i = 0;
  while ((i = s.indexOf(token, i)) >= 0) {
    n++;
    i += token.length;
  }
  return n;
}

/** 記法の記号を増減させる提案は捨てる */
export function isSyntaxSafe(original: string, suggestion: string): boolean {
  return SYNTAX_TOKENS.every((t) => count(original, t) === count(suggestion, t));
}

/**
 * 指摘を本文中の位置に置く。同じ文字列が複数あるときは、まだ使っていない最初の出現を使う。
 * baseOffset は送信した範囲の開始位置（選択範囲だけ送った場合）。
 */
export function locateIssues(text: string, issues: Issue[], baseOffset = 0, startId = 1): LocatedIssue[] {
  const used: [number, number][] = [];
  const overlaps = (a: number, b: number) => used.some(([x, y]) => a < y && x < b);
  const out: LocatedIssue[] = [];
  let id = startId;
  for (const is of issues) {
    if (!is.original || !isSyntaxSafe(is.original, is.suggestion)) continue;
    let pos = text.indexOf(is.original);
    while (pos >= 0 && overlaps(pos, pos + is.original.length)) pos = text.indexOf(is.original, pos + 1);
    if (pos < 0) continue;
    used.push([pos, pos + is.original.length]);
    out.push({ ...is, id: id++, from: baseOffset + pos, to: baseOffset + pos + is.original.length, status: "open" });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** 本文が変更されたときに、指摘の位置をずらす。指摘範囲そのものが変わったら lost にする */
export function shiftIssues(issues: LocatedIssue[], changeFrom: number, changeTo: number, insertedLength: number): LocatedIssue[] {
  const delta = insertedLength - (changeTo - changeFrom);
  return issues.map((is) => {
    if (is.status !== "open") return is;
    if (changeTo <= is.from) return { ...is, from: is.from + delta, to: is.to + delta };
    if (changeFrom >= is.to) return is;
    return { ...is, status: "lost" };
  });
}
