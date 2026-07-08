import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  A2UIMotionItem,
  A2UIMotionRoot,
} from "@/renderer/pages/conversation/messages/a2ui";

describe("A2UI layout motion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps motion keys as lightweight markers without forcing layout reads", () => {
    const animateMock = vi.fn();
    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const originalAnimate = Element.prototype.animate;
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: animateMock,
    });

    try {
      const { rerender } = render(<MotionProbe count={1} />);

      rerender(<MotionProbe count={2} />);

      expect(screen.getByTestId("motion-root").getAttribute("data-a2ui-motion-root")).toBe("true");
      expect(screen.getByText("0").getAttribute("data-a2ui-motion-key")).toBe("item:0");
      expect(screen.getByText("1").getAttribute("data-a2ui-motion-key")).toBe("item:1");
      expect(rectSpy).not.toHaveBeenCalled();
      expect(animateMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Element.prototype, "animate", {
        configurable: true,
        value: originalAnimate,
      });
    }
  });
});

function MotionProbe({ count }: { count: number }) {
  return (
    <A2UIMotionRoot data-testid="motion-root">
      {Array.from({ length: count }, (_, index) => (
        <A2UIMotionItem motionKey={`item:${index}`} key={index}>
          {index}
        </A2UIMotionItem>
      ))}
    </A2UIMotionRoot>
  );
}
