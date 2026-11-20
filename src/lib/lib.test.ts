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
