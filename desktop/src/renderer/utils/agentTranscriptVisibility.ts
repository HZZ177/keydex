import type { AgentChatMessage, AgentChatMessagePayload } from "@/types/protocol";

type TranscriptMessage = AgentChatMessage | AgentChatMessagePayload;

export function shouldDisplayAgentTranscriptMessage(message: TranscriptMessage): boolean {
  return !isHiddenForTranscript(message) && !isTaskContinuationUserMessage(message);
}

function isHiddenForTranscript(message: TranscriptMessage): boolean {
  const root = objectValue(message);
  const metadata = objectValue(message.metadata);
  return (
    booleanValue(root?.hidden_for_transcript) ||
    booleanValue(root?.hiddenForTranscript) ||
    booleanValue(metadata?.hidden_for_transcript) ||
    booleanValue(metadata?.hiddenForTranscript)
  );
}

function isTaskContinuationUserMessage(message: TranscriptMessage): boolean {
  if (message.role !== "user") {
    return false;
  }
  const threadTask = threadTaskRuntimeContext(message);
  return stringValue(threadTask?.trigger) === "task_continue";
}

function threadTaskRuntimeContext(message: TranscriptMessage): Record<string, unknown> | null {
  const root = objectValue(message);
  const metadata = objectValue(message.metadata);
  const runtimeParams =
    objectValue(root?.runtime_params) ||
    objectValue(root?.runtimeParams) ||
    objectValue(metadata?.runtime_params) ||
    objectValue(metadata?.runtimeParams);
  return (
    objectValue(runtimeParams?.thread_task) ||
    objectValue(runtimeParams?.threadTask) ||
    objectValue(metadata?.thread_task) ||
    objectValue(metadata?.threadTask)
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
