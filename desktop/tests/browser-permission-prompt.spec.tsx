import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PermissionPrompt } from "../src/renderer/features/browser/ui/PermissionPrompt";

describe("PermissionPrompt", () => {
  it("shows origin and uses the shared dialog for one-time camera permission", () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(
      <div data-theme="dark">
        <PermissionPrompt
          request={{
            permissionRequestId: "permission-1",
            origin: "https://example.com",
            permission: "camera",
            deadline: "2026-07-21T00:00:30Z",
          }}
          onAllow={onAllow}
          onDeny={onDeny}
        />
      </div>,
    );
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByText("https://example.com")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "仅允许本次" }));
    expect(onAllow).toHaveBeenCalledOnce();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("routes Escape and explicit deny to the same deny action", () => {
    const onDeny = vi.fn();
    render(
      <PermissionPrompt
        request={{
          permissionRequestId: "permission-2",
          origin: "https://example.com",
          permission: "microphone",
          deadline: "2026-07-21T00:00:30Z",
        }}
        onAllow={vi.fn()}
        onDeny={onDeny}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDeny).toHaveBeenCalledOnce();
  });
});
