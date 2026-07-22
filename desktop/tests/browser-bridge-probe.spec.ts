import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("fixed browser bridge probe", () => {
  it("injects one fixed all-frame protocol and attaches a native WebMessage broker", () => {
    const host = readFileSync(resolve(process.cwd(), "src-tauri/src/browser/host.rs"), "utf8");
    const bridge = readFileSync(resolve(process.cwd(), "src-tauri/src/browser/bridge.rs"), "utf8");
    const pageBridge = readFileSync(resolve(process.cwd(), "src-tauri/src/browser/page_bridge.js"), "utf8");
    const productBridge = bridge.split("#[cfg(test)]", 1)[0];
    expect(host).toContain("install_document_script");
    expect(host).toContain("attach_windows_web_message_broker");
    expect(bridge).toContain('WEB_ANNOTATION_BRIDGE_PROTOCOL: &str = "keydex.web-annotation.v1"');
    expect(bridge).toContain("add_WebMessageReceived");
    expect(bridge).toContain("WebMessageAsJson");
    expect(pageBridge).toContain("postNativeMessage(envelope)");
    expect(pageBridge).not.toContain("__TAURI_INTERNALS__");
    expect(pageBridge).not.toContain("transportToken");
    expect(pageBridge).toContain("bridgeBootstrapCompleteEventName");
    expect(bridge).toContain("keydex:web-annotation-bootstrap-complete");
    expect(pageBridge).not.toContain("postMessage(JSON.stringify(envelope))");
    expect(productBridge).not.toContain("querySelector");
    expect(productBridge).not.toContain("evaluateJavaScript");
  });

  it("does not expose Tauri commands or capabilities to remote composition pages", () => {
    const capability = readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf8");
    const browserPermission = readFileSync(
      resolve(process.cwd(), "src-tauri/permissions/application-commands.toml"),
      "utf8",
    );
    const applicationHost = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
    expect(capability).toContain('"webviews": ["main"]');
    expect(capability).not.toContain("browser-*");
    expect(capability).toContain('"allow-main-application-commands"');
    expect(browserPermission).not.toContain("allow-browser-page-bridge-message");
    expect(browserPermission).toContain('"resolve_dev_agent_connection"');
    const handlerBlock = applicationHost.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1];
    expect(handlerBlock).toBeTruthy();
    const registeredCommands = [...handlerBlock!.matchAll(/^\s*([a-z][a-z0-9_]*)[,]?$/gm)]
      .map((match) => match[1]);
    expect(registeredCommands).toContain("resolve_dev_agent_connection");
    expect(registeredCommands).not.toContain("browser_page_bridge_message");
    for (const command of registeredCommands) {
      expect(browserPermission, `missing ACL permission for ${command}`).toContain(`"${command}"`);
    }
    expect(applicationHost).toContain("browser_sync_geometry");
    expect(applicationHost).toContain("browser_begin_interactive_resize");
    expect(applicationHost).toContain("browser_end_interactive_resize");
    expect(applicationHost).toContain("reload_main_webview");
    expect(browserPermission).toContain('"reload_main_webview"');
    expect(applicationHost).not.toContain("browser_publish_geometry");
  });

  it("reclaims native browser surfaces without blocking the main page-load callback", () => {
    const applicationHost = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
    const browserHost = readFileSync(resolve(process.cwd(), "src-tauri/src/browser/host.rs"), "utf8");
    const contextMenu = readFileSync(
      resolve(process.cwd(), "src/renderer/providers/AppContextMenuProvider.tsx"),
      "utf8",
    );
    expect(applicationHost).toContain("reset_renderer_surfaces_in_background");
    expect(browserHost).toContain("spawn_blocking(move || state.reset_renderer_surfaces())");
    expect(browserHost).toContain("caller\n        .reload()");
    expect(contextMenu).toContain('invokeDesktopCommand("reload_main_webview", {})');
  });

  it("drives a windowed WebView2 viewport directly from its native WM_SIZE", () => {
    const windowHost = readFileSync(
      resolve(process.cwd(), "src-tauri/src/browser/window_host.rs"),
      "utf8",
    );
    const windowedSurface = readFileSync(
      resolve(process.cwd(), "src-tauri/src/browser/windowed_surface.rs"),
      "utf8",
    );
    const actor = readFileSync(resolve(process.cwd(), "src-tauri/src/browser/ui_actor.rs"), "utf8");
    expect(windowedSurface).toContain("CreateCoreWebView2Controller");
    expect(windowedSurface).not.toContain("CreateCoreWebView2CompositionController");
    expect(windowHost).toContain("WM_SIZE");
    expect(windowHost).toContain("controller.SetBounds(bounds)");
    expect(windowHost).toContain("SetWindowPos");
    expect(windowHost).not.toContain("SendMouseInput");
    expect(windowHost).not.toContain("WS_EX_NOREDIRECTIONBITMAP");
    expect(actor).toContain("WindowedBrowserSurface");
    expect(actor).not.toContain("CompositionHost");
  });
});
