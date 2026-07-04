import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { ConfigSettingsPage } from "@/renderer/pages/settings/config/ConfigSettingsPage";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type {
  CommandApprovalAuditRecord,
  CommandSettings,
  CommandShell,
  SettingsResponse,
  TrustedCommandRule,
} from "@/types/protocol";

describe("ConfigSettingsPage", () => {
  it("loads command settings, trusted rules and approval history", async () => {
    const runtime = fakeRuntime();

    renderConfigSettingsPage(runtime);

    expect(await screen.findByRole("heading", { name: "策略配置" })).not.toBeNull();
    expect(await screen.findByText("批准策略")).not.toBeNull();
    expect(screen.getByRole("button", { name: "批准策略：按请求" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "文件访问权限：工作区内信任" })).not.toBeNull();
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Git Bash",
      "PowerShell",
      "CMD",
    ]);
    expect(screen.getByRole("radio", { name: "CMD" })).not.toBeNull();
    expect(screen.getByText("未信任命令执行前需要确认，可在审批时保存信任规则。")).not.toBeNull();
    expect(screen.getByText("Agent 可以读写当前工作区。")).not.toBeNull();
    expect(screen.getByText("已信任命令")).not.toBeNull();
    expect(screen.getByText("审批记录")).not.toBeNull();
    expect(screen.getAllByText("pnpm test")).toHaveLength(2);
    expect(screen.getByText("精确")).not.toBeNull();
    expect(screen.getByText("已允许")).not.toBeNull();
    expect(screen.getByText("已保存信任")).not.toBeNull();
    expect(screen.getByText("精确匹配")).not.toBeNull();
    expect(screen.getByText("已关联规则")).not.toBeNull();
    expect(screen.getAllByText("D:/repo")).toHaveLength(2);
    expect(screen.getByText("第 1 / 1 页，共 1 条规则")).not.toBeNull();
    expect(screen.getByText("第 1 / 1 页，共 1 条")).not.toBeNull();
    expect(runtime.settings.listCommandApprovalHistory).toHaveBeenCalledWith({ page: 1, pageSize: 10 });
  });

  it("hides command runtime details when the command tool is disabled", async () => {
    const disabledCommand = commandSettings({ command_enabled: false });
    const runtime = fakeRuntime({
      getSettings: vi.fn().mockResolvedValue(settingsResponse(disabledCommand)),
    });

    renderConfigSettingsPage(runtime);

    expect(await screen.findByRole("button", { name: "开启命令行工具" })).not.toBeNull();
    expect(screen.queryByRole("radio", { name: "Git Bash" })).toBeNull();
    expect(screen.queryByText("批准策略")).toBeNull();
    expect(screen.queryByText("已信任命令")).toBeNull();
    expect(screen.getByText("文件访问权限")).not.toBeNull();
  });

  it("selects the first available preferred runtime when enabling from empty settings", async () => {
    const disabledCommand = commandSettings({
      command_enabled: false,
      selected_shell: "cmd",
      shell_path: "",
      shell_label: "",
      shell_edition: null,
      shell_version: null,
      shells: {},
    });
    const runtime = fakeRuntime({
      getSettings: vi.fn().mockResolvedValue(settingsResponse(disabledCommand)),
      discoverCommandRuntime: vi.fn((shell: CommandShell) => {
        if (shell === "git_bash") {
          return Promise.resolve({
            shell,
            found: false,
            diagnostics: [],
            error: "未找到 Git Bash",
          });
        }
        if (shell === "powershell") {
          return Promise.resolve({
            shell,
            found: true,
            path: "C:/Program Files/PowerShell/7/pwsh.exe",
            label: "PowerShell 7+",
            edition: "Core",
            version: "7.5.0",
            diagnostics: [],
          });
        }
        return Promise.resolve({
          shell,
          found: true,
          path: "C:/Windows/System32/cmd.exe",
          label: "CMD",
          diagnostics: [],
        });
      }),
    });

    renderConfigSettingsPage(runtime);

    fireEvent.click(await screen.findByRole("button", { name: "开启命令行工具" }));

    await waitFor(() => {
      expect(runtime.settings.saveCommandSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          command_enabled: true,
          selected_shell: "powershell",
          shell_path: "C:/Program Files/PowerShell/7/pwsh.exe",
          shell_label: "PowerShell 7+",
        }),
      );
    });
    expect(screen.queryByRole("dialog", { name: "定位 Git Bash executable" })).toBeNull();
  });

  it("opens manual locator dialog when selecting a missing runtime", async () => {
    const runtime = fakeRuntime({
      discoverCommandRuntime: vi.fn((shell: CommandShell) =>
        Promise.resolve(
          shell === "cmd"
            ? {
                shell,
                found: true,
                path: "C:/Windows/System32/cmd.exe",
                label: "CMD",
                diagnostics: [],
              }
            : {
                shell,
                found: false,
                diagnostics: [],
                error: shell === "git_bash" ? "未找到 Git Bash" : "未找到 PowerShell",
              },
        ),
      ),
    });

    renderConfigSettingsPage(runtime);

    await screen.findAllByText("pnpm test");
    fireEvent.click(screen.getByRole("radio", { name: "Git Bash" }));

    expect(await screen.findByRole("dialog", { name: "定位 Git Bash executable" })).not.toBeNull();
    expect(screen.getByText(/如果尚未安装，请先安装/)).not.toBeNull();
    await waitFor(() => {
      expect(runtime.settings.saveCommandSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          command_enabled: true,
          selected_shell: "git_bash",
          shell_path: "",
        }),
      );
    });
  });

  it("saves command settings from approval policy selection", async () => {
    const runtime = fakeRuntime();

    renderConfigSettingsPage(runtime);

    await screen.findAllByText("pnpm test");
    fireEvent.click(screen.getByRole("button", { name: "批准策略：按请求" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("option", { name: /按请求/ })).not.toBeNull();
    expect(screen.getByRole("option", { name: /无条件信任/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /无条件信任/ }));

    await waitFor(() => {
      expect(runtime.settings.saveCommandSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          selected_shell: "cmd",
          require_approval_for_untrusted: false,
          allow_persistent_trust: false,
          default_timeout_seconds: 120,
          inline_output_max_chars: 12000,
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("notification-viewport").textContent).toContain("批准策略已保存");
    });
  });

  it("saves file access mode from policy selection", async () => {
    const runtime = fakeRuntime();

    renderConfigSettingsPage(runtime);

    await screen.findAllByText("pnpm test");
    fireEvent.click(screen.getByRole("button", { name: "文件访问权限：工作区内信任" }));
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByRole("option", { name: /无文件访问权限/ })).not.toBeNull();
    expect(screen.getByRole("option", { name: /工作区内只读/ })).not.toBeNull();
    expect(screen.getByRole("option", { name: /工作区内信任/ })).not.toBeNull();
    expect(screen.getByRole("option", { name: /完全访问/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /工作区内只读/ }));

    await waitFor(() => {
      expect(runtime.settings.saveCommandSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          file_access_mode: "workspace_read_only",
          selected_shell: "cmd",
          require_approval_for_untrusted: true,
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("notification-viewport").textContent).toContain("文件访问权限已保存");
    });
  });

  it("updates and deletes trusted command rules", async () => {
    const runtime = fakeRuntime();

    renderConfigSettingsPage(runtime);

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

  it("paginates trusted command rules locally", async () => {
    const rules = Array.from({ length: 11 }, (_, index) => {
      const ruleNumber = index + 1;
      const command = `trusted command ${String(ruleNumber).padStart(2, "0")}`;
      return trustedRule({
        id: `rule-${ruleNumber}`,
        command_pattern: command,
        normalized_command: command,
        created_at: `2026-06-24T10:${String(ruleNumber).padStart(2, "0")}:00Z`,
        updated_at: `2026-06-24T10:${String(ruleNumber).padStart(2, "0")}:00Z`,
      });
    });
    const runtime = fakeRuntime({
      listTrustedCommandRules: vi.fn().mockResolvedValue(rules),
    });

    renderConfigSettingsPage(runtime);

    expect(await screen.findByText("trusted command 11")).not.toBeNull();
    expect(screen.queryByText("trusted command 01")).toBeNull();
    expect(screen.getByText("第 1 / 2 页，共 11 条规则")).not.toBeNull();
    expect(screen.getByRole("button", { name: "上一页已信任命令" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "下一页已信任命令" }));

    expect(await screen.findByText("trusted command 01")).not.toBeNull();
    expect(screen.queryByText("trusted command 11")).toBeNull();
    expect(screen.getByText("第 2 / 2 页，共 11 条规则")).not.toBeNull();
    expect(runtime.settings.listTrustedCommandRules).toHaveBeenCalledTimes(1);
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

    renderConfigSettingsPage(runtime);

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

function renderConfigSettingsPage(runtime: RuntimeBridge) {
  return render(
    <NotificationProvider>
      <ConfigSettingsPage runtime={runtime} />
    </NotificationProvider>,
  );
}

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
      discoverCommandRuntime: vi.fn().mockResolvedValue({
        shell: "cmd",
        found: true,
        path: "C:/Windows/System32/cmd.exe",
        label: "CMD",
        diagnostics: [],
      }),
      validateCommandRuntime: vi.fn().mockResolvedValue({
        shell: "cmd",
        found: true,
        path: "C:/Windows/System32/cmd.exe",
        label: "CMD",
        diagnostics: [],
      }),
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

function commandSettings(overrides: Partial<CommandSettings> = {}): CommandSettings {
  return {
    command_enabled: true,
    selected_shell: "cmd",
    shell_path: "C:/Windows/System32/cmd.exe",
    shell_label: "CMD",
    shell_edition: null,
    shell_version: null,
    shells: {
      cmd: {
        shell_path: "C:/Windows/System32/cmd.exe",
        shell_label: "CMD",
        shell_edition: null,
        shell_version: null,
      },
    },
    require_approval_for_untrusted: true,
    allow_persistent_trust: true,
    file_access_mode: "workspace_trusted",
    default_timeout_seconds: 120,
    max_timeout_seconds: 600,
    inline_output_max_chars: 12000,
    tail_max_chars: 12000,
    output_file_max_bytes: 8388608,
    progress_interval_ms: 500,
    ...overrides,
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
    general: { close_window_behavior: null },
    appearance: { font_family: "system" },
    command,
  };
}

function trustedRule(overrides: Partial<TrustedCommandRule> = {}): TrustedCommandRule {
  return {
    id: "rule-1",
    command_pattern: "pnpm test",
    normalized_command: "pnpm test",
    match_type: "exact",
    tool_name: "run_powershell",
    shell: "powershell",
    shell_path: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    workspace_root: "D:/repo",
    cwd_pattern: "D:/repo",
    enabled: true,
    created_from_approval_id: "approval-1",
    created_at: "2026-06-24T10:00:00Z",
    updated_at: "2026-06-24T10:00:00Z",
    last_used_at: null,
    ...overrides,
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
