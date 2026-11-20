// 左パネル：フォルダ構造のエクスプローラーと全文検索
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorText } from "./api";
import { h, icon, iconButton, toast } from "./dom";
import { dirName, fileName, joinPath, noteName } from "./lib/links";
import { searchLines } from "./lib/text";
import { saveWorkspace, workspace } from "./settings";
import { vault } from "./vault";

export interface ExplorerHost {
  openPath(path: string, other: boolean, line?: number): void;
  activePaths(): string[];
  renamed(map: Map<string, string>): void;
  removed(path: string): void;
}

interface Node {
  path: string;
  name: string;
  isDir: boolean;
  children: Node[];
}

function buildTree(): Node {
  const root: Node = { path: "", name: "", isDir: true, children: [] };
  const byPath = new Map<string, Node>([["", root]]);
  const ensure = (p: string): Node => {
    const hit = byPath.get(p);
    if (hit) return hit;
    const n: Node = { path: p, name: fileName(p), isDir: true, children: [] };
    byPath.set(p, n);
    ensure(dirName(p)).children.push(n);
    return n;
  };
  for (const e of vault.entries) {
    if (e.is_dir) ensure(e.path);
    else {
      const n: Node = { path: e.path, name: e.name, isDir: false, children: [] };
      byPath.set(e.path, n);
      ensure(dirName(e.path)).children.push(n);
    }
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, "ja", { numeric: true })));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

const isNote = (p: string) => p.toLowerCase().endsWith(".md");

export class Explorer {
  el: HTMLElement;
  private treeEl: HTMLElement;
  private filterInput: HTMLInputElement;
  private searchInput: HTMLInputElement;
  private searchResults: HTMLElement;
  private quickEl: HTMLElement;
  private selected: string | null = null;
  private searching = false;
  private menu: HTMLElement | null = null;
  private dragPath: string | null = null;

