// Ctrl+P のノート検索、設定画面
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText } from "./api";
import { h, toast } from "./dom";
import { dirName, noteName } from "./lib/links";
import { fuzzyScore } from "./lib/text";
import { applyTheme, PROVIDERS, saveSettings, settings, type ProviderId } from "./settings";
import { vault } from "./vault";

function modal(title: string, content: HTMLElement, cls = ""): { close: () => void; root: HTMLElement } {
  const prevFocus = document.activeElement as HTMLElement | null;
  const box = h("div", { class: `modal ${cls}`, role: "dialog", "aria-modal": "true", "aria-label": title });
  const overlay = h("div", { class: "overlay" }, box);
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  box.append(content);
  document.body.append(overlay);
  return { close, root: box };
}

export function openQuickSwitcher(onPick: (path: string, other: boolean) => void, onCreate: (name: string) => void): void {
  const input = h("input", { class: "input big", placeholder: "ノート名を入力…（Enterで開く／Ctrl+Enterで反対側に開く）", "aria-label": "ノート名" });
  const list = h("div", { class: "qs-list", role: "listbox" });
  let items: { path: string | null; label: string }[] = [];
  let index = 0;
  const render = () => {
    const q = input.value.trim();
    const scored = vault
      .notePaths()
      .map((p) => ({ p, s: q ? Math.max(fuzzyScore(q, noteName(p)), fuzzyScore(q, p) - 50) : 0 }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.p.localeCompare(b.p, "ja"))
      .slice(0, 50);
    items = scored.map((x) => ({ path: x.p, label: noteName(x.p) }));
    if (q && !vault.resolve(q, null)) items.push({ path: null, label: q });
    index = Math.min(index, Math.max(0, items.length - 1));
    list.replaceChildren(
      ...items.map((it, i) =>
        h(
          "div",
          { class: `qs-item${i === index ? " sel" : ""}`, role: "option", "aria-selected": String(i === index), "data-i": i },
          it.path ? h("span", {}, it.label) : h("span", {}, `「${it.label}」を新規作成`),
          h("span", { class: "muted small" }, it.path ? dirName(it.path) : "Enter"),
        ),
      ),
    );
    list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };
  const choose = (i: number, other: boolean) => {
    const it = items[i];
    if (!it) return;
    m.close();
    if (it.path) onPick(it.path, other);
    else onCreate(it.label);
  };
  input.addEventListener("input", () => {
    index = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 日本語変換中
    if (e.key === "ArrowDown") {
      e.preventDefault();
      index = Math.min(items.length - 1, index + 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      index = Math.max(0, index - 1);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(index, e.ctrlKey || e.metaKey);
    }
  });
  list.addEventListener("click", (e) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (it) choose(Number(it.dataset.i), e.ctrlKey || e.metaKey);
  });
  const m = modal("ノート検索", h("div", { class: "qs" }, input, list), "quick");
  render();
  input.focus();
}

export async function pickVaultFolder(): Promise<string | null> {
  const p = await openDialog({ directory: true, multiple: false, title: "ノートを保存するフォルダを選んでください" });
  return typeof p === "string" ? p : null;
}

export function openSettings(handlers: { changeVault: () => void; changed: () => void }): void {
  const section = (title: string, ...rows: HTMLElement[]) => h("section", { class: "set-section" }, h("h3", {}, title), ...rows);
  const row = (label: string, control: HTMLElement, note?: string) =>
    h("div", { class: "set-row" }, h("label", { class: "set-label" }, label), h("div", { class: "set-control" }, control, note ? h("div", { class: "muted small" }, note) : null));

  // 表示
  const theme = h("select", { class: "input" }, ...[["system", "システムに合わせる"], ["light", "ライト"], ["dark", "ダーク"]].map(([v, l]) => h("option", { value: v, selected: settings.theme === v }, l)));
  theme.addEventListener("change", () => {
    settings.theme = theme.value as typeof settings.theme;
    applyTheme();
    saveSettings();
  });
  const font = h("input", { class: "input narrow", type: "number", min: 11, max: 28, value: settings.fontSize });
  font.addEventListener("change", () => {
    settings.fontSize = Math.min(28, Math.max(11, Number(font.value) || 15));
    applyTheme();
    saveSettings();
  });

  // 暗記
  const check = (label: string, key: "highlight" | "cloze" | "bold") => {
    const c = h("input", { type: "checkbox", checked: settings.mask[key] });
    c.addEventListener("change", () => {
      settings.mask[key] = c.checked;
      saveSettings();
      handlers.changed();
    });
    return h("label", { class: "check" }, c, label);
  };

  // AI
  const provider = h("select", { class: "input" }, ...PROVIDERS.map((p) => h("option", { value: p.id, selected: settings.ai.provider === p.id }, p.label)));
  const modelInput = h("input", { class: "input", list: "model-list", "aria-label": "モデル" });
  const modelList = h("datalist", { id: "model-list" });
  const fetchedNote = h("div", { class: "muted small" });
  const refreshBtn = h("button", { class: "btn", type: "button" }, "一覧を更新");
  const baseUrl = h("input", { class: "input", placeholder: "既定の接続先を使う" });
  const keyInput = h("input", { class: "input", type: "password", placeholder: "APIキーを貼り付け", autocomplete: "off" });
  const keyStatus = h("span", { class: "key-status" });
  const keySave = h("button", { class: "btn primary", type: "button" }, "保存");
  const keyDelete = h("button", { class: "btn", type: "button" }, "削除");
  const keyLink = h("a", { href: "#", class: "small" }, "APIキーの取得ページを開く");
  const collapse = h("input", { type: "checkbox", checked: settings.ai.collapseExplorer });

  const pid = () => provider.value as ProviderId;
  const syncAi = async () => {
    const p = pid();
    const def = PROVIDERS.find((x) => x.id === p)!;
    modelInput.value = settings.ai.models[p] ?? def.defaultModel;
    modelInput.placeholder = def.defaultModel || "モデル名";
    const cached = settings.ai.modelLists[p];
    modelList.replaceChildren(...(cached?.ids ?? []).map((id) => h("option", { value: id })));
    fetchedNote.textContent = cached
      ? `一覧の取得日時：${new Date(cached.fetchedAt).toLocaleString("ja-JP")}（${cached.ids.length}件）。入力欄をクリックすると候補が出ます`
      : "［一覧を更新］で、このサービスで使える最新のモデルを取得します";
    baseUrl.value = settings.ai.baseUrls[p] ?? "";
    baseUrl.placeholder = p === "custom" ? "例：http://localhost:11434/v1" : "空欄なら既定の接続先";
    keyLink.style.display = def.keyUrl ? "" : "none";
    keyInput.value = "";
    keyStatus.textContent = "確認中…";
    const has = await api.secretHas(p).catch(() => false);
    keyStatus.textContent = has ? "保存済み" : "未設定";
    keyStatus.className = `key-status ${has ? "ok" : ""}`;
  };
  provider.addEventListener("change", () => {
    settings.ai.provider = pid();
    saveSettings();
    void syncAi();
  });
  modelInput.addEventListener("change", () => {
    settings.ai.models[pid()] = modelInput.value.trim();
    saveSettings();
  });
  baseUrl.addEventListener("change", () => {
    settings.ai.baseUrls[pid()] = baseUrl.value.trim();
    saveSettings();
  });
  refreshBtn.addEventListener("click", async () => {
    const p = pid();
    refreshBtn.disabled = true;
    refreshBtn.textContent = "取得中…";
    try {
      const ids = await api.aiListModels(p, settings.ai.baseUrls[p] || null);
      settings.ai.modelLists[p] = { ids, fetchedAt: new Date().toISOString() };
      if (!settings.ai.models[p] && !PROVIDERS.find((x) => x.id === p)?.defaultModel) settings.ai.models[p] = ids[0];
      saveSettings();
      toast(`${ids.length}件のモデルを取得しました`);
      void syncAi();
      modelInput.focus();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "一覧を更新";
    }
  });
  keySave.addEventListener("click", async () => {
    try {
      await api.secretSet(pid(), keyInput.value);
      toast("APIキーを保存しました（Windowsの資格情報マネージャー）");
      void syncAi();
    } catch (e) {
      toast(errorText(e), "error");
    }
  });
  keyDelete.addEventListener("click", async () => {
    await api.secretDelete(pid()).catch((e) => toast(errorText(e), "error"));
    void syncAi();
  });
  keyLink.addEventListener("click", (e) => {
    e.preventDefault();
    const url = PROVIDERS.find((x) => x.id === pid())?.keyUrl;
    if (url) void openUrl(url);
  });
  collapse.addEventListener("change", () => {
    settings.ai.collapseExplorer = collapse.checked;
    saveSettings();
  });

  const changeVault = h("button", { class: "btn", type: "button" }, "変更…");
  changeVault.addEventListener("click", () => {
    m.close();
    handlers.changeVault();
  });

  const body = h(
    "div",
    { class: "settings" },
    h("div", { class: "modal-head" }, h("h2", {}, "設定"), h("button", { class: "btn", type: "button", onclick: () => m.close() }, "閉じる")),
    h(
      "div",
      { class: "settings-body" },
      section("ノートフォルダ", row("場所", h("div", { class: "inline" }, h("code", { class: "path" }, vault.root || "未選択"), changeVault))),
      section("表示", row("テーマ", theme), row("本文の文字サイズ", font)),
      section(
        "暗記モード",
        row("隠す対象", h("div", { class: "checks" }, check("==強調==", "highlight"), check("{{穴埋め}}", "cloze"), check("**太字**", "bold")), "ノートの先頭に mask: highlight, bold のように書くと、そのノートだけ変えられます"),
      ),
      section(
        "AIチェック",
        row("サービス", provider),
        row("モデル", h("div", { class: "inline" }, modelInput, modelList, refreshBtn), undefined),
        h("div", { class: "set-row" }, h("span", { class: "set-label" }), h("div", { class: "set-control" }, fetchedNote)),
        row("APIキー", h("div", { class: "inline" }, keyInput, keySave, keyDelete, keyStatus), "キーは画面に再表示されません"),
        h("div", { class: "set-row" }, h("span", { class: "set-label" }), h("div", { class: "set-control" }, keyLink)),
        row("接続先URL", baseUrl, "OpenAI互換（カスタム）のときは必須。ほかは通常空欄のままで使えます"),
        row("", h("label", { class: "check" }, collapse, "AIパネルを開くときエクスプローラーを畳む")),
      ),
    ),
  );
  const m = modal("設定", body, "wide");
  void syncAi();
}
