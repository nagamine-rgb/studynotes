// 右のAIパネル（誤字・表記・内容のチェック）
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
import { h, iconButton, toast } from "./dom";
import { type LocatedIssue, locateIssues, shiftIssues } from "./lib/issues";
import { noteName } from "./lib/links";
import { parseFrontmatter } from "./lib/text";
import type { Pane } from "./pane";
import { currentModel, PROVIDERS, saveSettings, settings } from "./settings";

const MAX_CHARS = 20000;
const KIND_LABEL: Record<string, string> = { typo: "誤字", style: "表記", fact: "要確認" };

export interface AiHost {
  setOpen(open: boolean): void;
  openSettings(): void;
}

export class AiPanel {
  el: HTMLElement;
  isOpen = false;
  private pane: Pane | null = null;
  private targetPath: string | null = null;
  private issues: LocatedIssue[] = [];
  private running = false;
  private mode: "typo" | "facts" = "typo";
  private targetEl: HTMLElement;
  private engineEl: HTMLElement;
  private runBtn: HTMLButtonElement;
  private listEl: HTMLElement;
  private acceptAllBtn: HTMLButtonElement;
  private summaryEl: HTMLElement;

  constructor(private host: AiHost) {
    this.targetEl = h("div", { class: "ai-target" });
    this.engineEl = h("div", { class: "ai-engine muted small" });
    const modeTypo = h("input", { type: "radio", name: "ai-mode", value: "typo", checked: true });
    const modeFacts = h("input", { type: "radio", name: "ai-mode", value: "facts" });
    for (const r of [modeTypo, modeFacts]) r.addEventListener("change", () => (this.mode = r.value as "typo" | "facts"));
    this.runBtn = h("button", { class: "btn primary block", type: "button", onclick: () => void this.run() }, "チェック開始");
    this.summaryEl = h("div", { class: "ai-summary muted small" });
    this.listEl = h("div", { class: "ai-list" });
    this.acceptAllBtn = h("button", { class: "btn block", type: "button", onclick: () => this.acceptAll() }, "誤字・表記をすべて採用");
    this.el = h(
      "aside",
      { class: "ai-panel", "aria-label": "AIチェック" },
      h("div", { class: "ai-head" }, h("strong", {}, "AIチェック"), iconButton("close", "閉じる（Esc）", () => this.close())),
      h(
        "div",
        { class: "ai-controls" },
        this.targetEl,
        h(
          "div",
          { class: "ai-modes", role: "radiogroup", "aria-label": "チェックの種類" },
          h("label", { class: "check" }, modeTypo, "誤字・表記"),
          h("label", { class: "check" }, modeFacts, "内容も確認"),
        ),
        this.runBtn,
        this.engineEl,
      ),
      this.summaryEl,
      this.listEl,
      h("div", { class: "ai-foot" }, this.acceptAllBtn),
    );
    this.listEl.addEventListener("click", (e) => this.onListClick(e));
    this.render();
  }

  /** パネルを開いて対象のペインを決める */
  openFor(pane: Pane): void {
    if (this.pane !== pane || this.targetPath !== pane.path) this.clear();
    this.pane = pane;
    this.targetPath = pane.path;
    if (!this.isOpen) {
      this.isOpen = true;
      this.host.setOpen(true);
    }
    this.render();
    this.runBtn.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.clear();
    this.host.setOpen(false);
  }

  /** ペインの表示ノートが変わったら結果を捨てる */
  paneChanged(pane: Pane): void {
    if (pane === this.pane && pane.path !== this.targetPath) {
      this.clear();
      this.targetPath = pane.path;
      this.render();
    }
  }

  textChanged(pane: Pane, changes: { from: number; to: number; insertedLength: number }[]): void {
    if (pane !== this.pane || !this.issues.length) return;
    // 後ろの変更から順にずらす必要はない：iterChanges は元の文書の座標で、前から順に来る
    let offset = 0;
    for (const c of changes) {
      this.issues = shiftIssues(this.issues, c.from + offset, c.to + offset, c.insertedLength);
      offset += c.insertedLength - (c.to - c.from);
    }
    this.pushToEditor();
    this.render();
  }

  issueAction(pane: Pane, id: number, action: "accept" | "ignore"): void {
    if (pane !== this.pane) return;
    if (action === "accept") this.accept(id);
    else this.setStatus(id, "ignored");
  }

  private clear(): void {
    this.issues = [];
    this.pushToEditor();
    this.summaryEl.textContent = "";
  }

  private pushToEditor(): void {
    this.pane?.editor.setIssues(this.issues);
  }

  private setStatus(id: number, status: LocatedIssue["status"]): void {
    this.issues = this.issues.map((i) => (i.id === id ? { ...i, status } : i));
    this.pushToEditor();
    this.render();
  }

  private accept(id: number): void {
    const pane = this.pane;
    const is = this.issues.find((i) => i.id === id);
    if (!pane || !is || is.status !== "open") return;
    const doc = pane.editor.getText();
    if (doc.slice(is.from, is.to) !== is.original) {
      this.setStatus(id, "lost");
      toast("本文が変わっているため採用できません", "error");
      return;
    }
    this.issues = this.issues.map((i) => (i.id === id ? { ...i, status: "accepted" } : i));
    pane.editor.replace(is.from, is.to, is.suggestion);
    this.pushToEditor();
    this.render();
  }

