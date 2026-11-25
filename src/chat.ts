// AIパネルの「チャット」タブ
import { api, errorText } from "./api";
import { h, toast } from "./dom";
import { noteName } from "./lib/links";
import type { Pane } from "./pane";
import { renderNote } from "./render";
import { currentModel, saveSettings, settings } from "./settings";
import { vault } from "./vault";
import { ask } from "@tauri-apps/plugin-dialog";

interface ChatMessage {
  role: "user" | "assistant" | "error";
  content: string; // AIに送る内容
  display?: string; // 画面に出す短い表示（クイックボタン）
  note?: string | null; // 参照したノート名
  failed?: boolean; // 送信に失敗した質問（次からは履歴に含めない）
}

const QUICK: [string, string][] = [
  ["要約して", "このノートの内容を、要点が分かるように短く要約してください。"],
  ["わかりやすく説明", "このノートの内容を、初めて学ぶ人にも分かるように、例を交えて説明してください。"],
  ["確認問題を作って", "このノートの内容から、一問一答の確認問題を5問作ってください。答えは ==答え== の形で書いてください。"],
  ["重要語句を挙げて", "このノートで覚えるべき重要語句を挙げ、それぞれ一言で説明してください。"],
];

const MAX_NOTE_CHARS = 20000;

export interface ChatHost {
  pane(): Pane | null;
  openLink(target: string, other: boolean): void;
}

export class ChatView {
  el: HTMLElement;
  private messages: ChatMessage[] = [];
  private sending = false;
  private listEl: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private useNote: HTMLInputElement;
  private noteLabel: HTMLElement;
  private chips: HTMLElement;

