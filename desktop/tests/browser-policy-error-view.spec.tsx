import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BrowserEventEnvelope } from "../src/renderer/features/browser/domain";
import {
  BrowserPolicyCoordinator,
  normalizeExternalProtocolRequest,
} from "../src/renderer/features/browser/runtime/BrowserPolicyCoordinator";
import { BrowserErrorView } from "../src/renderer/features/browser/ui/BrowserErrorView";
import { BrowserExternalProtocolPrompt } from "../src/renderer/features/browser/ui/BrowserExternalProtocolPrompt";

function envelope<K extends BrowserEventEnvelope["kind"]>(
  kind: K,
  payload: Extract<BrowserEventEnvelope, { readonly kind: K }>["payload"],
): Extract<BrowserEventEnvelope, { readonly kind: K }> {
  return {
    schemaVersion: 2,
    kind,
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 1,
    sequence: 1,
    occurredAt: "2026-07-21T00:00:00.000Z",
    payload,
  } as Extract<BrowserEventEnvelope, { readonly kind: K }>;
}

describe("browser popup and external protocol policy", () => {
  it("opens target blank/window.open only for a trusted HTTP(S) user gesture", () => {
    let subscriber: ((event: BrowserEventEnvelope) => void) | undefined;
    const onOpenPanel = vi.fn();
    const onNavigationFailure = vi.fn();
    const coordinator = new BrowserPolicyCoordinator({
      client: { subscribe: (next) => { subscriber = next; return vi.fn(); } },
      onExternalProtocolRequest: vi.fn(),
      onNavigationFailure,
      onOpenPanel,
    });
    coordinator.start();

    subscriber?.(envelope("new_window.requested", {
      disposition: "tab", url: "https://example.com/popup", sourceUrl: "https://example.com/",
      userGesture: false, policyAllowed: false,
    }));
    subscriber?.(envelope("new_window.requested", {
      disposition: "tab", url: "javascript:alert(1)", sourceUrl: "https://example.com/",
      userGesture: true, policyAllowed: false,
    }));
    subscriber?.(envelope("new_window.requested", {
      disposition: "tab", url: "data:text/html,test", sourceUrl: "https://example.com/",
      userGesture: true, policyAllowed: false,
    }));
    subscriber?.(envelope("new_window.requested", {
      disposition: "tab", url: "file:///C:/secret.txt", sourceUrl: "https://example.com/",
      userGesture: true, policyAllowed: false,
    }));
    subscriber?.(envelope("new_window.requested", {
      disposition: "tab", url: "https://example.com/popup", sourceUrl: "https://example.com/",
      userGesture: true, policyAllowed: true,
    }));

    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    expect(onOpenPanel).toHaveBeenCalledWith("https://example.com/popup");
    expect(onNavigationFailure).toHaveBeenCalledTimes(4);
    expect(onNavigationFailure).toHaveBeenCalledWith({
      category: "policy_denied",
      url: "file:///C:/secret.txt",
    });
  });

  it("opens a local-file popup only from a local-file source after both policy layers allow it", () => {
    let subscriber: ((event: BrowserEventEnvelope) => void) | undefined;
    const onOpenPanel = vi.fn();
    const onNavigationFailure = vi.fn();
    const coordinator = new BrowserPolicyCoordinator({
      client: { subscribe: (next) => { subscriber = next; return vi.fn(); } },
      onExternalProtocolRequest: vi.fn(),
      onNavigationFailure,
      onOpenPanel,
    });
    coordinator.start();

    subscriber?.(envelope("new_window.requested", {
      disposition: "tab",
      url: "file:///D:/workspace/popup.html",
      sourceUrl: "file:///D:/workspace/index.html",
      userGesture: true,
      policyAllowed: true,
    }));
    subscriber?.(envelope("new_window.requested", {
      disposition: "tab",
      url: "file:///D:/workspace/private.html",
      sourceUrl: "https://example.test/article",
      userGesture: true,
      policyAllowed: true,
    }));

    expect(onOpenPanel).toHaveBeenCalledOnce();
    expect(onOpenPanel).toHaveBeenCalledWith("file:///D:/workspace/popup.html");
    expect(onNavigationFailure).toHaveBeenCalledWith({
      category: "policy_denied",
      url: "file:///D:/workspace/private.html",
    });
  });

  it("isolates policy events to the current panel, surface, and generation", () => {
    let subscriber: ((event: BrowserEventEnvelope) => void) | undefined;
    const onOpenPanel = vi.fn();
    const coordinator = new BrowserPolicyCoordinator({
      client: { subscribe: (next) => { subscriber = next; return vi.fn(); } },
      surface: { panelId: "panel-1", surfaceId: "surface-1", generation: 2 },
      onExternalProtocolRequest: vi.fn(),
      onNavigationFailure: vi.fn(),
      onOpenPanel,
    });
    coordinator.start();
    subscriber?.(envelope("new_window.requested", {
      disposition: "tab", url: "https://example.com/stale", sourceUrl: "https://example.com/",
      userGesture: true, policyAllowed: true,
    }));
    subscriber?.({
      ...envelope("new_window.requested", {
        disposition: "tab", url: "https://example.com/current", sourceUrl: "https://example.com/",
        userGesture: true, policyAllowed: true,
      }),
      generation: 2,
    });
    expect(onOpenPanel).toHaveBeenCalledOnce();
    expect(onOpenPanel).toHaveBeenCalledWith("https://example.com/current");
  });

  it("accepts only internally consistent mailto and tel requests", () => {
    expect(normalizeExternalProtocolRequest({ scheme: "mailto", target: "mailto:test@example.com" }))
      .toEqual({ scheme: "mailto", target: "mailto:test@example.com" });
    expect(normalizeExternalProtocolRequest({ scheme: "tel", target: "tel:+8613800138000" }))
      .toEqual({ scheme: "tel", target: "tel:+8613800138000" });
    expect(normalizeExternalProtocolRequest({ scheme: "mailto", target: "javascript:alert(1)" }))
      .toBeNull();
    expect(normalizeExternalProtocolRequest({ scheme: "custom", target: "custom:value" }))
      .toBeNull();
  });

  it("forwards main-frame DNS and TLS failures to the recoverable error state", () => {
    let subscriber: ((event: BrowserEventEnvelope) => void) | undefined;
    const onNavigationFailure = vi.fn();
    const coordinator = new BrowserPolicyCoordinator({
      client: { subscribe: (next) => { subscriber = next; return vi.fn(); } },
      onExternalProtocolRequest: vi.fn(),
      onNavigationFailure,
      onOpenPanel: vi.fn(),
    });
    coordinator.start();
    subscriber?.(envelope("navigation.failed", {
      errorCategory: "dns", isMainFrame: true, url: "https://missing.invalid/",
    }));
    subscriber?.(envelope("navigation.failed", {
      errorCategory: "tls_certificate", isMainFrame: true, url: "https://expired.example/",
    }));
    subscriber?.(envelope("navigation.failed", {
      errorCategory: "network", isMainFrame: false, url: "https://example.com/image.png",
    }));
    expect(onNavigationFailure).toHaveBeenCalledTimes(2);
  });
});

