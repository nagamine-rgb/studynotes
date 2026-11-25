// 編集モードのエディタ（CodeMirror 6）
import { autocompletion, startCompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, EditorView, hoverTooltip, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { parseLink, WIKILINK_RE } from "./lib/links";
import { livePreview, refreshPreview, type LivePreviewOptions } from "./livepreview";
import type { LocatedIssue } from "./lib/issues";
import { toggleHighlight } from "./lib/text";

export interface EditorOptions extends Omit<LivePreviewOptions, "openLink"> {
  onChange(text: string, changes: { from: number; to: number; insertedLength: number }[]): void;
  /** リンクを開く（other=true なら反対側のペイン） */
  onOpenLink(target: string, heading: string | null, other: boolean): void;
  linkExists(target: string): boolean;
  noteNames(): string[];
  onImages(files: File[], pos: number): void;
  onIssueAction(id: number, action: "accept" | "ignore"): void;
  onFocus(): void;
}

/** 選択範囲が「開き記号＋文字＋閉じ記号」で囲まれているか */
function isWrapped(doc: string, from: number, to: number, open: string, close: string): "inside" | "outside" | null {
  const sel = doc.slice(from, to);
  if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) return "inside";
  if (doc.slice(from - open.length, from) === open && doc.slice(to, to + close.length) === close) return "outside";
  return null;
}

const highlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.processingInstruction, t.meta], color: "var(--muted)" },
  { tag: t.monospace, fontFamily: "var(--mono)", color: "var(--code)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
]);



/** pos を含む [[…]] を探す */
function linkAt(state: EditorState, pos: number): { target: string; heading: string | null } | null {
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(WIKILINK_RE)) {
    const s = line.from + (m.index ?? 0);
    if (m[1] === "!") continue;
    if (pos >= s && pos <= s + m[0].length) {
      const p = parseLink(m[2]);
      return { target: p.target, heading: p.heading };
    }
  }
  return null;
}

// AIの指摘（波線）
export const setIssues = StateEffect.define<LocatedIssue[]>();

const issueField = StateField.define<{ list: LocatedIssue[]; deco: DecorationSet }>({
  create: () => ({ list: [], deco: Decoration.none }),
  update(value, tr) {
    let { list, deco } = value;
    if (tr.docChanged) deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setIssues)) {
        list = e.value.filter((i) => i.status === "open");
        const b = new RangeSetBuilder<Decoration>();
        for (const i of [...list].sort((a, c) => a.from - c.from)) {
          if (i.to > tr.state.doc.length || i.from >= i.to) continue;
          b.add(i.from, i.to, Decoration.mark({ class: `cm-issue cm-issue-${i.kind}`, attributes: { "data-issue": String(i.id) } }));
        }
        deco = b.finish();
      }
    }
    return { list, deco };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const KIND_LABEL: Record<string, string> = { typo: "誤字", style: "表記", fact: "要確認" };

function issueTooltip(onAction: EditorOptions["onIssueAction"]) {
  return hoverTooltip((view, pos) => {
    const { list } = view.state.field(issueField);
    const hit = list.find((i) => pos >= i.from && pos <= i.to);
    if (!hit) return null;
    return {
      pos: hit.from,
      end: hit.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "issue-tip";
        const head = document.createElement("div");
        head.className = `badge badge-${hit.kind}`;
        head.textContent = KIND_LABEL[hit.kind] ?? hit.kind;
        const body = document.createElement("div");
        body.className = "issue-tip-body";
        const sug = document.createElement("div");
        sug.className = "issue-sug";
        sug.textContent = hit.suggestion;
        const reason = document.createElement("div");
        reason.className = "issue-reason";
        reason.textContent = hit.reason;
        const btns = document.createElement("div");
        btns.className = "issue-btns";
        const ok = document.createElement("button");
        ok.className = "btn primary small";
        ok.textContent = "採用";
        ok.onclick = () => onAction(hit.id, "accept");
        const ng = document.createElement("button");
        ng.className = "btn small";
        ng.textContent = "無視";
        ng.onclick = () => onAction(hit.id, "ignore");
        btns.append(ok, ng);
        body.append(sug, reason, btns);
        dom.append(head, body);
        return { dom };
      },
    };
  });
}

