import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConnection, RuntimeBridge } from "@/runtime";
import type { CloseWindowBehaviorStore } from "@/runtime/closeWindowBehaviorStore";
import type { WindowLifecycleRuntime } from "@/runtime/windowLifecycle";
import { WindowClosePreferenceController } from "@/renderer/providers/WindowClosePreferenceController";
import { RuntimeConnectionProvider } from "@/renderer/providers/RuntimeConnectionProvider";
import type { CloseWindowBehavior, GeneralSettings } from "@/types/protocol";

describe("WindowClosePreferenceController", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("asks for a default close behavior when the stored value is null", async () => {
    const runtime = fakeRuntime({ close_window_behavior: null });
    const lifecycle = fakeWindowLifecycle();
    const behaviorStore = fakeBehaviorStore();

    render(
      <WindowClosePreferenceController
        runtime={runtime}
        behaviorStore={behaviorStore.runtime}
        windowLifecycle={lifecycle.runtime}
      />,
    );

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
    expect(behaviorStore.write).toHaveBeenCalledWith("minimize_to_tray");
    expect(lifecycle.hideWindowToTray).toHaveBeenCalledTimes(1);
    expect(lifecycle.exitApplication).not.toHaveBeenCalled();
  });

  it("uses the stored exit behavior without prompting", async () => {
    const runtime = fakeRuntime({ close_window_behavior: "exit" });
    const lifecycle = fakeWindowLifecycle();
    const behaviorStore = fakeBehaviorStore();

    render(
      <WindowClosePreferenceController
        runtime={runtime}
        behaviorStore={behaviorStore.runtime}
        windowLifecycle={lifecycle.runtime}
      />,
    );

    await waitFor(() => expect(lifecycle.listenForCloseRequest).toHaveBeenCalled());
    act(() => lifecycle.emitCloseRequest());

    await waitFor(() => expect(lifecycle.exitApplication).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(behaviorStore.write).toHaveBeenCalledWith("exit");
    expect(runtime.settings.saveGeneralSettings).not.toHaveBeenCalled();
  });

  it("uses the cached behavior while the backend is still starting", async () => {
    const runtime = fakeRuntime({ close_window_behavior: null });
    const lifecycle = fakeWindowLifecycle();
    const behaviorStore = fakeBehaviorStore("minimize_to_tray");

    render(
      <RuntimeConnectionProvider
        runtime={runtime}
        starter={() => new Promise<never>(() => undefined)}
        isDesktopRuntime={() => true}
      >
        <WindowClosePreferenceController
          runtime={runtime}
          behaviorStore={behaviorStore.runtime}
          windowLifecycle={lifecycle.runtime}
        />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(lifecycle.listenForCloseRequest).toHaveBeenCalled());
    act(() => lifecycle.emitCloseRequest());

    await waitFor(() => expect(lifecycle.hideWindowToTray).toHaveBeenCalledTimes(1));
    expect(lifecycle.exitApplication).not.toHaveBeenCalled();
    expect(runtime.settings.getSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waits for backend readiness when no cached behavior exists", async () => {
    const runtime = fakeRuntime({ close_window_behavior: "minimize_to_tray" });
    const lifecycle = fakeWindowLifecycle();
    const behaviorStore = fakeBehaviorStore();
    const starter = createDeferred<AgentConnection>();

    render(
      <RuntimeConnectionProvider
        runtime={runtime}
        starter={() => starter.promise}
        isDesktopRuntime={() => true}
      >
        <WindowClosePreferenceController
          runtime={runtime}
          behaviorStore={behaviorStore.runtime}
          windowLifecycle={lifecycle.runtime}
        />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(lifecycle.listenForCloseRequest).toHaveBeenCalled());
    act(() => lifecycle.emitCloseRequest());

    expect(lifecycle.exitApplication).not.toHaveBeenCalled();
    expect(lifecycle.hideWindowToTray).not.toHaveBeenCalled();
    expect(runtime.settings.getSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      starter.resolve(agentConnection());
      await starter.promise;
    });

    await waitFor(() => expect(lifecycle.hideWindowToTray).toHaveBeenCalledTimes(1));
    expect(lifecycle.exitApplication).not.toHaveBeenCalled();
    expect(runtime.settings.getSettings).toHaveBeenCalledTimes(1);
    expect(behaviorStore.write).toHaveBeenCalledWith("minimize_to_tray");
  });

  it("exits if startup fails while no cached behavior exists", async () => {
    const runtime = fakeRuntime({ close_window_behavior: "minimize_to_tray" });
    const lifecycle = fakeWindowLifecycle();
    const behaviorStore = fakeBehaviorStore();
    const starter = createDeferred<AgentConnection>();

    render(
      <RuntimeConnectionProvider
        runtime={runtime}
        starter={() => starter.promise}
        isDesktopRuntime={() => true}
      >
        <WindowClosePreferenceController
          runtime={runtime}
          behaviorStore={behaviorStore.runtime}
          windowLifecycle={lifecycle.runtime}
        />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(lifecycle.listenForCloseRequest).toHaveBeenCalled());
    act(() => lifecycle.emitCloseRequest());

    expect(lifecycle.exitApplication).not.toHaveBeenCalled();
    expect(runtime.settings.getSettings).not.toHaveBeenCalled();

    await act(async () => {
      starter.reject(new Error("health timeout"));
      await starter.promise.catch(() => undefined);
    });

    await waitFor(() => expect(lifecycle.exitApplication).toHaveBeenCalledTimes(1));
    expect(lifecycle.hideWindowToTray).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("syncs the configured behavior after the backend becomes ready", async () => {
    const runtime = fakeRuntime({ close_window_behavior: "exit" });
    const lifecycle = fakeWindowLifecycle();
    const behaviorStore = fakeBehaviorStore();

    render(
      <RuntimeConnectionProvider
        runtime={runtime}
        starter={() => Promise.resolve(agentConnection())}
        isDesktopRuntime={() => true}
      >
        <WindowClosePreferenceController
          runtime={runtime}
          behaviorStore={behaviorStore.runtime}
          windowLifecycle={lifecycle.runtime}
        />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(behaviorStore.write).toHaveBeenCalledWith("exit"));
    expect(lifecycle.exitApplication).not.toHaveBeenCalled();
    expect(lifecycle.hideWindowToTray).not.toHaveBeenCalled();
  });

  it("falls back without prompting when settings cannot be read", async () => {
    const runtime = fakeRuntime({ close_window_behavior: null }, { rejectGetSettings: true });
    const lifecycle = fakeWindowLifecycle();
    const behaviorStore = fakeBehaviorStore();

    render(
      <WindowClosePreferenceController
        runtime={runtime}
        behaviorStore={behaviorStore.runtime}
        windowLifecycle={lifecycle.runtime}
      />,
    );

    await waitFor(() => expect(lifecycle.listenForCloseRequest).toHaveBeenCalled());
    act(() => lifecycle.emitCloseRequest());

    await waitFor(() => expect(lifecycle.exitApplication).toHaveBeenCalledTimes(1));
    expect(runtime.settings.getSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
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

function fakeBehaviorStore(initialValue: CloseWindowBehavior | null = null) {
  let value = initialValue;
  const read = vi.fn(() => value);
  const write = vi.fn((nextBehavior: CloseWindowBehavior) => {
    value = nextBehavior;
  });
  const clear = vi.fn(() => {
    value = null;
  });
  return {
    runtime: {
      read,
      write,
      clear,
    } satisfies CloseWindowBehaviorStore,
    read,
    write,
    clear,
    value: () => value,
  };
}

function agentConnection(): AgentConnection {
  return {
    host: "127.0.0.1",
    port: 9234,
    base_url: "http://127.0.0.1:9234",
    data_dir: "D:/Keydex",
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function fakeRuntime(
  general: GeneralSettings,
  options: { rejectGetSettings?: boolean } = {},
): RuntimeBridge {
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
  const getSettings = options.rejectGetSettings
    ? vi.fn(() => Promise.reject(new Error("settings unavailable")))
    : vi.fn(() => Promise.resolve(response));
  return {
    settings: {
      getSettings,
      saveGeneralSettings: vi.fn((nextGeneral: { close_window_behavior: CloseWindowBehavior }) =>
        Promise.resolve({ ...response, general: nextGeneral }),
      ),
    },
  } as unknown as RuntimeBridge;
}
