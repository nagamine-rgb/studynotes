import { describe, expect, it } from "vitest";
import { extractLinks, parseLink, renameLinks, resolveLink, noteName } from "./links";
import { fuzzyScore, maskTargetsFor, parseFrontmatter, toggleHighlight, timestampName } from "./text";
import { isSyntaxSafe, locateIssues, shiftIssues } from "./issues";
import { renderNote } from "../render";

describe("links", () => {
  it("parses targets, headings, aliases", () => {
    expect(parseLink("鎌倉時代#できごと|まとめ")).toEqual({ target: "鎌倉時代", heading: "できごと", alias: "まとめ" });
    expect(extractLinks("a [[x]] ![[img.png]] [[y|Y]]")).toEqual(["x", "y"]);
    expect(noteName("英語/単語.md")).toBe("単語");
  });

  it("resolves by file name, preferring same folder then shallow", () => {
    const paths = ["英語/単語.md", "歴史/単語.md", "単語.md", "歴史/元寇.md"];
    expect(resolveLink("単語", "歴史/元寇.md", paths)).toBe("歴史/単語.md");
    expect(resolveLink("単語", "x.md", paths)).toBe("単語.md");
    expect(resolveLink("英語/単語", null, paths)).toBe("英語/単語.md");
    expect(resolveLink("元寇", null, paths)).toBe("歴史/元寇.md");
    expect(resolveLink("なし", null, paths)).toBeNull();
  });

  it("rewrites links on rename but not embeds or other names", () => {
    const src = "[[元寇]] [[元寇|げんこう]] [[元寇#1回目]] [[歴史/元寇]] [[元寇の後]] ![[元寇]]";
    expect(renameLinks(src, "元寇", "蒙古襲来")).toBe(
      "[[蒙古襲来]] [[蒙古襲来|げんこう]] [[蒙古襲来#1回目]] [[歴史/蒙古襲来]] [[元寇の後]] ![[元寇]]",
    );
  });
});

describe("text", () => {
  it("reads frontmatter and mask targets", () => {
    const c = "---\nmask: highlight, bold\ntags: [a]\n---\n# T";
    expect(parseFrontmatter(c).data.mask).toBe("highlight, bold");
    expect(c.slice(parseFrontmatter(c).bodyStart)).toBe("# T");
    expect(maskTargetsFor(c, { highlight: true, cloze: true, bold: false })).toEqual({ highlight: true, cloze: false, bold: true });
    expect(maskTargetsFor("# T", { highlight: true, cloze: true, bold: false }).cloze).toBe(true);
  });

  it("toggles == around selection and cursor", () => {
    const d = "abandon = 見捨てる";
    const e = toggleHighlight(d, 10, 14)!;
    expect(d.slice(0, e.from) + e.insert + d.slice(e.to)).toBe("abandon = ==見捨てる==");
    const d2 = "abandon = ==見捨てる==";
    const e2 = toggleHighlight(d2, 13, 13)!;
    expect(d2.slice(0, e2.from) + e2.insert + d2.slice(e2.to)).toBe("abandon = 見捨てる");
    expect(toggleHighlight("abc", 1, 1)).toBeNull();
  });

  it("fuzzy matches", () => {
    expect(fuzzyScore("仮定", "文法_仮定法")).toBeGreaterThan(0);
    expect(fuzzyScore("tnt", "unit1_note")).toBeGreaterThan(0);
    expect(fuzzyScore("zz", "abc")).toBe(-1);
    expect(fuzzyScore("単語", "単語_Unit1")).toBeGreaterThan(fuzzyScore("単語", "重要単語"));
  });

  it("builds timestamp names", () => {
    expect(timestampName("画像", "png", new Date(2026, 10, 21, 0, 1, 2))).toBe("画像_20261121_000102.png");
  });
});

