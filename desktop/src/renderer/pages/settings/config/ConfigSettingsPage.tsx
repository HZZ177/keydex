import { Check, ChevronDown, RefreshCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { RuntimeBridge } from "@/runtime";
import type { CommandApprovalAuditRecord, CommandSettings, FileAccessMode, TrustedCommandRule } from "@/types/protocol";

import styles from "./ConfigSettingsPage.module.css";

const APPROVAL_HISTORY_PAGE_SIZE = 10;

const DEFAULT_COMMAND_SETTINGS: CommandSettings = {
  command_enabled: true,
  require_approval_for_untrusted: true,
  allow_persistent_trust: true,
  file_access_mode: "workspace_trusted",
  default_timeout_seconds: 120,
  max_timeout_seconds: 600,
  max_output_chars: 65536,
};

type ApprovalPolicy = "on_request" | "never_ask" | "disabled";

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
  {
    value: "disabled",
    label: "关闭命令行工具",
    preview: "智能体不能调用命令行。",
    description: "命令行工具会返回已关闭结果，不会执行 shell 命令。",
  },
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
    description: "输入框禁用 @ 文件和文件附件；后端文件工具会直接拒绝读写和搜索请求。",
  },
  {
    value: "workspace_read_only",
    label: "工作区内只读",
    preview: "Agent 只能读取当前工作区内文件。",
    description: "允许 @ 工作区文件和工作区内附件；读取、目录和搜索工具可用，创建和编辑调用会返回权限错误。",
  },
  {
    value: "workspace_trusted",
    label: "工作区内信任",
    preview: "Agent 可以读写当前工作区。",
    description: "允许 @ 工作区文件和工作区内附件；文件读写、搜索和编辑工具仅限当前工作区。",
  },
  {
    value: "full_access",
    label: "完全访问",
    preview: "Agent 可以使用用户显式引入的全局文件真实路径。",
    description: "允许附件选择工作区外文件并保留真实路径；文件工具可访问绝对路径，命令行仍按命令策略审批。",
  },
];

