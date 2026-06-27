import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { ConfigSettingsPage } from "@/renderer/pages/settings/config/ConfigSettingsPage";
import type {
  CommandApprovalAuditRecord,
  CommandSettings,
  SettingsResponse,
  TrustedCommandRule,
} from "@/types/protocol";

describe("ConfigSettingsPage", () => {
  it("loads command settings, trusted rules and approval history", async () => {
    const runtime = fakeRuntime();

    render(<ConfigSettingsPage runtime={runtime} />);

    expect(await screen.findByText("批准策略")).not.toBeNull();
    expect(screen.getByRole("button", { name: "批准策略：按请求" })).not.toBeNull();
    expect(screen.getByText("未信任命令执行前需要确认，可在审批时保存信任规则。")).not.toBeNull();
    expect(screen.getByText("已信任命令")).not.toBeNull();
    expect(screen.getByText("审批记录")).not.toBeNull();
    expect(screen.getAllByText("pnpm test")).toHaveLength(2);
    expect(screen.getByText("精确")).not.toBeNull();
    expect(screen.getByText("已允许")).not.toBeNull();
    expect(screen.getByText("已保存信任")).not.toBeNull();
    expect(screen.getByText("精确匹配")).not.toBeNull();
    expect(screen.getByText("已关联规则")).not.toBeNull();
    expect(screen.getAllByText("D:/repo")).toHaveLength(2);
    expect(screen.getByText("第 1 / 1 页，共 1 条")).not.toBeNull();
    expect(runtime.settings.listCommandApprovalHistory).toHaveBeenCalledWith({ page: 1, pageSize: 10 });
  });

  it("saves command settings from approval policy selection", async () => {
    const runtime = fakeRuntime();

    render(<ConfigSettingsPage runtime={runtime} />);

    await screen.findAllByText("pnpm test");
    fireEvent.click(screen.getByRole("button", { name: "批准策略：按请求" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("option", { name: /按请求/ })).not.toBeNull();
    expect(screen.getByRole("option", { name: /无条件信任/ })).not.toBeNull();
    expect(screen.getByRole("option", { name: /关闭命令行工具/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /无条件信任/ }));

    await waitFor(() => {
      expect(runtime.settings.saveCommandSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          command_enabled: true,
          require_approval_for_untrusted: false,
          allow_persistent_trust: false,
          default_timeout_seconds: 120,
          max_output_chars: 65536,
        }),
      );
    });
    expect(await screen.findByText("批准策略已保存")).not.toBeNull();
  });

  it("updates and deletes trusted command rules", async () => {
    const runtime = fakeRuntime();

    render(<ConfigSettingsPage runtime={runtime} />);

    await screen.findAllByText("pnpm test");
    fireEvent.click(screen.getByRole("button", { name: "禁用 pnpm test" }));

    await waitFor(() => {
      expect(runtime.settings.updateTrustedCommandRule).toHaveBeenCalledWith("rule-1", false);
    });
    expect(screen.getByText("禁用")).not.toBeNull();
    expect(screen.getByRole("button", { name: "启用 pnpm test" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "删除 pnpm test" }));

    await waitFor(() => {
      expect(runtime.settings.deleteTrustedCommandRule).toHaveBeenCalledWith("rule-1");
    });
    expect(screen.getByText("暂无已信任命令")).not.toBeNull();
  });

  it("paginates approval history without reloading command settings and trusted rules", async () => {
    const runtime = fakeRuntime({
      listCommandApprovalHistory: vi.fn((options: { page?: number; pageSize?: number } = {}) => {
        const { page = 1, pageSize = 10 } = options;
        return Promise.resolve({
          list: [
            approvalHistory({
              id: `audit-${page}`,
              command: page === 2 ? "npm run build" : "pnpm test",
              cwd: page === 2 ? "D:/repo/web" : "D:/repo",
            }),
          ],
          total: 31,
          page,
          page_size: pageSize,
        });
      }),
    });

    render(<ConfigSettingsPage runtime={runtime} />);

    expect(await screen.findAllByText("pnpm test")).toHaveLength(2);
    expect(screen.getByText("第 1 / 4 页，共 31 条")).not.toBeNull();
    expect(screen.getByRole("button", { name: "上一页审批记录" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "下一页审批记录" }));

    expect(await screen.findByText("npm run build")).not.toBeNull();
    expect(screen.getByText("第 2 / 4 页，共 31 条")).not.toBeNull();
    expect(screen.getByRole("button", { name: "下一页审批记录" }).hasAttribute("disabled")).toBe(false);
    expect(runtime.settings.getSettings).toHaveBeenCalledTimes(1);
    expect(runtime.settings.listTrustedCommandRules).toHaveBeenCalledTimes(1);
    expect(runtime.settings.listCommandApprovalHistory).toHaveBeenLastCalledWith({ page: 2, pageSize: 10 });
  });
});

function fakeRuntime(options: Partial<RuntimeBridge["settings"]> = {}): RuntimeBridge {
  const command = commandSettings();
  const rule = trustedRule();
  return {
    settings: {
      getSettings: vi.fn().mockResolvedValue(settingsResponse(command)),
      saveCommandSettings: vi.fn((next: CommandSettings) => Promise.resolve(settingsResponse(next))),
      listTrustedCommandRules: vi.fn().mockResolvedValue([rule]),
      updateTrustedCommandRule: vi.fn().mockResolvedValue({ ...rule, enabled: false }),
      deleteTrustedCommandRule: vi.fn().mockResolvedValue(undefined),
      listCommandApprovalHistory: vi.fn().mockResolvedValue({
        list: [approvalHistory()],
        total: 1,
        page: 1,
        page_size: 10,
      }),
      ...options,
    },
  } as unknown as RuntimeBridge;
}

function commandSettings(): CommandSettings {
  return {
    command_enabled: true,
    require_approval_for_untrusted: true,
    allow_persistent_trust: true,
    default_timeout_seconds: 120,
    max_timeout_seconds: 600,
    max_output_chars: 65536,
  };
}

function settingsResponse(command: CommandSettings): SettingsResponse {
  return {
    model: {
      base_url: "https://api.example/v1",
      model: "qwen-coder",
      timeout_seconds: 60,
      api_key_set: true,
      api_key_preview: "sk-***",
    },
    appearance: { font_family: "system" },
    command,
  };
}

function trustedRule(): TrustedCommandRule {
  return {
    id: "rule-1",
    command_pattern: "pnpm test",
    normalized_command: "pnpm test",
    match_type: "exact",
    shell: "powershell",
    workspace_root: "D:/repo",
    cwd_pattern: "D:/repo",
    enabled: true,
    created_from_approval_id: "approval-1",
    created_at: "2026-06-24T10:00:00Z",
    updated_at: "2026-06-24T10:00:00Z",
    last_used_at: null,
  };
}

function approvalHistory(overrides: Partial<CommandApprovalAuditRecord> = {}): CommandApprovalAuditRecord {
  return {
    id: "audit-1",
    approval_id: "approval-1",
    session_id: "session-1",
    command: "pnpm test",
    cwd: "D:/repo",
    decision: "approved",
    trust_scope: "persistent",
    rule_match_type: "exact",
    trusted_rule_id: "rule-1",
    reject_message: null,
    metadata: {},
    created_at: "2026-06-24T10:01:00Z",
    ...overrides,
  };
}
