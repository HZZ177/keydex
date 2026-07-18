import type { AgentActionEnvelope } from "@/types/protocol";
import {
  normalizeSubagentHandle,
  normalizeSubagentRunSnapshot,
  type SubagentRunSnapshot,
} from "@/types/subagents";


export type SubagentEventRoute = "runtime" | "legacy_inline" | "none";

const RUNTIME_ACTIONS = new Set([
  "subagent_run_updated",
  "subagent_runs_snapshot",
  "subagent_run_snapshot",
  "subagent_control_result",
]);
const LEGACY_INLINE_ACTIONS = new Set([
  "subagent_start",
  "subagent_end",
  "subagent_error",
]);

export function routeSubagentEvent(event: AgentActionEnvelope): SubagentEventRoute {
  if (RUNTIME_ACTIONS.has(event.action)) return "runtime";
  if (LEGACY_INLINE_ACTIONS.has(event.action)) return "legacy_inline";
  return "none";
}

export function snapshotsFromSubagentEvent(event: AgentActionEnvelope): SubagentRunSnapshot[] {
  if (routeSubagentEvent(event) !== "runtime") return [];
  const data = event.data as Record<string, unknown>;
  if (event.action === "subagent_run_updated") {
    return [normalizeSubagentRunSnapshot(data)];
  }
  if (event.action === "subagent_runs_snapshot") {
    if (!Array.isArray(data.list)) throw new Error("subagent_runs_snapshot.list must be an array");
    return data.list.map(normalizeSubagentRunSnapshot);
  }
  if (event.action === "subagent_run_snapshot") {
    return [normalizeSubagentRunSnapshot(data.run)];
  }
  if (event.action === "subagent_control_result") {
    if (data.run) return [normalizeSubagentRunSnapshot(data.run)];
    if (data.handle) return [normalizeSubagentHandle(data.handle).initial_snapshot];
  }
  return [];
}
