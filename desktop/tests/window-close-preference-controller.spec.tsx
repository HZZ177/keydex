import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import type { WindowLifecycleRuntime } from "@/runtime/windowLifecycle";
import { WindowClosePreferenceController } from "@/renderer/providers/WindowClosePreferenceController";
import type { CloseWindowBehavior, GeneralSettings } from "@/types/protocol";

describe("WindowClosePreferenceController", () => {
  it("asks for a default close behavior when the stored value is null", async () => {
    const runtime = fakeRuntime({ close_window_behavior: null });
    const lifecycle = fakeWindowLifecycle();

    render(<WindowClosePreferenceController runtime={runtime} windowLifecycle={lifecycle.runtime} />);

    await waitFor(() => expect(lifecycle.listenForCloseRequest).toHaveBeenCalled());
    act(() => lifecycle.emitCloseRequest());

    expect(await screen.findByRole("dialog")).not.toBeNull();
    expect(screen.getByText("后续可以随时在设置 - 常规中变更。")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "最小化到托盘" }));

    await waitFor(() =>
      expect(runtime.settings.saveGeneralSettings).toHaveBeenCalledWith({
        close_window_behavior: "minimize_to_tray",
      }),
    );
    expect(lifecycle.hideWindowToTray).toHaveBeenCalledTimes(1);
    expect(lifecycle.exitApplication).not.toHaveBeenCalled();
  });

  it("uses the stored exit behavior without prompting", async () => {
    const runtime = fakeRuntime({ close_window_behavior: "exit" });
    const lifecycle = fakeWindowLifecycle();

    render(<WindowClosePreferenceController runtime={runtime} windowLifecycle={lifecycle.runtime} />);

    await waitFor(() => expect(lifecycle.listenForCloseRequest).toHaveBeenCalled());
    act(() => lifecycle.emitCloseRequest());

    await waitFor(() => expect(lifecycle.exitApplication).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runtime.settings.saveGeneralSettings).not.toHaveBeenCalled();
  });
});

function fakeWindowLifecycle() {
  let closeHandler: (() => void) | null = null;
  const listenForCloseRequest = vi.fn(async (handler: () => void) => {
    closeHandler = handler;
    return () => {
      closeHandler = null;
    };
  });
  const hideWindowToTray = vi.fn(async () => undefined);
  const exitApplication = vi.fn(async () => undefined);
  return {
    runtime: {
      listenForCloseRequest,
      hideWindowToTray,
      exitApplication,
    } satisfies WindowLifecycleRuntime,
    listenForCloseRequest,
    hideWindowToTray,
    exitApplication,
    emitCloseRequest() {
      closeHandler?.();
    },
  };
}

function fakeRuntime(general: GeneralSettings): RuntimeBridge {
  const response = {
    model: {
      base_url: "",
      model: "",
      timeout_seconds: 60,
      api_key_set: false,
      api_key_preview: null,
    },
    general,
    appearance: {
      font_family: "system" as const,
    },
    command: {
      command_enabled: true,
      require_approval_for_untrusted: true,
      allow_persistent_trust: true,
      file_access_mode: "workspace_trusted" as const,
      default_timeout_seconds: 60,
      max_timeout_seconds: 600,
      max_output_chars: 20000,
    },
  };
  return {
    settings: {
      getSettings: vi.fn(() => Promise.resolve(response)),
      saveGeneralSettings: vi.fn((nextGeneral: { close_window_behavior: CloseWindowBehavior }) =>
        Promise.resolve({ ...response, general: nextGeneral }),
      ),
    },
  } as unknown as RuntimeBridge;
}
