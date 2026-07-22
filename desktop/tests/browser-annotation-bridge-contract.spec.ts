import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BrowserBridgeEnvelopeGate,
  HOST_TO_PAGE_BRIDGE_KINDS,
  PAGE_TO_HOST_BRIDGE_KINDS,
  WEB_ANNOTATION_BRIDGE_MAX_MESSAGE_BYTES,
  WEB_ANNOTATION_BRIDGE_PROTOCOL,
  parseBrowserBridgeEnvelope,
} from "../src/renderer/features/browser/runtime/bridgeProtocol";

interface BridgeFixture {
  readonly schemaVersion: number;
  readonly protocol: string;
  readonly hostToPageKinds: string[];
  readonly pageToHostKinds: string[];
  readonly hostToPage: Record<string, unknown>[];
  readonly pageToHost: Record<string, unknown>[];
}

const fixture = JSON.parse(readFileSync(resolve(
  process.cwd(), "..", "test-fixtures", "sidebar-browser", "contracts", "web-annotation-bridge-v1.json",
), "utf8")) as BridgeFixture;

describe("web annotation bridge v1", () => {
  it("keeps both allowlists and every shared envelope aligned", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.protocol).toBe(WEB_ANNOTATION_BRIDGE_PROTOCOL);
    expect(fixture.hostToPageKinds).toEqual(HOST_TO_PAGE_BRIDGE_KINDS);
    expect(fixture.pageToHostKinds).toEqual(PAGE_TO_HOST_BRIDGE_KINDS);
    for (const envelope of fixture.hostToPage) {
      expect(parseBrowserBridgeEnvelope(envelope, "host-to-page")).toMatchObject({ ok: true });
      expect(parseBrowserBridgeEnvelope(envelope, "page-to-host")).toEqual({ ok: false, error: "unsupported_kind" });
    }
    for (const envelope of fixture.pageToHost) {
      expect(parseBrowserBridgeEnvelope(JSON.stringify(envelope), "page-to-host")).toMatchObject({ ok: true });
      expect(parseBrowserBridgeEnvelope(envelope, "host-to-page")).toEqual({ ok: false, error: "unsupported_kind" });
    }
  });

  it("rejects unknown fields, arbitrary selectors, sensitive DOM data, and unsupported kinds", () => {
    const ready = structuredClone(fixture.pageToHost[0]);
    expect(parseBrowserBridgeEnvelope({ ...ready, protocol: "keydex.web-annotation.v2" }, "page-to-host"))
      .toEqual({ ok: false, error: "unsupported_protocol" });
    expect(parseBrowserBridgeEnvelope({ ...ready, selector: "button.submit" }, "page-to-host"))
      .toEqual({ ok: false, error: "invalid_fields" });
    expect(parseBrowserBridgeEnvelope({ ...ready, kind: "native.execute" }, "page-to-host"))
      .toEqual({ ok: false, error: "unsupported_kind" });

    const selection = structuredClone(fixture.pageToHost[2]);
    const payload = selection.payload as Record<string, unknown>;
    payload.target = { ...(payload.target as Record<string, unknown>), outerHTML: "<button>secret</button>" };
    expect(parseBrowserBridgeEnvelope(selection, "page-to-host"))
      .toEqual({ ok: false, error: "invalid_value" });

    const configured = structuredClone(fixture.hostToPage[2]);
    const configuredPayload = configured.payload as { tokens: Record<string, unknown> };
    configuredPayload.tokens.accent = "red; background: url(https://hostile.test/)";
    expect(parseBrowserBridgeEnvelope(configured, "host-to-page"))
      .toEqual({ ok: false, error: "invalid_value" });

    const candidate = structuredClone(fixture.pageToHost[1]);
    (candidate.payload as Record<string, unknown>).label = "x".repeat(1_025);
    expect(parseBrowserBridgeEnvelope(candidate, "page-to-host"))
      .toEqual({ ok: false, error: "invalid_value" });
  });

  it("rejects oversized messages before parsing", () => {
    expect(parseBrowserBridgeEnvelope("x".repeat(WEB_ANNOTATION_BRIDGE_MAX_MESSAGE_BYTES + 1), "page-to-host"))
      .toEqual({ ok: false, error: "oversize" });
  });

  it("drops stale surface, navigation, frame, and replayed sequence", () => {
    const gate = new BrowserBridgeEnvelopeGate({
      surface: { panelId: "panel-1", surfaceId: "surface-1", generation: 2 },
      navigationId: "navigation-2",
      frameKeys: new Set(["main", "frame:https://example.test"]),
    });
    const ready = structuredClone(fixture.pageToHost[0]);
    expect(gate.accept(ready, "page-to-host")).toMatchObject({ ok: true });
    expect(gate.accept(ready, "page-to-host")).toEqual({ ok: false, error: "out_of_order" });
    expect(gate.accept({ ...ready, sequence: 2, generation: 1 }, "page-to-host"))
      .toEqual({ ok: false, error: "stale_surface" });
    expect(gate.accept({ ...ready, sequence: 2, navigationId: "navigation-old" }, "page-to-host"))
      .toEqual({ ok: false, error: "stale_navigation" });
    expect(gate.accept({ ...ready, sequence: 2, frameKey: "forged-frame" }, "page-to-host"))
      .toEqual({ ok: false, error: "stale_frame" });
  });
});
