import { AlertCircle, CheckCircle2, FileSearch, Power, RefreshCcw, SquareTerminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { RuntimeBridge } from "@/runtime";
import type {
  CommandApprovalAuditRecord,
  CommandRuntimeProbeResponse,
  CommandSettings,
  CommandShell,
  CommandShellConfig,
  FileAccessMode,
  AgentRuntimeSettings,
  FileEditToolStyle,
  TrustedCommandRule,
} from "@/types/protocol";
import { SettingsSelect } from "@/renderer/pages/settings/components";

import styles from "./ConfigSettingsPage.module.css";

const APPROVAL_HISTORY_PAGE_SIZE = 10;
const TRUSTED_COMMAND_RULE_PAGE_SIZE = 10;

const DEFAULT_COMMAND_SETTINGS: CommandSettings = {
  command_enabled: false,
  selected_shell: "git_bash",
  shell_path: "",
  shell_label: "",
  shell_edition: null,
  shell_version: null,
  shells: {},
  require_approval_for_untrusted: true,
  allow_persistent_trust: true,
  file_access_mode: "workspace_trusted",
  default_timeout_seconds: 120,
  max_timeout_seconds: 600,
  inline_output_max_chars: 12000,
  tail_max_chars: 12000,
  output_file_max_bytes: 8 * 1024 * 1024,
  progress_interval_ms: 500,
};

const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  file_edit_tool_style: "claude_code",
  auto_title: {
    enabled: false,
    only_when_default_title: true,
    max_title_length: 20,
  },
  duplicate_tool_call_guard: {
    enabled: true,
    max_repeats: 3,
  },
  context_compression: {
    enabled: true,
    context_window_tokens: 256000,
    trigger_fraction: 0.8,
  },
  a2ui: {
    enabled: true,
    debug_info_enabled: false,
  },
};

type ApprovalPolicy = "on_request" | "never_ask";
type RuntimeProbeMap = Partial<Record<CommandShell, CommandRuntimeProbeResponse>>;

interface ApprovalHistoryPage {
  list: CommandApprovalAuditRecord[];
  total: number;
  page: number;
  page_size: number;
}

const APPROVAL_POLICIES: Array<{
  value: ApprovalPolicy;
  label: string;
  preview: string;
  description: string;
}> = [
  {
    value: "on_request",
    label: "按请求",
    preview: "未信任命令执行前需要确认，可在审批时保存信任规则。",
    description: "未命中信任规则的命令会在执行前请求确认；审批时仍可选择以后信任相同命令或命令前缀。",
  },
  {
    value: "never_ask",
    label: "无条件信任",
    preview: "命令行工具直接执行，不弹出审批。",
    description: "智能体调用命令行工具时会直接执行命令。当前没有沙盒隔离，只适合你完全信任当前任务时使用。",
  },
];

const COMMAND_SHELLS: Array<{
  value: CommandShell;
  label: string;
  description: string;
}> = [
  { value: "git_bash", label: "Git Bash", description: "Git for Windows 的 bash.exe，不支持 WSL/MSYS2/Cygwin" },
  { value: "powershell", label: "PowerShell", description: "PowerShell 5.1/7+，适合对象管道和 .ps 语法" },
  { value: "cmd", label: "CMD", description: "Windows CMD，适合批处理和 cmd.exe 语法" },
];

const FILE_ACCESS_POLICIES: Array<{
  value: FileAccessMode;
  label: string;
  preview: string;
  description: string;
}> = [
  {
    value: "no_file_access",
    label: "无文件访问权限",
    preview: "Agent 不能引用、读取或修改本地文件。",
    description: "输入框禁用 @ 文件、目录和文件附件；后端文件工具会直接拒绝读写和搜索请求。",
  },
  {
    value: "workspace_read_only",
    label: "工作区内只读",
    preview: "Agent 只能读取当前工作区内文件。",
    description: "允许 @ 工作区文件、目录和工作区内附件；读取、目录和搜索工具可用，创建和编辑调用会返回权限错误。",
  },
  {
    value: "workspace_trusted",
    label: "工作区内信任",
    preview: "Agent 可以读写当前工作区。",
    description: "允许 @ 工作区文件、目录和工作区内附件；文件读写、搜索和编辑工具仅限当前工作区。",
  },
  {
    value: "full_access",
    label: "完全访问",
    preview: "Agent 可以使用用户显式引入的全局文件真实路径。",
    description: "允许附件选择工作区外文件并保留真实路径；文件工具可访问绝对路径，命令行仍按命令策略审批。",
  },
];

