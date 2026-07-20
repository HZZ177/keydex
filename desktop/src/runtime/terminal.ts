import { Channel, invoke } from "@tauri-apps/api/core";

import {
  decodeTerminalAttachSnapshot,
  decodeTerminalEvent,
  decodeTerminalProfile,
  decodeTerminalSnapshot,
  normalizeTerminalError,
  type TerminalAttachSnapshot,
  type TerminalErrorPayload,
  type TerminalEvent,
  type TerminalProfileSnapshot,
  type TerminalSnapshot,
} from "./terminalTypes";

export type TerminalRuntimeEvent =
  | { event: "output"; terminalId: string; seq: number; data: Uint8Array }
  | Exclude<TerminalEvent, { event: "output" }>;

export interface TerminalChannel<T> {
  onmessage: ((message: T) => void) | null;
}

export interface TerminalIpcAdapter {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  createChannel<T>(onMessage: (message: T) => void): TerminalChannel<T>;
}

export interface TerminalCreateOptions {
  sessionId: string;
  cwd?: string | null;
  profile: TerminalProfileSnapshot["id"];
  cols: number;
  rows: number;
}

export interface TerminalResizeOptions {
  cols: number;
  rows: number;
  pixelWidth?: number | null;
  pixelHeight?: number | null;
}

export interface TerminalAttachOptions {
  afterSeq?: number;
  onEvent: (event: TerminalRuntimeEvent) => void;
  onError?: (error: TerminalRuntimeError) => void;
}

export interface TerminalAttachment {
  snapshot: TerminalSnapshot;
  replay: TerminalRuntimeEvent[];
  cursor: number;
  dispose(): void;
}

export interface TerminalRuntime {
  listProfiles(): Promise<TerminalProfileSnapshot[]>;
  create(options: TerminalCreateOptions): Promise<TerminalSnapshot>;
  list(sessionId: string): Promise<TerminalSnapshot[]>;
  attach(terminalId: string, options: TerminalAttachOptions): Promise<TerminalAttachment>;
  write(terminalId: string, data: string | Uint8Array): Promise<void>;
  resize(terminalId: string, options: TerminalResizeOptions): Promise<void>;
  kill(terminalId: string): Promise<void>;
  rename(terminalId: string, title: string): Promise<TerminalSnapshot>;
  close(terminalId: string): Promise<void>;
  closeSession(sessionId: string): Promise<number>;
  closeAll(): Promise<number>;
}

export class TerminalRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalRuntimeError";
    this.code = code;
  }
}

const defaultAdapter: TerminalIpcAdapter = {
  invoke: (command, args) => invoke(command, args),
  createChannel<T>(onMessage: (message: T) => void): TerminalChannel<T> {
    const channel = new Channel<T>();
    channel.onmessage = onMessage;
    return channel;
  },
};

