// Rust 側のコマンド呼び出し
import { invoke } from "@tauri-apps/api/core";
import type { Issue } from "./lib/issues";

export interface Entry {
  path: string;
  name: string;
  is_dir: boolean;
}

export const api = {
  vaultOpen: (path: string) => invoke<string>("vault_open", { path }),
  vaultList: () => invoke<Entry[]>("vault_list"),
  vaultReadAll: () => invoke<{ path: string; content: string }[]>("vault_read_all"),
  noteRead: (path: string) => invoke<string>("note_read", { path }),
  noteWrite: (path: string, content: string) => invoke<void>("note_write", { path, content }),
  noteCreate: (path: string, content: string) => invoke<void>("note_create", { path, content }),
  folderCreate: (path: string) => invoke<void>("folder_create", { path }),
  entryRename: (from: string, to: string) => invoke<void>("entry_rename", { from, to }),
  entryDelete: (path: string) => invoke<void>("entry_delete", { path }),
  absPath: (path: string) => invoke<string>("abs_path", { path }),
  listDirs: (path: string) => invoke<{ path: string; parent: string | null; dirs: string[]; notes: number }>("list_dirs", { path }),
  platform: () => invoke<string>("platform"),
  openInDefaultApp: (path: string) => invoke<void>("open_in_default_app", { path }),
  workspaceLoad: () => invoke<string | null>("workspace_load"),
  workspaceSave: (json: string) => invoke<void>("workspace_save", { json }),
  settingsLoad: () => invoke<string | null>("settings_load"),
  settingsSave: (json: string) => invoke<void>("settings_save", { json }),
  attachmentImport: (path: string) => invoke<string>("attachment_import", { path }),
  attachmentSave: (name: string, dataBase64: string) => invoke<string>("attachment_save", { name, dataBase64 }),
  secretSet: (provider: string, key: string) => invoke<void>("secret_set", { provider, key }),
  secretHas: (provider: string) => invoke<boolean>("secret_has", { provider }),
  secretDelete: (provider: string) => invoke<void>("secret_delete", { provider }),
  aiCheck: (req: { provider: string; model: string; base_url: string | null; text: string; mode: "typo" | "facts" }) =>
    invoke<Issue[]>("ai_check", { req }),
  aiChat: (req: {
    provider: string;
    model: string;
    base_url: string | null;
    messages: { role: "user" | "assistant"; content: string }[];
    note_name: string | null;
    note_text: string | null;
  }) => invoke<string>("ai_chat", { req }),
  aiListModels: (providerId: string, baseUrl: string | null) => invoke<string[]>("ai_list_models", { providerId, baseUrl }),
};

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

export async function fileToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  return btoa(bin);
}
