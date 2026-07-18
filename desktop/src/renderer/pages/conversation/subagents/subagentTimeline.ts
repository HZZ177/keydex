import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { SubagentRunSnapshot } from "@/types/subagents";

export function mergeSubagentRunsIntoConversation(
  messages: ConversationMessage[],
  runs: SubagentRunSnapshot[],
): ConversationMessage[] {
  if (!runs.length) return messages;

  const sortedRuns = [...runs].sort(compareRuns);
  const runsByAnchor = new Map<string, SubagentRunSnapshot[]>();
  for (const run of sortedRuns) {
    const anchor = run.parent_tool_call_id?.trim();
    if (!anchor) {
      continue;
    }
    const group = runsByAnchor.get(anchor) ?? [];
    group.push(run);
    runsByAnchor.set(anchor, group);
  }

  const merged: ConversationMessage[] = [];
  const insertedRunIds = new Set<string>();
  for (const message of messages) {
    const invocation = isSubagentInvocation(message);
    const anchors = messageToolCallAnchors(message);
    const correlatedRuns = anchors.flatMap((anchor) => runsByAnchor.get(anchor) ?? []);
    if (!invocation) {
      merged.push(message);
    }
    for (const run of correlatedRuns) {
      if (!insertedRunIds.has(run.run_id)) {
        merged.push(messageFromRun(run, message.turnId));
        insertedRunIds.add(run.run_id);
      }
    }
    if (invocation && correlatedRuns.length === 0) {
      merged.push(message);
    }
  }

  for (const run of sortedRuns) {
    if (!insertedRunIds.has(run.run_id)) {
      merged.push(messageFromRun(run, null));
      insertedRunIds.add(run.run_id);
    }
  }
  return merged;
}

export function messageFromRun(
  run: SubagentRunSnapshot,
  turnId: string | null,
): ConversationMessage {
  return {
    id: `subagent-run:${run.run_id}`,
    threadId: run.parent_session_id,
    turnId,
    itemId: run.parent_tool_call_id,
    kind: "subagent_run",
    status:
      run.state === "running" || run.state === "queued"
        ? "in_progress"
        : run.state === "interrupted"
          ? "failed"
          : run.state,
    content: run.task,
    payload: { subagentRun: run },
    createdAt: run.created_at,
    updatedAt: run.updated_at ?? run.finished_at ?? run.started_at ?? run.created_at,
  };
}

function messageToolCallAnchors(message: ConversationMessage): string[] {
  const values = [
    message.itemId,
    message.payload.toolCallId,
    message.payload.tool_call_id,
    message.payload.runId,
    message.payload.run_id,
  ];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())))]
    .map((value) => value.trim());
}

function isSubagentInvocation(message: ConversationMessage): boolean {
  if (message.kind === "subagent_invocation") return true;
  const call = asRecord(message.payload.call);
  return text(call?.name) === "delegate_subagent";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compareRuns(left: SubagentRunSnapshot, right: SubagentRunSnapshot): number {
  return (
    left.parent_timeline_sequence - right.parent_timeline_sequence ||
    Date.parse(left.created_at) - Date.parse(right.created_at) ||
    left.run_id.localeCompare(right.run_id)
  );
}
