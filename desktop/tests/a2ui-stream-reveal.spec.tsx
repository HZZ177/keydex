import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  type A2UIRevealUnit,
  type ParsedA2UIMessage,
  buildA2UIRevealResetKey,
  useA2UIStreamReveal,
} from "@/renderer/pages/conversation/messages/a2ui";

describe("useA2UIStreamReveal", () => {
  it("uses a low-frequency backlog-driven cadence to drain A2UI semantic units", () => {
    vi.useFakeTimers();
    try {
      render(<RevealProbe unitCount={80} chunkCount={120} />);

      const probe = screen.getByTestId("a2ui-reveal-probe");
      expect(probe.getAttribute("data-enabled")).toBe("true");
      expect(Number(probe.getAttribute("data-visible"))).toBe(1);

      act(() => {
        vi.advanceTimersByTime(120);
      });

      expect(Number(probe.getAttribute("data-speed"))).toBeGreaterThanOrEqual(8);
      expect(Number(probe.getAttribute("data-visible"))).toBe(2);
      expect(Number(probe.getAttribute("data-visible"))).toBeLessThan(80);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("shows all units immediately when there is no A2UI stream backlog", () => {
    render(<RevealProbe unitCount={8} chunkCount={0} />);

    const probe = screen.getByTestId("a2ui-reveal-probe");
    expect(probe.getAttribute("data-enabled")).toBe("false");
    expect(Number(probe.getAttribute("data-visible"))).toBe(8);
    expect(Number(probe.getAttribute("data-backlog"))).toBe(0);
  });

  it("keeps visible units mounted and marks changed signatures as update snapshots", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <RevealProbe
          chunkCount={4}
          unitCount={3}
          unitSignatures={["old", "second", "third"]}
        />,
      );

      const probe = screen.getByTestId("a2ui-reveal-probe");
      expect(probe.getAttribute("data-visible-unit-0")).toBe("true");

      rerender(
        <RevealProbe
          chunkCount={5}
          unitCount={4}
          unitSignatures={["new", "second", "third", "fourth"]}
        />,
      );

      expect(probe.getAttribute("data-visible-unit-0")).toBe("true");
      expect(probe.getAttribute("data-phase-unit-0")).toBe("update");

      act(() => {
        vi.advanceTimersByTime(560);
      });

      expect(probe.getAttribute("data-phase-unit-0")).toBe("stable");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps the reveal reset key stable when final a2ui fields arrive", () => {
    const streaming = parsedMessage(4);
    const created: ParsedA2UIMessage = {
      ...streaming,
      a2ui: {
        render_key: "chart",
        mode: "render",
        stream_id: "probe-stream",
        tool_call_id: "probe-tool",
        trace_id: "probe-trace",
        turn_index: 1,
        payload: {},
        input_schema: {},
        submit_schema: {},
      },
      debug: streaming.debug ? { ...streaming.debug, status: "created" } : null,
      status: "created",
    };

    expect(buildA2UIRevealResetKey(created)).toBe(buildA2UIRevealResetKey(streaming));
  });
});

function RevealProbe({
  unitCount,
  chunkCount,
  unitSignatures,
}: {
  unitCount: number;
  chunkCount: number;
  unitSignatures?: unknown[];
}) {
  const parsed = parsedMessage(chunkCount);
  const units: A2UIRevealUnit[] = Array.from({ length: unitCount }, (_, index) => ({
    key: `unit:${index}`,
    kind: "probe",
    signature: unitSignatures?.[index],
  }));
  const reveal = useA2UIStreamReveal({ parsed, units });
  return (
    <div
      data-testid="a2ui-reveal-probe"
      data-enabled={reveal.enabled ? "true" : "false"}
      data-visible={reveal.visibleUnits}
      data-backlog={reveal.backlogUnits}
      data-speed={reveal.speedUnitsPerSecond}
      data-visible-unit-0={reveal.isVisible("unit:0") ? "true" : "false"}
      data-phase-unit-0={reveal.unitState("unit:0")?.phase}
    />
  );
}

function parsedMessage(chunkCount: number): ParsedA2UIMessage {
  const argsBuffer = chunkCount > 0 ? "{\"title\":\"流式\"}" : "";
  return {
    a2ui: null,
    debug: {
      id: "probe-stream",
      status: chunkCount > 0 ? "streaming" : "created",
      renderKey: "chart",
      mode: "render",
      streamId: "probe-stream",
      toolCallId: "probe-tool",
      traceId: "probe-trace",
      turnIndex: 1,
      chunkCount,
      argsBuffer,
      argsTextLength: argsBuffer.length,
      jsonParseStatus: chunkCount > 0 ? "partial" : "empty",
      rawEvents: [],
      updatedAt: 1_700_000_000_000,
    },
    payload: {},
    interaction: null,
    renderKey: "chart",
    mode: "render",
    status: chunkCount > 0 ? "streaming" : "created",
    interactionId: "",
    streamText: argsBuffer,
    parseError: "",
  };
}
