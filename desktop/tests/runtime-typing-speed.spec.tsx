import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  reportRuntimeTypingSpeed,
  useRuntimeTypingMetrics,
} from "@/renderer/hooks/useRuntimeTypingSpeed";
import { useTypingAnimation } from "@/renderer/pages/conversation/messages/useTypingAnimation";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime typing metrics session isolation", () => {
  it("only aggregates typing sources from the subscribed session", () => {
    render(
      <>
        <RuntimeTypingMetricsProbe sessionId="session-a" testId="metrics-a" />
        <RuntimeTypingMetricsProbe sessionId="session-b" testId="metrics-b" />
      </>,
    );

    act(() => {
      reportRuntimeTypingSpeed("session-a", "source-a", 120, 18);
    });
    expect(screen.getByTestId("metrics-a").textContent).toBe("120/18");
    expect(screen.getByTestId("metrics-b").textContent).toBe("0/0");

    act(() => {
      reportRuntimeTypingSpeed("session-b", "source-b", 80, 7);
    });
    expect(screen.getByTestId("metrics-a").textContent).toBe("120/18");
    expect(screen.getByTestId("metrics-b").textContent).toBe("80/7");
  });

  it("drops the previous session metrics when the subscriber changes scope", () => {
    const view = render(<RuntimeTypingMetricsProbe sessionId="session-a" testId="metrics" />);

    act(() => {
      reportRuntimeTypingSpeed("session-a", "source-a", 96, 12);
    });
    expect(screen.getByTestId("metrics").textContent).toBe("96/12");

    view.rerender(<RuntimeTypingMetricsProbe sessionId="session-b" testId="metrics" />);
    expect(screen.getByTestId("metrics").textContent).toBe("0/0");

    act(() => {
      reportRuntimeTypingSpeed("session-a", "source-a", 144, 22);
    });
    expect(screen.getByTestId("metrics").textContent).toBe("0/0");

    act(() => {
      reportRuntimeTypingSpeed("session-b", "source-b", 72, 5);
    });
    expect(screen.getByTestId("metrics").textContent).toBe("72/5");
  });

  it("does not reuse the displayed-content cache across sessions with the same message id", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const content = "x".repeat(1_000);
    const firstSession = render(
      <TypingAnimationProbe sessionId="session-a" messageId="shared-message" content={content} />,
    );

    expect(screen.getByTestId("displayed-length").textContent).toBe("580");
    act(() => {
      frames.shift()?.(performance.now() + 100);
    });
    expect(Number(screen.getByTestId("displayed-length").textContent)).toBeGreaterThan(580);

    firstSession.unmount();
    render(<TypingAnimationProbe sessionId="session-b" messageId="shared-message" content={content} />);

    expect(screen.getByTestId("displayed-length").textContent).toBe("580");
  });
});

function RuntimeTypingMetricsProbe({ sessionId, testId }: { sessionId: string; testId: string }) {
  const metrics = useRuntimeTypingMetrics(sessionId);
  return <div data-testid={testId}>{metrics.speed}/{metrics.backlog}</div>;
}

function TypingAnimationProbe({
  content,
  messageId,
  sessionId,
}: {
  content: string;
  messageId: string;
  sessionId: string;
}) {
  const { displayedContent } = useTypingAnimation({
    content,
    sessionId,
    resetKey: messageId,
  });
  return <div data-testid="displayed-length">{displayedContent.length}</div>;
}