function linkCompletion(names: () => string[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\[\[[^\[\]|#\n]*$/);
    if (!m) return null;
    const after = ctx.state.doc.sliceString(ctx.pos, ctx.pos + 2);
    const closes = after === "]]";
    return {
      from: m.from + 2,
      options: names().map((n) => ({ label: n, type: "text", apply: closes ? n : `${n}]]` })),
      validFor: /^[^\[\]|#\n]*$/,
    };
  };
}

export class NoteEditor {
  view: EditorView;
  private applyingExternal = false;

  constructor(parent: HTMLElement, opts: EditorOptions) {
    const extensions: Extension[] = [
      EditorView.theme({
        "&": { fontSize: "var(--note-font-size)", height: "100%" },
        ".cm-scroller": { fontFamily: "var(--font)", lineHeight: "1.85", padding: "16px 0 48px" },
        ".cm-content": { maxWidth: "760px", padding: "0 28px", caretColor: "var(--accent)" },
        ".cm-line": { padding: "0" },
      }),
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown(),
      syntaxHighlighting(highlight),
      search({ top: true }),
      highlightSelectionMatches(),
      placeholder("ここに書きます。[[ でリンク、==キーワード== で暗記用の強調"),
      livePreview({ ...opts, openLink: opts.onOpenLink }),
      // 空のリスト項目で Enter → リストを抜ける（UpNote・Word と同じ動き）
      Prec.highest(
        keymap.of([
          {
            key: "Enter",
            run: (v) => {
              const sel = v.state.selection.main;
              if (!sel.empty) return false;
              const line = v.state.doc.lineAt(sel.head);
              if (sel.head !== line.to || !/^\s*([-*+] \[[ xX]\]|[-*+]|\d+[.)]|>)\s*$/.test(line.text)) return false;
              v.dispatch({ changes: { from: line.from, to: line.to, insert: "" }, selection: EditorSelection.cursor(line.from) });
              return true;
            },
          },
        ]),
      ),
      issueField,
      issueTooltip(opts.onIssueAction),
      autocompletion({ override: [linkCompletion(opts.noteNames)], icons: false }),
      keymap.of([
        {
          key: "Mod-h",
          preventDefault: true,
          run: (v) => {
            const sel = v.state.selection.main;
            const e = toggleHighlight(v.state.doc.toString(), sel.from, sel.to);
            if (!e) return true;
            v.dispatch({ changes: { from: e.from, to: e.to, insert: e.insert }, selection: EditorSelection.range(e.selFrom, e.selTo) });
            return true;
          },
        },
        { key: "Mod-b", preventDefault: true, run: () => (this.wrap("**", "**"), true) },
        { key: "Mod-i", preventDefault: true, run: () => (this.wrap("*", "*"), true) },
        { key: "Mod-k", preventDefault: true, run: () => (this.insertLink(), true) },
        {
          key: "Mod-Enter",
          run: (v) => {
            const l = linkAt(v.state, v.state.selection.main.head);
            if (!l) return false;
            opts.onOpenLink(l.target, l.heading, false);
            return true;
          },
        },
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.domEventHandlers({
        paste: (ev, v) => {
          const files = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (!files.length) return false;
          ev.preventDefault();
          opts.onImages(files, v.state.selection.main.head);
          return true;
        },
        drop: (ev, v) => {
          const files = [...(ev.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (!files.length) return false;
          ev.preventDefault();
          const pos = v.posAtCoords({ x: ev.clientX, y: ev.clientY }) ?? v.state.selection.main.head;
          opts.onImages(files, pos);
          return true;
        },
        focus: () => {
          opts.onFocus();
          return false;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || this.applyingExternal) return;
        const changes: { from: number; to: number; insertedLength: number }[] = [];
        u.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insertedLength: inserted.length }));
        opts.onChange(u.state.doc.toString(), changes);
      }),
    ];
    this.extensions = extensions;
    this.view = new EditorView({ state: EditorState.create({ doc: "", extensions }), parent });
  }

  private extensions: Extension[];

  getText(): string {
    return this.view.state.doc.toString();
  }

  /** 外から本文を差し替える（onChange は呼ばない） */
  setText(text: string, keepSelection = false): void {
    if (text === this.getText()) return;
    const sel = this.view.state.selection.main;
    this.applyingExternal = true;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: keepSelection ? EditorSelection.cursor(Math.min(sel.head, text.length)) : EditorSelection.cursor(0),
    });
    this.applyingExternal = false;
  }

  /** 別ノートを開いたとき：元に戻す履歴ごと作り直す */
  load(text: string): void {
    this.view.setState(EditorState.create({ doc: text, extensions: this.extensions }));
  }

  replace(from: number, to: number, insert: string): void {
    this.view.dispatch({ changes: { from, to, insert } });
  }

  insertAt(pos: number, insert: string): void {
    this.view.dispatch({ changes: { from: pos, insert }, selection: EditorSelection.cursor(pos + insert.length) });
    this.view.focus();
  }

  select(from: number, to: number): void {
    this.view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true });
    this.view.focus();
  }

  selection(): { from: number; to: number } {
    const s = this.view.state.selection.main;
    return { from: s.from, to: s.to };
  }

  goToLine(line: number): void {
    const l = this.view.state.doc.line(Math.min(Math.max(1, line + 1), this.view.state.doc.lines));
    this.select(l.from, l.from);
  }

  setIssues(list: LocatedIssue[]): void {
    this.view.dispatch({ effects: setIssues.of(list) });
  }

  refreshLinks(): void {
    this.view.dispatch({ effects: refreshPreview.of(null) });
  }

  focus(): void {
    this.view.focus();
  }

  /** 選択範囲を記号で囲む／外す（選択がなければ記号の間にカーソル） */
  wrap(open: string, close: string): void {
    const v = this.view;
    const { from, to } = v.state.selection.main;
    const doc = v.state.doc.toString();
    const w = isWrapped(doc, from, to, open, close);
    if (w === "inside") {
      const inner = doc.slice(from + open.length, to - close.length);
      v.dispatch({ changes: { from, to, insert: inner }, selection: EditorSelection.range(from, from + inner.length) });
    } else if (w === "outside") {
      v.dispatch({
        changes: [
          { from: from - open.length, to: from, insert: "" },
          { from: to, to: to + close.length, insert: "" },
        ],
        selection: EditorSelection.range(from - open.length, to - open.length),
      });
    } else {
      v.dispatch({
        changes: { from, to, insert: open + doc.slice(from, to) + close },
        selection: EditorSelection.range(from + open.length, to + open.length),
      });
    }
    v.focus();
  }

  /** 選択した行の先頭記号（"- " "1. " "> " など）を付ける／外す */
  toggleLinePrefix(prefix: string): void {
    const v = this.view;
    const { from, to } = v.state.selection.main;
    const first = v.state.doc.lineAt(from).number;
    const last = v.state.doc.lineAt(to).number;
    const lines = [];
    for (let n = first; n <= last; n++) lines.push(v.state.doc.line(n));
    const strip = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+\. |> )/;
    const all = lines.every((l) => l.text.replace(/^\s*/, "").startsWith(prefix.trim() === "1." ? "1. " : prefix) || (prefix === "1. " && /^\s*\d+\. /.test(l.text)));
    const changes = lines.map((l, i) => {
      const m = strip.exec(l.text);
      const indent = /^\s*/.exec(l.text)![0];
      const rest = m ? l.text.slice(m[0].length) : l.text.slice(indent.length);
      const mark = prefix === "1. " ? `${i + 1}. ` : prefix;
      return { from: l.from, to: l.to, insert: all ? indent + rest : indent + mark + rest };
    });
    v.dispatch({ changes });
    v.focus();
  }

  /** 見出しの段階を変える（同じ段階を押すと外す） */
  setHeading(level: number): void {
    const v = this.view;
    const line = v.state.doc.lineAt(v.state.selection.main.head);
    const m = /^(#{1,6})\s+/.exec(line.text);
    // 見出しにするときは、箇条書き・チェック・引用の記号を外す
    const rest = m ? line.text.slice(m[0].length) : line.text.replace(/^\s*([-*+] \[[ xX]\] |[-*+] |\d+\. |> )/, "");
    const insert = m && m[1].length === level ? rest : `${"#".repeat(level)} ${rest}`;
    v.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: EditorSelection.cursor(line.from + insert.length) });
    v.focus();
  }

  /** カーソル位置に段落として挿入（前後に空行を入れる） */
  insertBlock(text: string, cursorOffset?: number): void {
    const v = this.view;
    const pos = v.state.selection.main.to;
    const doc = v.state.doc.toString();
    const before = pos === 0 ? "" : doc[pos - 1] === "\n" ? (doc[pos - 2] === "\n" || pos === 1 ? "" : "\n") : "\n\n";
    const insert = `${before}${text}\n`;
    const caret = pos + before.length + (cursorOffset ?? text.length);
    v.dispatch({ changes: { from: pos, insert }, selection: EditorSelection.cursor(caret) });
    v.focus();
  }

  /** [[ を入れてノート名の候補を出す（選択中の文字があればそれをリンクにする） */
  insertLink(): void {
    const v = this.view;
    const { from, to } = v.state.selection.main;
    if (to > from) {
      this.wrap("[[", "]]");
      return;
    }
    v.dispatch({ changes: { from, insert: "[[]]" }, selection: EditorSelection.cursor(from + 2) });
    v.focus();
    startCompletion(v);
  }

  undo(): void {
    undo(this.view);
    this.view.focus();
  }

  redo(): void {
    redo(this.view);
    this.view.focus();
  }
}
