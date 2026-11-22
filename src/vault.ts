// ノートフォルダの中身（一覧・本文・リンク索引）をメモリに持つ
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, type Entry } from "./api";
import { dirName, extractLinks, fileName, joinPath, noteName, renameLinks, resolveLink } from "./lib/links";

type Listener = () => void;

class Vault {
  root = "";
  entries: Entry[] = [];
  notes = new Map<string, string>(); // パス → 本文
  private listeners = new Set<Listener>();

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  async open(path: string): Promise<void> {
    this.root = await api.vaultOpen(path);
    await this.reload();
  }

  async reload(): Promise<void> {
    const [entries, files] = await Promise.all([api.vaultList(), api.vaultReadAll()]);
    this.entries = entries;
    this.notes = new Map(files.map((f) => [f.path, f.content]));
    this.written.clear();
    for (const f of files) this.remember(f.path, f.content); // 読み込んだ時点の内容も「既知」とする
    this.emit();
  }

  /** 外部変更の反映。変わったパスだけ読み直す */
  async refresh(changed: string[]): Promise<string[]> {
    this.entries = await api.vaultList();
    const exists = new Set(this.entries.map((e) => e.path));
    const updated: string[] = [];
    for (const p of changed) {
      if (!p.toLowerCase().endsWith(".md")) continue;
      if (!exists.has(p)) {
        if (this.notes.delete(p)) updated.push(p);
        continue;
      }
      try {
        const c = await api.noteRead(p);
        if (this.isOwnWrite(p, c)) continue; // 自分の保存、または既に知っている内容
        this.remember(p, c);
        if (this.notes.get(p) !== c) {
          this.notes.set(p, c);
          updated.push(p);
        }
      } catch {
        /* 消えた途中など */
      }
    }
    // フォルダごと消えた・移動したときのため、一覧にないノートを掃除
    for (const p of [...this.notes.keys()]) if (!exists.has(p)) this.notes.delete(p);
    for (const e of this.entries) {
      if (!e.is_dir && e.path.toLowerCase().endsWith(".md") && !this.notes.has(e.path)) {
        try {
          const c = await api.noteRead(e.path);
          this.notes.set(e.path, c);
          this.remember(e.path, c);
          updated.push(e.path);
        } catch {
          /* 無視 */
        }
      }
    }
    this.emit();
    return updated;
  }

  notePaths(): string[] {
    return [...this.notes.keys()].sort((a, b) => a.localeCompare(b, "ja"));
  }

  resolve(target: string, from: string | null): string | null {
    return resolveLink(target, from, this.notes.keys());
  }

  imageSrc(name: string): string | null {
    const lower = name.toLowerCase();
    const hit =
      this.entries.find((e) => !e.is_dir && e.path.toLowerCase() === `attachments/${lower}`) ??
      this.entries.find((e) => !e.is_dir && fileName(e.path).toLowerCase() === lower) ??
      this.entries.find((e) => !e.is_dir && e.path.toLowerCase() === lower);
    if (!hit) return null;
    const sep = this.root.includes("\\") ? "\\" : "/";
    return convertFileSrc(`${this.root}${sep}${hit.path.split("/").join(sep)}`);
  }

  backlinks(path: string): string[] {
    const out: string[] = [];
    for (const [p, c] of this.notes) {
      if (p === path) continue;
      if (extractLinks(c).some((t) => this.resolve(t, p) === path)) out.push(p);
    }
    return out.sort((a, b) => a.localeCompare(b, "ja"));
  }

  /**
   * アプリ自身が最近書いた内容（監視イベントで自分の保存を外部変更と取り違えないため）。
   * 短い間隔で何度か保存すると、古い保存の通知が後から届くので、最後の1件だけでなく数件覚えておく。
   */
  private written = new Map<string, string[]>();

  private remember(path: string, content: string): void {
    const list = this.written.get(path) ?? [];
    list.push(content);
    if (list.length > 10) list.shift();
    this.written.set(path, list);
  }

  isOwnWrite(path: string, content: string): boolean {
    return this.written.get(path)?.includes(content) ?? false;
  }

  async write(path: string, content: string): Promise<void> {
    this.remember(path, content);
    await api.noteWrite(path, content);
    this.notes.set(path, content);
  }

  /** 新しいノート。同名があれば「名前 2」…にする */
  async createNote(dir: string, name: string, body?: string): Promise<string> {
    const base = name.replace(/\.md$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim() || "無題のノート";
    let n = 1;
    let path = joinPath(dir, `${base}.md`);
    const taken = (p: string) => this.entries.some((e) => e.path.toLowerCase() === p.toLowerCase());
    while (taken(path)) path = joinPath(dir, `${base} ${++n}.md`);
    const content = body ?? `# ${noteName(path)}\n\n`;
    this.remember(path, content);
    await api.noteCreate(path, content);
    this.notes.set(path, content);
    this.entries = await api.vaultList();
    this.emit();
    return path;
  }

  async createFolder(dir: string, name: string): Promise<string> {
    const path = joinPath(dir, name.replace(/[\\/:*?"<>|]/g, "_").trim() || "新しいフォルダ");
    await api.folderCreate(path);
    this.entries = await api.vaultList();
    this.emit();
    return path;
  }

  /**
   * 名前の変更・移動。ノートの名前が変わったら、それを指すリンクを全ノートで書き換える。
   * 戻り値は 旧パス → 新パス の対応（フォルダの場合は中のノートすべて）。
   */
  async rename(from: string, to: string): Promise<Map<string, string>> {
    const isDir = this.entries.some((e) => e.path === from && e.is_dir);
    await api.entryRename(from, to);
    const moved = new Map<string, string>();
    if (isDir) {
      for (const p of [...this.notes.keys()]) if (p.startsWith(`${from}/`)) moved.set(p, to + p.slice(from.length));
    } else {
      moved.set(from, to);
    }
    for (const [a, b] of moved) {
      const c = this.notes.get(a);
      this.notes.delete(a);
      if (c !== undefined) this.notes.set(b, c);
    }
    if (!isDir && from.toLowerCase().endsWith(".md")) {
      const oldName = noteName(from);
      const newName = noteName(to);
      if (oldName !== newName) {
        for (const [p, c] of this.notes) {
          const next = renameLinks(c, oldName, newName);
          if (next !== c) await this.write(p, next);
        }
      }
    }
    this.entries = await api.vaultList();
    this.emit();
    return moved;
  }

  async remove(path: string): Promise<void> {
    await api.entryDelete(path);
    for (const p of [...this.notes.keys()]) if (p === path || p.startsWith(`${path}/`)) this.notes.delete(p);
    this.entries = await api.vaultList();
    this.emit();
  }

  isDir(path: string): boolean {
    return this.entries.some((e) => e.path === path && e.is_dir);
  }

  folderOf(path: string | null): string {
    if (!path) return "";
    return this.isDir(path) ? path : dirName(path);
  }
}

export const vault = new Vault();
