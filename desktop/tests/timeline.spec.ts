import { describe, expect, it } from "vitest";

import type { ThreadItem } from "@/types/protocol";

describe("timeline scenario", () => {
  it("contains the expected item types", () => {
    const items: ThreadItem[] = [
      {
        id: "item_user",
        thread_id: "thr_1",
        turn_id: "turn_1",
        type: "user_message",
        status: "completed",
        payload: { input: [{ type: "text", text: "hello" }] },
        created_at: "2026-06-15T00:00:00Z",
        updated_at: "2026-06-15T00:00:00Z",
        seq_start: null,
        seq_end: null,
      },
      {
        id: "item_command",
        thread_id: "thr_1",
        turn_id: "turn_1",
        type: "command_execution",
        status: "completed",
        payload: { command: "pytest", stdout: "passed", exit_code: 0 },
        created_at: "2026-06-15T00:00:01Z",
        updated_at: "2026-06-15T00:00:02Z",
        seq_start: null,
        seq_end: null,
      },
    ];

    expect(items.map((item) => item.type)).toEqual(["user_message", "command_execution"]);
  });
});
