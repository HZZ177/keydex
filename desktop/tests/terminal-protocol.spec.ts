import { describe, expect, it } from "vitest";

import {
  decodeTerminalEvent,
  decodeTerminalSnapshot,
  normalizeTerminalError,
} from "@/runtime/terminalTypes";

const snapshot = {
  contractVersion: 1,
  terminalId: "terminal-1",
  sessionId: "session-1",
  profileId: "powershell",
  cwd: "C:/repo",
  title: "PowerShell 1",
  status: "running",
  seq: 7,
  exitCode: null,
  createdAt: 10,
  updatedAt: 12,
};

describe("terminal protocol", () => {
  it("decodes a valid snapshot and every event variant", () => {
    expect(decodeTerminalSnapshot(snapshot)).toEqual(snapshot);
    expect(
      decodeTerminalEvent({ event: "output", terminalId: "terminal-1", seq: 8, dataBase64: "AAE=" }),
    ).toMatchObject({ event: "output", seq: 8 });
    expect(
      decodeTerminalEvent({ event: "replayTruncated", terminalId: "terminal-1", earliestSeq: 4 }),
    ).toMatchObject({ event: "replayTruncated", earliestSeq: 4 });
    expect(decodeTerminalEvent({ event: "exited", terminalId: "terminal-1", exitCode: 7 })).toMatchObject({
      event: "exited",
      exitCode: 7,
    });
    expect(
      decodeTerminalEvent({
        event: "failed",
        terminalId: "terminal-1",
        code: "terminal_internal",
        message: "failed",
      }),
    ).toMatchObject({ event: "failed", message: "failed" });
  });

  it("rejects malformed or unknown protocol values conservatively", () => {
    expect(() => decodeTerminalSnapshot({ ...snapshot, status: "paused" })).toThrow("未知终端状态");
    expect(() => decodeTerminalSnapshot({ ...snapshot, contractVersion: 2 })).toThrow("协议版本不兼容");
    expect(() => decodeTerminalEvent({ event: "mystery", terminalId: "terminal-1" })).toThrow(
      "未知终端事件",
    );
    expect(normalizeTerminalError({ code: "future_error", message: "future" })).toEqual({
      code: "terminal_internal",
      message: "future",
    });
  });
});