  constructor(private host: ExplorerHost) {
    this.filterInput = h("input", { type: "search", class: "input", placeholder: "絞り込み…", "aria-label": "ノートを絞り込み" });
    this.filterInput.addEventListener("input", () => this.render());
    this.treeEl = h("div", { class: "tree", role: "tree", tabindex: 0 });
    this.searchInput = h("input", { type: "search", class: "input", placeholder: "全ノートを検索…", "aria-label": "全文検索" });
    this.searchInput.addEventListener("input", () => this.renderSearch());
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.toggleSearch(false);
      }
    });
    this.searchResults = h("div", { class: "search-results" });
    this.quickEl = h("div", { class: "quick-lists" });

    const head = h(
      "div",
      { class: "explorer-head" },
      h("span", { class: "explorer-title" }, "エクスプローラー"),
      iconButton("plus", "新規ノート（Ctrl+N）", () => void this.newNote(this.targetFolder())),
      iconButton("folderPlus", "新規フォルダ", () => void this.newFolder(this.targetFolder())),
      iconButton("collapse", "すべて折りたたむ", () => {
        workspace.openFolders = [];
        saveWorkspace();
        this.render();
      }),
      iconButton("search", "全文検索（Ctrl+Shift+F）", () => this.toggleSearch()),
    );
    const treeView = h("div", { class: "tree-view" }, h("div", { class: "pad" }, this.filterInput), this.treeEl, this.quickEl);
    const searchView = h("div", { class: "search-view" }, h("div", { class: "pad" }, this.searchInput), this.searchResults);
    this.el = h("nav", { class: "explorer", "aria-label": "エクスプローラー" }, head, treeView, searchView);

    this.treeEl.addEventListener("click", (e) => this.onClick(e));
    this.treeEl.addEventListener("contextmenu", (e) => this.onContext(e));
    this.treeEl.addEventListener("keydown", (e) => this.onKey(e));
    this.treeEl.addEventListener("dragstart", (e) => this.onDragStart(e));
    this.treeEl.addEventListener("dragover", (e) => this.onDragOver(e));
    this.treeEl.addEventListener("dragleave", (e) => (e.target as HTMLElement).closest(".row")?.classList.remove("drop"));
    this.treeEl.addEventListener("drop", (e) => void this.onDrop(e));
    this.quickEl.addEventListener("click", (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
      if (!r) return;
      this.host.openPath(r.dataset.path!, e.ctrlKey || e.metaKey);
    });
    this.searchResults.addEventListener("click", (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
      if (!r) return;
      this.host.openPath(r.dataset.path!, e.ctrlKey || e.metaKey, r.dataset.line ? Number(r.dataset.line) : undefined);
    });
    document.addEventListener("click", () => this.closeMenu());
    vault.onChange(() => this.refresh());
  }

  refresh(): void {
    if (this.searching) this.renderSearch();
    this.render();
  }

  toggleSearch(force?: boolean): void {
    this.searching = force ?? !this.searching;
    this.el.classList.toggle("searching", this.searching);
    if (this.searching) {
      this.searchInput.focus();
      this.searchInput.select();
      this.renderSearch();
    }
  }

  private targetFolder(): string {
    return this.selected ? vault.folderOf(this.selected) : "";
  }

  private isOpen(path: string): boolean {
    return workspace.openFolders.includes(path);
  }

  private setOpen(path: string, open: boolean): void {
    const s = new Set(workspace.openFolders);
    if (open) s.add(path);
    else s.delete(path);
    workspace.openFolders = [...s];
    saveWorkspace();
  }

  /** あるノートが見えるように親フォルダを開く */
  reveal(path: string): void {
    let d = dirName(path);
    let changed = false;
    while (d) {
      if (!this.isOpen(d)) {
        this.setOpen(d, true);
        changed = true;
      }
      d = dirName(d);
    }
    if (changed) this.render();
  }

  render(): void {
    const active = new Set(this.host.activePaths());
    const q = this.filterInput.value.trim().toLowerCase();
    const rows: HTMLElement[] = [];
    const row = (n: Node, depth: number) => {
      const isActive = active.has(n.path);
      const r = h("div", {
        class: `row${n.isDir ? " dir" : ""}${isActive ? " active" : ""}${this.selected === n.path ? " selected" : ""}`,
        role: "treeitem",
        "data-path": n.path,
        draggable: "true",
        style: `padding-left:${8 + depth * 16}px`,
        title: n.path,
      });
      if (n.isDir) {
        const open = q ? true : this.isOpen(n.path);
        r.setAttribute("aria-expanded", String(open));
        const chev = icon("chevron", 12);
        chev.classList.add("chev");
        r.append(chev, icon("folder", 15), h("span", { class: "label" }, n.name));
      } else {
        r.append(h("span", { class: "chev-space" }), icon(isNote(n.path) ? "file" : "image", 14), h("span", { class: "label" }, isNote(n.path) ? noteName(n.path) : n.name));
        if (!isNote(n.path)) r.classList.add("asset");
      }
      rows.push(r);
    };
    const walk = (n: Node, depth: number) => {
      for (const c of n.children) {
        if (q) {
          if (c.isDir) {
            const before = rows.length;
            row(c, depth);
            walk(c, depth + 1);
            if (rows.length === before + 1) rows.pop(); // 中に一致なし
          } else if (c.name.toLowerCase().includes(q)) row(c, depth);
          continue;
        }
        row(c, depth);
        if (c.isDir && this.isOpen(c.path)) walk(c, depth + 1);
      }
    };
    walk(buildTree(), 0);
    if (!rows.length) rows.push(h("div", { class: "muted pad" }, q ? "一致するノートがありません" : "ノートがありません。＋で作成します"));
    this.treeEl.replaceChildren(...rows);
    this.renderQuick();
  }

  private renderQuick(): void {
    const exists = (p: string) => vault.notes.has(p);
    const pins = workspace.pins.filter(exists);
    const recent = workspace.recent.filter(exists).slice(0, 10);
    const item = (p: string) => h("div", { class: "row", "data-path": p, title: p }, icon("file", 14), h("span", { class: "label" }, noteName(p)));
    this.quickEl.replaceChildren(
      h("div", { class: "quick-title" }, "ピン留め"),
      ...(pins.length ? pins.map(item) : [h("div", { class: "muted pad small" }, "右クリック →「ピン留め」で追加")]),
      h("div", { class: "quick-title" }, "最近開いたノート"),
      ...recent.map(item),
    );
  }

  private renderSearch(): void {
    const q = this.searchInput.value.trim();
    if (!q) {
      this.searchResults.replaceChildren(h("div", { class: "muted pad" }, "キーワードを入力すると、全ノートから探します"));
      return;
    }
    const out: HTMLElement[] = [];
    let total = 0;
    for (const p of vault.notePaths()) {
      const content = vault.notes.get(p) ?? "";
      const nameHit = noteName(p).toLowerCase().includes(q.toLowerCase());
      const lines = searchLines(content, q, 5);
      if (!nameHit && !lines.length) continue;
      total++;
      out.push(h("div", { class: "result-note", "data-path": p }, icon("file", 14), h("span", {}, noteName(p)), h("span", { class: "muted small" }, dirName(p))));
      for (const l of lines) out.push(h("div", { class: "result-line", "data-path": p, "data-line": l.line }, highlightText(l.text, q)));
      if (total >= 100) break;
    }
    this.searchResults.replaceChildren(h("div", { class: "muted pad small" }, `${total}件のノート`), ...out);
  }

  private onClick(e: MouseEvent): void {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".row");
    if (!r) return;
    const path = r.dataset.path!;
    this.selected = path;
    if (vault.isDir(path)) {
      this.setOpen(path, !this.isOpen(path));
      this.render();
      return;
    }
    if (isNote(path)) this.host.openPath(path, e.ctrlKey || e.metaKey);
    else this.render();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.selected) return;
    if (e.key === "F2") {
      e.preventDefault();
      this.startRename(this.selected);
    } else if (e.key === "Delete") {
      e.preventDefault();
      void this.remove(this.selected);
    }
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const r = (e.target as HTMLElement).closest<HTMLElement>(".row");
    const path = r?.dataset.path ?? null;
    this.selected = path;
    this.render();
    const folder = path ? vault.folderOf(path) : "";
    const items: [string, () => void][] = [
      ["新規ノート", () => void this.newNote(folder)],
      ["新規フォルダ", () => void this.newFolder(folder)],
    ];
    if (path) {
      if (isNote(path)) {
        items.push(["反対側のペインで開く", () => this.host.openPath(path, true)]);
        const pinned = workspace.pins.includes(path);
        items.push([
          pinned ? "ピン留めを外す" : "ピン留め",
          () => {
            workspace.pins = pinned ? workspace.pins.filter((p) => p !== path) : [...workspace.pins, path];
            saveWorkspace();
            this.renderQuick();
          },
        ]);
      }
      items.push(["名前の変更（F2）", () => this.startRename(path)]);
      items.push(["削除（Delete）", () => void this.remove(path)]);
      items.push(["エクスプローラーで表示", () => void api.absPath(path).then((p) => revealItemInDir(p)).catch((err) => toast(errorText(err), "error"))]);
    }
    this.showMenu(e.clientX, e.clientY, items);
  }

  private showMenu(x: number, y: number, items: [string, () => void][]): void {
    this.closeMenu();
    const menu = h("div", { class: "context-menu", role: "menu" });
    for (const [label, fn] of items) {
      menu.append(
        h("button", {
          type: "button",
          role: "menuitem",
          onclick: (ev: Event) => {
            ev.stopPropagation();
            this.closeMenu();
            fn();
          },
        }, label),
      );
    }
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
    this.menu = menu;
    (menu.firstElementChild as HTMLElement | null)?.focus();
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  async newNote(folder: string): Promise<void> {
    try {
      if (folder) this.setOpen(folder, true);
      const p = await vault.createNote(folder, "無題のノート");
      this.selected = p;
      this.host.openPath(p, false);
      this.startRename(p);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  private async newFolder(folder: string): Promise<void> {
    try {
      let name = "新しいフォルダ";
      let n = 1;
      while (vault.entries.some((e) => e.path === joinPath(folder, name))) name = `新しいフォルダ ${++n}`;
      if (folder) this.setOpen(folder, true);
      const p = await vault.createFolder(folder, name);
      this.selected = p;
      this.render();
      this.startRename(p);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  startRename(path: string): void {
    this.reveal(path);
    this.render();
    const r = this.treeEl.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(path)}"]`);
    const label = r?.querySelector<HTMLElement>(".label");
    if (!r || !label) return;
    const note = isNote(path);
    const current = note ? noteName(path) : fileName(path);
    const input = h("input", { class: "rename-input", value: current, "aria-label": "新しい名前" });
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim().replace(/[\\/:*?"<>|]/g, "_");
      if (!commit || !v || v === current) {
        this.render();
        return;
      }
      const to = joinPath(dirName(path), note ? `${v}.md` : v);
      try {
        const map = await vault.rename(path, to);
        this.selected = to;
        workspace.pins = workspace.pins.map((p) => map.get(p) ?? p);
        workspace.recent = workspace.recent.map((p) => map.get(p) ?? p);
        if (vault.isDir(to)) workspace.openFolders = workspace.openFolders.map((p) => (p === path || p.startsWith(`${path}/`) ? to + p.slice(path.length) : p));
        saveWorkspace();
        this.host.renamed(map);
      } catch (e) {
        toast(errorText(e), "error");
        this.render();
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return; // 日本語変換中の Enter は確定に使う
      if (e.key === "Enter") void finish(true);
      if (e.key === "Escape") void finish(false);
    });
    input.addEventListener("blur", () => void finish(true));
  }

  async remove(path: string): Promise<void> {
    const label = isNote(path) ? noteName(path) : fileName(path);
    const ok = await ask(`「${label}」をごみ箱に移動しますか？`, { title: "StudyNotes", kind: "warning", okLabel: "ごみ箱へ", cancelLabel: "キャンセル" });
    if (!ok) return;
    try {
      await vault.remove(path);
      workspace.pins = workspace.pins.filter((p) => p !== path && !p.startsWith(`${path}/`));
      saveWorkspace();
      this.selected = null;
      this.host.removed(path);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  private onDragStart(e: DragEvent): void {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".row");
    if (!r || !e.dataTransfer) return;
    this.dragPath = r.dataset.path!;
    e.dataTransfer.setData("text/plain", this.dragPath);
    e.dataTransfer.effectAllowed = "move";
  }

  private dropTarget(e: DragEvent): string | null {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".row");
    if (!r) return "";
    const p = r.dataset.path!;
    return vault.isDir(p) ? p : dirName(p);
  }

  private onDragOver(e: DragEvent): void {
    if (!this.dragPath) return;
    const t = this.dropTarget(e);
    if (t === null || t === this.dragPath || t.startsWith(`${this.dragPath}/`) || dirName(this.dragPath) === t) return;
    e.preventDefault();
    (e.target as HTMLElement).closest(".row")?.classList.add("drop");
  }

  private async onDrop(e: DragEvent): Promise<void> {
    const from = this.dragPath;
    this.dragPath = null;
    if (!from) return;
    e.preventDefault();
    const folder = this.dropTarget(e);
    if (folder === null || folder === from || folder.startsWith(`${from}/`) || dirName(from) === folder) {
      this.render();
      return;
    }
    const to = joinPath(folder, fileName(from));
    try {
      const map = await vault.rename(from, to);
      if (folder) this.setOpen(folder, true);
      workspace.pins = workspace.pins.map((p) => map.get(p) ?? p);
      workspace.recent = workspace.recent.map((p) => map.get(p) ?? p);
      saveWorkspace();
      this.host.renamed(map);
    } catch (err) {
      toast(errorText(err), "error");
      this.render();
    }
  }
}

function highlightText(text: string, q: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  let idx: number;
  while ((idx = lower.indexOf(ql, i)) >= 0) {
    frag.append(text.slice(i, idx), h("mark", {}, text.slice(idx, idx + q.length)));
    i = idx + q.length;
  }
  frag.append(text.slice(i));
  return frag;
}