  private acceptAll(): void {
    // 後ろから採用すると前の位置がずれない
    const targets = this.issues.filter((i) => i.status === "open" && i.kind !== "fact").sort((a, b) => b.from - a.from);
    for (const i of targets) this.accept(i.id);
    if (targets.length) toast(`${targets.length}件を採用しました`);
  }

  private async run(): Promise<void> {
    const pane = this.pane;
    if (!pane?.path || this.running) return;
    if (!settings.ai.consent) {
      const ok = await ask(
        "AIチェックでは、ノートの本文（または選択範囲）が設定したAIサービスに送信されます。画像は送信されません。\n\n続けますか？（この確認は初回だけです）",
        { title: "StudyNotes", kind: "info", okLabel: "送信してチェック", cancelLabel: "やめる" },
      );
      if (!ok) return;
      settings.ai.consent = true;
      saveSettings();
    }
    const text = pane.editor.getText();
    let from = parseFrontmatter(text).bodyStart;
    let to = text.length;
    let label = "ノート全体";
    if (pane.mode === "edit") {
      const sel = pane.editor.selection();
      if (sel.to > sel.from) {
        from = sel.from;
        to = sel.to;
        label = "選択範囲";
      }
    }
    const part = text.slice(from, to);
    if (!part.trim()) {
      toast("チェックする文章がありません");
      return;
    }
    if (part.length > MAX_CHARS) {
      toast(`長すぎます（${part.length.toLocaleString()}文字）。${MAX_CHARS.toLocaleString()}文字以内の範囲を選んでください`, "error");
      return;
    }
    this.running = true;
    this.clear();
    this.summaryEl.textContent = `${label}をチェック中…`;
    this.render();
    try {
      const p = settings.ai.provider;
      const raw = await api.aiCheck({ provider: p, model: currentModel(), base_url: settings.ai.baseUrls[p] || null, text: part, mode: this.mode });
      if (pane.path !== this.targetPath || pane.editor.getText().slice(from, to) !== part) {
        this.summaryEl.textContent = "チェック中に本文が変わったため、結果を破棄しました。もう一度実行してください";
        return;
      }
      this.issues = locateIssues(part, raw, from);
      const dropped = raw.length - this.issues.length;
      this.summaryEl.textContent = this.issues.length
        ? `${label}：${this.issues.length}件の指摘${dropped > 0 ? `（記法を壊す・位置が不明な ${dropped}件は除外）` : ""}`
        : `${label}：問題は見つかりませんでした`;
      if (this.issues.length && pane.mode !== "edit") pane.setMode("edit");
      this.pushToEditor();
    } catch (e) {
      this.summaryEl.textContent = "";
      toast(errorText(e), "error");
    } finally {
      this.running = false;
      this.render();
    }
  }

  private onListClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    const item = el.closest<HTMLElement>("[data-id]");
    if (!item || !this.pane) return;
    const id = Number(item.dataset.id);
    const action = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (action === "accept") return this.accept(id);
    if (action === "ignore") return this.setStatus(id, "ignored");
    const is = this.issues.find((i) => i.id === id);
    if (!is || is.status === "lost") return;
    if (this.pane.mode !== "edit") this.pane.setMode("edit");
    this.pane.editor.select(is.from, is.to);
  }

  render(): void {
    const pane = this.pane;
    this.targetEl.textContent = pane?.path ? `対象：${noteName(pane.path)}（${pane.id === "L" ? "左" : "右"}ペイン）` : "対象のノートがありません";
    const prov = PROVIDERS.find((p) => p.id === settings.ai.provider);
    this.engineEl.replaceChildren(
      `${prov?.label ?? ""} / ${currentModel() || "モデル未設定"}　`,
      h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), this.host.openSettings()) }, "変更"),
    );
    this.runBtn.disabled = this.running || !pane?.path;
    this.runBtn.textContent = this.running ? "チェック中…" : "チェック開始";
    const visible = this.issues.filter((i) => i.status !== "ignored");
    this.listEl.replaceChildren(
      ...visible.map((i) =>
        h(
          "div",
          { class: `ai-item status-${i.status}`, "data-id": i.id, tabindex: 0 },
          h("div", { class: "ai-item-head" }, h("span", { class: `badge badge-${i.kind}` }, KIND_LABEL[i.kind] ?? i.kind), i.status === "accepted" ? h("span", { class: "muted small" }, "採用済み") : null, i.status === "lost" ? h("span", { class: "muted small" }, "位置が見つかりません") : null),
          h("div", { class: "ai-diff" }, h("del", {}, i.original), h("span", { class: "arrow" }, "→"), h("ins", {}, i.suggestion)),
          i.reason ? h("div", { class: "ai-reason" }, i.reason) : null,
          i.status === "open"
            ? h("div", { class: "issue-btns" }, h("button", { class: "btn primary small", type: "button", "data-act": "accept" }, "採用"), h("button", { class: "btn small", type: "button", "data-act": "ignore" }, "無視"))
            : null,
        ),
      ),
    );
    const openTypos = this.issues.filter((i) => i.status === "open" && i.kind !== "fact").length;
    this.acceptAllBtn.disabled = openTypos === 0;
    this.acceptAllBtn.textContent = openTypos ? `誤字・表記をすべて採用（${openTypos}件）` : "誤字・表記をすべて採用";
  }
}
