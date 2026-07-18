export const SUBAGENT_SCHEMA_VERSION = 1 as const;

export const SUBAGENT_ROLES = ["explorer", "worker"] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export const SUBAGENT_RUN_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type SubagentRunState = (typeof SUBAGENT_RUN_STATES)[number];

export const SUBAGENT_INSTANCE_STATES = ["idle", "running", "closed"] as const;
export type SubagentInstanceState = (typeof SUBAGENT_INSTANCE_STATES)[number];

export const SUBAGENT_BLOCKED_ON_VALUES = ["approval", "user_input", "external_tool"] as const;
export type SubagentBlockedOn = (typeof SUBAGENT_BLOCKED_ON_VALUES)[number];

export const SUBAGENT_INITIATORS = ["main_agent", "user"] as const;
export type SubagentInitiator = (typeof SUBAGENT_INITIATORS)[number];

export interface SubagentRunSnapshot {
  schema_version: typeof SUBAGENT_SCHEMA_VERSION;
  run_id: string;
  subagent_id: string;
  child_session_id: string;
  parent_session_id: string;
  parent_trace_id: string | null;
  parent_tool_call_id: string | null;
  parent_timeline_sequence: number;
  initiated_by: SubagentInitiator;
  role: SubagentRole;
  task: string;
  state: SubagentRunState;
  blocked_on: SubagentBlockedOn | null;
  version: number;
  final_report: string | null;
  report_truncated: boolean;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
  cancel_requested_at: string | null;
}

export interface SubagentHandle {
  schema_version: typeof SUBAGENT_SCHEMA_VERSION;
  subagent_id: string;
  run_id: string;
  child_session_id: string;
  parent_session_id: string;
  role: SubagentRole;
  initial_snapshot: SubagentRunSnapshot;
}

export interface SubagentInstanceSummary {
  schema_version: typeof SUBAGENT_SCHEMA_VERSION;
  subagent_id: string;
  child_session_id: string;
  parent_session_id: string;
  role: SubagentRole;
  state: SubagentInstanceState;
  active_run_id: string | null;
  closed_at: string | null;
}

export interface SubagentTerminalError {
  code: string;
  message: string;
  retryable: boolean;
}

interface DelegateSubagentResultBase {
  schema_version: typeof SUBAGENT_SCHEMA_VERSION;
  subagent_id: string;
  run_id: string;
  child_session_id: string;
  role: SubagentRole;
}

export interface DelegateSubagentCompletedResult extends DelegateSubagentResultBase {
  ok: true;
  state: "completed";
  final_report: string;
  report_truncated: boolean;
}

export interface DelegateSubagentFailedResult extends DelegateSubagentResultBase {
  ok: false;
  state: "failed" | "cancelled" | "interrupted";
  error: SubagentTerminalError;
}

export type DelegateSubagentResult = DelegateSubagentCompletedResult | DelegateSubagentFailedResult;

export interface SubagentControlAddress {
  subagent_id: string;
  child_session_id: string;
  expected_version: number;
}

export interface SubagentSteerRequest extends SubagentControlAddress {
  message: string;
}

export interface SubagentCancelRequest extends SubagentControlAddress {
  reason?: string | null;
}

export interface SubagentControlRunResponse {
  run: SubagentRunSnapshot;
}

export class SubagentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentProtocolError";
  }
}

