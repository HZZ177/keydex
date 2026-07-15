import { useMemo } from "react";
import { Sparkles } from "lucide-react";

import { runtimeBridge, type RuntimeBridge, type SkillSource, type WorkspaceScope } from "@/runtime";
import { useOptionalPreview } from "@/renderer/providers/PreviewProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { openSkillResourcePreview, skillResourcePreviewError } from "@/renderer/utils/skillResourcePreview";

import { previewRenderContextFromWorkspaceScope } from "./previewRenderContext";
import styles from "./SkillActivationBlock.module.css";

export interface SkillActivationBlockProps {
  message: ConversationMessage;
  workspaceRuntime?: RuntimeBridge;
  workspaceScope?: WorkspaceScope | null;
  onQuoteSelection?: (text: string, comment?: string) => void;
}

interface SkillActivationViewModel {
  skillName: string;
  source: SkillSource;
  resourcePath: string;
  title: string;
  status: "running" | "success" | "failed";
  canOpen: boolean;
}

export function SkillActivationBlock({
  message,
  workspaceRuntime,
  workspaceScope,
  onQuoteSelection,
}: SkillActivationBlockProps) {
  const previewContext = useOptionalPreview();
  const notifications = useNotifications();
  const model = useMemo(() => skillActivationViewModel(message), [message]);

  const handleOpen = () => {
    if (!model.canOpen || !previewContext) {
      return;
    }
    const renderContext = previewRenderContextFromWorkspaceScope(
      workspaceScope,
      workspaceRuntime,
      onQuoteSelection,
      previewContext.hostContext,
    );
    void openSkillResourcePreview({
      preview: previewContext,
      renderContext,
      runtime: workspaceRuntime ?? runtimeBridge,
      scope: workspaceScope,
      target: {
        skillName: model.skillName,
        source: model.source,
        resourcePath: model.resourcePath || "SKILL.md",
      },
    }).catch((reason) => notifications.error(skillResourcePreviewError(reason)));
  };

  return (
    <article
      className={styles.block}
      data-clickable={model.canOpen ? "true" : "false"}
      data-skill-source={model.source}
      data-status={model.status}
      data-testid="skill-activation-block"
    >
      <button
        className={styles.surface}
        type="button"
        aria-label={`打开 Skill ${model.skillName}`}
        disabled={!model.canOpen}
        onClick={handleOpen}
      >
        <span className={styles.icon} aria-hidden="true">
          <Sparkles size={14} strokeWidth={2} absoluteStrokeWidth focusable="false" />
        </span>
        <span className={styles.content}>
          <span className={styles.header}>
            <span className={styles.title}>{model.title}</span>
          </span>
        </span>
      </button>
    </article>
  );
}

function skillActivationViewModel(message: ConversationMessage): SkillActivationViewModel {
  const call = asRecord(message.payload.call);
  const result = asRecord(message.payload.result);
  const args =
    asRecord(call?.arguments) ??
    parseJsonRecord(stringValue(call?.arguments)) ??
    asRecord(message.payload.arguments) ??
    parseJsonRecord(stringValue(message.payload.arguments)) ??
    {};
  const resultPayload = parseToolResultPayload(result, message.payload);
  const skillName =
    stringValue(args.skill_name) ||
    stringValue(args.skillName) ||
    stringValue(resultPayload?.skill_name) ||
    stringValue(resultPayload?.skillName) ||
    "Skill";
  const resourcePath =
    stringValue(args.resource_path) ||
    stringValue(args.resourcePath) ||
    stringValue(resultPayload?.resource_path) ||
    stringValue(resultPayload?.resourcePath);
  const source = skillSource(
    stringValue(args.source) ||
      stringValue(resultPayload?.source) ||
      stringValue(asRecord(resultPayload?.metadata)?.source),
  );
  const status = activationStatus(message, result, resultPayload, Boolean(resourcePath));
  const resourceName = resourcePath ? fileName(resourcePath) : "";
  const title = resourcePath ? `${skillName} / ${resourceName || resourcePath}` : skillName;
  return {
    skillName,
    source,
    resourcePath,
    title,
    status,
    canOpen: Boolean(skillName),
  };
}

function skillSource(value: string): SkillSource {
  return value === "builtin" ? "builtin" : value === "system" ? "system" : "workspace";
}

function parseToolResultPayload(
  result: Record<string, unknown> | null,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const text =
    stringValue(result?.model_content) ||
    stringValue(result?.text) ||
    stringValue(payload.model_content) ||
    stringValue(payload.result_text);
  const parsed = parseJsonRecord(text);
  if (parsed) {
    return nestedSkillPayload(parsed);
  }
  return nestedSkillPayload(result) ?? nestedSkillPayload(asRecord(payload.ui_payload));
}

function nestedSkillPayload(
  value: Record<string, unknown> | null,
  depth = 0,
): Record<string, unknown> | null {
  if (!value || depth > 4) {
    return null;
  }
  if (
    stringValue(value.skill_name) ||
    stringValue(value.skillName) ||
    typeof value.loaded === "boolean" ||
    typeof value.injected === "boolean"
  ) {
    return value;
  }
  for (const key of ["result", "ui_payload", "uiPayload", "output_data", "outputData"]) {
    const nested = nestedSkillPayload(asRecord(value[key]), depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function activationStatus(
  message: ConversationMessage,
  result: Record<string, unknown> | null,
  resultPayload: Record<string, unknown> | null,
  resourceMode: boolean,
): SkillActivationViewModel["status"] {
  const resultStatus = stringValue(result?.status);
  const loaded = resultPayload?.loaded;
  const injected = resultPayload?.injected;
  if (message.status === "pending" || message.status === "running" || resultStatus === "running") {
    return "running";
  }
  if (
    message.status === "failed" ||
    resultStatus === "error" ||
    loaded === false ||
    (!resourceMode && injected === false)
  ) {
    return "failed";
  }
  return "success";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!text.trim()) {
    return null;
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
