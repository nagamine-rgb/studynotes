// 編集画面のライブプレビュー：カーソルのある行だけ記号を見せ、ほかの行は整形して表示する
import { type EditorState, type Range, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { parseLink } from "./lib/links";

export interface LivePreviewOptions {
  linkExists(target: string): boolean;
  imageSrc(nameOrPath: string): string | null;
  backlinks(): { path: string; label: string; dir: string }[];
  openLink(target: string, heading: string | null, other: boolean): void;
  openBacklink(path: string, other: boolean): void;
  openUrl(url: string): void;
}

/** フォーカスの有無（フォーカスがないときはどの行も整形表示） */
export const setFocused = StateEffect.define<boolean>();
/** ノートの増減などでリンクの色・バックリンクを描き直す */
export const refreshPreview = StateEffect.define<null>();

class ImageWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly src: string | null,
    readonly width: string | null,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.name === this.name && o.src === this.src && o.width === this.width;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-image";
    if (!this.src) {
      wrap.className = "cm-image missing";
      wrap.textContent = `画像が見つかりません: ${this.name}`;
      return wrap;
    }
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.name;
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    wrap.append(img);
    return wrap;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number, // "[ ]" の中の文字の位置
  ) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-hr";
    return s;
  }
}

class BacklinksWidget extends WidgetType {
  constructor(
    readonly items: { path: string; label: string; dir: string }[],
    readonly open: (path: string, other: boolean) => void,
  ) {
    super();
  }
  eq(o: BacklinksWidget) {
    return JSON.stringify(o.items) === JSON.stringify(this.items);
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-backlinks";
    const title = document.createElement("div");
    title.className = "backlinks-title";
    title.textContent = `バックリンク（${this.items.length}件）`;
    box.append(title);
    for (const it of this.items) {
      const a = document.createElement("a");
      a.href = "#";
      a.className = "bl";
      a.title = it.path;
      a.textContent = it.label;
      if (it.dir) {
        const d = document.createElement("span");
        d.className = "muted";
        d.textContent = `  ${it.dir}`;
        a.append(d);
      }
      a.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.open(it.path, e.ctrlKey || e.metaKey);
      });
      box.append(a);
    }
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

const hide = Decoration.replace({});
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

interface Span {
  from: number;
  to: number;
}

function overlaps(spans: Span[], from: number, to: number): boolean {
  return spans.some((s) => from < s.to && s.from < to);
}

