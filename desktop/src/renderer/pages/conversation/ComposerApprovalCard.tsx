import { ArrowUpDown, CornerDownLeft, PencilLine, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CommandApprovalDecisionPayload,
  CommandApprovalRequest,
  CommandApprovalTrustScope,
  TrustedCommandRuleMatchType,
} from "@/types/protocol";

import styles from "./ComposerApprovalCard.module.css";
import { useDeferredUnmount } from "./messages/useDeferredUnmount";

export interface ComposerApprovalCardProps {
  approval: CommandApprovalRequest;
  allowPersistentTrust: boolean;
  submitting?: boolean;
  error?: string | null;
  onSubmit: (decision: CommandApprovalDecisionPayload) => Promise<void> | void;
}

type ApprovalChoice =
  | "approve_once"
  | "approve_exact"
  | "approve_prefix"
  | "approve_session"
  | "approve_persistent_tool"
  | "approve_persistent_server"
  | "reject";

interface ApprovalChoiceOption {
  id: ApprovalChoice;
  label: string;
  title: string;
}

const REJECT_TEXTAREA_MIN_HEIGHT = 22;
const REJECT_TEXTAREA_MAX_HEIGHT = 108;
const GENERIC_COMMAND_APPROVAL_DESCRIPTIONS = new Set([
  "命令将在当前工作区执行。",
  "命令会在当前工作区执行。",
  "这个命令将在当前工作区执行。",
]);

