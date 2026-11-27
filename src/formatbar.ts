// 本文下の書式ツールバー（フォーカスしているペインに効く）
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
import { h, icon, toast } from "./dom";
import type { Pane } from "./pane";

export interface FormatHost {
  activePane(): Pane;
}


export class FormatBar {
  el: HTMLElement;

  constructor(private host: FormatHost) {
    const ed = () => this.host.activePane().editor;
    const btn = (label: string, title: string, run: () => void, iconName?: string, cls = "") => {
      const b = h("button", { class: `fmt ${cls}`, type: "button", title, "aria-label": title });
      if (iconName) b.append(icon(iconName, 17));
      else b.textContent = label;
      // ボタンを押してもエディタのカーソル位置・選択を失わないように mousedown を止める
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        const pane = this.host.activePane();
        if (!pane.path) return toast("ノートを開いてください");
        if (pane.masked) pane.setMasked(false);
        run();
      });
      return b;
    };
    const sep = () => h("span", { class: "fmt-sep", "aria-hidden": "true" });
    this.el = h(
      "div",
      { class: "formatbar", role: "toolbar", "aria-label": "書式" },
      btn("H1", "見出し1", () => ed().setHeading(1), undefined, "txt"),
      btn("H2", "見出し2", () => ed().setHeading(2), undefined, "txt"),
      btn("H3", "見出し3", () => ed().setHeading(3), undefined, "txt"),
      sep(),
      btn("B", "太字（Ctrl+B）", () => ed().wrap("**", "**"), undefined, "txt bold"),
      btn("I", "斜体（Ctrl+I）", () => ed().wrap("*", "*"), undefined, "txt italic"),
      btn("S", "取り消し線", () => ed().wrap("~~", "~~"), undefined, "txt strike"),
      sep(),
      btn("", "キーワード（暗記で隠す）==…==（Ctrl+H）", () => ed().wrap("==", "=="), "marker", "accent"),
      btn("", "穴埋め {{…}}（暗記で隠す）", () => ed().wrap("{{", "}}"), "cloze", "accent"),
      sep(),
      btn("", "箇条書き", () => ed().toggleLinePrefix("- "), "list"),
      btn("", "番号付きリスト", () => ed().toggleLinePrefix("1. "), "numbered"),
      btn("", "チェックリスト", () => ed().toggleLinePrefix("- [ ] "), "checklist"),
      btn("", "引用", () => ed().toggleLinePrefix("> "), "quote"),
      sep(),
      btn("", "ノートへのリンク [[…]]（Ctrl+K）", () => ed().insertLink(), "link"),
      btn("", "画像を挿入", () => void this.pickImages(), "image"),
      btn("", "表（本文で / を打つと大きさを選べます）", () => ed().insertTable(3, 3), "table"),
      btn("", "コード（文中）", () => ed().wrap("`", "`"), "code"),
      btn("", "コードブロック", () => ed().insertBlock("```\n\n```", 4), "codeblock"),
      btn("", "区切り線", () => ed().insertBlock("---"), "hr"),
      sep(),
      btn("", "元に戻す（Ctrl+Z）", () => ed().undo(), "undo"),
      btn("", "やり直し（Ctrl+Y）", () => ed().redo(), "redo"),
    );
  }

  private async pickImages(): Promise<void> {
    const pane = this.host.activePane();
    const picked = await openDialog({
      multiple: true,
      title: "挿入する画像を選んでください",
      filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"] }],
    });
    const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    const names: string[] = [];
    for (const p of paths) {
      try {
        names.push(await api.attachmentImport(p));
      } catch (e) {
        toast(errorText(e), "error");
      }
    }
    await pane.insertImages(names);
  }
}
