import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BrowserOcclusionProvider } from "@/renderer/features/browser/runtime";
import {
  MandatoryCheckpointMigrationGate,
} from "@/renderer/providers/MandatoryCheckpointMigrationGate";
import { RuntimeConnectionProvider } from "@/renderer/providers/RuntimeConnectionProvider";
import type {
  CheckpointMigrationStatus,
  RuntimeBridge,
} from "@/runtime";

const connection = {
  host: "127.0.0.1",
  port: 8765,
  base_url: "http://127.0.0.1:8765",
  data_dir: "",
};

describe("MandatoryCheckpointMigrationGate", () => {
  it("keeps required and running migration modal, exposes one total percentage only", async () => {
    const required = migrationStatus("required", 0, {
      can_start: true,
    });
    const running = migrationStatus("running", 12);
    const runtime = migrationRuntime({
      status: vi.fn().mockResolvedValue(required),
      start: vi.fn().mockResolvedValue(running),
    });

    renderGate(runtime);

    const dialog = await screen.findByRole("dialog", {
      name: "需要迁移会话数据",
    });
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    ).toBe("0");
    expect(dialog.textContent).toContain(
      "切换到新的会话存储策略，以显著降低长期使用产生的本地存储占用",
    );
    expect(dialog.textContent).toContain(
      "迁移会保留历史会话和消息，完成后仍可继续对话",
    );
    expect(dialog.textContent).toContain(
      "迁移前已有的历史消息将无法回溯，也无法从这些历史位置创建分支",
    );
    expect(dialog.textContent).toContain(
      "新产生的消息（包括在历史会话中继续对话产生的消息）以及新建会话不受影响",
    );
    expect(dialog.textContent).not.toMatch(
      /phase|namespace|table|row|byte|ratio|ETA/i,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(screen.getByRole("dialog")).not.toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "开始迁移" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("progressbar").getAttribute("aria-valuenow"),
      ).toBe("12"),
    );
    expect(screen.queryByText(/切换到新的会话存储策略/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(runtime.checkpointMigration.start).toHaveBeenCalledTimes(1);
  });

  it("keeps completed migration blocking until backend acknowledgement succeeds", async () => {
    const completed = migrationStatus("completed", 100, {
      can_acknowledge: true,
    });
    const ready = migrationStatus("ready", 100);
    const runtime = migrationRuntime({
      status: vi.fn().mockResolvedValue(completed),
      acknowledge: vi.fn().mockResolvedValue(ready),
    });

    renderGate(runtime);

    expect(
      await screen.findByRole("button", { name: "进入 Keydex" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    ).toBe("100");

    await userEvent.click(
      screen.getByRole("button", { name: "进入 Keydex" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(runtime.checkpointMigration.acknowledge).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("workbench")).not.toBeNull();
  });

  it("offers retry as the only failed-state action", async () => {
    const failed = migrationStatus("failed", 47, {
      can_retry: true,
      error: {
        code: "checkpoint_migration_insufficient_space",
        message: "可用磁盘空间不足，请清理空间后重试",
        retryable: true,
      },
    });
    const running = migrationStatus("running", 47);
    const runtime = migrationRuntime({
      status: vi.fn().mockResolvedValue(failed),
      retry: vi.fn().mockResolvedValue(running),
    });

    renderGate(runtime);

    expect(
      await screen.findByText("可用磁盘空间不足，请清理空间后重试"),
    ).not.toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(runtime.checkpointMigration.retry).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

function renderGate(runtime: RuntimeBridge) {
  return render(
    <BrowserOcclusionProvider>
      <RuntimeConnectionProvider
        runtime={runtime}
        starter={async () => connection}
      >
        <MandatoryCheckpointMigrationGate runtime={runtime}>
          <div data-testid="workbench">workbench</div>
        </MandatoryCheckpointMigrationGate>
      </RuntimeConnectionProvider>
    </BrowserOcclusionProvider>,
  );
}

function migrationRuntime(
  overrides: Partial<RuntimeBridge["checkpointMigration"]>,
): RuntimeBridge {
  return {
    checkpointMigration: {
      status: vi.fn().mockResolvedValue(migrationStatus("ready", 100)),
      start: vi.fn(),
      retry: vi.fn(),
      acknowledge: vi.fn(),
      ...overrides,
    },
  } as unknown as RuntimeBridge;
}

function migrationStatus(
  state: CheckpointMigrationStatus["state"],
  percent: number,
  overrides: Partial<CheckpointMigrationStatus> = {},
): CheckpointMigrationStatus {
  return {
    state,
    percent,
    can_start: false,
    can_retry: false,
    can_acknowledge: false,
    error: null,
    ...overrides,
  };
}