export function ComposerApprovalCard({
  approval,
  allowPersistentTrust,
  submitting = false,
  error = null,
  onSubmit,
}: ComposerApprovalCardProps) {
  const [selectedChoice, setSelectedChoice] = useState<ApprovalChoice>("approve_once");
  const [rejectMessage, setRejectMessage] = useState("");
  const [commandExpanded, setCommandExpanded] = useState(false);
  const [commandRenderExpanded, setCommandRenderExpanded] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const commandRafRef = useRef<number | null>(null);
  const commandCollapseTimerRef = useRef<number | null>(null);
  const rejectTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rejectMotion = useDeferredUnmount<HTMLSpanElement>(selectedChoice === "reject", 180, 220);
  const mcpToolApproval = isMcpToolApproval(approval);
  const mcpSamplingApproval = isMcpSamplingApproval(approval);
  const mcpApproval = mcpToolApproval || mcpSamplingApproval;
  const command = mcpToolApproval
    ? mcpArgumentsPreview(approval)
    : mcpSamplingApproval
      ? mcpSamplingPreview(approval)
      : stringValue(approval.details.command);
  const cwd = mcpToolApproval
    ? mcpTargetLabel(approval)
    : mcpSamplingApproval
      ? mcpSamplingTargetLabel(approval)
      : meaningfulCwd(approval.details.cwd);
  const exactRule = stringValue(approval.details.suggested_exact_rule) || command;
  const prefixRule = stringValue(approval.details.suggested_prefix_rule) || command;
  const description = meaningfulDescription(approval.description);
  const persistentActions = useMemo(
    () => [
      {
        label: "是，且以后相同命令不再询问",
        matchType: "exact" as TrustedCommandRuleMatchType,
        hint: exactRule,
      },
      {
        label: "是，且以后以该前缀开头的命令不再询问",
        matchType: "prefix" as TrustedCommandRuleMatchType,
        hint: prefixRule,
      },
    ],
    [exactRule, prefixRule],
  );
  const choices = useMemo<ApprovalChoiceOption[]>(
    () =>
      mcpApproval
        ? mcpSamplingApproval
          ? mcpSamplingApprovalChoices()
          : mcpApprovalChoices(mcpTrustOptions(approval))
        : [
            {
              id: "approve_once",
              label: "是",
              title: "",
            },
            ...(allowPersistentTrust
              ? persistentActions.map((action) => ({
                  id: action.matchType === "exact" ? ("approve_exact" as const) : ("approve_prefix" as const),
                  label: action.label,
                  title: action.hint,
                }))
              : []),
            {
              id: "reject",
              label: "否，请告知智能体如何调整",
              title: "",
            },
          ],
    [allowPersistentTrust, approval, mcpApproval, mcpSamplingApproval, persistentActions],
  );

  const clearCommandAnimationTimers = useCallback(() => {
    if (commandRafRef.current !== null) {
      window.cancelAnimationFrame(commandRafRef.current);
      commandRafRef.current = null;
    }
    if (commandCollapseTimerRef.current !== null) {
      window.clearTimeout(commandCollapseTimerRef.current);
      commandCollapseTimerRef.current = null;
    }
  }, []);
  const submit = () => {
    if (submitting) {
      return;
    }
    void onSubmit(decisionFromChoice(selectedChoice, rejectMessage));
  };
  const skip = () => {
    if (submitting) {
      return;
    }
    void onSubmit({ decision: "rejected", trust_scope: "once" });
  };
  const selectChoice = (choice: ApprovalChoice) => {
    if (!submitting) {
      setSelectedChoice(choice);
    }
  };
  const moveSelectedChoice = useCallback((direction: -1 | 1) => {
    if (submitting) {
      return;
    }
    const currentIndex = choices.findIndex((choice) => choice.id === selectedChoice);
    const nextIndex = (currentIndex + direction + choices.length) % choices.length;
    const nextChoiceId = choices[nextIndex].id;
    setSelectedChoice(nextChoiceId);
    window.requestAnimationFrame(() => {
      if (nextChoiceId === "reject") {
        focusRejectTextarea(rejectTextareaRef.current);
        return;
      }
      cardRef.current?.querySelector<HTMLElement>(`[data-approval-choice="${nextChoiceId}"]`)?.focus();
    });
  }, [choices, selectedChoice, submitting]);
  const commandLines = command.split(/\r?\n/);
  const commandIsLong = commandLines.length > 3 || command.length > 220;
  const commandText = command || "未提供命令";
  const collapsedCommand =
    commandLines.length > 3
      ? `${commandLines.slice(0, 3).join("\n")}\n...`
      : commandText.length > 220
        ? `${commandText.slice(0, 220)}...`
        : commandText;
  const commandPreview = commandRenderExpanded || !commandIsLong ? commandText : collapsedCommand;
  const toggleCommandExpanded = useCallback(() => {
    if (!commandIsLong) {
      return;
    }
    clearCommandAnimationTimers();
    if (commandExpanded) {
      setCommandExpanded(false);
      commandCollapseTimerRef.current = window.setTimeout(() => {
        commandCollapseTimerRef.current = null;
        setCommandRenderExpanded(false);
      }, 220);
      return;
    }
    setCommandRenderExpanded(true);
    commandRafRef.current = window.requestAnimationFrame(() => {
      commandRafRef.current = null;
      setCommandExpanded(true);
    });
  }, [clearCommandAnimationTimers, commandExpanded, commandIsLong]);

  useEffect(() => {
    if (selectedChoice === "reject") {
      resizeRejectTextarea(rejectTextareaRef.current);
    }
  }, [rejectMessage, selectedChoice]);

  useEffect(() => {
    clearCommandAnimationTimers();
    setCommandExpanded(false);
    setCommandRenderExpanded(false);
  }, [clearCommandAnimationTimers, commandText]);

  useEffect(() => clearCommandAnimationTimers, [clearCommandAnimationTimers]);

  useEffect(() => {
    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSelectedChoice(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSelectedChoice(-1);
      }
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [moveSelectedChoice]);

  return (
    <section
      className={styles.card}
      aria-label={mcpSamplingApproval ? "MCP 模型请求确认" : mcpToolApproval ? "MCP 工具确认" : "命令执行确认"}
      data-testid="composer-approval-card"
      ref={cardRef}
    >
      <header className={styles.header}>
        <span className={styles.approvalIcon} aria-hidden="true">
          <ShieldCheck size={15} strokeWidth={2.2} />
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.title}>{approvalTitle(approval.title, mcpSamplingApproval) || "是否允许执行命令？"}</div>
          {description ? <div className={styles.description}>{description}</div> : null}
        </div>
      </header>

      <div className={styles.commandPanel}>
        {cwd ? (
          <div className={styles.meta} data-testid="composer-approval-cwd" title={cwd}>
            {cwd}
          </div>
        ) : null}
        <pre
          className={styles.command}
          data-expanded={commandExpanded ? "true" : "false"}
          data-testid="composer-approval-command"
          tabIndex={commandExpanded && commandIsLong ? 0 : undefined}
        >
          {commandPreview}
        </pre>
        {commandIsLong ? (
          <button className={styles.expandButton} type="button" onClick={toggleCommandExpanded}>
            {commandExpanded ? "收起" : "展开"}
          </button>
        ) : null}
      </div>

      <div
        className={styles.actions}
        role="radiogroup"
        aria-label={mcpSamplingApproval ? "MCP 模型请求确认选项" : mcpToolApproval ? "MCP 工具确认选项" : "命令确认选项"}
      >
        {choices.map((choice, index) => {
          const selected = choice.id === selectedChoice;
          if (choice.id === "reject") {
            return (
              <div
                aria-checked={selected}
                aria-disabled={submitting ? "true" : undefined}
                aria-label={choice.label}
                className={styles.choice}
                data-selected={selected ? "true" : "false"}
                data-tone="danger"
                data-approval-choice={choice.id}
                key={choice.id}
                role="radio"
                tabIndex={submitting ? -1 : 0}
                onClick={() => selectChoice(choice.id)}
                onKeyDown={(event) => {
                  if (event.target instanceof HTMLTextAreaElement) {
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (selected) {
                      submit();
                    } else {
                      selectChoice(choice.id);
                    }
                  } else if (event.key === " ") {
                    event.preventDefault();
                    selectChoice(choice.id);
                  }
                }}
              >
                <span className={styles.choiceMark} aria-hidden="true">
                  <PencilLine size={12} />
                </span>
                <span className={styles.choiceText}>
                  {rejectMotion.shouldRender ? (
                    <span
                      className={styles.rejectInlinePanel}
                      data-motion={rejectMotion.phase}
                      data-testid="composer-approval-reject-panel"
                      ref={rejectMotion.ref}
                      style={rejectMotion.style}
                    >
                      <textarea
                        autoFocus={selected}
                        disabled={submitting || !selected}
                        onChange={(event) => {
                          setRejectMessage(event.target.value);
                          resizeRejectTextarea(event.currentTarget);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            submit();
                          }
                        }}
                        placeholder="告诉智能体如何调整"
                        ref={rejectTextareaRef}
                        rows={1}
                        value={rejectMessage}
                      />
                    </span>
                  ) : (
                    <span className={styles.choiceLabel}>{choice.label}</span>
                  )}
                </span>
                <span className={styles.choiceTrailing} aria-hidden="true">
                  {selected ? <ChoiceKeyHint /> : null}
                </span>
              </div>
            );
          }
          return (
            <button
              aria-checked={selected}
              aria-label={choice.label}
              className={styles.choice}
              data-selected={selected ? "true" : "false"}
              data-tone="default"
              data-approval-choice={choice.id}
              disabled={submitting}
              key={choice.id}
              role="radio"
              title={choice.title || undefined}
              type="button"
              onClick={() => selectChoice(choice.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (selected) {
                    submit();
                  } else {
                    selectChoice(choice.id);
                  }
                } else if (event.key === " ") {
                  event.preventDefault();
                  selectChoice(choice.id);
                }
              }}
            >
              <span className={styles.choiceMark} aria-hidden="true">
                {index + 1}
              </span>
              <span className={styles.choiceText}>
                <span className={styles.choiceLabel}>{choice.label}</span>
              </span>
              <span className={styles.choiceTrailing} aria-hidden="true">
                {selected ? <ChoiceKeyHint /> : null}
              </span>
            </button>
          );
        })}
      </div>

      <footer className={styles.footer}>
        {error ? <span className={styles.error}>{error}</span> : <span />}
        <span className={styles.footerActions}>
          <button className={styles.skipAction} disabled={submitting} type="button" onClick={skip}>
            跳过
          </button>
          <button
            className={styles.submitAction}
            disabled={submitting}
            type="button"
            onClick={submit}
          >
            <span>{submitting ? "提交中" : "提交"}</span>
            <CornerDownLeft size={15} />
          </button>
        </span>
      </footer>
    </section>
  );
}

