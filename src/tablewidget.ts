// 編集画面の表：マス目で表示し、セルをクリックしてそのまま書ける。
// 右クリックで行・列の追加と削除、セルの結合と解除。セルの中の画像は大きさを変えられる。
import { EditorSelection } from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";
import { createImageView } from "./imageview";
import { parseLink } from "./lib/links";
import * as T from "./lib/table";
import type { LivePreviewOptions } from "./livepreview";
import { renderInline } from "./render";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const EMBED_RE = /!\[\[([^\[\]\n]+)\]\]/g;
/** 表のセルに貼った画像の最初の幅 */
const CELL_IMAGE_WIDTH = 200;

/** 書き換えた直後に、新しい表のこのセルを編集状態にする */
let pendingFocus: { source: string; r: number; c: number } | null = null;

/** 書き換えの直後（同じ処理の中）に、新しい表のセルへフォーカスを移す。打ちかけの文字を落とさないため */
function flushPendingFocus(view: EditorView): void {
  const f = pendingFocus;
  if (!f) return;
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-wrap")) {
    const tv = (el as HTMLElement & { tableView?: TableView }).tableView;
    if (tv && tv.source === f.source) {
      pendingFocus = null;
      tv.startEdit(f.r, f.c);
      return;
    }
  }
}

interface Cell {
  r: number;
  c: number;
}

/** 文書の中で、dom（表の要素）がある表の位置 */
function locate(view: EditorView, dom: HTMLElement): { from: number; to: number } | null {
  if (!dom.isConnected) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(dom);
  } catch {
    return null;
  }
  const doc = view.state.doc;
  const lines: string[] = [];
  for (let n = 1; n <= doc.lines; n++) lines.push(doc.line(n).text);
  const at = doc.lineAt(Math.min(pos, doc.length)).number;
  const b = T.findTables(lines).find((t) => t.startLine <= at && at <= t.endLine);
  return b ? { from: doc.line(b.startLine).from, to: doc.line(b.endLine).to } : null;
}

/** from〜to（"/table" など）を空の表に置き換え、左上のセルを編集状態にする */
export function insertTable(view: EditorView, from: number, to: number, rows: number, cols: number): void {
  const doc = view.state.doc;
  const src = T.serialize(T.emptyTable(Math.max(1, rows), Math.max(1, cols)));
  const prev = from > 0 ? doc.sliceString(from - 1, from) : "";
  const prev2 = from > 1 ? doc.sliceString(from - 2, from - 1) : "";
  // 前後を空行で区切る（Markdown として確実に表になるように）
  const before = from === 0 ? "" : prev !== "\n" ? "\n\n" : prev2 !== "\n" && from > 1 ? "\n" : "";
  const next = doc.sliceString(to, to + 1);
  const after = next === "" ? "\n" : next === "\n" ? "\n" : "\n\n";
  const insert = `${before}${src}${after}`;
  pendingFocus = { source: src, r: 0, c: 0 };
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
  });
  flushPendingFocus(view);
}

/** セルの中の k 番目の ![[…]] の幅を変える */
function setEmbedWidth(text: string, k: number, w: number | null): string {
  let i = 0;
  return text.replace(EMBED_RE, (m, inner: string) => {
    if (i++ !== k) return m;
    return `![[${parseLink(inner).target}${w ? `|${w}` : ""}]]`;
  });
}

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly model: T.TableModel,
    readonly opts: LivePreviewOptions,
  ) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  get estimatedHeight() {
    return this.model.cells.length * 38 + 16;
  }
  toDOM(view: EditorView) {
    return new TableView(this, view).dom;
  }
  destroy(dom: HTMLElement) {
    (dom as HTMLElement & { tableView?: TableView }).tableView?.destroy();
  }
  ignoreEvent() {
    return true;
  }
}

class TableView {
  dom: HTMLElement;
  private table: HTMLTableElement;
  /** 今の中身（セルで打った文字もすぐここに入る） */
  private model: T.TableModel;
  private editing: { r: number; c: number; ta: HTMLTextAreaElement } | null = null;
  private sel: { a: Cell; b: Cell } | null = null;
  private menu: HTMLElement | null = null;
  private writing = false;
  private dragFrom: Cell | null = null;
  private dragged = false;

