import { useMemo } from "react";
import { Sparkles } from "lucide-react";

import type { RuntimeBridge, WorkspaceScope } from "@/runtime";
import { useOptionalPreview } from "@/renderer/providers/PreviewProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

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
  resourcePath: string;
  openPath: string;
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
  const model = useMemo(() => skillActivationViewModel(message), [message]);

  const handleOpen = () => {
    if (!model.canOpen || !previewContext) {
      return;
    }
    previewContext.openFilePanel(
      model.openPath,
      previewRenderContextFromWorkspaceScope(
        workspaceScope,
        workspaceRuntime,
        onQuoteSelection,
        previewContext.hostContext,
      ),
    );
  };

  return (
    <article
      className={styles.block}
      data-clickable={model.canOpen ? "true" : "false"}
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
  const args = asRecord(call?.arguments) ?? asRecord(message.payload.arguments) ?? {};
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
  const openPath = skillOpenPath(skillName, resourcePath, resultPayload);
  const status = activationStatus(message, result, resultPayload, Boolean(resourcePath));
  const resourceName = resourcePath ? fileName(resourcePath) : "";
  const title = resourcePath ? `${skillName} / ${resourceName || resourcePath}` : skillName;
  return {
    skillName,
    resourcePath,
    openPath,
    title,
    status,
    canOpen: Boolean(openPath),
  };
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
    return parsed;
  }
  const uiPayload = asRecord(result?.ui_payload) ?? asRecord(payload.ui_payload);
  return uiPayload;
}

function skillOpenPath(
  skillName: string,
  resourcePath: string,
  resultPayload: Record<string, unknown> | null,
): string {
  const explicitPath =
    stringValue(resultPayload?.entry_file) ||
    stringValue(resultPayload?.entryFile) ||
    stringValue(resultPayload?.locator) ||
    stringValue(asRecord(resultPayload?.metadata)?.locator);
  if (explicitPath && isWorkspaceRelativePath(explicitPath)) {
    return normalizeWorkspacePath(explicitPath);
  }
  const root =
    stringValue(resultPayload?.skill_root) ||
    stringValue(resultPayload?.skillRoot) ||
    fallbackSkillRoot(skillName);
  if (!root) {
    return "";
  }
  if (resourcePath) {
    const normalizedResource = normalizeWorkspacePath(resourcePath);
    if (!normalizedResource || normalizedResource.startsWith("../") || normalizedResource.includes("/../")) {
      return "";
    }
    return `${normalizeWorkspacePath(root).replace(/\/$/, "")}/${normalizedResource}`;
  }
  return `${normalizeWorkspacePath(root).replace(/\/$/, "")}/SKILL.md`;
}

function fallbackSkillRoot(skillName: string): string {
  const normalized = skillName.trim().replace(/^\/+/, "");
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    return "";
  }
  return `.keydex/skills/${normalized}`;
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

function isWorkspaceRelativePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return Boolean(normalized) && !/^[a-zA-Z]:\//.test(normalized) && !normalized.startsWith("/");
}

function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
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
