import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const tauriRoot = resolve(process.cwd(), "src-tauri");

describe("browser webview security configuration", () => {
  it("grants local permissions only to the exact main webview", () => {
    const capability = JSON.parse(
      readFileSync(resolve(tauriRoot, "capabilities/default.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(capability.identifier).toBe("main-webview");
    expect(capability.local).toBe(true);
    expect(capability.webviews).toEqual(["main"]);
    expect(capability).not.toHaveProperty("windows");
    expect(JSON.stringify(capability)).not.toContain("browser-*");
    expect(capability).not.toHaveProperty("remote");
  });

  it("keeps production CSP strict and dev HMR allowances isolated", () => {
    const config = JSON.parse(
      readFileSync(resolve(tauriRoot, "tauri.conf.json"), "utf8"),
    ) as { app: { security: { csp: string; devCsp: string } } };
    const { csp, devCsp } = config.app.security;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* ws://127.0.0.1:*");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("127.0.0.1:5173");

    expect(devCsp).toContain("http://127.0.0.1:5173");
    expect(devCsp).toContain("ws://127.0.0.1:*");
    expect(devCsp).toContain("'unsafe-eval'");
  });

  it("builds release without devtools and enables it only in the explicit dev script", () => {
    const cargo = readFileSync(resolve(tauriRoot, "Cargo.toml"), "utf8");
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(cargo).toContain('browser-devtools = ["tauri/devtools"]');
    expect(cargo).toContain('tauri = { version = "2", features = ["tray-icon", "unstable"] }');
    expect(cargo).not.toContain('features = ["devtools", "tray-icon"]');
    expect(packageJson.scripts["tauri:dev"]).toBe("tauri dev --features browser-devtools");
  });

  it("keeps a second caller-label check in the BrowserHost boundary", () => {
    const source = readFileSync(resolve(tauriRoot, "src/browser/security.rs"), "utf8");
    expect(source).toContain('TRUSTED_MAIN_WEBVIEW_LABEL: &str = "main"');
    expect(source).toContain("ensure_main_webview_caller");
    expect(source).toContain("webview.label()");
    expect(source).toContain("UnauthorizedCaller");
  });

  it("guards every BrowserHost command before it reaches surface or profile state", () => {
    const source = readFileSync(resolve(tauriRoot, "src/browser/host.rs"), "utf8");
    const commandBlocks = source.split("#[tauri::command]").slice(1);
    const historyHelper = source.match(
      /fn dispatch_history_command[\s\S]*?(?=\n#\[tauri::command\])/u,
    )?.[0] ?? "";

    expect(commandBlocks.length).toBeGreaterThanOrEqual(20);
    expect(historyHelper).toContain("ensure_main_webview_caller(&caller)");
    for (const block of commandBlocks) {
      const commandName = block.match(/browser_[a-z_]+/u)?.[0];
      expect(commandName).toBeTruthy();
      expect(
        block.includes("dispatch_history_command") ? historyHelper : block,
        `${commandName ?? "unknown command"} must reject remote webview callers`,
      ).toContain("ensure_main_webview_caller(&caller)");
    }
  });
});
