import { defineConfig } from "vite";

// Tauri の開発サーバー設定（https://v2.tauri.app/start/frontend/vite/）
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
