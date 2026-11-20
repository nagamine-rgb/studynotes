// ノートペイン（編集・閲覧・暗記）
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText, fileToBase64 } from "./api";
import { h, icon, iconButton, toast } from "./dom";
import { NoteEditor } from "./editor";
import { dirName, noteName } from "./lib/links";
import { maskTargetsFor, timestampName } from "./lib/text";
import { renderNote } from "./render";
import { settings, type Mode, type PaneId } from "./settings";
import { vault } from "./vault";

export interface PaneHost {
  openLink(from: Pane, target: string, heading: string | null, other: boolean): void;
  activate(id: PaneId): void;
  changed(): void; // 状態が変わった（保存・ツリー強調の更新）
  aiCheck(pane: Pane): void;
  textChanged(pane: Pane, changes: { from: number; to: number; insertedLength: number }[]): void;
  issueAction(pane: Pane, id: number, action: "accept" | "ignore"): void;
  setStatus(msg: string): void;
}

interface OpenOptions {
  heading?: string | null;
  line?: number;
  history?: boolean;
  mode?: Mode;
}

export class Pane {
  el: HTMLElement;
  path: string | null = null;
  mode: Mode = "read";
  masked = false;
  editor: NoteEditor;
  private back: string[] = [];
  private fwd: string[] = [];
  private saveTimer: number | undefined;
  private dirty = false;
  private titleEl: HTMLElement;
  private pathEl: HTMLElement;
  private modeBtns: Record<Mode, HTMLButtonElement>;
  private maskBtn: HTMLButtonElement;
  private maskBar: HTMLElement;
  private progressEl: HTMLElement;
  private editorHost: HTMLElement;
  private previewHost: HTMLElement;
  private article: HTMLElement;
  private backlinksEl: HTMLElement;
  private emptyEl: HTMLElement;
  private backBtn: HTMLButtonElement;
  private fwdBtn: HTMLButtonElement;