export function normalizeSubagentRunSnapshot(value: unknown): SubagentRunSnapshot {
  const record = requireRecord(value, "Sub-Agent Run snapshot");
  requireSchemaVersion(record);
  const state = requireEnum(record.state, SUBAGENT_RUN_STATES, "state");
  const initiatedBy = requireEnum(record.initiated_by, SUBAGENT_INITIATORS, "initiated_by");
  const blockedOn = optionalEnum(record.blocked_on, SUBAGENT_BLOCKED_ON_VALUES, "blocked_on");
  const snapshot: SubagentRunSnapshot = {
    schema_version: SUBAGENT_SCHEMA_VERSION,
    run_id: requireId(record.run_id, "run_id"),
    subagent_id: requireId(record.subagent_id, "subagent_id"),
    child_session_id: requireId(record.child_session_id, "child_session_id"),
    parent_session_id: requireId(record.parent_session_id, "parent_session_id"),
    parent_trace_id: optionalId(record.parent_trace_id, "parent_trace_id"),
    parent_tool_call_id: optionalId(record.parent_tool_call_id, "parent_tool_call_id"),
    parent_timeline_sequence: requireInteger(record.parent_timeline_sequence, "parent_timeline_sequence", 0),
    initiated_by: initiatedBy,
    role: requireEnum(record.role, SUBAGENT_ROLES, "role"),
    task: requireId(record.task, "task"),
    state,
    blocked_on: blockedOn,
    version: requireInteger(record.version, "version", 1),
    final_report: optionalText(record.final_report, "final_report"),
    report_truncated: requireBoolean(record.report_truncated, "report_truncated"),
    error_code: optionalText(record.error_code, "error_code"),
    error_message: optionalText(record.error_message, "error_message"),
    created_at: requireTimestamp(record.created_at, "created_at"),
    queued_at: optionalTimestamp(record.queued_at, "queued_at"),
    started_at: optionalTimestamp(record.started_at, "started_at"),
    finished_at: optionalTimestamp(record.finished_at, "finished_at"),
    updated_at: optionalTimestamp(record.updated_at, "updated_at"),
    cancel_requested_at: optionalTimestamp(record.cancel_requested_at, "cancel_requested_at"),
  };
  validateRunStatePayload(snapshot);
  return snapshot;
}

export function normalizeSubagentHandle(value: unknown): SubagentHandle {
  const record = requireRecord(value, "Sub-Agent Handle");
  requireSchemaVersion(record);
  const handle: SubagentHandle = {
    schema_version: SUBAGENT_SCHEMA_VERSION,
    subagent_id: requireId(record.subagent_id, "subagent_id"),
    run_id: requireId(record.run_id, "run_id"),
    child_session_id: requireId(record.child_session_id, "child_session_id"),
    parent_session_id: requireId(record.parent_session_id, "parent_session_id"),
    role: requireEnum(record.role, SUBAGENT_ROLES, "role"),
    initial_snapshot: normalizeSubagentRunSnapshot(record.initial_snapshot),
  };
  for (const key of ["subagent_id", "run_id", "child_session_id", "parent_session_id", "role"] as const) {
    if (handle[key] !== handle.initial_snapshot[key]) {
      invalid(`initial_snapshot ${key} does not match Handle`);
    }
  }
  if (!isActiveSubagentRun(handle.initial_snapshot.state)) {
    invalid("a new Handle requires an active initial snapshot");
  }
  return handle;
}

export function normalizeSubagentInstanceSummary(value: unknown): SubagentInstanceSummary {
  const record = requireRecord(value, "Sub-Agent instance summary");
  requireSchemaVersion(record);
  const summary: SubagentInstanceSummary = {
    schema_version: SUBAGENT_SCHEMA_VERSION,
    subagent_id: requireId(record.subagent_id, "subagent_id"),
    child_session_id: requireId(record.child_session_id, "child_session_id"),
    parent_session_id: requireId(record.parent_session_id, "parent_session_id"),
    role: requireEnum(record.role, SUBAGENT_ROLES, "role"),
    state: requireEnum(record.state, SUBAGENT_INSTANCE_STATES, "state"),
    active_run_id: optionalId(record.active_run_id, "active_run_id"),
    closed_at: optionalTimestamp(record.closed_at, "closed_at"),
  };
  if ((summary.state === "running") !== (summary.active_run_id !== null)) {
    invalid("only running instances require active_run_id");
  }
  if ((summary.state === "closed") !== (summary.closed_at !== null)) {
    invalid("only closed instances require closed_at");
  }
  return summary;
}

