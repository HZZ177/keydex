import { Check, ChevronDown, RefreshCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import type { CommandApprovalAuditRecord, CommandSettings, TrustedCommandRule } from "@/types/protocol";

import styles from "./ConfigSettingsPage.module.css";

const APPROVAL_HISTORY_PAGE_SIZE = 30;

const DEFAULT_COMMAND_SETTINGS: CommandSettings = {
  command_enabled: true,
  require_approval_for_untrusted: true,
  allow_persistent_trust: true,
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

export function ConfigSettingsPage({ runtime }: { runtime: RuntimeBridge }) {
  const [command, setCommand] = useState<CommandSettings>(DEFAULT_COMMAND_SETTINGS);
  const [rules, setRules] = useState<TrustedCommandRule[]>([]);
  const [history, setHistory] = useState<ApprovalHistoryPage>(() => emptyApprovalHistoryPage());
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyMenuOpen, setPolicyMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
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

  const updateApprovalPolicy = async (policy: ApprovalPolicy) => {
    setPolicyMenuOpen(false);
    const nextCommand = commandFromPolicy(command, policy);
    setCommand(nextCommand);
    setSavingPolicy(true);
    setError("");
    setMessage("");
    try {
      const response = await runtime.settings.saveCommandSettings(nextCommand);
      setCommand(response.command);
      setMessage("批准策略已保存");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSavingPolicy(false);
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
          <h1>配置</h1>
        </div>
        <button className={styles.iconButton} type="button" aria-label="刷新配置" onClick={() => void load(history.page)}>
          <RefreshCcw size={16} />
        </button>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}
      {message ? <div className={styles.success}>{message}</div> : null}
      {loading ? <div className={styles.loading}>正在加载配置</div> : null}

      <section className={styles.approvalBox} aria-label="命令行工具配置">
        <div className={styles.approvalHeader}>
          <div>
            <h2>命令行工具</h2>
            <p>配置命令执行审批策略、已信任命令和审批记录。</p>
          </div>
        </div>

        <div className={styles.policyBlock}>
          <div className={styles.policyRow}>
            <div className={styles.policyText}>
              <h3>批准策略</h3>
              <p>选择智能体何时请求批准。</p>
            </div>
            <div
              className={styles.policyMenu}
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
                  <span>{currentPolicyOption.preview}</span>
                </span>
                <ChevronDown aria-hidden="true" data-open={policyMenuOpen} size={16} />
              </button>
              {policyMenuOpen ? (
                <div className={styles.policyDropdown} role="listbox" aria-label="批准策略选项">
                  {APPROVAL_POLICIES.map((policy) => (
                    <button
                      aria-selected={policy.value === currentPolicy}
                      className={styles.policyOption}
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
          <div className={styles.policyHint}>{savingPolicy ? "正在保存策略" : currentPolicyOption.description}</div>
        </div>

        <section className={styles.subsection}>
          <div className={styles.sectionHeader}>
            <h2>已信任命令</h2>
          </div>
          {sortedRules.length ? (
            <div className={styles.table}>
              <div className={styles.tableHeader}>
                <span>命令</span>
                <span>匹配</span>
                <span>目录</span>
                <span>状态</span>
                <span>操作</span>
              </div>
              {sortedRules.map((rule) => (
                <div className={styles.tableRow} key={rule.id}>
                  <code title={rule.command_pattern}>{rule.command_pattern}</code>
                  <span>{rule.match_type === "exact" ? "精确" : "前缀"}</span>
                  <span title={rule.cwd_pattern}>{rule.cwd_pattern}</span>
                  <span>{rule.enabled ? "启用" : "禁用"}</span>
                  <span className={styles.rowActions}>
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
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>暂无已信任命令</div>
          )}
        </section>

        <section className={styles.subsection}>
          <div className={styles.sectionHeader}>
            <h2>审批记录</h2>
            {historyLoading ? <span className={styles.inlineStatus}>正在加载</span> : null}
          </div>
          {history.list.length ? (
            <div className={styles.historyList}>
              {history.list.map((item) => (
                <article className={styles.historyItem} key={item.id}>
                  <div>
                    <strong>{item.decision === "approved" ? "已允许" : "已拒绝"}</strong>
                    <code>{item.command}</code>
                  </div>
                  <div>
                    <span>{item.cwd || "."}</span>
                    <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                  </div>
                  {item.reject_message ? <p>{item.reject_message}</p> : null}
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
        </section>
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

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "配置操作失败";
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