export function ConfigSettingsPage({ runtime }: { runtime: RuntimeBridge }) {
  const notifications = useNotifications();
  const [command, setCommand] = useState<CommandSettings>(DEFAULT_COMMAND_SETTINGS);
  const [rules, setRules] = useState<TrustedCommandRule[]>([]);
  const [history, setHistory] = useState<ApprovalHistoryPage>(() => emptyApprovalHistoryPage());
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [savingFileAccess, setSavingFileAccess] = useState(false);
  const [policyMenuOpen, setPolicyMenuOpen] = useState(false);
  const [fileAccessMenuOpen, setFileAccessMenuOpen] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (historyPage = 1) => {
    setLoading(true);
    setError("");
    try {
      const [settings, trustedRules, approvalHistory] = await Promise.all([
        runtime.settings.getSettings(),
        runtime.settings.listTrustedCommandRules(),
        runtime.settings.listCommandApprovalHistory({ page: historyPage, pageSize: APPROVAL_HISTORY_PAGE_SIZE }),
      ]);
      setCommand(settings.command);
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

  const updateApprovalPolicy = async (policy: ApprovalPolicy) => {
    setPolicyMenuOpen(false);
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
    setFileAccessMenuOpen(false);
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
  const totalHistoryPages = Math.max(1, Math.ceil(history.total / history.page_size));
  const canGoPrevHistory = history.page > 1 && !historyLoading;
  const canGoNextHistory = history.page < totalHistoryPages && !historyLoading;

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
    <div className={styles.page} data-testid="config-settings-page">
      <header className={styles.header}>
        <div>
          <h1>策略配置</h1>
          <p>管理审批策略和命令执行权限</p>
        </div>
        <button
          className={styles.iconButton}
          type="button"
          aria-label="刷新策略配置"
          onClick={() => void load(history.page)}
        >
          <RefreshCcw size={16} />
        </button>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}
      {loading ? <div className={styles.loading}>正在加载策略配置</div> : null}

      <section className={`${styles.settingsGroup} ${styles.policyGroup}`} aria-labelledby="command-tools-title">
        <h2 id="command-tools-title">命令行工具</h2>
        <div className={styles.settingsPanel}>
          <div className={styles.policyBlock}>
            <div className={styles.policyText}>
              <h3>批准策略</h3>
              <p>{savingPolicy ? "正在保存策略" : currentPolicyOption.preview}</p>
              <p className={styles.policyHint}>{currentPolicyOption.description}</p>
            </div>
            <div
              className={styles.policyMenu}
              data-open={policyMenuOpen ? "true" : "false"}
              onBlur={(event) => {
                const nextTarget = event.relatedTarget;
                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                  setPolicyMenuOpen(false);
                }
              }}
            >
              <button
                aria-expanded={policyMenuOpen}
                aria-haspopup="listbox"
                aria-label={`批准策略：${currentPolicyOption.label}`}
                className={styles.policyTrigger}
                disabled={loading || savingPolicy}
                type="button"
                onClick={() => setPolicyMenuOpen((open) => !open)}
              >
                <span className={styles.policyTriggerText}>
                  <strong>{currentPolicyOption.label}</strong>
                </span>
                <ChevronDown aria-hidden="true" data-open={policyMenuOpen ? "true" : "false"} size={16} />
              </button>
              {policyMenuOpen ? (
                <div className={styles.policyDropdown} role="listbox" aria-label="批准策略选项">
                  {APPROVAL_POLICIES.map((policy) => (
                    <button
                      aria-selected={policy.value === currentPolicy}
                      className={styles.policyOption}
                      data-active={policy.value === currentPolicy ? "true" : "false"}
                      key={policy.value}
                      role="option"
                      type="button"
                      onClick={() => void updateApprovalPolicy(policy.value)}
                    >
                      <span>
                        <strong>{policy.label}</strong>
                        <small>{policy.preview}</small>
                      </span>
                      {policy.value === currentPolicy ? <Check aria-hidden="true" size={15} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className={styles.policyBlock}>
            <div className={styles.policyText}>
              <h3>文件访问权限</h3>
              <p>{savingFileAccess ? "正在保存权限" : currentFileAccessOption.preview}</p>
              <p className={styles.policyHint}>{currentFileAccessOption.description}</p>
            </div>
            <div
              className={styles.policyMenu}
              data-open={fileAccessMenuOpen ? "true" : "false"}
              onBlur={(event) => {
                const nextTarget = event.relatedTarget;
                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                  setFileAccessMenuOpen(false);
                }
              }}
            >
              <button
                aria-expanded={fileAccessMenuOpen}
                aria-haspopup="listbox"
                aria-label={`文件访问权限：${currentFileAccessOption.label}`}
                className={styles.policyTrigger}
                disabled={loading || savingFileAccess}
                type="button"
                onClick={() => setFileAccessMenuOpen((open) => !open)}
              >
                <span className={styles.policyTriggerText}>
                  <strong>{currentFileAccessOption.label}</strong>
                </span>
                <ChevronDown aria-hidden="true" data-open={fileAccessMenuOpen ? "true" : "false"} size={16} />
              </button>
              {fileAccessMenuOpen ? (
                <div className={styles.policyDropdown} role="listbox" aria-label="文件访问权限选项">
                  {FILE_ACCESS_POLICIES.map((policy) => (
                    <button
                      aria-selected={policy.value === command.file_access_mode}
                      className={styles.policyOption}
                      data-active={policy.value === command.file_access_mode ? "true" : "false"}
                      key={policy.value}
                      role="option"
                      type="button"
                      onClick={() => void updateFileAccessMode(policy.value)}
                    >
                      <span>
                        <strong>{policy.label}</strong>
                        <small>{policy.preview}</small>
                      </span>
                      {policy.value === command.file_access_mode ? <Check aria-hidden="true" size={15} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.settingsGroup} aria-labelledby="trusted-command-title">
        <div className={styles.groupHeader}>
          <h2 id="trusted-command-title">已信任命令</h2>
          <span>{sortedRules.length} 条</span>
        </div>
        <div className={styles.settingsPanel}>
          <div className={styles.sectionHeader}>
            <span>命令</span>
            <span>匹配方式与状态</span>
            <span>操作</span>
          </div>
          {sortedRules.length ? (
            <div className={styles.ruleList}>
              {sortedRules.map((rule) => (
                <article className={styles.ruleRow} key={rule.id}>
                  <div className={styles.ruleMain}>
                    <code title={rule.command_pattern}>{rule.command_pattern}</code>
                    <span title={rule.cwd_pattern}>{rule.cwd_pattern}</span>
                  </div>
                  <div className={styles.ruleMeta}>
                    <span>{rule.match_type === "exact" ? "精确" : "前缀"}</span>
                    <span>{rule.enabled ? "启用" : "禁用"}</span>
                  </div>
                  <div className={styles.rowActions}>
                    <button
                      aria-label={`${rule.enabled ? "禁用" : "启用"} ${rule.command_pattern}`}
                      type="button"
                      onClick={() => void toggleRule(rule)}
                    >
                      {rule.enabled ? "禁用" : "启用"}
                    </button>
                    <button
                      aria-label={`删除 ${rule.command_pattern}`}
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
        </div>
      </section>

      <section className={styles.settingsGroup} aria-labelledby="approval-history-title">
        <div className={styles.groupHeader}>
          <h2 id="approval-history-title">审批记录</h2>
          <span>{historyLoading ? "正在加载" : `${history.total} 条`}</span>
        </div>
        <div className={styles.settingsPanel}>
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
                  disabled={!canGoPrevHistory}
                  type="button"
                  onClick={() => void loadHistoryPage(history.page - 1)}
                >
                  上一页
                </button>
                <button
                  aria-label="下一页审批记录"
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
  return value === "persistent" ? "已保存信任" : "仅本次";
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
  if (!command.command_enabled) {
    return "disabled";
  }
  if (!command.require_approval_for_untrusted) {
    return "never_ask";
  }
  return "on_request";
}

function commandFromPolicy(command: CommandSettings, policy: ApprovalPolicy): CommandSettings {
  if (policy === "disabled") {
    return {
      ...command,
      command_enabled: false,
      require_approval_for_untrusted: true,
      allow_persistent_trust: false,
    };
  }
  if (policy === "never_ask") {
    return {
      ...command,
      command_enabled: true,
      require_approval_for_untrusted: false,
      allow_persistent_trust: false,
    };
  }
  return {
    ...command,
    command_enabled: true,
    require_approval_for_untrusted: true,
    allow_persistent_trust: true,
  };
}