export function normalizeDelegateSubagentResult(value: unknown): DelegateSubagentResult {
  const record = requireRecord(value, "delegate_subagent result");
  requireSchemaVersion(record);
  const base = {
    schema_version: SUBAGENT_SCHEMA_VERSION,
    subagent_id: requireId(record.subagent_id, "subagent_id"),
    run_id: requireId(record.run_id, "run_id"),
    child_session_id: requireId(record.child_session_id, "child_session_id"),
    role: requireEnum(record.role, SUBAGENT_ROLES, "role"),
  };
  if (record.ok === true && record.state === "completed") {
    return {
      ...base,
      ok: true,
      state: "completed",
      final_report: requireId(record.final_report, "final_report"),
      report_truncated: requireBoolean(record.report_truncated, "report_truncated"),
    };
  }
  if (record.ok === false && ["failed", "cancelled", "interrupted"].includes(String(record.state))) {
    const error = requireRecord(record.error, "terminal error");
    return {
      ...base,
      ok: false,
      state: record.state as DelegateSubagentFailedResult["state"],
      error: {
        code: requireId(error.code, "error.code"),
        message: requireId(error.message, "error.message"),
        retryable: requireBoolean(error.retryable, "error.retryable"),
      },
    };
  }
  return invalid("delegate_subagent result has an invalid terminal state or success flag");
}

export function isTerminalSubagentRun(state: SubagentRunState): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(state);
}

export function isActiveSubagentRun(state: SubagentRunState): boolean {
  return state === "queued" || state === "running";
}

function validateRunStatePayload(snapshot: SubagentRunSnapshot): void {
  if (snapshot.initiated_by === "main_agent" && snapshot.parent_tool_call_id === null) {
    invalid("main_agent Runs require parent_tool_call_id");
  }
  if (snapshot.blocked_on !== null && snapshot.state !== "running") {
    invalid("blocked_on is only valid while running");
  }
  if (isTerminalSubagentRun(snapshot.state) !== (snapshot.finished_at !== null)) {
    invalid("terminal Runs require finished_at and active Runs forbid it");
  }
  if (snapshot.state === "queued" && snapshot.started_at !== null) {
    invalid("queued Runs cannot have started_at");
  }
  if (snapshot.state === "running" && snapshot.started_at === null) {
    invalid("running Runs require started_at");
  }
  if (snapshot.state === "completed") {
    if (snapshot.final_report === null || snapshot.error_code !== null || snapshot.error_message !== null) {
      invalid("completed Runs require only final_report");
    }
  } else if (snapshot.state === "failed") {
    if (snapshot.final_report !== null || snapshot.error_code === null || snapshot.error_message === null) {
      invalid("failed Runs require error_code and error_message only");
    }
  } else if (snapshot.final_report !== null) {
    invalid("only completed Runs may contain final_report");
  }
  if (snapshot.report_truncated && snapshot.final_report === null) {
    invalid("report_truncated requires final_report");
  }
}

function requireSchemaVersion(record: Record<string, unknown>): void {
  if (record.schema_version !== SUBAGENT_SCHEMA_VERSION) {
    invalid(`unsupported Sub-Agent schema_version: ${String(record.schema_version)}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalId(value: unknown, field: string): string | null {
  return value === null ? null : requireId(value, field);
}

function optionalText(value: unknown, field: string): string | null {
  return value === null ? null : requireId(value, field);
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireId(value, field);
  if (Number.isNaN(Date.parse(timestamp))) invalid(`${field} must be an ISO timestamp`);
  return timestamp;
}

function optionalTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : requireTimestamp(value, field);
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    invalid(`${field} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(`${field} must be a boolean`);
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    invalid(`${field} contains an unknown value: ${String(value)}`);
  }
  return value as T[number];
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] | null {
  return value === null ? null : requireEnum(value, allowed, field);
}

function invalid(message: string): never {
  throw new SubagentProtocolError(message);
}
