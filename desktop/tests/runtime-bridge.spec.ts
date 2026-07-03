import { describe, expect, it, vi } from "vitest";

import type { AgentActionEnvelope, AgentInboundAction } from "@/types/protocol";
import { createRuntimeBridge } from "@/runtime/bridge";
import { RuntimeWsClient, type WsClientOptions } from "@/runtime/wsClient";

describe("RuntimeBridge", () => {
  it("routes settings and model calls through the backend HTTP facade", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/settings") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            model: {
              base_url: "https://api.example/v1",
              model: "qwen-coder",
              timeout_seconds: 60,
              api_key_set: true,
              api_key_preview: "sk-***",
            },
            appearance: {
              font_family: "maple-mono",
            },
            general: {
              close_window_behavior: null,
            },
          }),
        );
      }
      if (url.endsWith("/api/settings") && init.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return Promise.resolve(
          jsonResponse(200, {
            model: {
              base_url: "https://api.example/v1",
              model: "qwen-coder",
              timeout_seconds: 60,
              api_key_set: true,
              api_key_preview: "sk-***",
            },
            appearance: body.appearance ?? {
              font_family: "maple-mono",
            },
            general: body.general ?? {
              close_window_behavior: null,
            },
          }),
        );
      }
      if (url.endsWith("/api/models/refresh") && init.method === "POST") {
        return Promise.resolve(jsonResponse(200, { models: [{ id: "qwen-coder" }], cached: false }));
      }
      if (url.includes("/api/sessions/ses-1/workspace/search?") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, [{ path: "src/main.ts", name: "main.ts", type: "file" }]));
      }
      if (url.includes("/api/workspaces/ws-1/media?") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            path: "docs/assets/pixel.png",
            media_type: "image/png",
            size: 68,
            data_url: "data:image/png;base64,abc",
          }),
        );
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765/", fetcher });

    await expect(runtime.settings.getSettings()).resolves.toMatchObject({
      model: { model: "qwen-coder", api_key_set: true },
      appearance: { font_family: "maple-mono" },
      general: { close_window_behavior: null },
    });
    await expect(runtime.settings.saveAppearanceSettings({ font_family: "system" })).resolves.toMatchObject({
      appearance: { font_family: "system" },
    });
    await expect(
      runtime.settings.saveGeneralSettings({ close_window_behavior: "minimize_to_tray" }),
    ).resolves.toMatchObject({
      general: { close_window_behavior: "minimize_to_tray" },
    });
    await expect(runtime.models.refreshModels({ model: "qwen-coder" })).resolves.toEqual({
      models: [{ id: "qwen-coder" }],
      cached: false,
    });
    await expect(runtime.workspace.search({ sessionId: "ses-1" }, "main")).resolves.toEqual([
      { path: "src/main.ts", name: "main.ts", type: "file" },
    ]);
    await expect(runtime.workspace.readMedia({ workspaceId: "ws-1" }, "docs/assets/pixel.png")).resolves.toMatchObject({
      media_type: "image/png",
      data_url: "data:image/png;base64,abc",
    });

    expect(fetcher).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8765/api/settings", {
      method: "GET",
      headers: {},
      body: undefined,
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "http://127.0.0.1:8765/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appearance: { font_family: "system" } }),
    });
    expect(fetcher).toHaveBeenNthCalledWith(3, "http://127.0.0.1:8765/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ general: { close_window_behavior: "minimize_to_tray" } }),
    });
    expect(fetcher).toHaveBeenNthCalledWith(4, "http://127.0.0.1:8765/api/models/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: { model: "qwen-coder" } }),
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:8765/api/sessions/ses-1/workspace/search?q=main",
      {
        method: "GET",
        headers: {},
        body: undefined,
      },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      6,
      "http://127.0.0.1:8765/api/workspaces/ws-1/media?path=docs%2Fassets%2Fpixel.png",
      {
        method: "GET",
        headers: {},
        body: undefined,
      },
    );
  });

  it("routes workspace annotation CRUD calls to scoped backend endpoints", async () => {
    const anchor = {
      version: 2,
      kind: "source-range",
      sourceStart: 10,
      sourceEnd: 22,
      selectedText: "if (enabled)",
      sourceText: "if (enabled)",
      contentHash: "hash-1",
      lineStart: 3,
      lineEnd: 4,
      columnStart: 1,
      columnEnd: 14,
      createdInView: "source",
    } as const;
    const annotation = {
      id: "ann 1",
      scope_type: "session",
      scope_id: "ses 1",
      workspace_id: "ws-1",
      path: "src/main.ts",
      anchor_type: "selection",
      comment: "Check this branch",
      selected_text: "if (enabled)",
      line_start: 3,
      line_end: 4,
      column_start: 1,
      column_end: 14,
      content_hash: "hash-1",
      anchor_json: anchor,
      created_at: "2026-06-24T00:00:00Z",
      updated_at: "2026-06-24T00:00:00Z",
    };
    const signal = new AbortController().signal;
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (
        url.endsWith("/api/sessions/ses%201/workspace/annotations?path=src%2Fmain.ts") &&
        init.method === "GET"
      ) {
        return Promise.resolve(jsonResponse(200, [annotation]));
      }
      if (url.endsWith("/api/sessions/ses%201/workspace/annotations") && init.method === "POST") {
        return Promise.resolve(jsonResponse(200, annotation));
      }
      if (url.endsWith("/api/workspaces/ws%201/annotations/ann%201") && init.method === "PATCH") {
        return Promise.resolve(jsonResponse(200, { ...annotation, scope_type: "workspace", scope_id: "ws 1" }));
      }
      if (url.endsWith("/api/sessions/ses%201/workspace/annotations/ann%201") && init.method === "DELETE") {
        return Promise.resolve(jsonResponse(204, undefined));
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });

    await expect(runtime.workspace.listAnnotations({ sessionId: "ses 1" }, "src/main.ts", { signal })).resolves.toEqual([
      annotation,
    ]);
    await expect(
      runtime.workspace.createAnnotation(
        { sessionId: "ses 1" },
        {
          path: "src/main.ts",
          anchor_type: "selection",
          comment: "Check this branch",
          selected_text: "if (enabled)",
          line_start: 3,
          line_end: 4,
          column_start: 1,
          column_end: 14,
          content_hash: "hash-1",
          anchor_json: anchor,
        },
      ),
    ).resolves.toEqual(annotation);
    await expect(
      runtime.workspace.updateAnnotation(
        { workspaceId: "ws 1" },
        "ann 1",
        { comment: "Updated comment", anchor_json: anchor },
      ),
    ).resolves.toMatchObject({ anchor_json: anchor, comment: "Check this branch", scope_type: "workspace" });
    await expect(runtime.workspace.deleteAnnotation({ sessionId: "ses 1" }, "ann 1")).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8765/api/sessions/ses%201/workspace/annotations?path=src%2Fmain.ts",
      expect.objectContaining({ method: "GET", signal }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8765/api/sessions/ses%201/workspace/annotations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          path: "src/main.ts",
          anchor_type: "selection",
          comment: "Check this branch",
          selected_text: "if (enabled)",
          line_start: 3,
          line_end: 4,
          column_start: 1,
          column_end: 14,
          content_hash: "hash-1",
          anchor_json: anchor,
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8765/api/workspaces/ws%201/annotations/ann%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ comment: "Updated comment", anchor_json: anchor }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8765/api/sessions/ses%201/workspace/annotations/ann%201",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("routes workspace registry calls to the backend workspace API", async () => {
    const workspace = {
      id: "ws-1",
      name: "keydex",
      root_path: "D:/Pycharm Projects/keydex",
      normalized_root_path: "d:/pycharm projects/keydex",
      type: "project",
      created_at: "2026-06-21T00:00:00Z",
      updated_at: "2026-06-21T00:00:00Z",
      last_opened_at: null,
      is_deleted: false,
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/workspaces") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { list: [workspace], total: 1 }));
      }
      if (url.endsWith("/api/workspaces") && init.method === "POST") {
        return Promise.resolve(jsonResponse(200, { workspace }));
      }
      if (url.endsWith("/api/workspaces/ws%201") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { workspace: { ...workspace, id: "ws 1" } }));
      }
      if (url.endsWith("/api/workspaces/ws%201") && init.method === "PATCH") {
        return Promise.resolve(jsonResponse(200, { workspace: { ...workspace, id: "ws 1", name: "repo" } }));
      }
      if (url.endsWith("/api/workspaces/ws%201") && init.method === "DELETE") {
        return Promise.resolve(jsonResponse(204, undefined));
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });

    await expect(runtime.workspaces.list()).resolves.toMatchObject({ total: 1, list: [{ id: "ws-1" }] });
    await expect(
      runtime.workspaces.create({ rootPath: "D:/Pycharm Projects/keydex", name: "keydex" }),
    ).resolves.toMatchObject({ id: "ws-1" });
    await expect(runtime.workspaces.get("ws 1")).resolves.toMatchObject({ id: "ws 1" });
    await expect(runtime.workspaces.update("ws 1", { name: "repo", touch: true })).resolves.toMatchObject({
      name: "repo",
    });
    await expect(runtime.workspaces.delete("ws 1")).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8765/api/workspaces", expect.objectContaining({
      method: "GET",
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "http://127.0.0.1:8765/api/workspaces", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ root_path: "D:/Pycharm Projects/keydex", name: "keydex" }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8765/api/workspaces/ws%201",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8765/api/workspaces/ws%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "repo", touch: true }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:8765/api/workspaces/ws%201",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("routes conversation HTTP calls to session and history endpoints", async () => {
    const session = {
      id: "ses-1",
      user_id: "local-user",
      scene_id: "desktop-agent",
      status: "active",
      title: "会话",
      session_tag: "chat",
      session_type: "workspace",
      workspace_id: "ws-1",
      cwd: "D:/repo",
      workspace_roots: ["D:/repo"],
      workspace: {
        id: "ws-1",
        name: "repo",
        root_path: "D:/repo",
        normalized_root_path: "d:/repo",
        type: "project",
        created_at: "2026-06-18T00:00:00Z",
        updated_at: "2026-06-18T00:00:00Z",
        last_opened_at: null,
        is_deleted: false,
      },
      active_session_id: null,
      parent_session_id: null,
      child_session_id: null,
      source_trace_id: null,
      created_at: "2026-06-18T00:00:00Z",
      updated_at: "2026-06-18T00:00:00Z",
      is_debug: false,
      is_scheduled: false,
      is_current: false,
      current_model_provider_id: "provider-1",
      current_model: "qwen-coder",
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.includes("/api/sessions?") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { list: [session], total: 1, page: 1, page_size: 20 }));
      }
      if (url.endsWith("/api/sessions") && init.method === "POST") {
        return Promise.resolve(jsonResponse(200, { session }));
      }
      if (url.endsWith("/api/sessions/ses%201") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { session: { ...session, id: "ses 1" } }));
      }
      if (url.endsWith("/api/sessions/ses%201") && init.method === "PATCH") {
        return Promise.resolve(jsonResponse(200, { session: { ...session, id: "ses 1", title: "新标题" } }));
      }
      if (url.endsWith("/api/sessions/ses%201") && init.method === "DELETE") {
        return Promise.resolve(jsonResponse(204, undefined));
      }
      if (url.includes("/api/sessions/ses%201/history?") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            list: [{ role: "assistant", content: "历史" }],
            total: 1,
            page: 1,
            page_size: 50,
            session,
            event_total: 3,
            turn_indexes: [1],
          }),
        );
      }
      if (url.includes("/api/sessions/ses%201/tool-details?") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            detail: {
              toolName: "read_file",
              toolParams: { path: "README.md" },
              toolResult: "content",
            },
          }),
        );
      }
      if (url.endsWith("/api/sessions/ses%201/fork") && init.method === "POST") {
        return Promise.resolve(
          jsonResponse(200, {
            session: {
              ...session,
              id: "ses-fork",
              fork_source: {
                id: "fork 1",
                source_session_id: "ses 1",
                target_session_id: "ses-fork",
                source_message_event_id: "evt 1",
                target_message_event_id: "evt fork 1",
                source_turn_index: 1,
                target_turn_index: 1,
                source_checkpoint_id: "ckpt_1",
                source_checkpoint_ns: "",
                relation_type: "fork",
                created_at: "2026-06-17T10:00:00Z",
                updated_at: "2026-06-17T10:00:00Z",
              },
            },
            source: {
              session_id: "ses 1",
              active_session_id: "ses 1",
              checkpoint_id: "ckpt_1",
              checkpoint_ns: "",
              trace_id: "trace_1",
              turn_index: 1,
              message_event_id: "evt 1",
              source_type: "message_event",
            },
          }),
        );
      }
      if (url.endsWith("/api/sessions/ses%201/reverse") && init.method === "POST") {
        return Promise.resolve(
          jsonResponse(200, {
            session: { ...session, id: "ses 1" },
            source: {
              session_id: "ses 1",
              active_session_id: "ses 1",
              checkpoint_id: "ckpt_1",
              checkpoint_ns: "",
              trace_id: "trace_1",
              turn_index: 1,
              message_event_id: "evt 1",
              source_type: "message_event",
            },
          }),
        );
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });

    await expect(
      runtime.conversation.listSessions({
        title: "会话",
        sessionType: "workspace",
        workspaceId: "ws-1",
        page: 1,
        pageSize: 20,
      }),
    ).resolves.toMatchObject({
      list: [{ id: "ses-1" }],
    });
    await expect(
      runtime.conversation.createSession({
        title: "会话",
        sessionType: "workspace",
        workspaceId: "ws-1",
        cwd: "D:/repo",
        workspaceRoots: ["D:/repo"],
      }),
    ).resolves.toMatchObject({ id: "ses-1" });
    await expect(runtime.conversation.getSession("ses 1")).resolves.toMatchObject({ id: "ses 1" });
    await expect(runtime.conversation.updateSession("ses 1", { title: "新标题" })).resolves.toMatchObject({
      id: "ses 1",
      title: "新标题",
    });
    await expect(runtime.conversation.deleteSession("ses 1")).resolves.toBeUndefined();
    await expect(runtime.conversation.loadHistory("ses 1", { turnIndex: 1, order: "asc" })).resolves.toMatchObject({
      list: [{ role: "assistant", content: "历史" }],
      turn_indexes: [1],
    });
    await expect(
      runtime.conversation.loadToolDetails("ses 1", {
        startEventId: "evt start",
        endEventId: "evt end",
      }),
    ).resolves.toMatchObject({
      toolName: "read_file",
      toolResult: "content",
    });
    await expect(
      runtime.conversation.forkSession("ses 1", {
        messageEventId: "evt 1",
        title: "从这里继续",
        sessionTag: "btw",
      }),
    ).resolves.toMatchObject({ session: { id: "ses-fork" }, source: { checkpoint_id: "ckpt_1" } });
    await expect(
      runtime.conversation.reverseSession("ses 1", {
        traceId: "trace_1",
      }),
    ).resolves.toMatchObject({ session: { id: "ses 1" }, source: { trace_id: "trace_1" } });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8765/api/sessions?session_type=workspace&workspace_id=ws-1&title=%E4%BC%9A%E8%AF%9D&page=1&page_size=20",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8765/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "会话",
          session_type: "workspace",
          workspace_id: "ws-1",
          cwd: "D:/repo",
          workspace_roots: ["D:/repo"],
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8765/api/sessions/ses%201",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8765/api/sessions/ses%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "新标题" }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:8765/api/sessions/ses%201",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      6,
      "http://127.0.0.1:8765/api/sessions/ses%201/history?turn_index=1&order=asc",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      7,
      "http://127.0.0.1:8765/api/sessions/ses%201/tool-details?start_event_id=evt+start&end_event_id=evt+end",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      8,
      "http://127.0.0.1:8765/api/sessions/ses%201/fork",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "从这里继续", session_tag: "btw", message_event_id: "evt 1" }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      9,
      "http://127.0.0.1:8765/api/sessions/ses%201/reverse",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ trace_id: "trace_1" }),
      }),
    );
  });

  it("routes thread task calls through the conversation runtime API", async () => {
    const task = {
      id: "task 1",
      session_id: "ses 1",
      type: "goal",
      type_label: "目标",
      title: "长程目标",
      objective: "完成目标",
      status: "active",
      metadata: { source: "menu" },
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
    };
    const run = {
      id: "run 1",
      task_id: "task 1",
      session_id: "ses 1",
      turn_index: null,
      trace_id: null,
      status: "running",
      summary: {},
      error: {},
      started_at: "2026-07-03T00:00:00Z",
      finished_at: null,
      created_at: "2026-07-03T00:00:00Z",
      updated_at: "2026-07-03T00:00:00Z",
      is_running: true,
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/sessions/ses%201/tasks") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { list: [task] }));
      }
      if (url.endsWith("/api/sessions/ses%201/tasks") && init.method === "POST") {
        const body = JSON.parse(String(init.body));
        return Promise.resolve(jsonResponse(200, { task: { ...task, ...body } }));
      }
      if (url.endsWith("/api/sessions/ses%201/tasks/task%201") && init.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        return Promise.resolve(jsonResponse(200, { task: { ...task, ...body } }));
      }
      if (url.endsWith("/api/sessions/ses%201/tasks/task%201") && init.method === "DELETE") {
        return Promise.resolve(
          jsonResponse(200, {
            task: { ...task, status: "cancelled", deleted_at: "2026-07-03T00:01:00Z" },
          }),
        );
      }
      if (url.endsWith("/api/sessions/ses%201/tasks/task%201/runs") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { list: [run] }));
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });

    await expect(runtime.conversation.listThreadTasks("ses 1")).resolves.toMatchObject([{ id: "task 1" }]);
    await expect(
      runtime.conversation.createThreadTask("ses 1", {
        type: "goal",
        objective: "完成目标",
        title: "长程目标",
        metadata: { source: "menu" },
      }),
    ).resolves.toMatchObject({ objective: "完成目标", title: "长程目标" });
    await expect(runtime.conversation.updateThreadTask("ses 1", "task 1", { status: "paused" })).resolves.toMatchObject({
      status: "paused",
    });
    await expect(runtime.conversation.updateThreadTask("ses 1", "task 1", { status: "active" })).resolves.toMatchObject({
      status: "active",
    });
    await expect(runtime.conversation.deleteThreadTask("ses 1", "task 1")).resolves.toMatchObject({
      status: "cancelled",
      deleted_at: "2026-07-03T00:01:00Z",
    });
    await expect(runtime.conversation.listThreadTaskRuns("ses 1", "task 1")).resolves.toMatchObject([
      { id: "run 1", status: "running" },
    ]);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8765/api/sessions/ses%201/tasks",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8765/api/sessions/ses%201/tasks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          type: "goal",
          objective: "完成目标",
          title: "长程目标",
          metadata: { source: "menu" },
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8765/api/sessions/ses%201/tasks/task%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "paused" }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8765/api/sessions/ses%201/tasks/task%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:8765/api/sessions/ses%201/tasks/task%201",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      6,
      "http://127.0.0.1:8765/api/sessions/ses%201/tasks/task%201/runs",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("routes usage statistics calls to real backend paths", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.includes("/api/usage/summary?") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            request_count: 1,
            total_tokens: 55,
            input_tokens: 49,
            cache_read_tokens: 12,
            output_tokens: 6,
            success_count: 1,
            failed_count: 0,
            avg_duration_ms: 2400,
          }),
        );
      }
      if (url.includes("/api/usage/trend?") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            points: [
              {
                time: "2026-06-18",
                request_count: 1,
                input_tokens: 49,
                cache_read_tokens: 12,
                output_tokens: 6,
                total_tokens: 55,
                failed_count: 0,
              },
            ],
          }),
        );
      }
      if (url.includes("/api/usage/requests?") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            list: [{ id: "llm_req_1", model: "deepseek-v4-flash", status: "completed" }],
            total: 1,
            page: 2,
            page_size: 10,
          }),
        );
      }
      if (url.endsWith("/api/usage/requests/llm%20req%201") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            request: { id: "llm req 1", model: "deepseek-v4-flash", status: "completed" },
            trace: null,
            events: [],
          }),
        );
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });

    await expect(
      runtime.usage.getSummary({
        startTime: "2026-06-18T00:00:00Z",
        endTime: "2026-06-19T00:00:00Z",
        model: "deepseek-v4-flash",
      }),
    ).resolves.toMatchObject({ request_count: 1, total_tokens: 55 });
    await expect(
      runtime.usage.getTrend({
        bucket: "day",
        limit: 168,
        model: "deepseek-v4-flash",
        startAfter: "2026-06-18",
        timezoneOffsetMinutes: 480,
      }),
    ).resolves.toMatchObject({
      points: [{ time: "2026-06-18" }],
    });
    await expect(
      runtime.usage.listRequests({ status: "completed", page: 2, pageSize: 10 }),
    ).resolves.toMatchObject({
      total: 1,
      page: 2,
      page_size: 10,
    });
    await expect(runtime.usage.getRequestDetail("llm req 1")).resolves.toMatchObject({
      request: { id: "llm req 1" },
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8765/api/usage/summary?start_time=2026-06-18T00%3A00%3A00Z&end_time=2026-06-19T00%3A00%3A00Z&model=deepseek-v4-flash",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8765/api/usage/trend?model=deepseek-v4-flash&bucket=day&timezone_offset_minutes=480&start_after=2026-06-18&limit=168",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8765/api/usage/requests?status=completed&page=2&page_size=10",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8765/api/usage/requests/llm%20req%201",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("opens chat websocket channels and sends action envelopes", () => {
    const createdOptions: WsClientOptions[] = [];
    const clients: FakeRuntimeWsClient[] = [];
    const runtime = createRuntimeBridge({
      baseUrl: "https://agent.example",
      wsClientFactory(options) {
        createdOptions.push(options);
        const client = new FakeRuntimeWsClient(options);
        clients.push(client);
        return client;
      },
    });
    const onEvent = vi.fn();

    const channel = runtime.conversation.openChatChannel(onEvent, { sessionId: "ses-1" });
    channel.chat({ message: "你好" });
    channel.cancel();
    channel.requestStatus();
    channel.ping();

    expect(createdOptions[0].baseUrl).toBe("wss://agent.example");
    expect(clients[0].connectedWith).toEqual({ sessionId: "ses-1" });
    expect(clients[0].sent).toEqual([
      { action: "chat", data: { message: "你好" } },
      { action: "cancel", data: { session_id: "ses-1" } },
      { action: "get_status", data: { session_id: "ses-1" } },
      { action: "ping", data: {} },
    ]);
    expect(channel.getStatus()).toBe("open");
    expect(channel.getSessionId()).toBe("ses-1");
  });

  it("routes model provider commands to real backend paths", async () => {
    const provider = {
      id: "provider-1",
      name: "主模型",
      base_url: "http://provider.test/v1",
      enabled: true,
      api_key_set: true,
      models: ["qwen-coder"],
      model_enabled: { "qwen-coder": true },
      health: {},
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/model-providers") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { providers: [provider] }));
      }
      if (url.endsWith("/api/model-providers") && init.method === "POST") {
        return Promise.resolve(jsonResponse(201, provider));
      }
      if (url.endsWith("/api/model-providers/provider-1") && init.method === "PATCH") {
        return Promise.resolve(jsonResponse(200, { ...provider, name: "更新模型" }));
      }
      if (url.endsWith("/api/model-providers/provider-1/refresh") && init.method === "POST") {
        return Promise.resolve(jsonResponse(200, { provider, models: ["qwen-coder"] }));
      }
      if (
        url.endsWith("/api/model-providers/provider-1/models/qwen-coder/health") &&
        init.method === "POST"
      ) {
        return Promise.resolve(
          jsonResponse(200, {
            provider,
            health: {
              status: "healthy",
              latency_ms: 12,
              error: null,
              checked_at: "2026-06-17T10:00:00Z",
            },
          }),
        );
      }
      if (url.endsWith("/api/model-providers/provider-1") && init.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });

    await expect(runtime.models.listProviders()).resolves.toEqual([provider]);
    await expect(
      runtime.models.createProvider({ name: "主模型", base_url: "http://provider.test/v1" }),
    ).resolves.toEqual(provider);
    await expect(runtime.models.updateProvider("provider-1", { name: "更新模型" })).resolves.toMatchObject({
      name: "更新模型",
    });
    await expect(runtime.models.refreshProviderModels("provider-1")).resolves.toEqual(provider);
    await expect(runtime.models.checkModelHealth("provider-1", "qwen-coder")).resolves.toMatchObject({
      health: { status: "healthy" },
    });
    await expect(runtime.models.deleteProvider("provider-1")).resolves.toBeUndefined();
  });
});