  constructor(private host: ChatHost) {
    this.useNote = h("input", { type: "checkbox", checked: true });
    this.noteLabel = h("span", {});
    this.useNote.addEventListener("change", () => this.render());
    this.listEl = h("div", { class: "chat-list", "aria-live": "polite" });
    this.chips = h(
      "div",
      { class: "chat-chips" },
      ...QUICK.map(([label, prompt]) => h("button", { class: "chip", type: "button", onclick: () => void this.send(prompt, label) }, label)),
    );
    this.input = h("textarea", { class: "chat-input", rows: 3, placeholder: "質問を入力（Enterで送信／Shift+Enterで改行）", "aria-label": "AIへの質問" });
    this.input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 日本語変換中
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send(this.input.value);
      }
      e.stopPropagation();
    });
    this.sendBtn = h("button", { class: "btn primary", type: "button", onclick: () => void this.send(this.input.value) }, "送信");
    this.el = h(
      "div",
      { class: "chat-view" },
      h("div", { class: "chat-context" }, h("label", { class: "check" }, this.useNote, this.noteLabel)),
      this.listEl,
      h("div", { class: "chat-compose" }, this.chips, h("div", { class: "chat-row" }, this.input, this.sendBtn)),
    );
    this.listEl.addEventListener("click", (e) => this.onListClick(e));
    this.render();
  }

  focus(): void {
    this.input.focus();
  }

  clear(): void {
    this.messages = [];
    this.render();
    this.input.focus();
  }

  private async send(text: string, shown?: string): Promise<void> {
    const content = text.trim();
    if (!content || this.sending) return;
    const pane = this.host.pane();
    const note = this.useNote.checked && pane?.path ? pane.path : null;
    const noteText = note ? pane!.editor.getText() : null;
    if (noteText && noteText.length > MAX_NOTE_CHARS) {
      toast(`ノートが長すぎます（${noteText.length.toLocaleString()}文字）。「参照」を外すか、ノートを分けてください`, "error");
      return;
    }
    if (!settings.ai.consent) {
      const ok = await ask(
        "AIチャットでは、入力した質問（と参照するノートの本文）が設定したAIサービスに送信されます。\n\n続けますか？（この確認は初回だけです）",
        { title: "StudyNotes", kind: "info", okLabel: "送信する", cancelLabel: "やめる" },
      );
      if (!ok) return;
      settings.ai.consent = true;
      saveSettings();
    }
    this.messages.push({ role: "user", content, display: shown, note: note ? noteName(note) : null });
    const history = this.messages
      .filter((m) => m.role !== "error" && !m.failed)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    if (!shown) this.input.value = "";
    this.sending = true;
    this.render();
    try {
      const p = settings.ai.provider;
      const reply = await api.aiChat({
        provider: p,
        model: currentModel(),
        base_url: settings.ai.baseUrls[p] || null,
        messages: history,
        note_name: note ? noteName(note) : null,
        note_text: noteText,
      });
      this.messages.push({ role: "assistant", content: reply });
    } catch (e) {
      const last = this.messages[this.messages.length - 1];
      if (last?.role === "user") last.failed = true;
      this.messages.push({ role: "error", content: errorText(e) });
    } finally {
      this.sending = false;
      this.render();
      this.input.focus();
    }
  }

  private onListClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    const wl = el.closest<HTMLAnchorElement>("a.wl");
    if (wl) {
      e.preventDefault();
      this.host.openLink(wl.dataset.target ?? "", e.ctrlKey || e.metaKey);
      return;
    }
    if (el.closest("a")) {
      e.preventDefault();
      return;
    }
    const btn = el.closest<HTMLElement>("[data-act]");
    if (!btn) return;
    const msg = this.messages[Number(btn.dataset.i)];
    if (!msg) return;
    if (btn.dataset.act === "copy") void copyText(msg.content);
    if (btn.dataset.act === "insert") this.insert(msg.content);
  }

  private insert(text: string): void {
    const pane = this.host.pane();
    if (!pane?.path) {
      toast("挿入先のノートが開かれていません", "error");
      return;
    }
    if (pane.masked) pane.setMasked(false);
    const doc = pane.editor.getText();
    // カーソルを置いていなければ（先頭のまま）ノートの末尾に入れる
    const sel = pane.editor.selection().to;
    const pos = sel === 0 && doc.length > 0 ? doc.length : sel;
    const before = pos > 0 && doc[pos - 1] !== "\n" ? "\n\n" : pos > 0 ? "\n" : "";
    pane.editor.insertAt(pos, `${before}${text.trim()}\n`);
    toast(`「${noteName(pane.path)}」に挿入しました`);
  }

  render(): void {
    const pane = this.host.pane();
    this.noteLabel.textContent = pane?.path ? `表示中のノートを参照（${noteName(pane.path)}）` : "表示中のノートを参照（なし）";
    this.useNote.disabled = !pane?.path;
    this.chips.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = this.sending || !pane?.path || !this.useNote.checked));
    this.sendBtn.disabled = this.sending;
    this.sendBtn.textContent = this.sending ? "送信中…" : "送信";
    const items: HTMLElement[] = this.messages.map((m, i) => {
      if (m.role === "user") {
        return h("div", { class: "msg user" }, h("div", { class: "bubble" }, m.display ?? m.content), m.note ? h("div", { class: "msg-meta" }, `参照：${m.note}`) : null);
      }
      if (m.role === "error") return h("div", { class: "msg error" }, m.content);
      const body = h("div", { class: "bubble note" });
      body.innerHTML = renderNote(m.content, {
        resolve: (t) => vault.resolve(t, pane?.path ?? null),
        imageSrc: () => null,
      });
      return h(
        "div",
        { class: "msg assistant" },
        body,
        h(
          "div",
          { class: "msg-actions" },
          h("button", { class: "btn small", type: "button", "data-act": "insert", "data-i": i, title: "カーソルの位置（置いていなければ末尾）に挿入" }, "ノートに挿入"),
          h("button", { class: "btn small", type: "button", "data-act": "copy", "data-i": i }, "コピー"),
        ),
      );
    });
    if (this.sending) items.push(h("div", { class: "msg assistant thinking" }, h("div", { class: "bubble" }, "考え中…")));
    if (!items.length) {
      items.push(
        h(
          "div",
          { class: "chat-empty muted" },
          h("p", {}, "ノートについて質問したり、要約や確認問題を作ってもらえます。"),
          h("p", { class: "small" }, "会話はアプリを閉じるまで残ります。上の［履歴をクリア］で消せます。"),
          h("p", { class: "small" }, `使用中：${currentModel() || "モデル未設定"}`),
        ),
      );
    }
    this.listEl.replaceChildren(...items);
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", {}, text);
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("コピーしました");
}