function ChoiceKeyHint() {
  return (
    <span className={styles.choiceKeyHint}>
      <ArrowUpDown size={14} />
    </span>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target.isContentEditable;
}

function focusRejectTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return;
  }
  textarea.focus();
  const cursorPosition = textarea.value.length;
  textarea.setSelectionRange(cursorPosition, cursorPosition);
}

function resizeRejectTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return;
  }
  textarea.style.height = "auto";
  const contentHeight = Math.max(textarea.scrollHeight, REJECT_TEXTAREA_MIN_HEIGHT);
  const nextHeight = Math.min(contentHeight, REJECT_TEXTAREA_MAX_HEIGHT);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = contentHeight > REJECT_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
}

function meaningfulCwd(value: unknown): string {
  const cwd = stringValue(value).trim();
  const normalized = cwd.replace(/\\/g, "/");
  if (!cwd || normalized === "." || normalized === "./") {
    return "";
  }
  return cwd;
}

function meaningfulDescription(value: unknown): string {
  const description = stringValue(value).trim();
  if (!description || GENERIC_COMMAND_APPROVAL_DESCRIPTIONS.has(description)) {
    return "";
  }
  return description;
}

function decisionFromChoice(choice: ApprovalChoice, rejectMessage: string): CommandApprovalDecisionPayload {
  if (choice === "approve_session") {
    return {
      decision: "approved",
      trust_scope: "session",
    };
  }
  if (choice === "approve_persistent_tool") {
    return {
      decision: "approved",
      trust_scope: "persistent_tool",
    };
  }
  if (choice === "approve_persistent_server") {
    return {
      decision: "approved",
      trust_scope: "persistent_server",
    };
  }
  if (choice === "approve_exact") {
    return {
      decision: "approved",
      trust_scope: "persistent",
      rule_match_type: "exact",
    };
  }
  if (choice === "approve_prefix") {
    return {
      decision: "approved",
      trust_scope: "persistent",
      rule_match_type: "prefix",
    };
  }
  if (choice === "reject") {
    return {
      decision: "rejected",
      trust_scope: "once",
      reject_message: rejectMessage,
    };
  }
  return { decision: "approved", trust_scope: "once" };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isMcpToolApproval(approval: CommandApprovalRequest): boolean {
  return approval.kind === "mcp_tool_call" || stringValue(approval.details.approval_kind) === "mcp_tool_call";
}

function isMcpSamplingApproval(approval: CommandApprovalRequest): boolean {
  return approval.kind === "mcp_sampling" || stringValue(approval.details.approval_kind) === "mcp_sampling";
}

function mcpTrustOptions(approval: CommandApprovalRequest): CommandApprovalTrustScope[] {
  const raw = approval.details.trust_options;
  if (!Array.isArray(raw)) {
    return ["once"];
  }
  const allowed = new Set<CommandApprovalTrustScope>(["once", "session", "persistent_tool", "persistent_server"]);
  const options = raw
    .map((value) => stringValue(value))
    .filter((value): value is CommandApprovalTrustScope => allowed.has(value as CommandApprovalTrustScope));
  return options.includes("once") ? options : ["once", ...options];
}

function mcpSamplingApprovalChoices(): ApprovalChoiceOption[] {
  return [
    {
      id: "approve_once",
      label: "允许本次模型请求",
      title: "",
    },
    {
      id: "reject",
      label: "拒绝，请告知智能体如何调整",
      title: "",
    },
  ];
}

function mcpApprovalChoices(options: CommandApprovalTrustScope[]): ApprovalChoiceOption[] {
  const available = new Set(options);
  const choices: ApprovalChoiceOption[] = [
    {
      id: "approve_once",
      label: "允许本次",
      title: "",
    },
  ];
  if (available.has("session")) {
    choices.push({
      id: "approve_session",
      label: "允许并信任本会话",
      title: "当前会话内同一工具不再重复询问",
    });
  }
  if (available.has("persistent_tool")) {
    choices.push({
      id: "approve_persistent_tool",
      label: "始终信任该工具",
      title: "以后此服务的同名工具不再重复询问",
    });
  }
  if (available.has("persistent_server")) {
    choices.push({
      id: "approve_persistent_server",
      label: "信任此 MCP 服务器",
      title: "以后此 MCP 服务器的工具调用不再重复询问",
    });
  }
  choices.push({
    id: "reject",
    label: "拒绝，请告知智能体如何调整",
    title: "",
  });
  return choices;
}

function mcpSamplingTargetLabel(approval: CommandApprovalRequest): string {
  const server = stringValue(approval.details.server_name) || stringValue(approval.server_name) || stringValue(approval.details.server_id) || stringValue(approval.server_id);
  const model =
    stringValue(approval.details.model) ||
    stringValue(approval.details.requested_model) ||
    stringValue(approval.details.model_policy);
  return [server, model].filter(Boolean).join(" / ");
}

function mcpSamplingPreview(approval: CommandApprovalRequest): string {
  const preview = approval.details.arguments_preview ?? approval.details.messages_preview;
  if (preview !== undefined && preview !== null) {
    if (typeof preview === "string") {
      return preview;
    }
    try {
      return JSON.stringify(preview, null, 2);
    } catch {
      return String(preview);
    }
  }
  const maxTokens = stringValue(approval.details.max_tokens);
  const messageCount = stringValue(approval.details.message_count);
  return [
    "MCP 模型请求",
    messageCount ? `消息数：${messageCount}` : "",
    maxTokens ? `Token 上限：${maxTokens}` : "",
  ].filter(Boolean).join("\n");
}

function mcpTargetLabel(approval: CommandApprovalRequest): string {
  const server = stringValue(approval.details.server_name) || stringValue(approval.server_name) || stringValue(approval.details.server_id) || stringValue(approval.server_id);
  const tool =
    stringValue(approval.details.raw_tool_name) ||
    stringValue(approval.raw_tool_name) ||
    stringValue(approval.details.tool_name) ||
    stringValue(approval.details.model_tool_name) ||
    stringValue(approval.model_tool_name);
  return [server, tool].filter(Boolean).join(" / ");
}

function approvalTitle(title: string | undefined, isSampling: boolean): string {
  const raw = stringValue(title);
  if (!raw && isSampling) {
    return "是否允许 MCP 服务器发起模型请求？";
  }
  return raw.replace(/MCP Sampling/gi, "MCP 模型请求");
}

function mcpArgumentsPreview(approval: CommandApprovalRequest): string {
  const preview = approval.details.arguments_preview;
  if (preview === undefined || preview === null) {
    return stringValue(approval.details.model_tool_name) || stringValue(approval.model_tool_name) || "MCP 工具调用";
  }
  if (typeof preview === "string") {
    return preview;
  }
  try {
    return JSON.stringify(preview, null, 2);
  } catch {
    return String(preview);
  }
}
