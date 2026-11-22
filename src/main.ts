// StudyNotes 本体：画面の組み立てと全体の配線
import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorText } from "./api";
import { AiPanel } from "./aipanel";
import { openQuickSwitcher, openSettings, pickVaultFolder } from "./dialogs";
import { h, icon, iconButton, toast } from "./dom";
import { Explorer } from "./explorer";
import { dirName, noteName } from "./lib/links";
import { Pane } from "./pane";
import {
  applyTheme,
  loadSettings,
  loadWorkspace,
  saveSettings,
  saveWorkspace,
  settings,
  workspace,
  type PaneId,
} from "./settings";
import { vault } from "./vault";

const WELCOME_NOTE = `# はじめに

StudyNotes へようこそ。ノートはこのフォルダの中に、普通の .md ファイルとして保存されます。

## 基本
- 左のエクスプローラーでノートを選ぶと開きます。**Ctrl+クリック**で反対側のペインに開きます
- **Ctrl+P** でノート名を検索、**Ctrl+Shift+F** で全文検索
- **Ctrl+E** で 編集 ⇔ 閲覧 を切り替え。入力は自動で保存されます

## リンク
編集中に [[ と打つとノート名の候補が出ます。例：[[暗記モードの使い方]]（まだないノートは、クリックすると作られます）

## 暗記
==キーワード== のように == で囲むと、暗記モード（**Ctrl+M**）で隠れます。
編集中に文字を選んで **Ctrl+H** を押すと、== を付けたり外したりできます。
{{穴埋め}} も隠れます。暗記モードでは Space で次を表示します。

## 画像
編集中にスクリーンショットを **Ctrl+V** で貼ると、attachments フォルダに保存されます。

## AIチェック
ペインの右上の「AI」ボタンで、誤字や表記ゆれを確認できます。⚙ 設定でAIサービスとAPIキーを選んでください。
`;

class App {
  root = h("div", { id: "app" });
  panes: Record<PaneId, Pane>;
  explorer: Explorer;
  ai: AiPanel;
  private statusMsg = h("span", { class: "status-msg" }, "準備完了");
  private statusCount = h("span", { class: "status-count" });
  private vaultLabel = h("span", { class: "vault-label" });
  private splitBtn: HTMLButtonElement;
  private panesEl: HTMLElement;
  private divider: HTMLElement;
  private explorerWrap: HTMLElement;
  private unlisten: (() => void) | null = null;

