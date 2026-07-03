import { describe, expect, it } from "vitest";

import {
  GOAL_INITIAL_THREAD_TASK_KEY,
  goalContextItem,
  runtimeParamsWithGoalContextItem,
  runtimeParamsWithInitialGoalTask,
} from "@/renderer/pages/conversation/goalSeedContext";
import type { ThreadTask } from "@/types/protocol";

describe("goal seed context helpers", () => {
  it("adds initial goal task payload without dropping existing runtime context", () => {
    const goalItem = goalContextItem("完成目标");
    const task = {
      id: "task-1",
      session_id: "session-1",
      type: "goal",
      type_label: "目标",
      title: null,
      objective: "完成目标",
      status: "active",
      metadata: {},
      evidence: [],
      blocked_audit: {},
      system_stop_reason: null,
      current_run_id: null,
      turn_count: 0,
      elapsed_seconds: 0,
      token_usage: {},
      created_at: "2026-07-03T00:00:00Z",
      updated_at: "2026-07-03T00:00:00Z",
      deleted_at: null,
      is_open: true,
      is_terminal: false,
    } satisfies ThreadTask;

    const runtimeParams = runtimeParamsWithInitialGoalTask(
      runtimeParamsWithGoalContextItem(
        {
          message_injection: [
            {
              type: "follow",
              role: "HumanMessage",
              content: "用户通过 @ 引用了 README.md",
            },
          ],
          skill_activation: {
            skill_name: "dev-plan-execute",
            source: "workspace",
            origin: "slash",
          },
        },
        goalItem,
      ),
      task,
    );

    expect(runtimeParams.message_injection).toHaveLength(1);
    expect(runtimeParams.skill_activation).toEqual({
      skill_name: "dev-plan-execute",
      source: "workspace",
      origin: "slash",
    });
    expect(runtimeParams.message_context_items).toEqual([goalItem]);
    expect(runtimeParams[GOAL_INITIAL_THREAD_TASK_KEY]).toEqual({
      task_id: "task-1",
      type: "goal",
      trigger: "task_start",
    });
  });
});
