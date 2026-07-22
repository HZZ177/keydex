export const TERMINAL_CONTRACT_VERSION = 2 as const;
export const TERMINAL_REPLAY_LIMIT_BYTES = 1024 * 1024;
export const TERMINAL_REPLAY_LIMIT_CHUNKS = 4096;
export const TERMINAL_MAX_OUTPUT_CHUNK_BYTES = 32 * 1024;
export const TERMINAL_DELIVERY_WINDOW_BYTES = 256 * 1024;
export const TERMINAL_DELIVERY_WINDOW_CHUNKS = 64;

export type TerminalStatus = "starting" | "running" | "exited" | "failed" | "closing";

export type TerminalErrorCode =
  | "terminal_session_required"
  | "terminal_profile_unavailable"
  | "terminal_cwd_invalid"
  | "terminal_session_limit_reached"
  | "terminal_global_limit_reached"
  | "terminal_not_found"
  | "terminal_not_running"
  | "terminal_input_invalid"
  | "terminal_input_too_large"
  | "terminal_size_invalid"
  | "terminal_attach_failed"
  | "terminal_internal";

export interface TerminalErrorPayload {
  code: TerminalErrorCode;
  message: string;
}

export interface TerminalProfileSnapshot {
  id: "git-bash" | "powershell" | "cmd";
  label: string;
  available: boolean;
  executable: string | null;
  args: string[];
  unavailableReason: string | null;
}

export interface TerminalSnapshot {
  contractVersion: typeof TERMINAL_CONTRACT_VERSION;
  terminalId: string;
  sessionId: string;
  profileId: TerminalProfileSnapshot["id"];
  cwd: string;
  title: string;
  status: TerminalStatus;
  seq: number;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
}

export type TerminalEvent =
  | { event: "output"; terminalId: string; seq: number; dataBase64: string }
  | { event: "replayTruncated"; terminalId: string; earliestSeq: number }
  | { event: "exited"; terminalId: string; exitCode: number | null }
  | { event: "failed"; terminalId: string; code: string; message: string };

export interface TerminalAttachSnapshot {
  snapshot: TerminalSnapshot;
  replay: TerminalEvent[];
  cursor: number;
  subscriptionId: string;
}

export function decodeTerminalProfile(value: unknown): TerminalProfileSnapshot {
  const record = objectValue(value, "terminal profile");
  const id = stringValue(record.id, "id") as TerminalProfileSnapshot["id"];
  if (!PROFILE_IDS.has(id)) {
    throw new Error(`未知终端配置：${id}`);
  }
  const args = record.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("args 不是字符串数组");
  }
  return {
    id,
    label: stringValue(record.label, "label"),
    available: booleanValue(record.available, "available"),
    executable: nullableStringValue(record.executable, "executable"),
    args: [...args],
    unavailableReason: nullableStringValue(record.unavailableReason, "unavailableReason"),
  };
}

export function decodeTerminalAttachSnapshot(value: unknown): TerminalAttachSnapshot {
  const record = objectValue(value, "terminal attach snapshot");
  if (!Array.isArray(record.replay)) {
    throw new Error("replay 不是数组");
  }
  if (record.replay.length > TERMINAL_REPLAY_LIMIT_CHUNKS + 1) {
    throw new Error("replay 超过安全块数上限");
  }
  return {
    snapshot: decodeTerminalSnapshot(record.snapshot),
    replay: record.replay.map(decodeTerminalEvent),
    cursor: safeIntegerValue(record.cursor, "cursor"),
    subscriptionId: stringValue(record.subscriptionId, "subscriptionId"),
  };
}

const TERMINAL_STATUSES = new Set<TerminalStatus>([
  "starting",
  "running",
  "exited",
  "failed",
  "closing",
]);

const PROFILE_IDS = new Set<TerminalProfileSnapshot["id"]>(["git-bash", "powershell", "cmd"]);

export function decodeTerminalSnapshot(value: unknown): TerminalSnapshot {
  const record = objectValue(value, "terminal snapshot");
  const status = stringValue(record.status, "status") as TerminalStatus;
  const profileId = stringValue(record.profileId, "profileId") as TerminalProfileSnapshot["id"];
  if (!TERMINAL_STATUSES.has(status)) {
    throw new Error(`未知终端状态：${status}`);
  }
  if (!PROFILE_IDS.has(profileId)) {
    throw new Error(`未知终端配置：${profileId}`);
  }
  if (numberValue(record.contractVersion, "contractVersion") !== TERMINAL_CONTRACT_VERSION) {
    throw new Error("终端协议版本不兼容");
  }
  return {
    contractVersion: TERMINAL_CONTRACT_VERSION,
    terminalId: stringValue(record.terminalId, "terminalId"),
    sessionId: stringValue(record.sessionId, "sessionId"),
    profileId,
    cwd: stringValue(record.cwd, "cwd"),
    title: stringValue(record.title, "title"),
    status,
    seq: safeIntegerValue(record.seq, "seq"),
    exitCode: nullableIntegerValue(record.exitCode, "exitCode"),
    createdAt: safeIntegerValue(record.createdAt, "createdAt"),
    updatedAt: safeIntegerValue(record.updatedAt, "updatedAt"),
  };
}

export function decodeTerminalEvent(value: unknown): TerminalEvent {
  const record = objectValue(value, "terminal event");
  const event = stringValue(record.event, "event");
  const terminalId = stringValue(record.terminalId, "terminalId");
  if (event === "output") {
    return {
      event,
      terminalId,
      seq: safeIntegerValue(record.seq, "seq"),
      dataBase64: stringValue(record.dataBase64, "dataBase64"),
    };
  }
  if (event === "replayTruncated") {
    return { event, terminalId, earliestSeq: safeIntegerValue(record.earliestSeq, "earliestSeq") };
  }
  if (event === "exited") {
    return { event, terminalId, exitCode: nullableIntegerValue(record.exitCode, "exitCode") };
  }
  if (event === "failed") {
    return {
      event,
      terminalId,
      code: stringValue(record.code, "code"),
      message: stringValue(record.message, "message"),
    };
  }
  throw new Error(`未知终端事件：${event}`);
}

export function normalizeTerminalError(value: unknown): TerminalErrorPayload {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const rawCode = typeof record?.code === "string" ? record.code : "terminal_internal";
  const message =
    typeof record?.message === "string"
      ? record.message
      : value instanceof Error
        ? value.message
        : "终端操作失败";
  return {
    code: isTerminalErrorCode(rawCode) ? rawCode : "terminal_internal",
    message,
  };
}

function isTerminalErrorCode(value: string): value is TerminalErrorCode {
  return value.startsWith("terminal_") && [
    "terminal_session_required",
    "terminal_profile_unavailable",
    "terminal_cwd_invalid",
    "terminal_session_limit_reached",
    "terminal_global_limit_reached",
    "terminal_not_found",
    "terminal_not_running",
    "terminal_input_invalid",
    "terminal_input_too_large",
    "terminal_size_invalid",
    "terminal_attach_failed",
    "terminal_internal",
  ].includes(value);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 不是对象`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} 不是非空字符串`);
  }
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} 不是数字`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} 不是布尔值`);
  }
  return value;
}

function nullableStringValue(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} 不是字符串`);
  }
  return value;
}

function safeIntegerValue(value: unknown, field: string): number {
  const result = numberValue(value, field);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${field} 不是非负安全整数`);
  }
  return result;
}

function nullableIntegerValue(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = numberValue(value, field);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${field} 不是安全整数`);
  }
  return result;
}