export function buildDecorations(state: EditorState, focused: boolean, opts: LivePreviewOptions): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  // カーソル・選択範囲がかかっている行は記号をそのまま見せる
  const active = new Set<number>();
  if (focused) {
    for (const r of state.selection.ranges) {
      const a = doc.lineAt(r.from).number;
      const b = doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) active.add(n);
    }
  }
  let inFence = false;
  let inFront = doc.lines > 1 && doc.line(1).text.trim() === "---";
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;
    const isActive = active.has(n);
    const lineDeco = (cls: string) => out.push(Decoration.line({ class: cls }).range(line.from));

    if (inFront) {
      lineDeco("cm-frontmatter");
      if (n > 1 && text.trim() === "---") inFront = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      lineDeco("cm-codeblock cm-fence");
      continue;
    }
    if (inFence) {
      lineDeco("cm-codeblock");
      continue;
    }

    let bodyStart = 0; // 行頭の記号を除いた本文の開始位置（行内の相対位置）
    const h = /^(#{1,6})\s+/.exec(text);
    const quote = /^>\s?/.exec(text);
    const task = /^(\s*)[-*+] \[( |x|X)\] /.exec(text);
    const bullet = !task ? /^(\s*)([-*+]) /.exec(text) : null;
    if (h) {
      lineDeco(`cm-h${h[1].length}`);
      if (!isActive) out.push(hide.range(line.from, line.from + h[0].length));
      bodyStart = h[0].length;
    } else if (quote) {
      lineDeco("cm-quote");
      if (!isActive) out.push(hide.range(line.from, line.from + quote[0].length));
      bodyStart = quote[0].length;
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
      if (!isActive) out.push(Decoration.replace({ widget: new HrWidget() }).range(line.from, line.to));
      continue;
    } else if (task) {
      const checked = task[2] !== " ";
      lineDeco(`cm-li${checked ? " cm-done" : ""}`);
      if (!isActive) {
        const s = line.from + task[1].length;
        out.push(Decoration.replace({ widget: new CheckboxWidget(checked, s + 3) }).range(s, line.from + task[0].length));
      }
      bodyStart = task[0].length;
    } else if (bullet) {
      lineDeco("cm-li");
      if (!isActive) {
        const s = line.from + bullet[1].length;
        out.push(Decoration.replace({ widget: new BulletWidget() }).range(s, s + 1));
      }
      bodyStart = bullet[0].length;
    }

    // 行内の書式
    const body = text.slice(bodyStart);
    const base = line.from + bodyStart;
    const code: Span[] = [];
    for (const m of body.matchAll(/`([^`\n]+)`/g)) {
      const s = base + (m.index ?? 0);
      const e = s + m[0].length;
      code.push({ from: s, to: e });
      out.push(Decoration.mark({ class: "cm-inline-code" }).range(s, e));
      if (!isActive) out.push(hide.range(s, s + 1), hide.range(e - 1, e));
    }
    const taken: Span[] = [...code];
    const each = (re: RegExp, fn: (s: number, e: number, m: RegExpMatchArray) => void) => {
      for (const m of body.matchAll(re)) {
        const s = base + (m.index ?? 0);
        const e = s + m[0].length;
        if (overlaps(code, s, e)) continue;
        fn(s, e, m);
      }
    };
    // 画像 ![[名前|幅]] と ![説明](パス)
    each(/!\[\[([^\[\]\n]+)\]\]/g, (s, e, m) => {
      taken.push({ from: s, to: e });
      const p = parseLink(m[1]);
      if (!IMAGE_EXT.test(p.target)) {
        out.push(Decoration.mark({ class: "cm-embed" }).range(s, e));
        return;
      }
      const width = p.alias && /^\d+$/.test(p.alias) ? p.alias : null;
      const widget = new ImageWidget(p.target, opts.imageSrc(p.target), width);
      if (isActive) {
        out.push(Decoration.mark({ class: "cm-embed" }).range(s, e));
        out.push(Decoration.widget({ widget, block: true, side: 1 }).range(line.to));
      } else out.push(Decoration.replace({ widget }).range(s, e));
    });
    each(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (s, e, m) => {
      taken.push({ from: s, to: e });
      const url = m[2];
      const src = /^https?:\/\//i.test(url) ? url : opts.imageSrc(decodeURIComponent(url));
      const widget = new ImageWidget(m[1] || url, src, null);
      if (isActive) out.push(Decoration.widget({ widget, block: true, side: 1 }).range(line.to));
      else out.push(Decoration.replace({ widget }).range(s, e));
    });
    // リンク [[ノート名#見出し|表示名]]
    each(/\[\[([^\[\]\n]+)\]\]/g, (s, e, m) => {
      if (overlaps(taken, s, e)) return;
      taken.push({ from: s, to: e });
      const p = parseLink(m[1]);
      const ok = opts.linkExists(p.target);
      const cls = `cm-wl${ok ? "" : " cm-missing"}${isActive ? "" : " cm-rendered"}`;
      const attrs = { "data-target": p.target, "data-heading": p.heading ?? "", title: ok ? "クリックで開く／Ctrl+クリックで反対側に開く" : "まだないノートです。クリックで作成" };
      if (isActive) {
        out.push(Decoration.mark({ class: cls, attributes: attrs }).range(s, e));
        return;
      }
      // 表示名があれば「ノート名|」も隠す
      const innerStart = s + 2;
      const shownFrom = p.alias ? innerStart + m[1].lastIndexOf("|") + 1 : innerStart;
      out.push(hide.range(s, shownFrom));
      out.push(Decoration.mark({ class: cls, attributes: attrs }).range(shownFrom, e - 2));
      out.push(hide.range(e - 2, e));
    });
    // 外部リンク [文字](URL)
    each(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (s, e, m) => {
      if (overlaps(taken, s, e)) return;
      taken.push({ from: s, to: e });
      const attrs = { "data-href": m[2], title: `${m[2]}（Ctrl+クリックで開く）` };
      if (isActive) {
        out.push(Decoration.mark({ class: "cm-link", attributes: attrs }).range(s, e));
        return;
      }
      out.push(hide.range(s, s + 1));
      out.push(Decoration.mark({ class: "cm-link cm-rendered", attributes: attrs }).range(s + 1, s + 1 + m[1].length));
      out.push(hide.range(s + 1 + m[1].length, e));
    });
    // 強調系：記号を隠して見た目だけ付ける
    const pair = (re: RegExp, open: number, cls: string) =>
      each(re, (s, e) => {
        if (overlaps(taken, s, s + open) || overlaps(taken, e - open, e)) return;
        out.push(Decoration.mark({ class: cls }).range(s, e));
        if (!isActive) out.push(hide.range(s, s + open), hide.range(e - open, e));
      });
    pair(/==([^=\n]+)==/g, 2, "cm-hl");
    pair(/\{\{([^{}\n]+)\}\}/g, 2, "cm-cloze");
    pair(/\*\*([^*\n]+)\*\*/g, 2, "cm-strong");
    pair(/~~([^~\n]+)~~/g, 2, "cm-strike");
    pair(/(?<![*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, 1, "cm-em");
    pair(/(?<![_\w])_(?!\s)([^_\n]+?)_(?![_\w])/g, 1, "cm-em");
  }
  // 末尾にバックリンク
  const bl = opts.backlinks();
  out.push(Decoration.widget({ widget: new BacklinksWidget(bl, opts.openBacklink), block: true, side: 1 }).range(doc.length));
  return Decoration.set(out, true);
}

export function livePreview(opts: LivePreviewOptions): Extension {
  const field = StateField.define<{ focused: boolean; deco: DecorationSet }>({
    create: (state) => ({ focused: false, deco: buildDecorations(state, false, opts) }),
    update(value, tr) {
      let focused = value.focused;
      let dirty = tr.docChanged || tr.selection !== undefined;
      for (const e of tr.effects) {
        if (e.is(setFocused)) {
          dirty = dirty || e.value !== focused;
          focused = e.value;
        }
        if (e.is(refreshPreview)) dirty = true;
      }
      if (!dirty) return value;
      return { focused, deco: buildDecorations(tr.state, focused, opts) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  return [
    field,
    EditorView.domEventHandlers({
      focus: (_e, view) => {
        queueMicrotask(() => view.dispatch({ effects: setFocused.of(true) }));
        return false;
      },
      blur: (_e, view) => {
        queueMicrotask(() => view.dispatch({ effects: setFocused.of(false) }));
        return false;
      },
      mousedown: (e) => {
        if (e.button !== 0) return false;
        const el = e.target as HTMLElement;
        const mod = e.ctrlKey || e.metaKey;
        const wl = el.closest<HTMLElement>(".cm-wl");
        // 整形表示中のリンクはクリックで開く。記号が見えている（編集中の）行では Ctrl+クリックで反対側に開く
        if (wl && (mod || wl.classList.contains("cm-rendered"))) {
          e.preventDefault();
          opts.openLink(wl.dataset.target ?? "", wl.dataset.heading || null, mod);
          return true;
        }
        const ln = el.closest<HTMLElement>(".cm-link");
        if (ln && (mod || ln.classList.contains("cm-rendered"))) {
          e.preventDefault();
          const href = ln.dataset.href ?? "";
          if (/^https?:\/\//i.test(href)) opts.openUrl(href);
          return true;
        }
        return false;
      },
    }),
  ];
}
