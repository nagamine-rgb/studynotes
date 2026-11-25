// アプリの設定（%APPDATA% の settings.json）と画面の状態（ノートフォルダ内の workspace.json）
import { api } from "./api";
import type { MaskTargets } from "./lib/text";

export type ProviderId = "openai" | "deepseek" | "gemini" | "anthropic" | "custom";

export const PROVIDERS: { id: ProviderId; label: string; defaultModel: string; keyUrl?: string }[] = [
  { id: "openai", label: "OpenAI", defaultModel: "gpt-5.6-luna", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "deepseek", label: "DeepSeek", defaultModel: "deepseek-flash", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "gemini", label: "Google Gemini", defaultModel: "gemini-3.5-flash-lite", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "anthropic", label: "Anthropic Claude", defaultModel: "claude-haiku-5-5", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "custom", label: "OpenAI互換（カスタム）", defaultModel: "" },
];

export interface Settings {
  vaultPath: string | null;
  theme: "system" | "light" | "dark";
  fontSize: number;
  mask: MaskTargets;
  ai: {
    provider: ProviderId;
    models: Partial<Record<ProviderId, string>>;
    baseUrls: Partial<Record<ProviderId, string>>;
    modelLists: Partial<Record<ProviderId, { ids: string[]; fetchedAt: string }>>;
    consent: boolean;
    collapseExplorer: boolean;
  };
}

export const defaultSettings = (): Settings => ({
  vaultPath: null,
  theme: "system",
  fontSize: 15,
  mask: { highlight: true, cloze: true, bold: false },
  ai: { provider: "openai", models: {}, baseUrls: {}, modelLists: {}, consent: false, collapseExplorer: true },
});

export type PaneId = "L" | "R";

export interface PaneState {
  path: string | null;
  masked: boolean;
}

export interface Workspace {
  split: boolean;
  ratio: number; // 左ペインの割合
  active: PaneId;
  explorerVisible: boolean;
  explorerWidth: number;
  panes: Record<PaneId, PaneState>;
  openFolders: string[];
  pins: string[];
  recent: string[];
}

export const defaultWorkspace = (): Workspace => ({
  split: true,
  ratio: 0.5,
  active: "L",
  explorerVisible: true,
  explorerWidth: 260,
  panes: { L: { path: null, masked: false }, R: { path: null, masked: false } },
  openFolders: [],
  pins: [],
  recent: [],
});

function merge<T>(base: T, loaded: unknown): T {
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(loaded as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

export let settings: Settings = defaultSettings();
export let workspace: Workspace = defaultWorkspace();

export async function loadSettings(): Promise<void> {
  try {
    const s = await api.settingsLoad();
    settings = merge(defaultSettings(), s ? JSON.parse(s) : null);
  } catch {
    settings = defaultSettings();
  }
}

let settingsTimer: number | undefined;
export function saveSettings(): void {
  clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(() => void api.settingsSave(JSON.stringify(settings, null, 2)).catch(() => {}), 200);
}

export async function loadWorkspace(): Promise<void> {
  try {
    const s = await api.workspaceLoad();
    workspace = merge(defaultWorkspace(), s ? JSON.parse(s) : null);
  } catch {
    workspace = defaultWorkspace();
  }
}

let wsTimer: number | undefined;
export function saveWorkspace(): void {
  clearTimeout(wsTimer);
  wsTimer = window.setTimeout(() => void api.workspaceSave(JSON.stringify(workspace, null, 2)).catch(() => {}), 400);
}

export function currentModel(): string {
  const p = settings.ai.provider;
  return settings.ai.models[p] ?? PROVIDERS.find((x) => x.id === p)?.defaultModel ?? "";
}

export function applyTheme(): void {
  const dark =
    settings.theme === "dark" || (settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.setProperty("--note-font-size", `${settings.fontSize}px`);
}
