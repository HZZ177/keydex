import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationRenderUnit } from "@/renderer/pages/conversation/timeline/ConversationRenderUnit";
import {
  ConversationTimelineSurface,
  type ConversationTimelineSurfaceHandle,
} from "@/renderer/pages/conversation/timeline/ConversationTimelineSurface";

describe("ConversationTimelineSurface", () => {
  it("notifies readiness consumers after a rendered unit clears measurement pending", async () => {
    const runtimeRef: { current: ConversationTimelineSurfaceHandle | null } = { current: null };
    const committedVersions: string[] = [];
    const onUnitCommitted = vi.fn((unit: ConversationRenderUnit) => {
      const element = runtimeRef.current?.getUnitElement(unit.id);
      expect(element?.hasAttribute("data-conversation-unit-measurement-pending")).toBe(false);
      committedVersions.push(unit.renderVersion);
    });
    const first = unit("initial");
    const { rerender, unmount } = render(
      <ConversationTimelineSurface
        units={[first]}
        residentUnitIds={[first.id]}
        runtimeRef={runtimeRef}
        renderUnit={(entry) => <span>{entry.renderVersion}</span>}
        onUnitCommitted={onUnitCommitted}
      />,
    );

    await waitFor(() => expect(committedVersions).toContain("initial"));

    const updated = unit("streaming-update");
    rerender(
      <ConversationTimelineSurface
        units={[updated]}
        residentUnitIds={[updated.id]}
        runtimeRef={runtimeRef}
        renderUnit={(entry) => <span>{entry.renderVersion}</span>}
        onUnitCommitted={onUnitCommitted}
      />,
    );

    await waitFor(() => expect(committedVersions).toContain("streaming-update"));
    expect(onUnitCommitted).toHaveBeenCalledTimes(2);
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
  });
});

function unit(renderVersion: string): ConversationRenderUnit {
  return {
    id: "unit-assistant",
    kind: "assistant-markdown",
    owner: "markdown-runtime",
    turnId: "turn-1",
    turnIndex: 0,
    businessTurnIndex: 0,
    sourceMessageIds: ["assistant-1"],
    item: null,
    parentUnitId: null,
    dynamic: true,
    interactive: false,
    pinPolicy: "never",
    measurementPolicy: "observe-until-settled",
    estimatedHeight: 100,
    renderVersion,
  };
}