  constructor(
    private w: TableWidget,
    private view: EditorView,
  ) {
    this.model = w.model;
    this.dom = document.createElement("div");
    this.dom.className = "cm-table-wrap";
    this.dom.contentEditable = "false";
    (this.dom as HTMLElement & { tableView?: TableView }).tableView = this;
    this.table = document.createElement("table");
    this.table.className = "cm-table";
    this.dom.append(this.table);
    this.render();
    this.table.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.table.addEventListener("mouseover", (e) => this.onMouseOver(e));
    this.table.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    if (pendingFocus && pendingFocus.source === w.source) {
      const f = pendingFocus;
      // 画面外などで同じ処理の中に描かれなかったときの予備
      requestAnimationFrame(() => {
        if (pendingFocus !== f) return;
        pendingFocus = null;
        if (!this.editing && this.dom.isConnected) this.startEdit(f.r, f.c);
      });
    }
  }

  destroy(): void {
    this.closeMenu();
    document.removeEventListener("mouseup", this.onMouseUp, true);
    document.removeEventListener("mousedown", this.onOutside, true);
  }

  // ---------- 表示 ----------

  private render(): void {
    this.table.replaceChildren();
    const covered = T.coveredSet(this.model);
    this.model.cells.forEach((row, r) => {
      const tr = document.createElement("tr");
      row.forEach((_text, c) => {
        if (covered.has(`${r},${c}`)) return;
        const td = document.createElement(r === 0 ? "th" : "td");
        td.dataset.r = String(r);
        td.dataset.c = String(c);
        const m = T.mergeAt(this.model, r, c);
        if (m) {
          td.rowSpan = m.rs;
          td.colSpan = m.cs;
        }
        if (this.model.aligns[c]) td.style.textAlign = this.model.aligns[c];
        this.fillCell(td, r, c);
        tr.append(td);
      });
      this.table.append(tr);
    });
    this.paintSelection();
  }

  private cellEl(r: number, c: number): HTMLTableCellElement | null {
    return this.table.querySelector<HTMLTableCellElement>(`[data-r="${r}"][data-c="${c}"]`);
  }

  /** セルの中身（書式・リンク・画像）を描く */
  private fillCell(td: HTMLElement, r: number, c: number): void {
    td.replaceChildren();
    td.classList.remove("editing");
    const text = this.model.cells[r][c];
    const box = document.createElement("div");
    box.className = "cm-cell";
    const ctx = {
      resolve: (t: string) => (this.w.opts.linkExists(t) ? t : null),
      imageSrc: (n: string) => this.w.opts.imageSrc(n),
    };
    let last = 0;
    let k = 0;
    const addText = (s: string) => {
      if (!s) return;
      const span = document.createElement("span");
      span.innerHTML = renderInline(s, ctx);
      box.append(span);
    };
    for (const m of text.matchAll(EMBED_RE)) {
      const idx = k++;
      const p = parseLink(m[1]);
      if (!IMAGE_EXT.test(p.target)) continue; // 画像以外の埋め込みは文字として描く
      addText(text.slice(last, m.index));
      last = (m.index ?? 0) + m[0].length;
      const src = this.w.opts.imageSrc(p.target);
      const wrap = document.createElement("span");
      wrap.className = "cm-image";
      if (!src) {
        wrap.className = "cm-image missing";
        wrap.textContent = `画像が見つかりません: ${p.target}`;
      } else {
        const width = p.alias && /^\d+$/.test(p.alias) ? p.alias : null;
        wrap.append(
          createImageView({
            name: p.target,
            src,
            width,
            onWidth: (w) => {
              this.model = T.setCell(this.model, r, c, setEmbedWidth(this.model.cells[r][c], idx, w));
              this.write();
            },
            maxWidth: () => Math.max(160, Math.floor(this.view.contentDOM.getBoundingClientRect().width - 120)),
            sizes: () => [
              ["小", 120],
              ["中", 240],
              ["大", 400],
            ],
            defaultCss: `${CELL_IMAGE_WIDTH}px`,
            openImage: (n) => this.w.opts.openImage(n),
          }),
        );
      }
      box.append(wrap);
    }
    addText(text.slice(last));
    td.append(box);
  }

  // ---------- 書き込み ----------