const FILE_EDIT_TOOL_STYLES: Array<{
  value: FileEditToolStyle;
  label: string;
  preview: string;
  description: string;
}> = [
  {
    value: "claude_code",
    label: "Claude Code 风格（推荐）",
    preview: "使用 create_file、edit_file、delete_file、move_file 四个简单文件工具。",
    description: "适合多供应商模型。编辑用 old_string/new_string 精确替换，删除和移动也会被文件变更 UI 追踪。",
  },
  {
    value: "codex",
    label: "Codex 风格",
    preview: "使用单个 apply_patch 工具处理新增、修改、删除和移动。",
    description: "适合熟悉 Codex apply_patch 语法的模型；新增文件使用 *** Add File，不再暴露 create_file。",
  },
];

export function ConfigSettingsPage({ runtime }: { runtime: RuntimeBridge }) {
  const notifications = useNotifications();
  const [command, setCommand] = useState<CommandSettings>(DEFAULT_COMMAND_SETTINGS);
  const [runtimeSettings, setRuntimeSettings] = useState<AgentRuntimeSettings>(DEFAULT_AGENT_RUNTIME_SETTINGS);
  const [rules, setRules] = useState<TrustedCommandRule[]>([]);
  const [rulesPage, setRulesPage] = useState(1);
  const [history, setHistory] = useState<ApprovalHistoryPage>(() => emptyApprovalHistoryPage());
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [refreshingRuntime, setRefreshingRuntime] = useState(false);
  const [manualShell, setManualShell] = useState<CommandShell | null>(null);
  const [manualError, setManualError] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [savingFileAccess, setSavingFileAccess] = useState(false);
  const [savingFileEditStyle, setSavingFileEditStyle] = useState(false);
  const [error, setError] = useState("");
  const [runtimeProbes, setRuntimeProbes] = useState<RuntimeProbeMap>({});

  const load = useCallback(async (historyPage = 1) => {
    setLoading(true);
    setError("");
    try {
      const [settings, extensionSettings, trustedRules, approvalHistory] = await Promise.all([
        runtime.settings.getSettings(),
        runtime.settings.getExtensionSettings(),
        runtime.settings.listTrustedCommandRules(),
        runtime.settings.listCommandApprovalHistory({ page: historyPage, pageSize: APPROVAL_HISTORY_PAGE_SIZE }),
      ]);
      setCommand(settings.command);
      setRuntimeSettings(extensionSettings);
      setRules(trustedRules);
      setHistory(approvalHistory);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentPolicy = useMemo(() => policyFromCommand(command), [command]);
  const currentPolicyOption = useMemo(
    () => APPROVAL_POLICIES.find((policy) => policy.value === currentPolicy) ?? APPROVAL_POLICIES[0],
    [currentPolicy],
  );
  const currentFileAccessOption = useMemo(
    () => FILE_ACCESS_POLICIES.find((policy) => policy.value === command.file_access_mode) ?? FILE_ACCESS_POLICIES[2],
    [command.file_access_mode],
  );
  const currentFileEditToolStyleOption = useMemo(
    () =>
      FILE_EDIT_TOOL_STYLES.find((style) => style.value === runtimeSettings.file_edit_tool_style) ??
      FILE_EDIT_TOOL_STYLES[0],
    [runtimeSettings.file_edit_tool_style],
  );
  const currentShellOption = useMemo(
    () => COMMAND_SHELLS.find((shell) => shell.value === command.selected_shell) ?? COMMAND_SHELLS[0],
    [command.selected_shell],
  );

  const saveCommandRuntime = async (nextCommand: CommandSettings, message: string) => {
    setSavingRuntime(true);
    setError("");
    try {
      const response = await runtime.settings.saveCommandSettings(nextCommand);
      setCommand(response.command);
      notifications.success(message);
      return response.command;
    } catch (reason) {
      setError(errorMessage(reason));
      return null;
    } finally {
      setSavingRuntime(false);
    }
  };

  const disableCommandRuntime = async () => {
    if (!command.command_enabled || savingRuntime || refreshingRuntime) {
      return;
    }
    await saveCommandRuntime({ ...command, command_enabled: false }, "命令行工具已关闭");
  };

  const refreshRuntimes = async (
    selectedShell: CommandShell,
    enable = command.command_enabled,
    options: { fallbackToPreferredAvailable?: boolean } = {},
  ) => {
    if (savingRuntime || refreshingRuntime) {
      return;
    }
    setRefreshingRuntime(true);
    setError("");
    setManualError("");
    try {
      const probes = await Promise.all(
        COMMAND_SHELLS.map(async (shell) => {
          try {
            return await runtime.settings.discoverCommandRuntime(shell.value);
          } catch (reason) {
            return {
              shell: shell.value,
              found: false,
              diagnostics: [],
              error: errorMessage(reason),
            } satisfies CommandRuntimeProbeResponse;
          }
        }),
      );
      const probeMap = Object.fromEntries(probes.map((probe) => [probe.shell, probe])) as RuntimeProbeMap;
      const targetShell =
        enable && options.fallbackToPreferredAvailable
          ? preferredAvailableShell(probes, selectedShell)
          : selectedShell;
      let nextCommand = {
        ...command,
        command_enabled: enable,
        selected_shell: targetShell,
      };
      for (const probe of probes) {
        nextCommand = commandWithProbe(nextCommand, probe);
      }
      nextCommand = syncSelectedShell(nextCommand, targetShell);
      setRuntimeProbes(probeMap);
      const saved = await saveCommandRuntime(
        nextCommand,
        enable ? "命令执行环境已更新" : "命令行工具已关闭",
      );
      const selectedConfig = saved ? shellConfig(saved, targetShell) : null;
      if (enable && saved && !(selectedConfig?.shell_path && selectedConfig.shell_label)) {
        setManualShell(targetShell);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRefreshingRuntime(false);
    }
  };

  const enableCommandRuntime = async () => {
    if (command.command_enabled || savingRuntime || refreshingRuntime) {
      return;
    }
    const selectedConfig = shellConfig(command, command.selected_shell);
    await refreshRuntimes(command.selected_shell, true, {
      fallbackToPreferredAvailable: !(selectedConfig.shell_path && selectedConfig.shell_label),
    });
  };

  const selectRuntimeShell = async (shell: CommandShell) => {
    await refreshRuntimes(shell, true);
  };

  const chooseManualRuntimePath = async (shell: CommandShell) => {
    if (!runtime.desktopPicker.isFilePickerAvailable()) {
      setManualError("当前环境不可用文件选择器，请确认已安装后从系统文件管理器定位 executable。");
      return;
    }
    setRefreshingRuntime(true);
    setError("");
    setManualError("");
    try {
      const [path] = await runtime.desktopPicker.pickFiles();
      if (!path) {
        return;
      }
      const probe = await runtime.settings.validateCommandRuntime(shell, path);
      setRuntimeProbes((items) => ({ ...items, [shell]: probe }));
      if (!probe.found || !probe.path || !probe.label) {
        setManualError(probe.error || "所选 executable 无法通过当前运行环境校验");
        return;
      }
      const nextCommand = syncSelectedShell(
        commandWithProbe(
          {
            ...command,
            command_enabled: true,
            selected_shell: shell,
          },
          probe,
        ),
        shell,
      );
      const saved = await saveCommandRuntime(nextCommand, "命令执行环境已保存");
      if (saved) {
        setManualShell(null);
      }
    } catch (reason) {
      setManualError(errorMessage(reason));
    } finally {
      setRefreshingRuntime(false);
    }
  };

  const updateApprovalPolicy = async (policy: ApprovalPolicy) => {
    if (policy === currentPolicy || savingPolicy) {
      return;
    }
    const nextCommand = commandFromPolicy(command, policy);
    setCommand(nextCommand);
    setSavingPolicy(true);
    setError("");
    try {
      const response = await runtime.settings.saveCommandSettings(nextCommand);
      setCommand(response.command);
      notifications.success("批准策略已保存");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSavingPolicy(false);
    }
  };

  const updateFileAccessMode = async (mode: FileAccessMode) => {
    if (mode === command.file_access_mode || savingFileAccess) {
      return;
    }
    const nextCommand = { ...command, file_access_mode: mode };
    setCommand(nextCommand);
    setSavingFileAccess(true);
    setError("");
    try {
      const response = await runtime.settings.saveCommandSettings(nextCommand);
      setCommand(response.command);
      notifications.success("文件访问权限已保存");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSavingFileAccess(false);
    }
  };

  const updateFileEditToolStyle = async (style: FileEditToolStyle) => {
    if (style === runtimeSettings.file_edit_tool_style || savingFileEditStyle) {
      return;
    }
    const nextSettings = { ...runtimeSettings, file_edit_tool_style: style };
    setRuntimeSettings(nextSettings);
    setSavingFileEditStyle(true);
    setError("");
    try {
      const response = await runtime.settings.saveExtensionSettings(nextSettings);
      setRuntimeSettings(response);
      notifications.success("文件编辑工具风格已保存");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSavingFileEditStyle(false);
    }
  };

  const toggleRule = async (rule: TrustedCommandRule) => {
    setError("");
    try {
      const updated = await runtime.settings.updateTrustedCommandRule(rule.id, !rule.enabled);
      setRules((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const deleteRule = async (rule: TrustedCommandRule) => {
    setError("");
    try {
      await runtime.settings.deleteTrustedCommandRule(rule.id);
      setRules((items) => items.filter((item) => item.id !== rule.id));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const sortedRules = useMemo(
    () => [...rules].sort((left, right) => right.created_at.localeCompare(left.created_at)),
    [rules],
  );
  const totalRulePages = Math.max(1, Math.ceil(sortedRules.length / TRUSTED_COMMAND_RULE_PAGE_SIZE));
  const trustedRulesPage = Math.min(Math.max(1, rulesPage), totalRulePages);
  const pagedRules = useMemo(() => {
    const start = (trustedRulesPage - 1) * TRUSTED_COMMAND_RULE_PAGE_SIZE;
    return sortedRules.slice(start, start + TRUSTED_COMMAND_RULE_PAGE_SIZE);
  }, [sortedRules, trustedRulesPage]);
  const canGoPrevRules = trustedRulesPage > 1;
  const canGoNextRules = trustedRulesPage < totalRulePages;
  const totalHistoryPages = Math.max(1, Math.ceil(history.total / history.page_size));
  const canGoPrevHistory = history.page > 1 && !historyLoading;
  const canGoNextHistory = history.page < totalHistoryPages && !historyLoading;

  useEffect(() => {
    if (rulesPage !== trustedRulesPage) {
      setRulesPage(trustedRulesPage);
    }
  }, [rulesPage, trustedRulesPage]);

  const loadHistoryPage = async (page: number) => {
    const nextPage = Math.min(Math.max(1, page), totalHistoryPages);
    if (nextPage === history.page || historyLoading) {
      return;
    }
    setHistoryLoading(true);
    setError("");
    try {
      const response = await runtime.settings.listCommandApprovalHistory({
        page: nextPage,
        pageSize: APPROVAL_HISTORY_PAGE_SIZE,
      });
      setHistory(response);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <div className={styles.page} data-settings-page data-testid="config-settings-page">
      <header className={styles.header} data-settings-header>
        <div>
          <h1>策略配置</h1>
          <p>管理审批策略和命令执行权限</p>
        </div>
        <button
          className={styles.iconButton}
          data-settings-icon-button
          type="button"
          aria-label="刷新策略配置"
          onClick={() => void load(history.page)}
        >
          <RefreshCcw size={16} />
        </button>
      </header>

      {error ? <div className={styles.error} data-settings-error>{error}</div> : null}
      {loading ? <div className={styles.loading} data-settings-muted>正在加载策略配置</div> : null}

      <section className={styles.settingsGroup} data-settings-group aria-labelledby="command-tools-title">
        <h2 data-settings-group-title id="command-tools-title">命令行工具</h2>
        <div className={styles.settingsPanel} data-settings-panel>
          <div className={styles.commandToggleBlock} data-settings-row>
            <div className={styles.policyText} data-settings-row-text>
              <h3>{command.command_enabled ? "已开启" : "已关闭"}</h3>
              <p>
                {command.command_enabled
                  ? `当前使用 ${currentShellOption.label}，Agent 只会获得对应命令工具。`
                  : "关闭后 Agent 不会获得任何命令行工具。"}
              </p>
            </div>
            <button
              className={styles.toggleButton}
              data-active={command.command_enabled ? "true" : "false"}
              disabled={savingRuntime || refreshingRuntime}
              type="button"
              onClick={() => void (command.command_enabled ? disableCommandRuntime() : enableCommandRuntime())}
            >
              <Power size={14} />
              {command.command_enabled ? "关闭命令行工具" : "开启命令行工具"}
            </button>
          </div>

          {command.command_enabled ? (
            <>
              <div className={styles.runtimeBlock} data-settings-row>
                <div className={styles.policyText} data-settings-row-text>
                  <h3>运行环境</h3>
                  <p>选择后会重新检测三个环境，已发现的 executable 会自动保存。</p>
                  <p className={styles.policyHint}>{currentShellOption.description}</p>
                </div>
                <div className={styles.shellCards} role="radiogroup" aria-label="命令执行环境">
                  {COMMAND_SHELLS.map((shell) => {
                    const state = shellCardState(command, runtimeProbes, shell.value, refreshingRuntime);
                    const config = shellConfig(command, shell.value);
                    const probe = runtimeProbes[shell.value];
                    const isActive = command.selected_shell === shell.value;
                    return (
                      <button
                        key={shell.value}
                        className={styles.shellCard}
                        type="button"
                        role="radio"
                        aria-label={shell.label}
                        aria-checked={isActive}
                        data-active={isActive ? "true" : "false"}
                        data-state={state}
                        disabled={savingRuntime || refreshingRuntime}
                        onClick={() => void selectRuntimeShell(shell.value)}
                      >
                        <span className={styles.shellCardTitle}>
                          <SquareTerminal size={14} />
                          <span>{shell.label}</span>
                        </span>
                        <span className={styles.shellCardStatus}>
                          {state === "checking" ? (
                            <RefreshCcw size={13} />
                          ) : state === "found" ? (
                            <CheckCircle2 size={13} />
                          ) : (
                            <AlertCircle size={13} />
                          )}
                          <span>{shellCardStatusText(state)}</span>
                        </span>
                        <span className={styles.shellCardPath}>
                          {state === "found" ? config.shell_path : probe?.error || "点击后可手动定位 executable"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className={styles.policyBlock} data-settings-row>
                <div className={styles.policyText} data-settings-row-text>
                  <h3>批准策略</h3>
                  <p>{savingPolicy ? "正在保存策略" : currentPolicyOption.preview}</p>
                  <p className={styles.policyHint}>{currentPolicyOption.description}</p>
                </div>
                <SettingsSelect
                  ariaLabel="批准策略"
                  disabled={loading || savingPolicy}
                  onChange={(policy) => void updateApprovalPolicy(policy)}
                  options={APPROVAL_POLICIES.map((policy) => ({
                    description: policy.preview,
                    label: policy.label,
                    value: policy.value,
                  }))}
                  value={currentPolicy}
                />
              </div>
            </>
          ) : null}
        </div>
      </section>

      <section className={styles.settingsGroup} data-settings-group aria-labelledby="file-access-title">
        <h2 data-settings-group-title id="file-access-title">文件访问权限</h2>
        <div className={styles.settingsPanel} data-settings-panel>
          <div className={styles.policyBlock} data-settings-row>
            <div className={styles.policyText} data-settings-row-text>
              <h3>访问范围</h3>
              <p>{savingFileAccess ? "正在保存权限" : currentFileAccessOption.preview}</p>
              <p className={styles.policyHint}>{currentFileAccessOption.description}</p>
            </div>
            <SettingsSelect
              ariaLabel="文件访问权限"
              disabled={loading || savingFileAccess}
              onChange={(mode) => void updateFileAccessMode(mode)}
              options={FILE_ACCESS_POLICIES.map((policy) => ({
                description: policy.preview,
                label: policy.label,
                value: policy.value,
              }))}
              value={command.file_access_mode}
            />
          </div>
          <div className={styles.policyBlock} data-settings-row>
            <div className={styles.policyText} data-settings-row-text>
              <h3>文件编辑工具风格</h3>
              <p>{savingFileEditStyle ? "正在保存工具风格" : currentFileEditToolStyleOption.preview}</p>
              <p className={styles.policyHint}>{currentFileEditToolStyleOption.description}</p>
            </div>
            <SettingsSelect
              ariaLabel="文件编辑工具风格"
              disabled={loading || savingFileEditStyle}
              onChange={(style) => void updateFileEditToolStyle(style)}
              options={FILE_EDIT_TOOL_STYLES.map((style) => ({
                description: style.preview,
                label: style.label,
                value: style.value,
              }))}
              value={runtimeSettings.file_edit_tool_style}
            />
          </div>
        </div>
      </section>

      {command.command_enabled ? (
        <>
          <section className={styles.settingsGroup} data-settings-group aria-labelledby="trusted-command-title">
            <div className={styles.groupHeader} data-settings-group-header>
              <h2 id="trusted-command-title">已信任命令</h2>
              <span>{sortedRules.length} 条</span>
            </div>
            <div className={styles.settingsPanel} data-settings-panel>
              <div className={styles.sectionHeader}>
                <span>命令</span>
                <span>匹配方式与状态</span>
                <span>操作</span>
              </div>
              {sortedRules.length ? (
                <div className={styles.ruleList}>
                  {pagedRules.map((rule) => (
                    <article className={styles.ruleRow} key={rule.id}>
                      <div className={styles.ruleMain}>
                        <code title={rule.command_pattern}>{rule.command_pattern}</code>
                        <span title={`${rule.tool_name || rule.shell} · ${rule.shell_path || rule.cwd_pattern}`}>
                          {[rule.tool_name || rule.shell, rule.shell_path].filter(Boolean).join(" · ") || rule.cwd_pattern}
                        </span>
                        <span title={rule.cwd_pattern}>{rule.cwd_pattern}</span>
                      </div>
                      <div className={styles.ruleMeta}>
                        <span>{rule.match_type === "exact" ? "精确" : "前缀"}</span>
                        <span>{rule.enabled ? "启用" : "禁用"}</span>
                      </div>
                      <div className={styles.rowActions}>
                        <button
                          aria-label={`${rule.enabled ? "禁用" : "启用"} ${rule.command_pattern}`}
                          data-settings-secondary
                          type="button"
                          onClick={() => void toggleRule(rule)}
                        >
                          {rule.enabled ? "禁用" : "启用"}
                        </button>
                        <button
                          aria-label={`删除 ${rule.command_pattern}`}
                          data-settings-secondary
                          type="button"
                          onClick={() => void deleteRule(rule)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className={styles.empty}>暂无已信任命令</div>
              )}
              {sortedRules.length > 0 ? (
                <div className={styles.pagination} aria-label="已信任命令分页">
                  <span>
                    第 {trustedRulesPage} / {totalRulePages} 页，共 {sortedRules.length} 条规则
                  </span>
                  <div>
                    <button
                      aria-label="上一页已信任命令"
                      data-settings-secondary
                      disabled={!canGoPrevRules}
                      type="button"
                      onClick={() => setRulesPage(trustedRulesPage - 1)}
                    >
                      上一页
                    </button>
                    <button
                      aria-label="下一页已信任命令"
                      data-settings-secondary
                      disabled={!canGoNextRules}
                      type="button"
                      onClick={() => setRulesPage(trustedRulesPage + 1)}
                    >
                      下一页
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section className={styles.settingsGroup} data-settings-group aria-labelledby="approval-history-title">
            <div className={styles.groupHeader} data-settings-group-header>
              <h2 id="approval-history-title">审批记录</h2>
              <span>{historyLoading ? "正在加载" : `${history.total} 条`}</span>
            </div>
            <div className={styles.settingsPanel} data-settings-panel>
              <div className={styles.sectionHeader}>
                <span>结果</span>
                <span>命令与目录</span>
                <span>来源</span>
              </div>
              {history.list.length ? (
                <div className={styles.historyList}>
                  {history.list.map((item) => (
                    <article className={styles.historyItem} data-decision={item.decision} key={item.id}>
                      <div className={styles.historyStatus}>
                        <span className={styles.decisionBadge} data-decision={item.decision}>
                          {decisionLabel(item.decision)}
                        </span>
                        <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                      </div>
                      <div className={styles.historyMain}>
                        <code title={item.command}>{item.command}</code>
                        <span title={item.cwd || "."}>{item.cwd || "."}</span>
                      </div>
                      <div className={styles.historyMeta} aria-label="审批记录元信息">
                        {item.trust_scope ? <span>{trustScopeLabel(item.trust_scope)}</span> : null}
                        {item.rule_match_type ? <span>{ruleMatchLabel(item.rule_match_type)}</span> : null}
                        {item.trusted_rule_id ? <span>已关联规则</span> : null}
                      </div>
                      {item.reject_message ? <p className={styles.historyReason}>拒绝原因：{item.reject_message}</p> : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className={styles.empty}>暂无审批记录</div>
              )}
              {history.total > 0 ? (
                <div className={styles.pagination} aria-label="审批记录分页">
                  <span>
                    第 {history.page} / {totalHistoryPages} 页，共 {history.total} 条
                  </span>
                  <div>
                    <button
                      aria-label="上一页审批记录"
                      data-settings-secondary
                      disabled={!canGoPrevHistory}
                      type="button"
                      onClick={() => void loadHistoryPage(history.page - 1)}
                    >
                      上一页
                    </button>
                    <button
                      aria-label="下一页审批记录"
                      data-settings-secondary
                      disabled={!canGoNextHistory}
                      type="button"
                      onClick={() => void loadHistoryPage(history.page + 1)}
                    >
                      下一页
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </>
      ) : null}

      {manualShell ? (
        <div className={styles.modalBackdrop} role="presentation">
          <div
            className={styles.manualRuntimeDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-runtime-title"
          >
            <header>
              <div>
                <h2 id="manual-runtime-title">定位 {shellOptionLabel(manualShell)} executable</h2>
                <p>未找到 {shellOptionLabel(manualShell)}。如果尚未安装，请先安装后再选择对应 executable。</p>
              </div>
              <button
                type="button"
                aria-label="关闭手动定位"
                disabled={refreshingRuntime}
                onClick={() => {
                  setManualShell(null);
                  setManualError("");
                }}
              >
                <X size={15} />
              </button>
            </header>
            <div className={styles.manualRuntimeBody}>
              <p>{manualRuntimeHint(manualShell)}</p>
              {manualError ? <div className={styles.manualRuntimeError}>{manualError}</div> : null}
            </div>
            <footer>
              <button
                type="button"
                data-settings-secondary
                disabled={refreshingRuntime}
                onClick={() => {
                  setManualShell(null);
                  setManualError("");
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-settings-primary
                disabled={refreshingRuntime}
                onClick={() => void chooseManualRuntimePath(manualShell)}
              >
                <FileSearch size={14} />
                选择 executable
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function decisionLabel(value: CommandApprovalAuditRecord["decision"]): string {
  return value === "approved" ? "已允许" : "已拒绝";
}

function trustScopeLabel(value: NonNullable<CommandApprovalAuditRecord["trust_scope"]>): string {
  switch (value) {
    case "persistent":
      return "已保存信任";
    case "session":
      return "本会话信任";
    case "persistent_tool":
      return "已信任工具";
    case "persistent_server":
      return "已信任 MCP 服务器";
    case "once":
    default:
      return "仅本次";
  }
}

function ruleMatchLabel(value: NonNullable<CommandApprovalAuditRecord["rule_match_type"]>): string {
  return value === "exact" ? "精确匹配" : "前缀匹配";
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "策略配置操作失败";
}

function emptyApprovalHistoryPage(page = 1): ApprovalHistoryPage {
  return {
    list: [],
    total: 0,
    page,
    page_size: APPROVAL_HISTORY_PAGE_SIZE,
  };
}

function policyFromCommand(command: CommandSettings): ApprovalPolicy {
  if (!command.require_approval_for_untrusted) {
    return "never_ask";
  }
  return "on_request";
}

function commandFromPolicy(command: CommandSettings, policy: ApprovalPolicy): CommandSettings {
  if (policy === "never_ask") {
    return {
      ...command,
      require_approval_for_untrusted: false,
      allow_persistent_trust: false,
    };
  }
  return {
    ...command,
    require_approval_for_untrusted: true,
    allow_persistent_trust: true,
  };
}

function shellConfig(command: CommandSettings, shell: CommandShell): CommandShellConfig {
  const fromMap = command.shells?.[shell];
  if (fromMap?.shell_path && fromMap.shell_label) {
    return fromMap;
  }
  if (shell === command.selected_shell && command.shell_path && command.shell_label) {
    return {
      shell_path: command.shell_path,
      shell_label: command.shell_label,
      shell_edition: command.shell_edition ?? null,
      shell_version: command.shell_version ?? null,
    };
  }
  return { shell_path: "", shell_label: "", shell_edition: null, shell_version: null };
}

function commandWithProbe(command: CommandSettings, probe: CommandRuntimeProbeResponse): CommandSettings {
  const shells = { ...(command.shells ?? {}) };
  if (probe.found && probe.path && probe.label) {
    shells[probe.shell] = {
      shell_path: probe.path,
      shell_label: probe.label,
      shell_edition: probe.edition ?? null,
      shell_version: probe.version ?? null,
    };
  } else {
    delete shells[probe.shell];
  }
  const nextCommand =
    probe.shell === command.selected_shell && !(probe.found && probe.path && probe.label)
      ? {
          ...command,
          shell_path: "",
          shell_label: "",
          shell_edition: null,
          shell_version: null,
          shells,
        }
      : { ...command, shells };
  return syncSelectedShell(nextCommand, command.selected_shell);
}

function preferredAvailableShell(
  probes: CommandRuntimeProbeResponse[],
  fallback: CommandShell,
): CommandShell {
  const availableShells = new Set(
    probes
      .filter((probe) => probe.found && probe.path && probe.label)
      .map((probe) => probe.shell),
  );
  return COMMAND_SHELLS.find((shell) => availableShells.has(shell.value))?.value ?? fallback;
}

function syncSelectedShell(command: CommandSettings, selectedShell: CommandShell): CommandSettings {
  const fromMap = command.shells?.[selectedShell];
  const selected =
    fromMap?.shell_path && fromMap.shell_label
      ? fromMap
      : command.selected_shell === selectedShell && command.shell_path && command.shell_label
        ? {
            shell_path: command.shell_path,
            shell_label: command.shell_label,
            shell_edition: command.shell_edition ?? null,
            shell_version: command.shell_version ?? null,
          }
        : { shell_path: "", shell_label: "", shell_edition: null, shell_version: null };
  return {
    ...command,
    selected_shell: selectedShell,
    shell_path: selected.shell_path,
    shell_label: selected.shell_label,
    shell_edition: selected.shell_edition ?? null,
    shell_version: selected.shell_version ?? null,
  };
}

function shellCardState(
  command: CommandSettings,
  probes: RuntimeProbeMap,
  shell: CommandShell,
  refreshing: boolean,
): "checking" | "found" | "missing" {
  if (refreshing) {
    return "checking";
  }
  const probe = probes[shell];
  if (probe) {
    return probe.found ? "found" : "missing";
  }
  const config = shellConfig(command, shell);
  return config.shell_path && config.shell_label ? "found" : "missing";
}

function shellCardStatusText(state: "checking" | "found" | "missing"): string {
  if (state === "checking") {
    return "检测中";
  }
  return state === "found" ? "已发现" : "未找到";
}

function shellOptionLabel(shell: CommandShell): string {
  return COMMAND_SHELLS.find((item) => item.value === shell)?.label ?? shell;
}

function manualRuntimeHint(shell: CommandShell): string {
  if (shell === "git_bash") {
    return "请选择 Git for Windows 安装目录下的 bin\\bash.exe 或 usr\\bin\\bash.exe。";
  }
  if (shell === "cmd") {
    return "请选择 Windows System32 目录下的 cmd.exe。";
  }
  return "请选择 pwsh.exe 或 WindowsPowerShell\\v1.0\\powershell.exe。";
}