  constructor() {
    const host = {
      openLink: (from: Pane, target: string, heading: string | null, other: boolean) => void this.openLink(from, target, heading, other),
      activate: (id: PaneId) => this.activate(id),
      changed: () => this.paneChanged(),
      aiCheck: (p: Pane) => this.openAi(p),
      textChanged: (p: Pane, c: { from: number; to: number; insertedLength: number }[]) => this.ai.textChanged(p, c),
      issueAction: (p: Pane, id: number, a: "accept" | "ignore") => this.ai.issueAction(p, id, a),
      setStatus: (m: string) => (this.statusMsg.textContent = m),
    };
    this.panes = { L: new Pane("L", host), R: new Pane("R", host) };
    this.explorer = new Explorer({
      openPath: (p, other, line) => void this.openPath(p, other, line),
      activePaths: () => (Object.values(this.panes) as Pane[]).filter((p) => this.visible(p.id)).map((p) => p.path).filter((p): p is string => !!p),
      renamed: (map) => {
        for (const p of Object.values(this.panes)) p.renamed(map);
        this.refreshPreviews();
        this.paneChanged();
      },
      removed: (path) => {
        for (const p of Object.values(this.panes)) p.removed(path);
        this.refreshPreviews();
        this.paneChanged();
      },
    });
    this.ai = new AiPanel({
      setOpen: (open) => {
        this.root.classList.toggle("ai-open", open);
        if (open && settings.ai.collapseExplorer && workspace.explorerVisible) {
          this.root.classList.add("explorer-auto-hidden");
        }
        if (!open) this.root.classList.remove("explorer-auto-hidden");
      },
      openSettings: () => this.openSettings(),
      activePane: () => this.active,
      openLink: (from, target, other) => void this.openLink(from, target, null, other),
    });

    this.splitBtn = h("button", { class: "btn", type: "button", title: "1画面 ⇔ 2画面（Ctrl+\\）", onclick: () => this.toggleSplit() }, icon("split", 15), "2画面");
    const toolbar = h(
      "header",
      { class: "toolbar" },
      iconButton("sidebar", "エクスプローラーの表示切替（Ctrl+B）", () => this.toggleExplorer()),
      h("div", { class: "brand" }, h("strong", {}, "StudyNotes"), this.vaultLabel),
      h("div", { class: "spacer" }),
      h("button", { class: "btn", type: "button", title: "新規ノート（Ctrl+N）", onclick: () => void this.newNote() }, icon("plus", 15), "新規"),
      h("button", { class: "btn", type: "button", title: "ノート名で検索（Ctrl+P）", onclick: () => this.quickOpen() }, icon("search", 15), "検索", h("kbd", {}, "Ctrl+P")),
      this.splitBtn,
      iconButton("settings", "設定（Ctrl+,）", () => this.openSettings()),
    );
    const explorerResizer = h("div", { class: "resizer", role: "separator", "aria-orientation": "vertical", title: "ドラッグで幅を変更" });
    this.explorerWrap = h("div", { class: "explorer-wrap" }, this.explorer.el, explorerResizer);
    this.divider = h("div", { class: "pane-divider", role: "separator", "aria-orientation": "vertical", title: "ドラッグで幅を変更／ダブルクリックで半分ずつ" });
    this.panesEl = h("main", { class: "panes" }, this.panes.L.el, this.divider, this.panes.R.el);
    const status = h(
      "footer",
      { class: "statusbar" },
      this.statusMsg,
      this.statusCount,
      h("span", { class: "spacer" }),
      h("span", { class: "hints" }, "Ctrl+クリック：反対側に開く ・ Ctrl+E：編集/閲覧 ・ Ctrl+M：暗記 ・ Ctrl+H：キーワード化"),
    );
    this.root.append(toolbar, h("div", { class: "workspace" }, this.explorerWrap, this.panesEl, this.ai.el), status);

    this.dragResize(explorerResizer, (x) => {
      workspace.explorerWidth = Math.min(480, Math.max(180, x));
      this.applyLayout();
    });
    this.dragResize(this.divider, (x) => {
      const r = this.panesEl.getBoundingClientRect();
      workspace.ratio = Math.min(0.8, Math.max(0.2, (x - r.left) / r.width));
      this.applyLayout();
    });
    this.divider.addEventListener("dblclick", () => {
      workspace.ratio = 0.5;
      this.applyLayout();
      saveWorkspace();
    });
    vault.onChange(() => {
      this.statusCount.textContent = `${vault.notes.size}ノート`;
    });
  }