describe("issues", () => {
  it("drops suggestions that break syntax", () => {
    expect(isSyntaxSafe("==見捨るる==", "==見捨てる==")).toBe(true);
    expect(isSyntaxSafe("==見捨てる==", "見捨てる")).toBe(false);
  });

  it("locates issues and shifts them on edits", () => {
    const text = "あいう かきく あいう";
    const loc = locateIssues(
      text,
      [
        { kind: "typo", original: "あいう", suggestion: "アイウ", reason: "" },
        { kind: "typo", original: "あいう", suggestion: "アイウ", reason: "" },
        { kind: "typo", original: "ない", suggestion: "x", reason: "" },
      ],
      100,
    );
    expect(loc.map((i) => [i.from, i.to])).toEqual([
      [100, 103],
      [108, 111],
    ]);
    const shifted = shiftIssues(loc, 104, 104, 2);
    expect(shifted[0].from).toBe(100);
    expect(shifted[1].from).toBe(110);
    expect(shiftIssues(loc, 101, 102, 0)[0].status).toBe("lost");
  });
});

describe("render", () => {
  const ctx = {
    resolve: (t: string) => (t === "元寇" ? "歴史/元寇.md" : null),
    imageSrc: (n: string) => (n === "図.png" ? "asset://図.png" : null),
  };

  it("renders marks, cloze, links and images", () => {
    const html = renderNote("---\nmask: bold\n---\n# 題\n- ==1192==年 {{征夷大将軍}}\n- [[元寇]] [[承久の乱]]\n![[図.png|300]]", ctx);
    expect(html).toContain('<mark class="hl">1192</mark>');
    expect(html).toContain('<span class="cloze">征夷大将軍</span>');
    expect(html).toContain('class="wl" data-target="元寇"');
    expect(html).toContain('class="wl missing" data-target="承久の乱"');
    expect(html).toContain('src="asset://図.png" alt="図.png" width="300"');
    expect(html).toContain('<h1 data-line="3">');
    expect(html).not.toContain("mask: bold");
  });

  it("escapes html and renders task lists", () => {
    const html = renderNote("<script>x</script>\n\n- [x] 済み\n- [ ] まだ", ctx);
    expect(html).not.toContain("<script>");
    expect(html).toContain('<input type="checkbox" disabled checked> 済み');
  });
});

import { findConflicts } from "./conflicts";
import { diffLines } from "./diff";

describe("conflicts", () => {
  it("detects copies from each sync app", () => {
    const paths = [
      "英語/単語.md",
      "英語/単語 (Taro's conflicted copy 2026-11-26).md",
      "英語/単語 (Taro の競合コピー 2026-11-26).md",
      "英語/単語.sync-conflict-20261126-123456-ABCDEF1.md",
      "英語/単語-DESKTOP-AB12CD.md",
      "英語/単語 (conflict).md",
      "attachments/図.png",
      "attachments/図-LAPTOP-XY99.png",
      "歴史/元寇.md",
      "歴史/元寇-TOEIC.md", // 普通のノート名（PC名らしくない）なので競合ではない
      "歴史/NOTE-ABCD.md", // 元の NOTE.md がないので競合ではない
      "歴史/鎌倉時代.md",
    ];
    const c = findConflicts(paths);
    const byPath = Object.fromEntries(c.map((x) => [x.path, x]));
    expect(byPath["英語/単語 (Taro's conflicted copy 2026-11-26).md"]).toMatchObject({ original: "英語/単語.md", source: "Dropbox" });
    expect(byPath["英語/単語 (Taro の競合コピー 2026-11-26).md"]).toMatchObject({ original: "英語/単語.md", source: "Dropbox" });
    expect(byPath["英語/単語.sync-conflict-20261126-123456-ABCDEF1.md"]).toMatchObject({ original: "英語/単語.md", source: "Syncthing" });
    expect(byPath["英語/単語-DESKTOP-AB12CD.md"]).toMatchObject({ original: "英語/単語.md", source: "OneDrive" });
    expect(byPath["英語/単語 (conflict).md"]).toMatchObject({ original: "英語/単語.md" });
    expect(byPath["attachments/図-LAPTOP-XY99.png"]).toMatchObject({ original: "attachments/図.png" });
    expect(byPath["歴史/NOTE-ABCD.md"]).toBeUndefined();
    expect(byPath["歴史/元寇-TOEIC.md"]).toBeUndefined();
    expect(byPath["歴史/鎌倉時代.md"]).toBeUndefined();
    expect(byPath["英語/単語.md"]).toBeUndefined();
  });
});

