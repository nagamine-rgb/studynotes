// 右端のAIパネル。フォーカスしているペインのノートを対象にする
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
import { ChatView } from "./chat";
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
  /** いま対象にするペイン（フォーカスしているペイン） */
  activePane(): Pane;
  /** 指定のノートを表示しているペイン */
  panesShowing(path: string): Pane[];
  openLink(from: Pane, target: string, other: boolean): void;
  isSplit(): boolean;
}

type Tab = "check" | "chat";

interface CheckResult {
  issues: LocatedIssue[];
  summary: string;
}

export class AiPanel {
  el: HTMLElement;
  isOpen = false;
  /** チェック結果はノートごとに持つ（ペインを切り替えても消えない） */
  private results = new Map<string, CheckResult>();
  private running: string | null = null; // チェック中のノート
  private mode: "typo" | "facts" = "typo";
  private tab: Tab = "check";
  private targetEl: HTMLElement;
  private engineEl: HTMLElement;
  private runBtn: HTMLButtonElement;
  private listEl: HTMLElement;
  private acceptAllBtn: HTMLButtonElement;
  private summaryEl: HTMLElement;
  private clearChatBtn: HTMLButtonElement;
  private chat: ChatView;
  private tabBtns: Record<Tab, HTMLButtonElement>;

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
    this.chat = new ChatView({
      pane: () => this.host.activePane(),
      openLink: (target, other) => this.host.openLink(this.host.activePane(), target, other),
    });
    this.tabBtns = {
      check: h("button", { class: "tab", type: "button", role: "tab", onclick: () => this.setTab("check") }, "チェック"),
      chat: h("button", { class: "tab", type: "button", role: "tab", onclick: () => this.setTab("chat") }, "チャット"),
    };
    this.clearChatBtn = h("button", { class: "btn small", type: "button", title: "チャットの履歴を消す", onclick: () => this.chat.clear() }, "履歴をクリア");
    const checkView = h(
      "div",
      { class: "check-view" },
      h(
        "div",
        { class: "ai-controls" },
        h(
          "div",
          { class: "ai-modes", role: "radiogroup", "aria-label": "チェックの種類" },
          h("label", { class: "check" }, modeTypo, "誤字・表記"),
          h("label", { class: "check" }, modeFacts, "内容も確認"),
        ),
        this.runBtn,
      ),
      this.summaryEl,
      this.listEl,
      h("div", { class: "ai-foot" }, this.acceptAllBtn),
    );
    this.el = h(
      "aside",
      { class: "ai-panel", "aria-label": "AI" },
      h(
        "div",
        { class: "ai-head" },
        h("div", { class: "tabs", role: "tablist" }, this.tabBtns.check, this.tabBtns.chat),
        this.clearChatBtn,
        iconButton("close", "閉じる（Ctrl+Shift+A）", () => this.close()),
      ),
      h("div", { class: "ai-target-bar" }, this.targetEl, this.engineEl),
      checkView,
      this.chat.el,
    );
    this.listEl.addEventListener("click", (e) => this.onListClick(e));
    this.setTab("check");
  }

  private get pane(): Pane {
    return this.host.activePane();
  }

  private get current(): CheckResult | undefined {
    return this.pane.path ? this.results.get(this.pane.path) : undefined;
  }

  setTab(tab: Tab): void {
    this.tab = tab;
    this.el.dataset.tab = tab;
    for (const [k, b] of Object.entries(this.tabBtns)) b.setAttribute("aria-selected", String(k === tab));
    this.clearChatBtn.hidden = tab !== "chat";
    this.render();
    if (tab === "chat") this.chat.focus();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(tab?: Tab): void {
    if (!this.isOpen) {
      this.isOpen = true;
      this.host.setOpen(true);
    }
    this.setTab(tab ?? this.tab);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.host.setOpen(false);
  }

  /** フォーカスや表示ノートが変わったとき */
  refresh(): void {
    if (this.isOpen) this.render();
  }

  /** あるペインに表示中のノートの指摘を、そのエディタに反映する */
  syncEditor(pane: Pane): void {
    pane.editor.setIssues(pane.path ? (this.results.get(pane.path)?.issues ?? []) : []);
  }

  private pushToEditors(path: string): void {
    for (const p of this.host.panesShowing(path)) this.syncEditor(p);
  }

  textChanged(pane: Pane, changes: { from: number; to: number; insertedLength: number }[]): void {
    const path = pane.path;
    const r = path ? this.results.get(path) : undefined;
    if (!path || !r?.issues.length) return;
    // iterChanges は元の文書の座標で前から順に来るので、ずらしながら適用する
    let offset = 0;
    for (const c of changes) {
      r.issues = shiftIssues(r.issues, c.from + offset, c.to + offset, c.insertedLength);
      offset += c.insertedLength - (c.to - c.from);
    }
    this.pushToEditors(path);
    if (this.isOpen && this.pane.path === path) this.render();
  }

  /** ノート名の変更に追従する */
  renamed(map: Map<string, string>): void {
    for (const [a, b] of map) {
      const r = this.results.get(a);
      if (r) {
        this.results.delete(a);
        this.results.set(b, r);
      }
    }
  }

  issueAction(pane: Pane, id: number, action: "accept" | "ignore"): void {
    if (!pane.path) return;
    if (action === "accept") this.accept(pane, id);
    else this.setStatus(pane.path, id, "ignored");
  }

  private setStatus(path: string, id: number, status: LocatedIssue["status"]): void {
    const r = this.results.get(path);
    if (!r) return;
    r.issues = r.issues.map((i) => (i.id === id ? { ...i, status } : i));
    this.pushToEditors(path);
    this.render();
  }

  private accept(pane: Pane, id: number): void {
    const path = pane.path;
    const r = path ? this.results.get(path) : undefined;
    const is = r?.issues.find((i) => i.id === id);
    if (!path || !r || !is || is.status !== "open") return;
    const doc = pane.editor.getText();
    if (doc.slice(is.from, is.to) !== is.original) {
      this.setStatus(path, id, "lost");
      toast("本文が変わっているため採用できません", "error");
      return;
    }
    r.issues = r.issues.map((i) => (i.id === id ? { ...i, status: "accepted" } : i));
    if (pane.masked) pane.setMasked(false);
    pane.editor.replace(is.from, is.to, is.suggestion);
    this.pushToEditors(path);
    this.render();
  }

  private acceptAll(): void {
    const pane = this.pane;
    const r = this.current;
    if (!r) return;
    // 後ろから採用すると前の位置がずれない
    const targets = r.issues.filter((i) => i.status === "open" && i.kind !== "fact").sort((a, b) => b.from - a.from);
    for (const i of targets) this.accept(pane, i.id);
    if (targets.length) toast(`${targets.length}件を採用しました`);
  }

  private async run(): Promise<void> {
    const pane = this.pane;
    const path = pane.path;
    if (!path || this.running) return;
    if (!settings.ai.consent) {
      const ok = await ask(
        "AIの機能では、ノートの本文（または選択範囲）が設定したAIサービスに送信されます。画像は送信されません。\n\n続けますか？（この確認は初回だけです）",
        { title: "StudyNotes", kind: "info", okLabel: "送信する", cancelLabel: "やめる" },
      );
      if (!ok) return;
      settings.ai.consent = true;
      saveSettings();
    }
    const text = pane.editor.getText();
    let from = parseFrontmatter(text).bodyStart;
    let to = text.length;
    let label = "ノート全体";
    if (!pane.masked) {
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
    this.running = path;
    this.results.set(path, { issues: [], summary: `${label}をチェック中…` });
    this.pushToEditors(path);
    this.render();
    try {
      const p = settings.ai.provider;
      const raw = await api.aiCheck({ provider: p, model: currentModel(), base_url: settings.ai.baseUrls[p] || null, text: part, mode: this.mode });
      const now = this.host.panesShowing(path)[0]?.editor.getText() ?? text;
      if (now.slice(from, to) !== part) {
        this.results.set(path, { issues: [], summary: "チェック中に本文が変わったため、結果を破棄しました。もう一度実行してください" });
        return;
      }
      const issues = locateIssues(part, raw, from);
      const dropped = raw.length - issues.length;
      const summary = issues.length
        ? `${label}：${issues.length}件の指摘${dropped > 0 ? `（記法を壊す・位置が不明な ${dropped}件は除外）` : ""}。本文の波線にマウスを乗せても採用できます`
        : `${label}：問題は見つかりませんでした`;
      this.results.set(path, { issues, summary });
    } catch (e) {
      this.results.delete(path);
      toast(errorText(e), "error");
    } finally {
      this.running = null;
      this.pushToEditors(path);
      this.render();
    }
  }

  private onListClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    const item = el.closest<HTMLElement>("[data-id]");
    const pane = this.pane;
    if (!item || !pane.path) return;
    const id = Number(item.dataset.id);
    const action = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (action === "accept") return this.accept(pane, id);
    if (action === "ignore") return this.setStatus(pane.path, id, "ignored");
    const is = this.current?.issues.find((i) => i.id === id);
    if (!is || is.status === "lost") return;
    if (pane.masked) pane.setMasked(false);
    pane.editor.select(is.from, is.to);
  }

  render(): void {
    const pane = this.pane;
    const where = this.host.isSplit() ? `（${pane.id === "L" ? "左" : "右"}）` : "";
    this.targetEl.replaceChildren(
      h("span", { class: "muted" }, "対象："),
      pane.path ? h("strong", {}, `${noteName(pane.path)}${where}`) : h("span", { class: "muted" }, "ノートが開かれていません"),
    );
    const prov = PROVIDERS.find((p) => p.id === settings.ai.provider);
    this.engineEl.replaceChildren(
      `${prov?.label ?? ""} / ${currentModel() || "モデル未設定"}　`,
      h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), this.host.openSettings()) }, "変更"),
    );
    if (this.tab === "chat") {
      this.chat.render();
      return;
    }
    const r = this.current;
    const busy = this.running !== null;
    this.runBtn.disabled = busy || !pane.path;
    this.runBtn.textContent = busy ? (this.running === pane.path ? "チェック中…" : "ほかのノートをチェック中…") : "チェック開始";
    this.summaryEl.textContent = r?.summary ?? (pane.path ? "選択範囲があればその部分、なければノート全体をチェックします" : "");
    const visible = (r?.issues ?? []).filter((i) => i.status !== "ignored");
    this.listEl.replaceChildren(
      ...visible.map((i) =>
        h(
          "div",
          { class: `ai-item status-${i.status}`, "data-id": i.id, tabindex: 0 },
          h(
            "div",
            { class: "ai-item-head" },
            h("span", { class: `badge badge-${i.kind}` }, KIND_LABEL[i.kind] ?? i.kind),
            i.status === "accepted" ? h("span", { class: "muted small" }, "採用済み") : null,
            i.status === "lost" ? h("span", { class: "muted small" }, "位置が見つかりません") : null,
          ),
          h("div", { class: "ai-diff" }, h("del", {}, i.original), h("span", { class: "arrow" }, "→"), h("ins", {}, i.suggestion)),
          i.reason ? h("div", { class: "ai-reason" }, i.reason) : null,
          i.status === "open"
            ? h(
                "div",
                { class: "issue-btns" },
                h("button", { class: "btn primary small", type: "button", "data-act": "accept" }, "採用"),
                h("button", { class: "btn small", type: "button", "data-act": "ignore" }, "無視"),
              )
            : null,
        ),
      ),
    );
    const openTypos = (r?.issues ?? []).filter((i) => i.status === "open" && i.kind !== "fact").length;
    this.acceptAllBtn.disabled = openTypos === 0;
    this.acceptAllBtn.textContent = openTypos ? `誤字・表記をすべて採用（${openTypos}件）` : "誤字・表記をすべて採用";
  }
}