  /** 今の中身を本文に書き戻す。focus があれば書き戻した後そのセルを編集、exit があれば表の外へ出る */
  private write(focus?: Cell, exit?: "before" | "after"): void {
    const src = T.serialize(this.model);
    const loc = locate(this.view, this.dom);
    if (!loc) return;
    if (src !== this.w.source) {
      if (focus) pendingFocus = { source: src, r: focus.r, c: focus.c };
      this.writing = true;
      this.view.dispatch({ changes: { from: loc.from, to: loc.to, insert: src } });
      if (focus) flushPendingFocus(this.view);
    } else if (focus) {
      this.startEdit(focus.r, focus.c);
      return;
    }
    if (exit) this.exit(exit, loc.from, loc.from + src.length);
  }

  /** 表を出て、本文の表の前／後ろの行にカーソルを置く */
  private exit(where: "before" | "after", from: number, to: number): void {
    if (!this.writing) this.endEdit(false);
    this.editing = null;
    const doc = this.view.state.doc;
    if (where === "after") {
      if (to >= doc.length) this.view.dispatch({ changes: { from: to, insert: "\n" }, selection: EditorSelection.cursor(to + 1) });
      else this.view.dispatch({ selection: EditorSelection.cursor(to + 1), scrollIntoView: true });
    } else if (from === 0) {
      this.view.dispatch({ changes: { from: 0, insert: "\n" }, selection: EditorSelection.cursor(0) });
    } else {
      this.view.dispatch({ selection: EditorSelection.cursor(from - 1), scrollIntoView: true });
    }
    this.view.focus();
  }

  // ---------- セルの編集 ----------

  get source(): string {
    return this.w.source;
  }