describe("diff", () => {
  it("finds added and removed lines", () => {
    const d = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(d.map((l) => `${l.kind}:${l.text}`)).toEqual(["same:a", "del:b", "add:B", "same:c", "same:d", "add:e"]);
  });
});

import * as T from "./table";
import { renameEmbeds } from "./links";

describe("table", () => {
  const md = "| 科目 | 評価 |\n| --- | :---: |\n| 物理 | A |\n| ![[図.png\\|200]] | x\\|y<br>z |";
  it("parses and writes markdown tables", () => {
    const t = T.parseMarkdownTable(md.split("\n"))!;
    expect(t.cells).toEqual([["科目", "評価"], ["物理", "A"], ["![[図.png|200]]", "x|y\nz"]]);
    expect(t.aligns).toEqual(["", "center"]);
    expect(T.toMarkdown(t)).toBe(md);
    expect(parseLink("図.png\\|200")).toMatchObject({ target: "図.png", alias: "200" });
    expect(renameEmbeds(md, "図.png", "図2.png")).toContain("![[図2.png\\|200]]");
    expect(renameLinks("| [[a\\|A]] |", "a", "b")).toBe("| [[b\\|A]] |");
  });
  it("finds tables outside code blocks", () => {
    const lines = ["# x", "", ...md.split("\n"), "", "```", "| a |", "| - |", "```", "<table>", "<tr><th>a</th></tr>", "</table>"];
    const found = T.findTables(lines);
    expect(found.map((b) => [b.startLine, b.endLine, b.kind])).toEqual([[3, 6, "md"], [12, 14, "html"]]);
  });
  it("merges cells and writes html, unmerge returns to markdown", () => {
    let t = T.emptyTable(3, 3);
    t = T.setCell(t, 0, 0, "科目");
    t = T.setCell(t, 0, 2, "評価");
    t = T.setCell(t, 1, 0, "物理");
    t = T.setCell(t, 1, 1, "実技");
    t = T.setCell(t, 2, 1, "理論");
    t = T.setCell(t, 1, 2, "A");
    t = T.setCell(t, 2, 2, "B+");
    t = T.mergeCells(t, 0, 0, 0, 1);
    t = T.mergeCells(t, 1, 0, 2, 0);
    const html = T.serialize(t);
    expect(html).toBe(
      '<table>\n<tr><th colspan="2">科目</th><th>評価</th></tr>\n<tr><td rowspan="2">物理</td><td>実技</td><td>A</td></tr>\n<tr><td>理論</td><td>B+</td></tr>\n</table>',
    );
    const back = T.parseHtmlTable(html)!;
    expect(back.cells).toEqual(t.cells);
    expect(back.merges).toEqual(t.merges);
    let u = T.unmergeCell(back, 2, 0);
    u = T.unmergeCell(u, 0, 1);
    expect(T.serialize(u).startsWith("| 科目 |")).toBe(true);
  });
  it("keeps merges consistent when rows/cols change", () => {
    let t = T.mergeCells(T.emptyTable(4, 3), 1, 0, 2, 0);
    t = T.setCell(t, 1, 0, "物理");
    expect(T.insertRow(t, 2).merges).toEqual([{ r: 1, c: 0, rs: 3, cs: 1 }]);
    expect(T.insertRow(t, 0).merges).toEqual([{ r: 2, c: 0, rs: 2, cs: 1 }]);
    const d = T.deleteRow(t, 1);
    expect(d.merges).toEqual([]);
    expect(d.cells[1][0]).toBe("物理");
    expect(T.insertCol(T.mergeCells(T.emptyTable(2, 3), 0, 0, 0, 1), 1).merges).toEqual([{ r: 0, c: 0, rs: 1, cs: 3 }]);
    expect(T.deleteCol(T.mergeCells(T.emptyTable(2, 3), 0, 0, 0, 1), 0).merges).toEqual([]);
    // 結合の一部だけ選んでも結合全体が含まれるよう広がる
    expect(T.expandRect(T.mergeCells(T.emptyTable(3, 3), 0, 0, 1, 1), 1, 1, 2, 2)).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
  });
});
