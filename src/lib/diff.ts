// 2つの文章の違いを行ごとに求める（競合コピーの比較用）

export interface DiffLine {
  kind: "same" | "del" | "add"; // del = 元にだけある行、add = 競合コピーにだけある行
  text: string;
}

/** 最長共通部分列で行の差分を求める。長すぎる場合は前後の共通部分を除いてから計算する */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const head: DiffLine[] = x.slice(0, start).map((t) => ({ kind: "same", text: t }));
  const tail: DiffLine[] = x.slice(endX).map((t) => ({ kind: "same", text: t }));
  const xs = x.slice(start, endX);
  const ys = y.slice(start, endY);
  const n = xs.length;
  const m = ys.length;
  // 中間が大きすぎる場合は単純に「削除→追加」で表す
  if (n * m > 4_000_000) {
    return [...head, ...xs.map((t) => ({ kind: "del" as const, text: t })), ...ys.map((t) => ({ kind: "add" as const, text: t })), ...tail];
  }
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = xs[i] === ys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (xs[i] === ys[j]) {
      mid.push({ kind: "same", text: xs[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) mid.push({ kind: "del", text: xs[i++] });
    else mid.push({ kind: "add", text: ys[j++] });
  }
  while (i < n) mid.push({ kind: "del", text: xs[i++] });
  while (j < m) mid.push({ kind: "add", text: ys[j++] });
  return [...head, ...mid, ...tail];
}