class FakeRuntimeWsClient extends RuntimeWsClient {
  connectedWith: { sessionId: string | null } | null = null;
  sent: Array<{ action: string; data: Record<string, unknown> }> = [];
  private fakeStatus: ReturnType<RuntimeWsClient["getStatus"]> = "idle";
  private fakeSessionId: string | null = null;

  constructor(readonly createdWith: WsClientOptions) {
    super(createdWith);
  }

  override connect(sessionId?: string | null) {
    this.connectedWith = { sessionId: sessionId ?? null };
    this.fakeSessionId = sessionId ?? null;
    this.fakeStatus = "open";
  }

  override close() {
    this.fakeStatus = "closed";
  }

  override getStatus() {
    return this.fakeStatus;
  }

  override getSessionId() {
    return this.fakeSessionId;
  }

  override sendAction(action: AgentInboundAction, data: Record<string, unknown> = {}) {
    this.sent.push({ action, data });
  }

  override chat(data: Record<string, unknown>) {
    this.sent.push({ action: "chat", data });
  }

  override cancel(sessionId = this.fakeSessionId) {
    this.sent.push({ action: "cancel", data: sessionId ? { session_id: sessionId } : {} });
  }

  override requestStatus(sessionId = this.fakeSessionId) {
    this.sent.push({ action: "get_status", data: sessionId ? { session_id: sessionId } : {} });
  }

  override ping() {
    this.sent.push({ action: "ping", data: {} });
  }

  emit(event: AgentActionEnvelope) {
    this.createdWith.onEvent(event);
  }
}

function jsonResponse(status: number, body: unknown) {
  if (status === 204) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
