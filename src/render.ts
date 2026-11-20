// Markdown → HTML（閲覧・暗記モード用）
import MarkdownIt, { type StateCore, type StateInline } from "markdown-it";
import { parseLink } from "./lib/links";
import { parseFrontmatter } from "./lib/text";

export interface RenderContext {
  /** リンク先のノートのパス（見つからなければ null） */
  resolve(target: string): string | null;
  /** attachments 内の画像の表示用URL（見つからなければ null） */
  imageSrc(name: string): string | null;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

let ctx: RenderContext = { resolve: () => null, imageSrc: () => null };

function delimited(open: string, close: string, type: string) {
  return (state: StateInline, silent: boolean): boolean => {
    const start = state.pos;
    if (!state.src.startsWith(open, start)) return false;
    const end = state.src.indexOf(close, start + open.length);
    if (end < 0 || end === start + open.length) return false;
    if (state.src.slice(start + open.length, end).includes("\n")) return false;
    if (!silent) {
      const oldMax = state.posMax;
      state.push(`${type}_open`, type === "mark" ? "mark" : "span", 1);
      state.pos = start + open.length;
      state.posMax = end;
      state.md.inline.tokenize(state);
      state.push(`${type}_close`, type === "mark" ? "mark" : "span", -1);
      state.posMax = oldMax;
    }
    state.pos = end + close.length;
    return true;
  };
}

function wikilink(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const embed = state.src.startsWith("![[", start);
  if (!embed && !state.src.startsWith("[[", start)) return false;
  const innerStart = start + (embed ? 3 : 2);
  const end = state.src.indexOf("]]", innerStart);
  if (end < 0) return false;
  const inner = state.src.slice(innerStart, end);
  if (!inner.trim() || inner.includes("\n") || inner.includes("[")) return false;
  if (!silent) {
    const t = state.push("wikilink", "", 0);
    t.meta = { embed, ...parseLink(inner) };
  }
  state.pos = end + 2;
  return true;
}

function sourceLines(state: StateCore) {
  for (const t of state.tokens) {
    if (t.map && t.nesting === 1) t.attrSet("data-line", String(t.map[0]));
  }
}

function taskLists(state: StateCore) {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
    const first = t.children?.[0];
    const m = first && first.type === "text" ? /^\[([ xX])\]\s/.exec(first.content) : null;
    if (!m || !first) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled${m[1] !== " " ? " checked" : ""}> `;
    t.children!.unshift(box);
    toks[i - 2].attrJoin("class", "task");
  }
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
md.inline.ruler.before("link", "wikilink", wikilink);
md.inline.ruler.before("emphasis", "mark", delimited("==", "==", "mark"));
md.inline.ruler.before("emphasis", "cloze", delimited("{{", "}}", "cloze"));
md.core.ruler.push("source_lines", sourceLines);
md.core.ruler.push("task_lists", taskLists);

md.renderer.rules.mark_open = () => '<mark class="hl">';
md.renderer.rules.mark_close = () => "</mark>";
md.renderer.rules.cloze_open = () => '<span class="cloze">';
md.renderer.rules.cloze_close = () => "</span>";

md.renderer.rules.wikilink = (tokens, idx) => {
  const m = tokens[idx].meta as { embed: boolean; target: string; heading: string | null; alias: string | null };
  const esc = md.utils.escapeHtml;
  if (m.embed && IMAGE_RE.test(m.target)) {
    const src = ctx.imageSrc(m.target);
    if (!src) return `<span class="img-missing">画像が見つかりません: ${esc(m.target)}</span>`;
    const width = m.alias && /^\d+$/.test(m.alias) ? ` width="${m.alias}"` : "";
    return `<img class="embed" src="${esc(src)}" alt="${esc(m.target)}"${width}>`;
  }
  const path = ctx.resolve(m.target);
  const label = m.alias ?? (m.heading ? `${m.target} › ${m.heading}` : m.target);
  const cls = path ? "wl" : "wl missing";
  const title = path ? "クリックで開く／Ctrl+クリックで反対側に開く" : "まだないノートです。クリックで作成";
  return `<a href="#" class="${cls}" data-target="${esc(m.target)}" data-heading="${esc(m.heading ?? "")}" title="${title}">${esc(label)}</a>`;
};

// 外部リンクは既定のブラウザで開く（クリック時に main 側で処理）
const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  tokens[idx].attrJoin("class", "ext");
  return defaultLinkOpen(tokens, idx, opts, env, self);
};

/** フロントマターを除いた本文をHTMLにする。data-line は元ファイルの行番号 */
export function renderNote(content: string, context: RenderContext): string {
  ctx = context;
  const { bodyStart } = parseFrontmatter(content);
  const skippedLines = content.slice(0, bodyStart).split("\n").length - 1;
  let html = md.render(content.slice(bodyStart));
  if (skippedLines > 0) {
    html = html.replace(/data-line="(\d+)"/g, (_m, n: string) => `data-line="${Number(n) + skippedLines}"`);
  }
  return html;
}
