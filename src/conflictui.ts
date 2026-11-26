// 競合コピーの確認・解決ダイアログ
import { ask } from "@tauri-apps/plugin-dialog";
import { errorText } from "./api";
import { modal } from "./dialogs";
import { h, icon, toast } from "./dom";
import type { Conflict } from "./lib/conflicts";
import { diffLines } from "./lib/diff";
import { fileName, noteName } from "./lib/links";
import { saveWorkspace, workspace } from "./settings";
import { vault } from "./vault";

export interface ConflictHost {
  /** ノートを開く（mobile なら1パネルで） */
  openPath(path: string): void;
  /** 書き換え・削除のあと、開いているペインを更新する */
  afterChange(changed: string[], removed: string[], renamed?: Map<string, string>): void;
}

const isNote = (p: string) => p.toLowerCase().endsWith(".md");

export function activeConflicts(): Conflict[] {
  const ignored = new Set(workspace.ignoredConflicts ?? []);
  return vault.conflicts().filter((c) => !ignored.has(c.path));
}

export function openConflictDialog(host: ConflictHost): void {
  const body = h("div", { class: "conflicts" });
  const m = modal("競合コピー", body, "wide sheet-tall");

  const showList = () => {
    const list = activeConflicts();
    if (!list.length) {
      m.close();
      toast("競合コピーはありません");
      return;
    }
    body.replaceChildren(
      h("div", { class: "modal-head" }, h("h2", {}, `競合コピー（${list.length}件）`), h("button", { class: "btn", type: "button", onclick: () => m.close() }, "閉じる")),
      h(
        "div",
        { class: "cf-body" },
        h(
          "p",
          { class: "muted small" },
          "同期アプリが、PCとスマホで同時に変更されたファイルを別名で残したものです。元のファイルと比べて、どちらを残すか選んでください。",
        ),
        ...list.map((c) =>
          h(
            "button",
            { class: "cf-item", type: "button", onclick: () => showCompare(c) },
            icon(isNote(c.path) ? "file" : "image", 16),
            h(
              "span",
              { class: "cf-names" },
              h("span", { class: "cf-name" }, isNote(c.path) ? noteName(c.path) : fileName(c.path)),
              h("span", { class: "muted small" }, c.original ? `元：${c.original}（${c.source}）` : `元のファイルが見つかりません（${c.source}）`),
            ),
            h("span", { class: "cf-go" }, "比べる ›"),
          ),
        ),
      ),
    );
  };

  const run = async (fn: () => Promise<void>, done: string) => {
    try {
      await fn();
      toast(done);
      showList();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const showCompare = (c: Conflict) => {
    const note = isNote(c.path);
    let view: HTMLElement;
    if (note) {
      const a = c.original ? (vault.notes.get(c.original) ?? "") : "";
      const b = vault.notes.get(c.path) ?? "";
      const lines = diffLines(a, b);
      const changed = lines.filter((l) => l.kind !== "same").length;
      view = h(
        "div",
        { class: "cf-diff" },
        ...(changed === 0 ? [h("div", { class: "cf-same" }, "内容は元のノートとまったく同じです。競合コピーは削除して大丈夫です。")] : []),
        ...lines.map((l) =>
          h("div", { class: `cf-line ${l.kind}` }, h("span", { class: "cf-mark" }, l.kind === "del" ? "−" : l.kind === "add" ? "+" : " "), l.text || " "),
        ),
      );
    } else {
      const img = (p: string | null, label: string) =>
        h("figure", { class: "cf-img" }, p && vault.imageSrc(p) ? h("img", { src: vault.imageSrc(p) ?? "", alt: label }) : h("div", { class: "muted" }, "なし"), h("figcaption", {}, label));
      view = h("div", { class: "cf-images" }, img(c.original, "元の画像"), img(c.path, "競合コピー"));
    }

    const adopt = h("button", { class: "btn primary", type: "button", disabled: !c.original }, "競合コピーを採用");
    adopt.title = "元のファイルを競合コピーの内容で置き換え、競合コピーは削除します";
    adopt.addEventListener("click", async () => {
      if (!c.original) return;
      const ok = await ask(`「${fileName(c.original)}」を競合コピーの内容で置き換えますか？\n（元の内容はごみ箱に移ります）`, {
        title: "StudyNotes",
        kind: "warning",
        okLabel: "置き換える",
        cancelLabel: "やめる",
      });
      if (!ok) return;
      const original = c.original;
      await run(async () => {
        if (note) {
          await vault.remove(original); // 元の内容はごみ箱へ（念のため残す）
          await vault.rename(c.path, original);
          host.afterChange([original], [c.path]);
        } else {
          await vault.remove(original);
          const map = await vault.rename(c.path, original);
          host.afterChange([original], [c.path], map);
        }
      }, "競合コピーを採用しました");
    });
    const del = h("button", { class: "btn danger", type: "button" }, "競合コピーを削除");
    del.title = "元のファイルを残し、競合コピーを削除します";
    del.addEventListener("click", async () => {
      const ok = await ask(`競合コピー「${fileName(c.path)}」を削除しますか？\n（${navigator.userAgent.includes("Android") ? ".studynote/trash" : "ごみ箱"}に移ります）`, {
        title: "StudyNotes",
        kind: "warning",
        okLabel: "削除する",
        cancelLabel: "やめる",
      });
      if (!ok) return;
      await run(async () => {
        await vault.remove(c.path);
        host.afterChange([], [c.path]);
      }, "競合コピーを削除しました");
    });
    const ignore = h("button", { class: "btn", type: "button", title: "競合コピーではないファイルが誤って表示されたとき" }, "競合ではない");
    ignore.addEventListener("click", () => {
      workspace.ignoredConflicts = [...(workspace.ignoredConflicts ?? []), c.path];
      saveWorkspace();
      showList();
    });
    const open = h("button", { class: "btn", type: "button" }, "開く");
    open.addEventListener("click", () => {
      m.close();
      host.openPath(c.path);
    });

    body.replaceChildren(
      h(
        "div",
        { class: "modal-head" },
        h("button", { class: "btn", type: "button", onclick: () => showList() }, "‹ 一覧"),
        h("h2", { class: "cf-title" }, note ? noteName(c.path) : fileName(c.path)),
        h("button", { class: "btn", type: "button", onclick: () => m.close() }, "閉じる"),
      ),
      h(
        "div",
        { class: "cf-body" },
        h(
          "div",
          { class: "cf-legend small" },
          note ? h("span", { class: "cf-key del" }, "− 元のノートだけにある行") : null,
          note ? h("span", { class: "cf-key add" }, "+ 競合コピーだけにある行") : null,
          h("span", { class: "muted" }, c.original ? `元：${c.original}` : "元のファイルが見つかりません"),
        ),
        view,
      ),
      h("div", { class: "cf-actions" }, adopt, del, ignore, note ? open : null),
    );
  };

  showList();
}