  constructor(
    public id: PaneId,
    private host: PaneHost,
  ) {
    this.titleEl = h("div", { class: "pane-title" });
    this.pathEl = h("div", { class: "pane-path" });
    this.backBtn = iconButton("back", "戻る（Alt+←）", () => void this.goBack());
    this.fwdBtn = iconButton("forward", "進む（Alt+→）", () => void this.goForward());
    this.modeBtns = {
      edit: h("button", { class: "seg", type: "button", title: "編集（Ctrl+E）", onclick: () => this.setMode("edit") }, "編集"),
      read: h("button", { class: "seg", type: "button", title: "閲覧（Ctrl+E）", onclick: () => this.setMode("read") }, "閲覧"),
    };
    this.maskBtn = h("button", { class: "btn mask-btn", type: "button", title: "暗記モード（Ctrl+M）", onclick: () => this.toggleMask() }, "暗記");
    this.progressEl = h("span", { class: "mask-progress" });
    this.maskBar = h(
      "div",
      { class: "mask-bar" },
      this.progressEl,
      h("button", { class: "btn small", type: "button", title: "次を表示（Space）", onclick: () => this.revealNext() }, "次を表示"),
      h("button", { class: "btn small", type: "button", onclick: () => this.revealAll(true) }, "すべて表示"),
      h("button", { class: "btn small", type: "button", onclick: () => this.revealAll(false) }, "すべて隠す"),
    );
    const aiBtn = h("button", { class: "btn ai-btn", type: "button", title: "AIチェック（Ctrl+Shift+A）", onclick: () => this.host.aiCheck(this) }, icon("sparkle", 14), "AI");
    const header = h(
      "div",
      { class: "pane-header" },
      h("div", { class: "pane-nav" }, this.backBtn, this.fwdBtn),
      h("div", { class: "pane-heading" }, this.titleEl, this.pathEl),
      this.maskBar,
      h("div", { class: "segmented", role: "group", "aria-label": "表示モード" }, this.modeBtns.edit, this.modeBtns.read),
      this.maskBtn,
      aiBtn,
    );
    this.editorHost = h("div", { class: "editor-host" });
    this.article = h("article", { class: "note" });
    this.backlinksEl = h("div", { class: "backlinks" });
    this.previewHost = h("div", { class: "preview-host" }, this.article, this.backlinksEl);
    this.emptyEl = h(
      "div",
      { class: "pane-empty" },
      h("p", {}, "ノートが開かれていません"),
      h("p", { class: "muted" }, "左のエクスプローラーで選ぶか、Ctrl+P でノート名を検索します"),
    );
    this.el = h("section", { class: "pane", "data-pane": id }, header, this.editorHost, this.previewHost, this.emptyEl);
    this.el.addEventListener("mousedown", () => this.host.activate(this.id), true);

    this.editor = new NoteEditor(this.editorHost, {
      onChange: (text, changes) => this.onEdit(text, changes),
      onOpenLink: (target, heading, other) => this.host.openLink(this, target, heading, other),
      linkExists: (target) => vault.resolve(target, this.path) !== null,
      noteNames: () => vault.notePaths().map(noteName),
      onImages: (files, pos) => void this.pasteImages(files, pos),
      onIssueAction: (id, action) => this.host.issueAction(this, id, action),
      onFocus: () => this.host.activate(this.id),
    });

    this.article.addEventListener("click", (e) => this.onPreviewClick(e));
    this.backlinksEl.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
      if (!a) return;
      e.preventDefault();
      const other = e.ctrlKey || e.metaKey;
      this.host.openLink(this, noteName(a.dataset.path!), null, other);
    });
    this.update();
  }

  get text(): string {
    return this.path ? (vault.notes.get(this.path) ?? "") : "";
  }

  async open(path: string | null, opts: OpenOptions = {}): Promise<void> {
    await this.flush();
    if (opts.history !== false && this.path && path !== this.path) {
      this.back.push(this.path);
      if (this.back.length > 50) this.back.shift();
      this.fwd = [];
    }
    const changed = path !== this.path;
    this.path = path;
    // 既存のノートは閲覧で開く（新規作成時などは mode を指定する）
    if (opts.mode) this.mode = opts.mode;
    else if (changed) this.mode = "read";
    if (changed) this.editor.load(this.text);
    this.update();
    if (opts.line !== undefined) this.goToLine(opts.line);
    else if (opts.heading) this.goToHeading(opts.heading);
    else if (changed) this.previewHost.scrollTop = 0;
    this.host.changed();
  }

  async goBack(): Promise<void> {
    const p = this.back.pop();
    if (!p) return;
    if (this.path) this.fwd.push(this.path);
    await this.open(p, { history: false });
  }

  async goForward(): Promise<void> {
    const p = this.fwd.pop();
    if (!p) return;
    if (this.path) this.back.push(this.path);
    await this.open(p, { history: false });
  }

  /** 名前の変更・移動に追従する */
  renamed(map: Map<string, string>): void {
    const fix = (p: string) => map.get(p) ?? p;
    this.back = this.back.map(fix);
    this.fwd = this.fwd.map(fix);
    if (this.path && map.has(this.path)) {
      this.path = map.get(this.path)!;
    }
    this.update();
  }

  /** 削除されたノートを閉じる */
  removed(path: string): void {
    const gone = (p: string) => p === path || p.startsWith(`${path}/`);
    this.back = this.back.filter((p) => !gone(p));
    this.fwd = this.fwd.filter((p) => !gone(p));
    if (this.path && gone(this.path)) {
      clearTimeout(this.saveTimer);
      this.dirty = false;
      this.path = null;
      this.editor.load("");
      this.update();
    }
  }

  setMode(mode: Mode): void {
    if (mode === "edit" && this.masked) this.masked = false;
    this.mode = mode;
    this.update();
    if (mode === "edit") this.editor.focus();
    this.host.changed();
  }

  toggleMode(): void {
    this.setMode(this.mode === "edit" ? "read" : "edit");
  }

  toggleMask(): void {
    this.masked = !this.masked;
    if (this.masked) this.mode = "read";
    this.update();
    this.host.changed();
  }

  /** 外部でファイルが変わった */
  async externalChange(): Promise<void> {
    if (!this.path) return;
    if (!vault.notes.has(this.path)) {
      this.removed(this.path);
      return;
    }
    if (this.dirty) {
      const reload = await ask("このノートはほかのアプリで変更されました。\n外部の内容を読み込みますか？\n（いいえ：アプリで編集中の内容を残す）", {
        title: "StudyNotes",
        kind: "warning",
      });
      if (!reload) {
        await this.flush(true);
        return;
      }
      clearTimeout(this.saveTimer);
      this.dirty = false;
    }
    this.editor.setText(this.text, true);
    this.update();
  }

  /** 保存待ちの内容をすぐに書き込む */
  async flush(force = false): Promise<void> {
    if (!this.path || (!this.dirty && !force)) return;
    clearTimeout(this.saveTimer);
    const path = this.path;
    const text = this.editor.getText();
    this.dirty = false;
    try {
      await vault.write(path, text);
      this.host.setStatus("自動保存済み");
    } catch (e) {
      this.dirty = true;
      toast(`保存できませんでした: ${errorText(e)}`, "error");
    }
  }

  focus(): void {
    if (this.mode === "edit") this.editor.focus();
    else this.previewHost.focus();
  }

  goToLine(line: number): void {
    if (this.mode === "edit") {
      this.editor.goToLine(line);
      return;
    }
    const els = [...this.article.querySelectorAll<HTMLElement>("[data-line]")];
    const target = els.filter((e) => Number(e.dataset.line) <= line).pop();
    target?.scrollIntoView({ block: "center" });
    target?.classList.add("flash");
    window.setTimeout(() => target?.classList.remove("flash"), 1200);
  }

  goToHeading(heading: string): void {
    const lines = this.text.split("\n");
    const i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#{1,6}\s+/, "").trim() === heading.trim());
    if (i >= 0) this.goToLine(i);
  }

  private onEdit(text: string, changes: { from: number; to: number; insertedLength: number }[]): void {
    if (!this.path) return;
    vault.notes.set(this.path, text);
    this.dirty = true;
    this.host.setStatus("保存中…");
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 500);
    this.host.textChanged(this, changes);
  }

  private async pasteImages(files: File[], pos: number): Promise<void> {
    let insert = "";
    for (const f of files) {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
      const name = f.name && f.name !== "image.png" ? f.name : timestampName("画像", ext);
      try {
        const saved = await api.attachmentSave(name, await fileToBase64(f));
        insert += `![[${saved}]]\n`;
      } catch (e) {
        toast(errorText(e), "error");
      }
    }
    if (!insert) return;
    await vault.refresh([]);
    const doc = this.editor.getText();
    const needsNl = pos > 0 && doc[pos - 1] !== "\n";
    this.editor.insertAt(pos, (needsNl ? "\n" : "") + insert);
    toast("画像を attachments に保存しました");
  }

  private onPreviewClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    const wl = el.closest<HTMLAnchorElement>("a.wl");
    if (wl) {
      e.preventDefault();
      this.host.openLink(this, wl.dataset.target ?? "", wl.dataset.heading || null, e.ctrlKey || e.metaKey);
      return;
    }
    const ext = el.closest<HTMLAnchorElement>("a.ext");
    if (ext) {
      e.preventDefault();
      if (/^https?:\/\//i.test(ext.href)) void openUrl(ext.href);
      return;
    }
    if (this.masked) {
      const m = el.closest<HTMLElement>(".mask");
      if (m) {
        m.classList.toggle("revealed");
        this.updateProgress();
      }
    }
  }

  private masks(): HTMLElement[] {
    return [...this.article.querySelectorAll<HTMLElement>(".mask")];
  }

  revealNext(): void {
    if (!this.masked) return;
    const next = this.masks().find((m) => !m.classList.contains("revealed"));
    if (next) {
      next.classList.add("revealed");
      next.scrollIntoView({ block: "nearest" });
    }
    this.updateProgress();
  }

  revealAll(show: boolean): void {
    for (const m of this.masks()) m.classList.toggle("revealed", show);
    this.updateProgress();
  }

  private updateProgress(): void {
    const all = this.masks();
    const shown = all.filter((m) => m.classList.contains("revealed")).length;
    this.progressEl.textContent = all.length ? `${shown} / ${all.length}` : "隠す対象がありません";
  }

  /** 閲覧表示を描き直す（他のノートが増減したときもリンクの色を更新するため呼ぶ） */
  renderPreview(): void {
    if (!this.path || this.mode !== "read") return;
    const revealed = new Set(this.masks().map((m, i) => (m.classList.contains("revealed") ? i : -1)).filter((i) => i >= 0));
    this.article.innerHTML = renderNote(this.text, {
      resolve: (t) => vault.resolve(t, this.path),
      imageSrc: (n) => vault.imageSrc(n),
    });
    const targets = maskTargetsFor(this.text, settings.mask);
    const sel = [targets.highlight && "mark.hl", targets.cloze && ".cloze", targets.bold && "strong"].filter(Boolean).join(",");
    if (sel) {
      this.article.querySelectorAll<HTMLElement>(sel).forEach((m, i) => {
        m.classList.add("mask");
        m.tabIndex = this.masked ? 0 : -1;
        if (revealed.has(i)) m.classList.add("revealed");
      });
    }
    const bl = vault.backlinks(this.path);
    this.backlinksEl.replaceChildren(
      h("div", { class: "backlinks-title" }, `バックリンク（${bl.length}件）`),
      ...bl.map((p) => h("a", { href: "#", class: "bl", "data-path": p, title: p }, noteName(p), h("span", { class: "muted" }, dirName(p) ? `  ${dirName(p)}` : ""))),
    );
    this.updateProgress();
  }

  update(): void {
    const has = !!this.path;
    this.el.classList.toggle("is-empty", !has);
    this.el.classList.toggle("mode-edit", has && this.mode === "edit");
    this.el.classList.toggle("mode-read", has && this.mode === "read");
    this.el.classList.toggle("masking", has && this.masked);
    this.titleEl.textContent = has ? noteName(this.path!) : "（空）";
    this.pathEl.textContent = has ? this.path! : "";
    this.modeBtns.edit.setAttribute("aria-pressed", String(this.mode === "edit"));
    this.modeBtns.read.setAttribute("aria-pressed", String(this.mode === "read"));
    this.maskBtn.setAttribute("aria-pressed", String(this.masked));
    this.maskBtn.textContent = this.masked ? "暗記 ON" : "暗記";
    this.backBtn.disabled = this.back.length === 0;
    this.fwdBtn.disabled = this.fwd.length === 0;
    if (has && this.mode === "read") this.renderPreview();
    if (has && this.mode === "edit") this.editor.refreshLinks();
  }

  isDirty(): boolean {
    return this.dirty;
  }
}
