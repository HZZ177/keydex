import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { CLOSE_WINDOW_BEHAVIOR_STORAGE_KEY } from "@/runtime/closeWindowBehaviorStore";
import { GeneralSettingsPage } from "@/renderer/pages/settings/general";
import type { GeneralSettings } from "@/types/protocol";

function renderPage(runtime: RuntimeBridge = fakeRuntime()) {
  return render(<GeneralSettingsPage runtime={runtime} />);
}

describe("GeneralSettingsPage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows the annual usage overview first on the general page", async () => {
    const runtime = fakeRuntime();

    renderPage(runtime);

    const sectionHeadings = screen.getAllByRole("heading", { level: 2 });
    expect(sectionHeadings[0].textContent).toBe("年度概览");
    expect(screen.getByTestId("annual-usage-overview")).not.toBeNull();
    expect(screen.getByTestId("usage-token-heatwall")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "应用显示" })).toBeNull();
    await waitFor(() =>
      expect(runtime.usage.getTrend).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: "day",
          startTime: expect.any(String),
          endTime: expect.any(String),
          timezoneOffsetMinutes: expect.any(Number),
        }),
      ),
    );
  });

  it("does not expose file history controls on the general page", async () => {
    const runtime = fakeRuntime({
      close_window_behavior: null,
      conversation_send_default_mode: "steer",
      file_history_enabled: true,
      file_history_max_storage_bytes: 1_073_741_824,
      file_history_max_versions_per_file: 1_000,
      file_history_max_rewind_points: 100,
      file_history_retention_days: 30,
    });

    renderPage(runtime);

    await waitFor(() => expect(runtime.settings.getSettings).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "文件回溯" })).toBeNull();
    expect(screen.queryByRole("button", { name: /文件历史开关/ })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /文件历史|单文件历史/ })).toBeNull();
  });

  it("saves the close window behavior from the general page", async () => {
    const runtime = fakeRuntime();

    renderPage(runtime);

    const trigger = await screen.findByRole("button", { name: /关闭窗口后行为/ });
    fireEvent.click(trigger);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(screen.queryByRole("option", { name: /未设置/ })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: /最小化到托盘/ }));

    await waitFor(() =>
      expect(runtime.settings.saveGeneralSettings).toHaveBeenCalledWith({
        close_window_behavior: "minimize_to_tray",
        conversation_send_default_mode: "steer",
        file_history_enabled: true,
        file_history_max_storage_bytes: 1_073_741_824,
        file_history_max_versions_per_file: 1_000,
        file_history_max_rewind_points: 100,
        file_history_retention_days: 30,
      }),
    );
    expect(localStorage.getItem(CLOSE_WINDOW_BEHAVIOR_STORAGE_KEY)).toBe("minimize_to_tray");
    expect(screen.getByRole("button", { name: /最小化到托盘/ })).not.toBeNull();
  });

  it("saves the default conversation send behavior from the general page", async () => {
    const runtime = fakeRuntime({
      close_window_behavior: null,
      conversation_send_default_mode: "steer",
    });

    renderPage(runtime);

    const trigger = await screen.findByRole("button", { name: /对话中发送消息默认行为/ });
    expect(trigger.textContent).toContain("引导当前回复");
    expect(screen.getByText("回复中发送时默认引导当前回复，Ctrl+Enter 临时加入等待队列")).not.toBeNull();

    fireEvent.click(trigger);
    const queueOption = screen
      .getAllByRole("option")
      .find((option) => within(option).queryByText("加入等待队列"));
    expect(queueOption).not.toBeUndefined();
    fireEvent.click(queueOption as HTMLElement);

    await waitFor(() =>
      expect(runtime.settings.saveGeneralSettings).toHaveBeenCalledWith({
        close_window_behavior: null,
        conversation_send_default_mode: "queue",
        file_history_enabled: true,
        file_history_max_storage_bytes: 1_073_741_824,
        file_history_max_versions_per_file: 1_000,
        file_history_max_rewind_points: 100,
        file_history_retention_days: 30,
      }),
    );
    expect(screen.getByRole("button", { name: /加入等待队列/ })).not.toBeNull();
  });

});

function fakeRuntime(general: GeneralSettings = { close_window_behavior: null }): RuntimeBridge {
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
      selected_shell: "cmd" as const,
      shell_path: "C:/Windows/System32/cmd.exe",
      shell_label: "CMD",
      shell_edition: null,
      require_approval_for_untrusted: true,
      allow_persistent_trust: true,
      file_access_mode: "workspace_trusted" as const,
      default_timeout_seconds: 60,
      max_timeout_seconds: 600,
      inline_output_max_chars: 20000,
      tail_max_chars: 20000,
      output_file_max_bytes: 8388608,
      progress_interval_ms: 500,
    },
  };
  return {
    settings: {
      getSettings: vi.fn(() => Promise.resolve(response)),
      saveGeneralSettings: vi.fn((nextGeneral: GeneralSettings) =>
        Promise.resolve({ ...response, general: nextGeneral }),
      ),
    },
    usage: {
      getTrend: vi.fn(() => Promise.resolve({ points: [] })),
    },
  } as unknown as RuntimeBridge;
}
