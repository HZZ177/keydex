import { describe, expect, it } from "vitest";

import snapshotFixture from "./fixtures/subagent-run-snapshot.json";
import { createConversationRuntime } from "@/runtime/conversation";
import { createHttpClient } from "@/runtime/httpClient";

describe("Sub-Agent conversation runtime", () => {
  it("uses controlled parent/Run paths for history, tool detail and allowed user controls", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/runs")) return json({ list: [snapshotFixture] });
      if (url.includes("/session/tool-details")) return json({ detail: { result: "ok" } });
      if (url.includes("/session?")) {
        return json({ session: { id: "child-1" }, history: { session: { id: "child-1" }, list: [] } });
      }
      return json({ run: snapshotFixture });
    };
    const runtime = createConversationRuntime(
      createHttpClient({ baseUrl: "http://keydex", fetcher }),
    );
    const parent = "parent/1";
    const run = "run/1";
    const address = {
      subagent_id: snapshotFixture.subagent_id,
      child_session_id: snapshotFixture.child_session_id,
      expected_version: snapshotFixture.version,
    };

    await runtime.listSubagentRuns(parent);
    await runtime.loadSubagentSession(parent, run, { page: 2, pageSize: 10 });
    await runtime.loadSubagentToolDetails(parent, run, { startEventId: "start/1", endEventId: "end/1" });
    await runtime.steerSubagent(parent, run, { ...address, message: "guide" });
    await runtime.cancelSubagent(parent, run, { ...address, reason: "user" });

    expect(requests.map((item) => item.url)).toEqual([
      "http://keydex/api/sessions/parent%2F1/subagents/runs",
      "http://keydex/api/sessions/parent%2F1/subagents/runs/run%2F1/session?page=2&page_size=10",
      "http://keydex/api/sessions/parent%2F1/subagents/runs/run%2F1/session/tool-details?start_event_id=start%2F1&end_event_id=end%2F1",
      "http://keydex/api/sessions/parent%2F1/subagents/runs/run%2F1/steer",
      "http://keydex/api/sessions/parent%2F1/subagents/runs/run%2F1/cancel",
    ]);
    expect(requests.slice(3).map((item) => JSON.parse(String(item.init?.body)))).toEqual([
      { ...address, message: "guide" },
      { ...address, reason: "user" },
    ]);
  });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
