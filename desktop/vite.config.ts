import react from "@vitejs/plugin-react";
import UnoCSS from "unocss/vite";
import { fileURLToPath, URL } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const CODEMIRROR_DEDUPE = [
  "@codemirror/lang-css",
  "@codemirror/lang-html",
  "@codemirror/lang-javascript",
  "@codemirror/lang-json",
  "@codemirror/lang-markdown",
  "@codemirror/lang-python",
  "@codemirror/lang-sql",
  "@codemirror/lang-xml",
  "@codemirror/lang-yaml",
  "@codemirror/language",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
];

const e2eCacheDir = process.env.KEYDEX_E2E_VITE_CACHE_DIR?.trim();

export default defineConfig({
  cacheDir: e2eCacheDir || undefined,
  plugins: [react(), UnoCSS()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    dedupe: ["react", "react-dom", ...CODEMIRROR_DEDUPE],
  },
  optimizeDeps: {
    entries: ["index.html"],
    include: ["@radix-ui/react-slider"],
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**"],
    globals: true,
    include: ["tests/**/*.{spec,test}.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
  },
});
