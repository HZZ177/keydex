import { describe, expect, it } from "vitest";

import {
  ArchiveCatalogContractError,
  createArchiveRuntime,
  createLifecycleRequestId,
  decodeLifecycleRuntimeError,
} from "@/runtime/archive";
import { createConversationRuntime } from "@/runtime/conversation";
import { RuntimeHttpError } from "@/runtime/errors";
import { createHttpClient } from "@/runtime/httpClient";
import { createWorkspacesRuntime } from "@/runtime/workspaces";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("archive lifecycle runtimes", () => {
  it("creates a fresh request id for each UI lifecycle intent", () => {
    const first = createLifecycleRequestId("session-archive");
    const second = createLifecycleRequestId("session-undo");

    expect(first).toMatch(/^session-archive:/);
    expect(second).toMatch(/^session-undo:/);
    expect(second).not.toBe(first);
  });

  it("sends explicit session lifecycle command paths and bodies", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/archive")) {
        return jsonResponse({
          operation_id: "op-a",
          request_id: "req-a",
          session_id: "ses/1",
          workspace_id: null,
          changed: true,
          archived_at: "2026-07-14T00:00:00Z",
          archive_origin: "manual",
          event: null,
        });
      }
      if (String(input).endsWith("/restore")) {
        return jsonResponse({
          operation_id: "op-r",
          request_id: "req-r",
          session_id: "ses/1",
          workspace_id: null,
          workspace: null,
          changed: true,
          event: null,
        });
      }
      return jsonResponse({
        operation_id: "op-p",
        state: "completed",
        entity_type: "session",
        counts: { sessions: 1 },
        replayed: false,
        event: null,
      });
    };
    const runtime = createConversationRuntime(createHttpClient({ baseUrl: "http://keydex", fetcher }));

    await runtime.archiveSession("ses/1", { requestId: "req-a", stopIfActive: true });
    await runtime.restoreSession("ses/1", { requestId: "req-r" });
    await runtime.purgeArchivedSession("ses/1", "req-p");

    expect(requests.map((item) => item.url)).toEqual([
      "http://keydex/api/sessions/ses%2F1/archive",
      "http://keydex/api/sessions/ses%2F1/restore",
      "http://keydex/api/archive/sessions/ses%2F1/purge",
    ]);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      request_id: "req-a",
      stop_if_active: true,
    });
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({ request_id: "req-r" });
    expect(JSON.parse(String(requests[2].init?.body))).toEqual({
      request_id: "req-p",
      confirmed: true,
    });
  });

  it("passes explicit workspace restore mode and exact confirmation names", async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      if ((bodies.at(-1) as { stop_active_sessions?: boolean }).stop_active_sessions !== undefined) {
        return jsonResponse({
          operation_id: "op-a",
          request_id: "req-a",
          workspace_id: "ws-1",
          changed: true,
          archived_at: "2026-07-14T00:00:00Z",
          newly_archived: 2,
          manual_preserved: 1,
          project_preserved: 0,
          event: null,
        });
      }
      if ((bodies.at(-1) as { mode?: string }).mode) {
        return jsonResponse({
          operation_id: "op-r",
          request_id: "req-r",
          workspace_id: "ws-1",
          mode: "project_only",
          changed: true,
          restored_project_sessions: 0,
          remaining_manual: 1,
          remaining_project: 1,
          remaining_total: 2,
          event: null,
        });
      }
      return jsonResponse({
        operation_id: "op-p",
        state: "completed",
        entity_type: "workspace",
        counts: {},
        replayed: false,
        event: null,
      });
    };
    const runtime = createWorkspacesRuntime(createHttpClient({ baseUrl: "http://keydex", fetcher }));

    await runtime.archive("ws-1", { requestId: "req-a", stopActiveSessions: true });
    await runtime.restore("ws-1", { requestId: "req-r", mode: "project_only" });
    await runtime.purgeArchived("ws-1", "req-p", "  Exact Name  ");
    await runtime.purgeArchivedSessions("ws/1", "req-ps", "  Exact Name  ");

    expect(bodies).toEqual([
      { request_id: "req-a", stop_active_sessions: true },
      { request_id: "req-r", mode: "project_only" },
      { request_id: "req-p", confirmation_name: "  Exact Name  " },
      { request_id: "req-ps", confirmation_name: "  Exact Name  " },
    ]);
    expect(urls.at(-1)).toBe("http://keydex/api/archive/workspaces/ws%2F1/sessions/purge");
  });

  it("rejects an archived workspace leaked into the active list", async () => {
    const runtime = createWorkspacesRuntime(
      createHttpClient({
        baseUrl: "http://keydex",
        fetcher: async () => jsonResponse({
          list: [{ id: "ws-archived", name: "Archived", archived_at: "2026-07-14T00:00:00Z" }],
          total: 1,
        }),
      }),
    );

    await expect(runtime.list()).rejects.toBeInstanceOf(ArchiveCatalogContractError);
  });

  it("encodes archive catalog query and rejects duplicate backend items", async () => {
    const urls: string[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    let duplicate = false;
    const fetcher: typeof fetch = async (input, init) => {
      urls.push(String(input));
      signals.push(init?.signal);
      return jsonResponse({
        items: duplicate
          ? [
              { id: "same", title: "A" },
              { id: "same", title: "B" },
            ]
          : [],
        next_cursor: null,
        has_more: false,
        total: null,
        total_kind: "not_computed",
      });
    };
    const runtime = createArchiveRuntime(createHttpClient({ baseUrl: "http://keydex", fetcher }));
    const controller = new AbortController();

    await runtime.listArchivedSessions({ query: "中文 %/_'", workspaceIds: ["ws/1", "ws-2"], cursor: "a+b=", limit: 20, signal: controller.signal });
    duplicate = true;

    expect(urls[0]).toContain("query=%E4%B8%AD%E6%96%87+%25%2F_%27");
    expect(urls[0]).toContain("cursor=a%2Bb%3D");
    expect(urls[0]).toContain("workspace_id=ws%2F1&workspace_id=ws-2");
    expect(signals[0]).toBe(controller.signal);
    await expect(runtime.listArchivedSessions()).rejects.toBeInstanceOf(
      ArchiveCatalogContractError,
    );
  });

  it("decodes lifecycle conflicts without parsing error messages", () => {
    const workspaceConflict = decodeLifecycleRuntimeError(
      new RuntimeHttpError({
        code: "workspace_archived",
        message: "localized message",
        details: { workspace_id: "ws-1", workspace_name: "Project" },
        status: 409,
        method: "POST",
        path: "/restore",
        body: {},
        rawText: "",
      }),
    );
    const cleanupFailed = decodeLifecycleRuntimeError(
      new RuntimeHttpError({
        code: "cleanup_failed",
        message: "localized message",
        details: { retryable: true, operation_id: "op-1" },
        status: 409,
        method: "POST",
        path: "/purge",
        body: {},
        rawText: "",
      }),
    );

    expect(workspaceConflict?.kind).toBe("workspace_archived");
    expect(workspaceConflict?.details.workspace_id).toBe("ws-1");
    expect(cleanupFailed).toMatchObject({ kind: "cleanup_failed", retryable: true });
  });
});
