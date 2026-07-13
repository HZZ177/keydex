import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { conversationBaselineDiagnostics } from "@/renderer/pages/conversation/messages/conversationBaselineDiagnostics";
import { MessageText } from "@/renderer/pages/conversation/messages/MessageText";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("MessageText settled render isolation", () => {
  afterEach(() => {
    conversationBaselineDiagnostics.enable(false);
    conversationBaselineDiagnostics.reset();
  });

  it("does not rerender a stable settled message when its parent updates a tail sibling", () => {
    const stable = message("stable", "Settled answer");
    conversationBaselineDiagnostics.enable(true);
    const { rerender } = render(
      <div>
        <MessageText message={stable} />
        <span data-testid="tail">one</span>
      </div>,
    );
    const beforeParentUpdate = renderCount("stable");
    rerender(
      <div>
        <MessageText message={stable} />
        <span data-testid="tail">two</span>
      </div>,
    );

    expect(beforeParentUpdate).toBeGreaterThan(0);
    expect(renderCount("stable")).toBe(beforeParentUpdate);
  });

  it("rerenders when the message content itself changes", () => {
    const stable = message("stable", "Settled answer");
    conversationBaselineDiagnostics.enable(true);
    const { rerender } = render(<MessageText message={stable} />);
    const beforeCorrection = renderCount("stable");
    rerender(<MessageText message={{ ...stable, content: "Corrected answer" }} />);

    expect(renderCount("stable")).toBeGreaterThan(beforeCorrection);
  });
});

function renderCount(messageId: string): number {
  return conversationBaselineDiagnostics.snapshot().events.filter(
    (event) => event.stage === "message-text-render" && event.messageId === messageId,
  ).length;
}

function message(id: string, content: string): ConversationMessage {
  return {
    id,
    threadId: "session-1",
    turnId: "turn-1",
    itemId: id,
    kind: "assistant",
    status: "completed",
    content,
    payload: {},
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}