export function createTerminalRuntime(adapter: TerminalIpcAdapter = defaultAdapter): TerminalRuntime {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await adapter.invoke<T>(command, args);
    } catch (reason) {
      throw terminalRuntimeError(reason);
    }
  };

  return {
    async listProfiles() {
      const values = await call<unknown[]>("terminal_list_profiles");
      return ensureArray(values, "终端配置").map(decodeTerminalProfile);
    },

    async create(options) {
      const value = await call<unknown>("terminal_create", {
        sessionId: options.sessionId,
        cwd: options.cwd?.trim() || null,
        profile: options.profile,
        cols: options.cols,
        rows: options.rows,
      });
      return decodeTerminalSnapshot(value);
    },

    async list(sessionId) {
      const values = await call<unknown[]>("terminal_list", { sessionId });
      return ensureArray(values, "终端列表").map(decodeTerminalSnapshot);
    },

    async attach(terminalId, options) {
      const afterSeq = options.afterSeq ?? 0;
      let active = true;
      let ready = false;
      let lastSeq = afterSeq;
      const pending: unknown[] = [];
      const reportError = (error: TerminalRuntimeError) => options.onError?.(error);
      const deliver = (raw: unknown) => {
        if (!active) return;
        try {
          const event = decodeRuntimeEvent(raw);
          if (event.terminalId !== terminalId) {
            throw new TerminalRuntimeError("terminal_event_mismatch", "终端输出标识不匹配");
          }
          if (event.event === "output") {
            if (event.seq <= lastSeq) {
              throw new TerminalRuntimeError("terminal_event_out_of_order", "收到重复或乱序的终端输出");
            }
            if (event.seq > lastSeq + 1) {
              reportError(new TerminalRuntimeError("terminal_event_gap", "终端输出出现缺口，正在重新连接"));
            }
            lastSeq = event.seq;
          }
          options.onEvent(event);
        } catch (reason) {
          reportError(terminalRuntimeError(reason, "terminal_event_invalid"));
        }
      };
      const channel = adapter.createChannel<unknown>((message) => {
        if (!ready) {
          pending.push(message);
          return;
        }
        deliver(message);
      });
      let attached: TerminalAttachSnapshot;
      try {
        attached = decodeTerminalAttachSnapshot(
          await call<unknown>("terminal_attach", {
            terminalId,
            afterSeq,
            onEvent: channel,
          }),
        );
      } catch (reason) {
        active = false;
        channel.onmessage = null;
        throw terminalRuntimeError(reason, "terminal_attach_failed");
      }
      const replay = attached.replay.map(decodeRuntimeEvent);
      lastSeq = Math.max(afterSeq, attached.cursor);
      ready = true;
      for (const message of pending.splice(0)) deliver(message);
      return {
        snapshot: attached.snapshot,
        replay,
        cursor: attached.cursor,
        dispose() {
          active = false;
          channel.onmessage = null;
          pending.length = 0;
        },
      };
    },

    async write(terminalId, data) {
      await call<void>("terminal_write", {
        terminalId,
        dataBase64: encodeTerminalInput(data),
      });
    },

    async resize(terminalId, options) {
      await call<void>("terminal_resize", {
        terminalId,
        cols: options.cols,
        rows: options.rows,
        pixelWidth: options.pixelWidth ?? null,
        pixelHeight: options.pixelHeight ?? null,
      });
    },

    async kill(terminalId) {
      await call<void>("terminal_kill", { terminalId });
    },

    async rename(terminalId, title) {
      return decodeTerminalSnapshot(
        await call<unknown>("terminal_rename", { terminalId, title }),
      );
    },

    async close(terminalId) {
      await call<void>("terminal_close", { terminalId });
    },

    async closeSession(sessionId) {
      return call<number>("terminal_close_session", { sessionId });
    },

    async closeAll() {
      return call<number>("terminal_close_all");
    },
  };
}

export const terminalRuntime = createTerminalRuntime();

export function isTerminalRuntimeAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const internals = (window as Window & {
    __TAURI_INTERNALS__?: { invoke?: unknown };
  }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function";
}

export function decodeRuntimeEvent(value: unknown): TerminalRuntimeEvent {
  const event = decodeTerminalEvent(value);
  if (event.event !== "output") {
    return event;
  }
  return {
    event: "output",
    terminalId: event.terminalId,
    seq: event.seq,
    data: decodeBase64(event.dataBase64),
  };
}

export function encodeTerminalInput(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch (reason) {
    throw new TerminalRuntimeError("terminal_event_invalid", "终端输出编码无效", { cause: reason });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function ensureArray<T>(value: T[], label: string): T[] {
  if (!Array.isArray(value)) {
    throw new TerminalRuntimeError("terminal_protocol_invalid", `${label}格式无效`);
  }
  return value;
}

function terminalRuntimeError(reason: unknown, fallbackCode = "terminal_internal"): TerminalRuntimeError {
  if (reason instanceof TerminalRuntimeError) return reason;
  const normalized: TerminalErrorPayload = normalizeTerminalError(reason);
  return new TerminalRuntimeError(normalized.code || fallbackCode, normalized.message, { cause: reason });
}
