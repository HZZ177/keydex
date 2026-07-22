import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("fixed browser bridge probe", () => {
  it("injects one fixed all-frame protocol and attaches a native WebMessage broker", () => {
    const host = readFileSync(resolve(process.cwd(), "src-tauri/src/browser/host.rs"), "utf8");
    const bridge = readFileSync(resolve(process.cwd(), "src-tauri/src/browser/bridge.rs"), "utf8");
    const pageBridge = readFileSync(resolve(process.cwd(), "src-tauri/src/browser/page_bridge.js"), "utf8");
    const productBridge = bridge.split("#[cfg(test)]", 1)[0];
    expect(host).toContain("initialization_script_for_all_frames");
    expect(host).toContain("attach_windows_web_message_broker");
    expect(bridge).toContain('WEB_ANNOTATION_BRIDGE_PROTOCOL: &str = "keydex.web-annotation.v1"');
    expect(bridge).toContain("add_WebMessageReceived");
    expect(bridge).toContain("WebMessageAsJson");
    expect(pageBridge).toContain("postNativeMessage(envelope)");
    expect(pageBridge).toContain('invokeNative("browser_page_bridge_message"');
    expect(pageBridge).toContain("transportToken: bootstrap.transportToken");
    expect(pageBridge).toContain("bridgeBootstrapCompleteEventName");
    expect(bridge).toContain("keydex:web-annotation-bootstrap-complete");
    expect(pageBridge).not.toContain("postMessage(JSON.stringify(envelope))");
    expect(productBridge).not.toContain("querySelector");
    expect(productBridge).not.toContain("evaluateJavaScript");
  });

  it("grants hostile pages only the authenticated page bridge command and uses no host object", () => {
    const capability = readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf8");
    const browserCapability = readFileSync(
      resolve(process.cwd(), "src-tauri/capabilities/browser-page-bridge.json"),
      "utf8",
    );
    const browserPermission = readFileSync(
      resolve(process.cwd(), "src-tauri/permissions/application-commands.toml"),
      "utf8",
    );
    const applicationHost = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
    const hostile = readFileSync(
      resolve(process.cwd(), "../.dev/test/keydex-sidebar-browser/probe/hostile.html"),
      "utf8",
    );
    expect(capability).toContain('"webviews": ["main"]');
    expect(capability).not.toContain("browser-*");
    expect(capability).toContain('"allow-main-application-commands"');
    expect(browserCapability).toContain('"webviews": ["browser-*"]');
    expect(browserCapability).toContain('"permissions": ["allow-browser-page-bridge-message"]');
    expect(browserPermission).toContain('commands.allow = ["browser_page_bridge_message"]');
    expect(browserPermission).toContain('"resolve_dev_agent_connection"');
    const handlerBlock = applicationHost.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1];
    expect(handlerBlock).toBeTruthy();
    const registeredCommands = [...handlerBlock!.matchAll(/^\s*([a-z][a-z0-9_]*)[,]?$/gm)]
      .map((match) => match[1]);
    expect(registeredCommands).toContain("resolve_dev_agent_connection");
    expect(registeredCommands).toContain("browser_page_bridge_message");
    for (const command of registeredCommands) {
      expect(browserPermission, `missing ACL permission for ${command}`).toContain(`"${command}"`);
    }
    const mainPermissionBlock = browserPermission.split("[[permission]]")[1] ?? "";
    expect(mainPermissionBlock).not.toContain('"browser_page_bridge_message"');
    expect(hostile).toContain("__TAURI_INTERNALS__");
    expect(hostile).toContain('kind: "native.execute"');
    expect(hostile).not.toContain("setInterval");
    expect(hostile).not.toContain("hostObjects");
  });
});