  startEdit(r: number, c: number): void {
    if (!this.dom.isConnected) return;
    this.endEdit(false);
    this.clearSelection();
    const td = this.cellEl(r, c);
    if (!td) return;
    const ta = document.createElement("textarea");
    ta.className = "cm-cell-input";
    ta.value = this.model.cells[r][c];
    ta.rows = 1;
    ta.spellcheck = false;
    td.replaceChildren(ta);
    td.classList.add("editing");
    const fit = () => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener("input", () => {
      this.model = T.setCell(this.model, r, c, ta.value);
      fit();
    });
    ta.addEventListener("keydown", (e) => this.onKey(e, r, c, ta));
    ta.addEventListener("blur", () => {
      if (this.writing || this.editing?.ta !== ta) return;
      // 右クリックメニューを開いたときは、メニューを閉じるまで書き戻さない
      if (this.menu) return;
      this.endEdit(true);
    });
    ta.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      void this.addImages(files, r, c, ta);
    });
    ta.addEventListener("drop", (e) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      void this.addImages(files, r, c, ta);
    });
    this.editing = { r, c, ta };
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    fit();
  }

  /** 編集をやめる（commit=true なら本文へ書き戻す） */
  private endEdit(commit: boolean): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    if (commit) {
      this.write();
      if (this.writing) return; // 表は作り直される
    }
    const td = this.cellEl(e.r, e.c);
    if (td) this.fillCell(td, e.r, e.c);
  }

  private async addImages(files: File[], r: number, c: number, ta: HTMLTextAreaElement): Promise<void> {
    const names = await this.w.opts.saveImages(files);
    if (!names.length) return;
    const ins = names.map((n) => `![[${n}|${CELL_IMAGE_WIDTH}]]`).join(" ");
    const s = ta.selectionStart;
    const v = ta.value;
    const value = `${v.slice(0, s)}${s > 0 && !/\s$/.test(v.slice(0, s)) ? " " : ""}${ins}${v.slice(ta.selectionEnd)}`;
    this.model = T.setCell(this.model, r, c, value);
    this.editing = null;
    this.write(); // 書き戻すと画像が表示される
  }

  /** 結合で隠れていないセルを左上から順に */
  private anchors(): Cell[] {
    const covered = T.coveredSet(this.model);
    const out: Cell[] = [];
    this.model.cells.forEach((row, r) => row.forEach((_t, c) => !covered.has(`${r},${c}`) && out.push({ r, c })));
    return out;
  }

  /** 上下に隣のセル（結合を考える） */
  private vertical(r: number, c: number, dir: 1 | -1): Cell | null {
    const m = T.mergeAt(this.model, r, c);
    let nr = dir > 0 ? (m ? m.r + m.rs : r + 1) : (m ? m.r : r) - 1;
    if (nr < 0 || nr >= this.model.cells.length) return null;
    const n = T.mergeAt(this.model, nr, c);
    return n ? { r: n.r, c: n.c } : { r: nr, c };
  }

  private onKey(e: KeyboardEvent, r: number, c: number, ta: HTMLTextAreaElement): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Tab") {
      e.preventDefault();
      const list = this.anchors();
      const i = list.findIndex((x) => x.r === r && x.c === c);
      let next = list[i + (e.shiftKey ? -1 : 1)];
      if (!next && !e.shiftKey) {
        // 最後のセルで Tab → 行を足す
        this.model = T.insertRow(this.model, this.model.cells.length);
        next = { r: this.model.cells.length - 1, c: 0 };
      }
      if (!next) return;
      this.write(next);
      return;
    }
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      this.write(undefined, "after");
      return;
    }
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    if ((e.key === "ArrowUp" && atStart) || (e.key === "ArrowDown" && atEnd)) {
      if (e.shiftKey || e.altKey) return;
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const to = this.vertical(r, c, dir);
      if (to) this.write(to);
      else this.write(undefined, dir < 0 ? "before" : "after");
    }
  }

  // ---------- マウス：クリックで編集、ドラッグで範囲選択 ----------

  private cellOf(target: EventTarget | null): Cell | null {
    const td = (target as HTMLElement | null)?.closest<HTMLElement>("td, th");
    if (!td || !this.table.contains(td) || td.dataset.r === undefined) return null;
    return { r: Number(td.dataset.r), c: Number(td.dataset.c) };
  }

  private onMouseDown(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    if (el.closest(".cm-cell-input")) return; // 文字入力中はそのまま
    // 編集中に右クリックしても入力欄からフォーカスを外さない（メニューを閉じてから書き戻す）
    if (e.button === 2 && this.editing) e.preventDefault();
    if (e.button !== 0) return;
    const cell = this.cellOf(e.target);
    if (!cell) return;
    // リンク
    const wl = el.closest<HTMLElement>("a.wl");
    if (wl) {
      e.preventDefault();
      this.w.opts.openLink(wl.dataset.target ?? "", wl.dataset.heading || null, e.ctrlKey || e.metaKey);
      return;
    }
    const ext = el.closest<HTMLAnchorElement>("a.ext");
    if (ext) {
      e.preventDefault();
      if (/^https?:\/\//i.test(ext.getAttribute("href") ?? "")) this.w.opts.openUrl(ext.getAttribute("href")!);
      return;
    }
    e.preventDefault();
    if (e.shiftKey) {
      const from = this.sel?.a ?? (this.editing ? { r: this.editing.r, c: this.editing.c } : cell);
      this.endEdit(false);
      this.setSelection(from, cell);
      return;
    }
    this.dragFrom = cell;
    this.dragged = false;
    document.addEventListener("mouseup", this.onMouseUp, true);
  }

  private onMouseOver(e: MouseEvent): void {
    if (!this.dragFrom) return;
    const cell = this.cellOf(e.target);
    if (!cell) return;
    if (!this.dragged && cell.r === this.dragFrom.r && cell.c === this.dragFrom.c) return;
    if (!this.dragged) {
      this.dragged = true;
      this.endEdit(false);
    }
    this.setSelection(this.dragFrom, cell);
  }

  private onMouseUp = (): void => {
    document.removeEventListener("mouseup", this.onMouseUp, true);
    const from = this.dragFrom;
    this.dragFrom = null;
    if (!from || this.dragged) return;
    // クリック：編集中のセルがあれば書き戻してから、押したセルを編集
    if (this.editing && (this.editing.r !== from.r || this.editing.c !== from.c)) {
      this.editing = null;
      this.write(from);
    } else if (!this.editing) this.startEdit(from.r, from.c);
  };

  private setSelection(a: Cell, b: Cell): void {
    this.sel = { a, b };
    this.paintSelection();
    document.addEventListener("mousedown", this.onOutside, true);
  }

  private clearSelection(): void {
    if (!this.sel) return;
    this.sel = null;
    this.paintSelection();
    document.removeEventListener("mousedown", this.onOutside, true);
  }

  private onOutside = (e: MouseEvent): void => {
    if (this.menu?.contains(e.target as Node)) return;
    if (!this.table.contains(e.target as Node)) this.clearSelection();
  };

  private selRect() {
    if (!this.sel) return null;
    return T.expandRect(this.model, this.sel.a.r, this.sel.a.c, this.sel.b.r, this.sel.b.c);
  }

  private paintSelection(): void {
    const rect = this.selRect();
    this.table.querySelectorAll<HTMLElement>("td, th").forEach((td) => {
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      const on = !!rect && r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2;
      td.classList.toggle("sel", on);
    });
  }

  // ---------- 右クリックメニュー ----------

  private onContextMenu(e: MouseEvent): void {
    const cell = this.cellOf(e.target);
    if (!cell) return;
    e.preventDefault();
    const rect = this.selRect();
    const inSel = !!rect && cell.r >= rect.r1 && cell.r <= rect.r2 && cell.c >= rect.c1 && cell.c <= rect.c2;
    if (!inSel) this.clearSelection();
    const multi = inSel && !!rect && (rect.r1 !== rect.r2 || rect.c1 !== rect.c2);
    const m = T.mergeAt(this.model, cell.r, cell.c);
    const top = m ? m.r : cell.r;
    const bottom = m ? m.r + m.rs : cell.r + 1;
    const left = m ? m.c : cell.c;
    const right = m ? m.c + m.cs : cell.c + 1;
    const apply = (fn: (t: T.TableModel) => T.TableModel) => () => {
      this.editing = null;
      this.model = fn(this.model);
      this.sel = null;
      this.write();
      if (!this.writing) this.render(); // 中身が変わらなかったとき
    };
    type Item = [string, () => void, boolean?] | null;
    const items: Item[] = [];
    if (multi && rect) items.push(["セルを結合", apply((t) => T.mergeCells(t, rect.r1, rect.c1, rect.r2, rect.c2))]);
    if (m) items.push(["結合を解除", apply((t) => T.unmergeCell(t, cell.r, cell.c))]);
    if (items.length) items.push(null);
    items.push(
      ["上に行を追加", apply((t) => T.insertRow(t, top))],
      ["下に行を追加", apply((t) => T.insertRow(t, bottom))],
      ["左に列を追加", apply((t) => T.insertCol(t, left))],
      ["右に列を追加", apply((t) => T.insertCol(t, right))],
      null,
      ["行を削除", apply((t) => T.deleteRow(t, cell.r)), this.model.cells.length <= 1],
      ["列を削除", apply((t) => T.deleteCol(t, cell.c)), this.model.aligns.length <= 1],
      null,
      ["左揃え", apply((t) => T.setAlign(t, cell.c, "left"))],
      ["中央揃え", apply((t) => T.setAlign(t, cell.c, "center"))],
      ["右揃え", apply((t) => T.setAlign(t, cell.c, "right"))],
      null,
      ["表を削除", () => this.removeTable()],
    );
    this.showMenu(e.clientX, e.clientY, items);
  }

  private showMenu(x: number, y: number, items: ([string, () => void, boolean?] | null)[]): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.setAttribute("role", "menu");
    for (const it of items) {
      if (!it) {
        menu.append(Object.assign(document.createElement("div"), { className: "menu-sep" }));
        continue;
      }
      const [label, fn, disabled] = it;
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = label;
      b.disabled = !!disabled;
      b.addEventListener("mousedown", (ev) => ev.preventDefault());
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.closeMenu(false);
        fn();
      });
      menu.append(b);
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 8))}px`;
    this.menu = menu;
    const close = (ev: Event) => {
      if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
      if (ev.type === "mousedown" && menu.contains(ev.target as Node)) return;
      this.closeMenu();
    };
    this.menuClose = close;
    document.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
  }

  private menuClose: ((ev: Event) => void) | null = null;

  /** メニューを閉じる。afterwards=true なら、編集中の文字をここで書き戻す */
  private closeMenu(afterwards = true): void {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    if (this.menuClose) {
      document.removeEventListener("mousedown", this.menuClose, true);
      document.removeEventListener("keydown", this.menuClose, true);
      window.removeEventListener("blur", this.menuClose);
      this.menuClose = null;
    }
    if (afterwards && this.editing && document.activeElement !== this.editing.ta) this.endEdit(true);
  }

  private removeTable(): void {
    const loc = locate(this.view, this.dom);
    if (!loc) return;
    this.writing = true;
    const doc = this.view.state.doc;
    const to = doc.sliceString(loc.to, loc.to + 1) === "\n" ? loc.to + 1 : loc.to;
    this.view.dispatch({ changes: { from: loc.from, to, insert: "" }, selection: EditorSelection.cursor(loc.from) });
    this.view.focus();
  }
}
