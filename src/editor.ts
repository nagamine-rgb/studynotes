// 編集モードのエディタ（CodeMirror 6）
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  hoverTooltip,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { parseLink, WIKILINK_RE } from "./lib/links";
import type { LocatedIssue } from "./lib/issues";
import { toggleHighlight } from "./lib/text";

export interface EditorOptions {
  onChange(text: string, changes: { from: number; to: number; insertedLength: number }[]): void;
  /** リンクを開く（other=true なら反対側のペイン） */
  onOpenLink(target: string, heading: string | null, other: boolean): void;
  linkExists(target: string): boolean;
  noteNames(): string[];
  onImages(files: File[], pos: number): void;
  onIssueAction(id: number, action: "accept" | "ignore"): void;
  onFocus(): void;
}

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.12em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.processingInstruction, t.meta], color: "var(--muted)" },
  { tag: t.monospace, fontFamily: "var(--mono)", color: "var(--code)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
]);

// ==強調== {{穴埋め}} [[リンク]] の装飾
function buildMarks(view: EditorView, linkExists: (t: string) => boolean): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const m of text.matchAll(/==([^=\n]+)==/g)) {
      const s = from + (m.index ?? 0);
      ranges.push({ from: s, to: s + m[0].length, deco: Decoration.mark({ class: "cm-hl" }) });
    }
    for (const m of text.matchAll(/\{\{([^{}\n]+)\}\}/g)) {
      const s = from + (m.index ?? 0);
      ranges.push({ from: s, to: s + m[0].length, deco: Decoration.mark({ class: "cm-cloze" }) });
    }
    for (const m of text.matchAll(WIKILINK_RE)) {
      const s = from + (m.index ?? 0);
      const embed = m[1] === "!";
      const ok = embed || linkExists(parseLink(m[2]).target);
      ranges.push({
        from: s,
        to: s + m[0].length,
        deco: Decoration.mark({
          class: embed ? "cm-embed" : ok ? "cm-wl" : "cm-wl cm-missing",
          attributes: embed ? {} : { title: "Ctrl+クリックで反対側に開く／Ctrl+Enterでこのペインに開く" },
        }),
      });
    }
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
}

function marksPlugin(linkExists: (t: string) => boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildMarks(view, linkExists);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLinks))))
          this.decorations = buildMarks(u.view, linkExists);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export const refreshLinks = StateEffect.define<null>();

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
      marksPlugin(opts.linkExists),
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
        mousedown: (ev, v) => {
          if (!(ev.ctrlKey || ev.metaKey) || ev.button !== 0) return false;
          const pos = v.posAtCoords({ x: ev.clientX, y: ev.clientY });
          if (pos == null) return false;
          const l = linkAt(v.state, pos);
          if (!l) return false;
          ev.preventDefault();
          opts.onOpenLink(l.target, l.heading, true);
          return true;
        },
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
    this.view.dispatch({ effects: refreshLinks.of(null) });
  }

  focus(): void {
    this.view.focus();
  }
}
