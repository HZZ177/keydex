import { render, screen } from "@testing-library/react";

import {
  AppUpdateDialog,
  type AppUpdateStatus,
} from "@/renderer/providers/AppUpdateController";
import type { AppUpdateProgress, PendingAppUpdate } from "@/runtime";

const EMPTY_PROGRESS: AppUpdateProgress = {
  downloadedBytes: 0,
  totalBytes: null,
  finished: false,
};

describe("AppUpdateDialog", () => {
  it.each([
    ["checking", "正在连接更新服务"],
    ["current", "Keydex 0.3.11 已是最新版本"],
  ] satisfies Array<[AppUpdateStatus, string]>)("shows the %s state in the dialog", (status, expected) => {
    renderDialog({ status });
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("renders available release notes as Markdown", () => {
    renderDialog({ status: "available", pendingUpdate: pendingUpdate() });

    expect(screen.getByRole("heading", { name: "重点更新" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "下载并重启" })).toBeTruthy();
  });

  it("offers a check retry after a check failure", () => {
    renderDialog({ status: "error", error: "network down", errorKind: "check" });
    expect(screen.getByText("network down")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeTruthy();
  });
});

function renderDialog(overrides: {
  status?: AppUpdateStatus;
  pendingUpdate?: PendingAppUpdate | null;
  error?: string;
  errorKind?: "check" | "install" | null;
} = {}) {
  return render(
    <AppUpdateDialog
      currentVersion="0.3.11"
      dialogOpen
      status={overrides.status ?? "checking"}
      pendingUpdate={overrides.pendingUpdate ?? null}
      progress={EMPTY_PROGRESS}
      error={overrides.error ?? ""}
      errorKind={overrides.errorKind ?? null}
      onClose={vi.fn()}
      onInstall={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
}

function pendingUpdate(): PendingAppUpdate {
  return {
    currentVersion: "0.3.10",
    version: "0.3.11",
    date: "2026-07-17T08:00:00Z",
    body: "## 重点更新\n\n- 支持 Markdown\n- 修复问题",
    update: {} as PendingAppUpdate["update"],
  };
}