describe("BrowserErrorView", () => {
  it("explains the desktop host requirement instead of presenting a white Web viewport", () => {
    render(
      <BrowserErrorView
        category="desktop_runtime_required"
        url="https://www.bing.com/"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("需要 Keydex 桌面运行时")).not.toBeNull();
    expect(screen.getByText("pnpm run tauri:dev:isolated")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("preserves the failed URL, retries, and exposes no TLS bypass action", () => {
    const onRetry = vi.fn();
    render(
      <div data-theme="dark">
        <BrowserErrorView
          category="tls_certificate"
          url="https://expired.example/private?key=value"
          onRetry={onRetry}
        />
      </div>,
    );
    expect(screen.getByRole("alert").hasAttribute("style")).toBe(false);
    expect(screen.getByText("https://expired.example/private?key=value")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /继续|绕过/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders a recoverable DNS error using inherited theme state", () => {
    render(<BrowserErrorView category="dns" url="https://missing.invalid/" onRetry={vi.fn()} />);
    expect(screen.getByText("找不到此网站")).not.toBeNull();
    expect(screen.getByRole("alert").getAttribute("data-browser-error")).toBe("dns");
  });
});

describe("BrowserExternalProtocolPrompt", () => {
  it("reuses ConfirmDialog and requires explicit confirmation", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <BrowserExternalProtocolPrompt
        request={{ scheme: "mailto", target: "mailto:test@example.com" }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByText("mailto:test@example.com")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开邮件应用" }));
    expect(onConfirm).toHaveBeenCalledWith("mailto:test@example.com");
    expect(onCancel).not.toHaveBeenCalled();
  });
});
