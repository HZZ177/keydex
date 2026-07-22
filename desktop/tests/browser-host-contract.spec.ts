import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_HOST_MAX_ENVELOPE_BYTES,
  BROWSER_HOST_SCHEMA_VERSION,
  eventBelongsToCursor,
  parseBrowserCommandEnvelope,
  parseBrowserCommandResponse,
  parseBrowserEventEnvelope,
  type BrowserCommandEnvelope,
  type BrowserCommandResponse,
  type BrowserEventEnvelope,
} from "../src/renderer/features/browser/domain";

interface BrowserHostFixture {
  readonly schemaVersion: number;
  readonly commands: readonly unknown[];
  readonly responses: readonly unknown[];
  readonly events: readonly unknown[];
}

const fixturePath = resolve(
  process.cwd(),
  "..",
  "test-fixtures",
  "sidebar-browser",
  "contracts",
  "browser-host-v1.json",
);

function fixture(): BrowserHostFixture {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as BrowserHostFixture;
}

describe("BrowserHost wire contract", () => {
  it("roundtrips the shared surface, navigation, permission, download, selection, and capture fixtures", () => {
    const contract = fixture();
    expect(contract.schemaVersion).toBe(BROWSER_HOST_SCHEMA_VERSION);

    const commands = contract.commands.map(parseBrowserCommandEnvelope);
    expect(commands.map((item) => item.command)).toEqual([
      "browser_create_surface",
      "browser_navigate",
      "browser_respond_permission",
      "browser_respond_download",
      "browser_start_selection",
      "browser_configure_overlay",
      "browser_resolve_annotations",
      "browser_render_highlights",
      "browser_clear_highlights",
      "browser_navigate_to_annotation_target",
      "browser_capture_region",
      "browser_discard_capture",
    ]);
    expect(JSON.parse(JSON.stringify(commands))).toEqual(contract.commands);

    const responses = contract.responses.map(parseBrowserCommandResponse);
    expect(JSON.parse(JSON.stringify(responses))).toEqual(contract.responses);

    const events = contract.events.map(parseBrowserEventEnvelope);
    expect(events.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(JSON.parse(JSON.stringify(events))).toEqual(contract.events);
  });

  it("rejects unknown command/event kinds, unknown versions, and extra fields", () => {
    const contract = fixture();
    const command = contract.commands[0] as BrowserCommandEnvelope;
    const event = contract.events[0] as BrowserEventEnvelope;

    expect(() => parseBrowserCommandEnvelope({ ...command, schemaVersion: 2 })).toThrow(
      "schema version is unsupported",
    );
    expect(() => parseBrowserCommandEnvelope({ ...command, command: "browser_evaluate_javascript" })).toThrow(
      "command kind is unsupported",
    );
    expect(() => parseBrowserCommandEnvelope({ ...command, agentAction: "click" })).toThrow(
      "fields are invalid",
    );
    expect(() => parseBrowserEventEnvelope({ ...event, schemaVersion: 2 })).toThrow(
      "schema version is unsupported",
    );
    expect(() => parseBrowserEventEnvelope({ ...event, kind: "agent.action" })).toThrow(
      "event kind is unsupported",
    );
    expect(() => parseBrowserEventEnvelope({
      ...event,
      payload: { ...(event.payload as object), selector: "button.submit" },
    })).toThrow("fields are invalid");
  });

  it("filters stale surfaces and out-of-order events using the full identity tuple", () => {
    const event = parseBrowserEventEnvelope(fixture().events[1]);
    const cursor = {
      panelId: event.panelId,
      surfaceId: event.surfaceId,
      generation: event.generation,
      lastSequence: event.sequence - 1,
    };

    expect(eventBelongsToCursor(event, cursor)).toBe(true);
    expect(eventBelongsToCursor(event, { ...cursor, generation: cursor.generation + 1 })).toBe(false);
    expect(eventBelongsToCursor(event, { ...cursor, surfaceId: "old-surface" })).toBe(false);
    expect(eventBelongsToCursor(event, { ...cursor, lastSequence: event.sequence })).toBe(false);
  });

  it("validates Chromium-native structured element selection events", () => {
    const event: BrowserEventEnvelope<"selection.result"> = {
      schemaVersion: 1,
      kind: "selection.result",
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 2,
      sequence: 8,
      navigationId: "navigation-1",
      occurredAt: "2026-07-22T00:00:01.000Z",
      payload: {
        selectionRequestId: "selection-1",
        frameKey: "devtools:iframe-session-1",
        binding: { documentId: "document-1", nodeHandleId: "node-1" },
        target: {
          type: "element",
          tag: "canvas",
          stableAttributes: [{ name: "id", value: "chart" }],
          path: [
            { childIndex: 0, shadowRoot: false },
            { childIndex: 1, shadowRoot: false },
          ],
          context: { headingPath: ["Dashboard"] },
          rect: { x: 20, y: 40, width: 600, height: 320 },
          frame: { url: "https://example.test/dashboard", indexPath: [0] },
        },
      },
    };

    expect(parseBrowserEventEnvelope(event)).toEqual(event);
    expect(() => parseBrowserEventEnvelope({
      ...event,
      payload: { ...event.payload, target: { ...event.payload.target, tag: "CANVAS" } },
    })).toThrow("payload.target.tag must be lowercase");
  });

  it("keeps the success/error response shape stable and rejects invalid combinations", () => {
    const success: BrowserCommandResponse = { ok: true, requestId: "request-1" };
    expect(parseBrowserCommandResponse(success)).toEqual(success);
    expect(() => parseBrowserCommandResponse({ ...success, error: { code: "host_failure" } })).toThrow(
      "fields are invalid",
    );
    expect(() => parseBrowserCommandResponse({ ok: false, requestId: "request-1" })).toThrow(
      "fields are invalid",
    );
  });

  it("rejects envelopes above the shared byte limit", () => {
    const event = fixture().events[0] as BrowserEventEnvelope<"surface.ready">;
    expect(() => parseBrowserEventEnvelope({
      ...event,
      payload: {
        ...event.payload,
        capabilities: ["x".repeat(BROWSER_HOST_MAX_ENVELOPE_BYTES)],
      },
    })).toThrow("exceeds the maximum size");
  });

  it("contains no generic page automation or arbitrary script escape hatch", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/features/browser/domain/browserHostContract.ts"),
      "utf8",
    );
    for (const forbidden of [
      "evaluateJavaScript",
      "querySelector",
      "browser_click",
      "browser_fill",
      "browser_scroll",
      "browser_submit",
      "cdpSession",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("accepts only verified highlight states and strict structured targets", () => {
    const render = fixture().commands.find((command) => (
      (command as BrowserCommandEnvelope).command === "browser_render_highlights"
    )) as BrowserCommandEnvelope<"browser_render_highlights">;
    const resolution = render.payload.resolutions[0] as {
      readonly annotationId: string;
      readonly state: string;
      readonly target: Record<string, unknown>;
    };

    expect(() => parseBrowserCommandEnvelope({
      ...render,
      payload: {
        ...render.payload,
        resolutions: [{ ...resolution, state: "ambiguous" }],
      },
    })).toThrow("payload.resolutions[0].state is invalid");
  });
});