  private dragResize(handle: HTMLElement, onMove: (x: number) => void): void {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      const move = (ev: PointerEvent) => onMove(ev.clientX);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing");
        saveWorkspace();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  visible(id: PaneId): boolean {
    return workspace.split || workspace.active === id;
  }

  get active(): Pane {
    return this.panes[workspace.active];
  }

  other(id: PaneId): Pane {
    return this.panes[id === "L" ? "R" : "L"];
  }

  applyLayout(): void {
    this.root.classList.toggle("split", workspace.split);
    this.root.classList.toggle("explorer-hidden", !workspace.explorerVisible);
    this.root.style.setProperty("--explorer-w", `${workspace.explorerWidth}px`);
    this.root.style.setProperty("--ratio", String(workspace.ratio));
    for (const p of Object.values(this.panes)) {
      p.el.classList.toggle("active", p.id === workspace.active && workspace.split);
      p.el.hidden = !this.visible(p.id);
    }
    this.splitBtn.setAttribute("aria-pressed", String(workspace.split));
  }

  activate(id: PaneId): void {
    if (workspace.active === id) return;
    workspace.active = id;
    this.applyLayout();
    this.paneChanged();
  }

  paneChanged(): void {
    for (const p of Object.values(this.panes)) {
      workspace.panes[p.id] = { path: p.path, mode: p.mode, masked: p.masked };
      this.ai.paneChanged(p);
    }
    this.ai.refreshChat();
    saveWorkspace();
    this.explorer.render();
    const path = this.active.path;
    document.title = path ? `${noteName(path)} - StudyNotes` : "StudyNotes";
  }

  refreshPreviews(): void {
    for (const p of Object.values(this.panes)) p.update();
  }

  async openPath(path: string, other: boolean, line?: number, mode?: "edit" | "read"): Promise<void> {
    let target = this.active;
    if (other) {
      target = this.other(workspace.active);
      if (!workspace.split) workspace.split = true;
    }
    workspace.active = target.id;
    this.applyLayout();
    await target.open(path, { line, mode });
    workspace.recent = [path, ...workspace.recent.filter((p) => p !== path)].slice(0, 20);
    this.explorer.reveal(path);
    this.paneChanged();
    target.focus();
  }

  async openLink(from: Pane, target: string, heading: string | null, other: boolean): Promise<void> {
    const resolved = vault.resolve(target, from.path);
    const pane = other ? this.other(from.id) : from;
    if (other && !workspace.split) workspace.split = true;
    workspace.active = pane.id;
    this.applyLayout();
    if (resolved) {
      await pane.open(resolved, { heading });
    } else {
      // まだないノート：リンク元と同じフォルダ（フォルダ付きならその場所）に作る
      const folder = target.includes("/") ? dirName(target) : dirName(from.path ?? "");
      try {
        const p = await vault.createNote(folder, target.includes("/") ? target.slice(target.lastIndexOf("/") + 1) : target);
        await pane.open(p, { mode: "edit" });
        toast(`「${noteName(p)}」を作成しました`);
        this.refreshPreviews();
      } catch (e) {
        toast(errorText(e), "error");
      }
    }
    if (pane.path) workspace.recent = [pane.path, ...workspace.recent.filter((p) => p !== pane.path)].slice(0, 20);
    this.paneChanged();
    pane.focus();
  }

  async newNote(name = "無題のノート"): Promise<void> {
    const folder = vault.folderOf(this.active.path);
    try {
      const p = await vault.createNote(folder, name);
      await this.openPath(p, false, undefined, "edit");
      this.refreshPreviews();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  quickOpen(): void {
    openQuickSwitcher(
      (p, other) => void this.openPath(p, other),
      (name) => void this.newNote(name),
    );
  }

  toggleSplit(): void {
    workspace.split = !workspace.split;
    this.applyLayout();
    this.paneChanged();
    if (workspace.split && !this.other(workspace.active).path) {
      // 右側が空なら、最近のノートを出しておく
      const next = workspace.recent.find((p) => p !== this.active.path && vault.notes.has(p));
      if (next) void this.other(workspace.active).open(next);
    }
  }

  toggleExplorer(): void {
    if (this.root.classList.contains("explorer-auto-hidden")) {
      this.root.classList.remove("explorer-auto-hidden");
      return;
    }
    workspace.explorerVisible = !workspace.explorerVisible;
    this.applyLayout();
    saveWorkspace();
  }

  openAi(p: Pane): void {
    workspace.active = p.id;
    this.applyLayout();
    this.ai.openFor(p);
  }

  openSettings(): void {
    openSettings({
      changeVault: () => void this.chooseVault(),
      changed: () => this.refreshPreviews(),
    });
  }

  async chooseVault(): Promise<void> {
    const p = await pickVaultFolder();
    if (p) await this.openVault(p);
  }

  async openVault(path: string): Promise<void> {
    for (const p of Object.values(this.panes)) await p.flush();
    try {
      await vault.open(path);
    } catch (e) {
      toast(errorText(e), "error");
      showWelcome(this);
      return;
    }
    settings.vaultPath = path;
    saveSettings();
    await loadWorkspace();
    this.vaultLabel.textContent = vault.root;
    if (vault.notes.size === 0) {
      try {
        await vault.createNote("", "はじめに", WELCOME_NOTE);
        workspace.panes.L = { path: "はじめに.md", mode: "read", masked: false };
      } catch {
        /* 無視 */
      }
    }
    document.body.replaceChildren(this.root);
    this.applyLayout();
    for (const id of ["L", "R"] as PaneId[]) {
      const st = workspace.panes[id];
      const p = st.path && vault.notes.has(st.path) ? st.path : null;
      this.panes[id].masked = !!st.masked && !!p;
      await this.panes[id].open(p, { history: false, mode: st.mode });
    }
    if (!this.panes.L.path && !this.panes.R.path) {
      const first = workspace.recent.find((p) => vault.notes.has(p)) ?? vault.notePaths()[0];
      if (first) await this.panes.L.open(first, { history: false });
    }
    this.explorer.refresh();
    for (const p of Object.values(this.panes)) if (p.path) this.explorer.reveal(p.path);
    this.paneChanged();
    this.unlisten?.();
    this.unlisten = await listen<string[]>("vault-changed", (e) => void this.onExternalChange(e.payload));
  }

  private async onExternalChange(paths: string[]): Promise<void> {
    const updated = new Set(await vault.refresh(paths));
    for (const p of Object.values(this.panes)) {
      if (p.path && (updated.has(p.path) || !vault.notes.has(p.path))) await p.externalChange();
    }
    this.refreshPreviews();
  }

  async flushAll(): Promise<void> {
    for (const p of Object.values(this.panes)) await p.flush();
  }

  handleKey(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return; // 日本語変換中
    // 再読み込みで編集中の内容を失わないように
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      return;
    }
    if (document.querySelector(".overlay")) return; // ダイアログ表示中
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const inText = (e.target as HTMLElement).closest("input, textarea, select, .cm-editor") !== null;
    const run = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (mod && !e.shiftKey && k === "p") return run(() => this.quickOpen());
    if (mod && e.shiftKey && k === "f") return run(() => this.explorer.toggleSearch(true));
    if (mod && !e.shiftKey && k === "n") return run(() => void this.newNote());
    if (mod && !e.shiftKey && k === "e") return run(() => this.active.toggleMode());
    if (mod && !e.shiftKey && k === "m") return run(() => this.active.toggleMask());
    if (mod && (k === "\\" || e.code === "IntlYen" || e.code === "Backslash")) return run(() => this.toggleSplit());
    if (mod && k === "tab") return run(() => workspace.split && this.activate(this.other(workspace.active).id));
    if (mod && !e.shiftKey && k === "b") return run(() => this.toggleExplorer());
    if (mod && e.shiftKey && k === "a") return run(() => this.openAi(this.active));
    if (mod && k === ",") return run(() => this.openSettings());
    if (e.altKey && k === "arrowleft") return run(() => void this.active.goBack());
    if (e.altKey && k === "arrowright") return run(() => void this.active.goForward());
    if (k === "escape" && this.ai.isOpen && !inText) return run(() => this.ai.close());
    if (k === " " && !inText && this.active.masked) return run(() => this.active.revealNext());
    if (mod && k === "s") return run(() => void this.flushAll()); // 癖で押しても困らないように
  }
}

function showWelcome(app: App): void {
  const pick = h("button", { class: "btn primary big", type: "button" }, "ノートフォルダを選ぶ");
  pick.addEventListener("click", () => void app.chooseVault());
  document.body.replaceChildren(
    h(
      "div",
      { class: "welcome" },
      h("div", { class: "welcome-card" }, h("h1", {}, "StudyNotes"), h("p", {}, "シンプルな学習用ノート"), h("p", { class: "muted" }, "ノートを保存するフォルダを選んでください。中のノートは普通の .md ファイルなので、ほかのアプリでも開けます。"), pick),
    ),
  );
  pick.focus();
}

async function main(): Promise<void> {
  await loadSettings();
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  const app = new App();
  window.addEventListener("keydown", (e) => app.handleKey(e), true);
  // ブラウザ既定の右クリックメニューは入力欄以外で出さない
  window.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest("input, textarea, .cm-editor, .note")) e.preventDefault();
  });
  // ノート外へのファイルのドロップでページが開いてしまうのを防ぐ
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  const win = getCurrentWindow();
  // 閉じる前に入力中のノートを保存する。保存に失敗しても閉じられるようにする
  // （閉じる処理自体は capabilities の core:window:allow-destroy が必要）
  void win.onCloseRequested(async () => {
    try {
      await Promise.race([app.flushAll(), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      /* 保存エラーはトーストで通知済み */
    }
  });
  if (settings.vaultPath) await app.openVault(settings.vaultPath);
  else showWelcome(app);
}

void main();
