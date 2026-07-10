import { describe, expect, it } from "vitest";

import {
  AGENT_CHAT_ACTIONS,
  AGENT_COMPLETED_EVENT_ITEM_ACTIONS,
  AGENT_INBOUND_ACTIONS,
  AGENT_REPLAY_ACTIONS,
  type A2UIAckActionData,
  type A2UICancelActionPayload,
  type A2UICreatedActionData,
  type A2UIObject,
  type A2UIResumeActionData,
  type A2UIStreamActionData,
  type A2UISubmitActionPayload,
  type A2UIWaitingInputActionData,
  type A2UIWaitingInputStatusItem,
  type ApprovalKind,
  type CommandApprovalTrustScope,
  type AgentActionEnvelope,
  type AgentChatMessage,
  type AgentCompletedPayload,
  type AgentRuntimeSettings,
  type AgentSession,
  type AgentThreadTaskStatusData,
  type AgentToolEventData,
  type AgentTurnStartedData,
  type FileEditToolStyle,
  type McpErrorPayload,
  type McpAuditRecord,
  type McpImportPreviewResponse,
  type McpOAuthStatusResponse,
  type McpRuntimeSnapshotSummary,
  type McpRuntimeStatusResponse,
  type McpServerCreatePayload,
  type McpServerDetailResponse,
  type McpServerSummary,
  type McpSessionToolOverride,
  type McpToolEventMetadata,
  type McpToolSummary,
  type McpTrustRule,
  type ThreadTask,
  type ThreadTaskEventData,
  type ThreadTaskRun,
  type ThreadTaskRunEventData,
} from "@/types/protocol";

describe("agent protocol types", () => {
  it("exposes action constants aligned with the backend event contract", () => {
    expect(AGENT_CHAT_ACTIONS).toContain("session_created");
    expect(AGENT_CHAT_ACTIONS).toContain("stream");
    expect(AGENT_CHAT_ACTIONS).toContain("llm_first_token");
    expect(AGENT_CHAT_ACTIONS).toContain("a2ui_stream_start");
    expect(AGENT_CHAT_ACTIONS).toContain("a2ui_stream_chunk");
    expect(AGENT_CHAT_ACTIONS).toContain("a2ui_stream_finish");
    expect(AGENT_CHAT_ACTIONS).toContain("a2ui_created");
    expect(AGENT_CHAT_ACTIONS).toContain("waiting_input");
    expect(AGENT_CHAT_ACTIONS).toContain("a2ui_submit_ack");
    expect(AGENT_CHAT_ACTIONS).toContain("a2ui_cancel_ack");
    expect(AGENT_CHAT_ACTIONS).toContain("a2ui_resume");
    expect(AGENT_CHAT_ACTIONS).toContain("a2ui_waiting_input");
    expect(AGENT_CHAT_ACTIONS).toContain("tool_start");
    expect(AGENT_CHAT_ACTIONS).toContain("tool_progress");
    expect(AGENT_CHAT_ACTIONS).toContain("tool_end");
    expect(AGENT_CHAT_ACTIONS).toContain("reasoning");
    expect(AGENT_CHAT_ACTIONS).toContain("completed");
    expect(AGENT_CHAT_ACTIONS).toContain("session_title_updated");
    expect(AGENT_CHAT_ACTIONS).toContain("task_updated");
    expect(AGENT_CHAT_ACTIONS).toContain("task_deleted");
    expect(AGENT_CHAT_ACTIONS).toContain("task_run_started");
    expect(AGENT_CHAT_ACTIONS).toContain("task_run_finished");
    expect(AGENT_CHAT_ACTIONS).toContain("turn_started");
    expect(AGENT_CHAT_ACTIONS).toContain("thread_task_status");
    expect(AGENT_CHAT_ACTIONS).toContain("pending_input_submitted");
    expect(AGENT_CHAT_ACTIONS).toContain("pending_input_updated");
    expect(AGENT_CHAT_ACTIONS).toContain("pending_inputs_reordered");
    expect(AGENT_CHAT_ACTIONS).toContain("pending_input_cancelled");
    expect(AGENT_CHAT_ACTIONS).toContain("pending_input_delivered");
    expect(AGENT_CHAT_ACTIONS).toContain("pending_input_converted");
    expect(AGENT_CHAT_ACTIONS).toContain("pending_input_paused");
    expect(AGENT_CHAT_ACTIONS).toContain("pending_input_resumed");
    expect(AGENT_CHAT_ACTIONS).toContain("pending_input_failed");
    expect(AGENT_CHAT_ACTIONS).toContain("mcp_server_status_changed");
    expect(AGENT_CHAT_ACTIONS).toContain("mcp_runtime_snapshot_created");
    expect(AGENT_CHAT_ACTIONS).toContain("mcp_tool_policy_changed");
    expect(AGENT_CHAT_ACTIONS).toContain("mcp_elicitation_requested");
    expect(AGENT_CHAT_ACTIONS).toContain("mcp_elicitation_resolved");
    expect(AGENT_CHAT_ACTIONS).toContain("mcp_oauth_required");
    expect(AGENT_REPLAY_ACTIONS).toContain("stream_batch");
    expect(AGENT_REPLAY_ACTIONS).toContain("a2ui_created");
    expect(AGENT_REPLAY_ACTIONS).toContain("waiting_input");
    expect(AGENT_REPLAY_ACTIONS).toContain("reasoning");
    expect(AGENT_REPLAY_ACTIONS).toContain("task_updated");
    expect(AGENT_REPLAY_ACTIONS).toContain("task_run_finished");
    expect(AGENT_REPLAY_ACTIONS).toContain("turn_started");
    expect(AGENT_REPLAY_ACTIONS).toContain("thread_task_status");
    expect(AGENT_REPLAY_ACTIONS).toContain("pending_input_submitted");
    expect(AGENT_REPLAY_ACTIONS).toContain("pending_input_updated");
    expect(AGENT_REPLAY_ACTIONS).toContain("pending_inputs_reordered");
    expect(AGENT_REPLAY_ACTIONS).toContain("pending_input_cancelled");
    expect(AGENT_REPLAY_ACTIONS).toContain("pending_input_delivered");
    expect(AGENT_REPLAY_ACTIONS).toContain("pending_input_converted");
    expect(AGENT_REPLAY_ACTIONS).toContain("pending_input_paused");
    expect(AGENT_REPLAY_ACTIONS).toContain("pending_input_resumed");
    expect(AGENT_REPLAY_ACTIONS).toContain("pending_input_failed");
    expect(AGENT_REPLAY_ACTIONS).toContain("mcp_runtime_snapshot_created");
    expect(AGENT_REPLAY_ACTIONS).toContain("mcp_oauth_required");
    expect(AGENT_COMPLETED_EVENT_ITEM_ACTIONS).toEqual([
      "ai_message",
      "tool_start",
      "tool_end",
      "stream",
      "reasoning_message",
    ]);
    expect(AGENT_INBOUND_ACTIONS).toContain("create_session");
    expect(AGENT_INBOUND_ACTIONS).toContain("bind_session");
    expect(AGENT_INBOUND_ACTIONS).toContain("a2ui_submit");
    expect(AGENT_INBOUND_ACTIONS).toContain("a2ui_cancel");
    expect(AGENT_INBOUND_ACTIONS).toContain("pending_input_update");
    expect(AGENT_INBOUND_ACTIONS).toContain("pending_input_reorder");
    expect(AGENT_INBOUND_ACTIONS).toContain("pending_input_cancel");
    expect(AGENT_INBOUND_ACTIONS).toContain("pending_input_resume");
    expect(AGENT_INBOUND_ACTIONS).toContain("cancel");
  });

  it("constructs runtime settings with file edit tool style", () => {
    const claude = "claude_code" satisfies FileEditToolStyle;
    const codex = "codex" satisfies FileEditToolStyle;
    const settings = {
      file_edit_tool_style: claude,
      auto_title: {
        enabled: false,
        only_when_default_title: true,
        max_title_length: 20,
      },
      duplicate_tool_call_guard: {
        enabled: true,
        max_repeats: 3,
      },
      context_compression: {
        enabled: true,
        context_window_tokens: 256000,
        trigger_fraction: 0.8,
      },
      a2ui: {
        enabled: true,
        debug_info_enabled: false,
      },
    } satisfies AgentRuntimeSettings;

    expect(settings.file_edit_tool_style).toBe("claude_code");
    expect(codex).toBe("codex");
  });

  it("constructs MCP protocol shapes", () => {
    const approvalKind = "mcp_tool_call" satisfies ApprovalKind;
    const trustScope = "persistent_server" satisfies CommandApprovalTrustScope;
    const server = {
      id: "srv_1",
      name: "filesystem",
      description: "Local files",
      enabled: true,
      required: false,
      transport: "stdio",
      status: "online",
      tools_count: 3,
      resources_reserved: true,
      last_refresh_at: "2026-07-06T00:00:00Z",
      last_error_message: null,
    } satisfies McpServerSummary;
    const detail = {
      ...server,
      auth: {
        auth_type: "oauth",
        headers_configured: true,
        env_headers_configured: false,
        bearer_token_env_var: null,
        secret_ref_keys: ["api_key"],
        oauth_configured: true,
        oauth_resource: "https://mcp.example.test",
        oauth_scopes: ["tools:read"],
      },
      startup_timeout_sec: 30,
      tool_timeout_sec: 60,
      read_timeout_sec: 60,
      sse_read_timeout_sec: 300,
      shutdown_timeout_sec: 10,
      auto_refresh: true,
      refresh_interval_sec: 60,
      default_tool_exposure_mode: "allow_all_except_disabled",
      default_tool_approval_mode: "auto",
      elicitation_enabled: true,
      sampling_enabled: false,
    } satisfies McpServerDetailResponse;
    const tool = {
      id: "tool_1",
      server_id: "srv_1",
      server_name: "filesystem",
      raw_name: "read_file",
      model_name: "mcp__filesystem__read_file",
      display_name: "Read file",
      description: "Read a file",
      input_schema: { type: "object" },
      enabled: true,
      hidden: false,
      status: "unchanged",
      discovery_status: "unchanged",
      effective_state: "enabled",
      approval_mode: "auto",
      effective_approval_mode: "auto",
      annotations: { readOnlyHint: true },
      last_used_at: null,
    } satisfies McpToolSummary;
    const createServer = {
      name: "filesystem",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      default_tool_approval_mode: "prompt",
      default_tool_exposure_mode: "allow_all_except_disabled",
      resource_reserved_policy: { reserved_only: true },
    } satisfies McpServerCreatePayload;
    const override = {
      id: "override_1",
      session_id: "ses_1",
      server_id: "srv_1",
      raw_tool_name: "read_file",
      enabled: false,
      reason: "paused for current task",
      created_at: "2026-07-06T00:00:00Z",
    } satisfies McpSessionToolOverride;
    const snapshot = {
      id: "snap_1",
      snapshot_id: "snap_1",
      session_id: "ses_1",
      turn_id: "turn_1",
      servers_total: 2,
      servers_online: 1,
      tools_visible: 4,
      tools_disabled_for_session: 1,
      pending_approvals: 0,
      created_at: "2026-07-06T00:00:01Z",
    } satisfies McpRuntimeSnapshotSummary;
    const runtimeStatus = {
      session_id: "ses_1",
      manager: {
        enabled: true,
        runtime_status: "enabled",
        started: true,
        active_client_count: 1,
      },
      snapshot,
      servers: [server],
      tools: [tool],
      overrides: [override],
      running_calls: [],
      pending_approvals: 0,
      summary: {
        servers_total: 1,
        servers_online: 1,
        tools_total: 1,
        tools_enabled: 1,
        running_calls: 0,
        pending_approvals: 0,
      },
    } satisfies McpRuntimeStatusResponse;
    const importPreview = {
      source_type: "keydex",
      conflict_strategy: "skip",
      server_count: 1,
      servers: [
        {
          name: "filesystem",
          transport: "stdio",
          enabled: true,
          conflict: false,
          action: "create",
          missing_secrets: [],
          unknown_fields: [],
        },
      ],
      conflicts: [],
      missing_secrets: [],
      unknown_fields: [],
      valid: true,
    } satisfies McpImportPreviewResponse;
    const trustRule = {
      id: "trust_1",
      rule_kind: "tool_with_params",
      scope: "global",
      approval_mode: "approve",
      hit_count: 0,
      server_id: server.id,
      raw_tool_name: "read_file",
      condition: { arguments_sha256: "hash-a" },
      created_at: "2026-07-06T00:00:00Z",
      updated_at: "2026-07-06T00:00:00Z",
    } satisfies McpTrustRule;
    const oauth = {
      server_id: server.id,
      status: "authorized",
      token_configured: true,
      account_label: "user@example.test",
      scopes: ["tools:read"],
      expires_at: null,
    } satisfies McpOAuthStatusResponse;
    const audit = {
      id: "audit_1",
      event_type: "refresh.completed",
      server_id: server.id,
      status: "completed",
      summary: "refresh",
      detail: { tools_count: 1 },
      created_at: "2026-07-06T00:00:00Z",
    } satisfies McpAuditRecord;
    const metadata = {
      kind: "mcp_tool",
      server_id: "srv_1",
      server_name: "filesystem",
      raw_tool_name: "read_file",
      model_tool_name: "mcp__filesystem__read_file",
      snapshot_id: snapshot.snapshot_id,
    } satisfies McpToolEventMetadata;
    const error = {
      code: "server_offline",
      message: "MCP server is offline.",
      detail: { server_id: server.id },
    } satisfies McpErrorPayload;

    expect(approvalKind).toBe("mcp_tool_call");
    expect(trustScope).toBe("persistent_server");
    expect(createServer.args).toEqual(["server.js"]);
    expect(detail.auth.secret_ref_keys).toEqual(["api_key"]);
    expect(tool.model_name).toBe(metadata.model_tool_name);
    expect(runtimeStatus.overrides[0].enabled).toBe(false);
    expect(snapshot.tools_visible).toBe(4);
    expect(importPreview.servers[0].action).toBe("create");
    expect(trustRule.rule_kind).toBe("tool_with_params");
    expect(oauth.token_configured).toBe(true);
    expect(audit.event_type).toBe("refresh.completed");
    expect(error.code).toBe("server_offline");
  });

  it("constructs session and message shapes for all visible roles", () => {
    const session = {
      id: "ses_1",
      user_id: "local-user",
      scene_id: "desktop-agent",
      status: "running",
      title: "研读源码",
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
        created_at: "2026-06-18T01:00:00Z",
        updated_at: "2026-06-18T01:00:00Z",
        last_opened_at: null,
        is_deleted: false,
      },
      active_session_id: null,
      parent_session_id: null,
      child_session_id: null,
      source_trace_id: null,
      created_at: "2026-06-18T01:00:00Z",
      updated_at: "2026-06-18T01:01:00Z",
      is_debug: false,
      is_scheduled: false,
      is_current: true,
      current_model_provider_id: "provider-1",
      current_model: "qwen-coder",
    } satisfies AgentSession;

    const messages = [
      message("user", "需求说明", { attachments: [{ type: "file", name: "REQ.md", path: "REQ.md" }] }),
      message("assistant", "实现完成", {
        ghostStats: {
          traceId: "trace_1",
          inputTokens: 120,
          cacheReadTokens: 0,
          outputTokens: 80,
        },
      }),
      message("tool", "", {
        runId: "run_tool",
        toolName: "read_file",
        toolParams: { path: "README.md" },
        toolResult: "content",
        toolDurationMs: 12,
        status: "completed",
      }),
      message("system", "系统提示"),
      message("subagent", "子任务结果", {
        subagentName: "reviewer",
        subagentId: "sub_1",
        subagentToolCalls: [
          {
            runId: "run_sub_tool",
            toolName: "search_text",
            status: "completed",
          },
        ],
      }),
      message("reasoning", "正在分析", { reasoningKind: "progress_fact" }),
      message("error", "模型失败", { traceId: "trace_failed" }),
      message("a2ui", "", {
        contentType: "a2ui",
        content_type: "a2ui",
        a2ui: a2uiObject("chart", "render"),
      }),
      message("turn", "", { turnIndex: 3, metadata: { kind: "turn_started", source: "thread_task" } }),
      message("thread_task", "目标已完成", {
        toolName: "update_thread_task",
        toolParams: { status: "complete" },
        uiPayload: { task: { id: "task_1", type: "goal" } },
      }),
    ] satisfies AgentChatMessage[];

    expect(session.status).toBe("running");
    expect(messages.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "system",
      "subagent",
      "reasoning",
      "error",
      "a2ui",
      "turn",
      "thread_task",
    ]);
    expect(messages[0].attachments?.[0].name).toBe("REQ.md");
    expect(messages[1].ghostStats?.traceId).toBe("trace_1");
    expect(messages[2].toolName).toBe("read_file");
    expect(messages[7].a2ui?.render_key).toBe("chart");
  });

  it("constructs A2UI protocol shapes for builtin render keys", () => {
    const chart = a2uiObject("chart", "render", {
      payload: {
        title: "Token 使用趋势",
        series: [{ name: "输入", data: [10, 12, 8] }],
      },
      interaction: null,
    });
    const confirm = a2uiObject("confirm", "interactive", {
      payload: {
        title: "确认执行",
        description: "是否继续写入文件",
        confirm_label: "执行",
        cancel_label: "不执行",
      },
      interaction: {
        interaction_id: "int_confirm",
        status: "waiting_user_input",
        can_submit: true,
        resume_status: "not_started",
      },
    });
    const choice = a2uiObject("choice", "interactive", {
      payload: {
        title: "选择方案",
        multiple: true,
        options: [
          { value: "a", label: "方案 A" },
          { value: "b", label: "方案 B" },
        ],
      },
      interaction: {
        interaction_id: "int_choice",
        status: "submitted",
        can_submit: false,
        submit_request_id: "req_choice",
        submit_result: { selected_values: ["a"] },
        resume_status: "started",
      },
    });
    const form = a2uiObject("form", "interactive", {
      payload: {
        title: "补充信息",
        fields: [{ name: "reason", label: "原因", type: "textarea", required: true }],
      },
      interaction: {
        interaction_id: "int_form",
        status: "cancelled",
        can_submit: false,
        cancel_request_id: "req_form",
        cancel_reason: "用户取消",
        resume_status: "succeeded",
      },
    });
    const stream = {
      session_id: "ses_1",
      trace_id: "trace_a2ui",
      turn_index: 4,
      render_key: "confirm",
      mode: "interactive",
      stream_id: "a2ui:confirm:tool_call_1",
      tool_call_id: "tool_call_1",
      stream: {
        status: "chunk",
        chunk_index: 2,
        args_delta: "\"title\":\"确认\"",
        args_text_length: 24,
        parsed_payload: { title: "确认" },
        json_parse_status: "partial",
      },
    } satisfies A2UIStreamActionData;
    const created = {
      session_id: "ses_1",
      trace_id: "trace_a2ui",
      turn_index: 4,
      render_key: "confirm",
      mode: "interactive",
      stream_id: stream.stream_id,
      tool_call_id: "tool_call_1",
      interaction_id: "int_confirm",
      interaction: confirm.interaction,
      a2ui: confirm,
    } satisfies A2UICreatedActionData;
    const waiting = {
      session_id: "ses_1",
      reason: "a2ui",
      interaction_id: "int_confirm",
      render_key: "confirm",
      stream_id: stream.stream_id,
      tool_call_id: "tool_call_1",
      a2ui: confirm,
      checkpoint: { checkpoint_id: "ckpt_1" },
    } satisfies A2UIWaitingInputActionData;
    const pending = {
      session_id: "ses_1",
      interaction_id: "int_confirm",
      status: "waiting_user_input",
      can_submit: true,
      render_key: "confirm",
      stream_id: stream.stream_id,
    } satisfies A2UIWaitingInputStatusItem;
    const submit = {
      action: "a2ui_submit",
      session_id: "ses_1",
      interaction_id: "int_confirm",
      request_id: "req_submit",
      submit_result: { confirmed: true, note: "继续" },
    } satisfies A2UISubmitActionPayload;
    const cancel = {
      action: "a2ui_cancel",
      session_id: "ses_1",
      interaction_id: "int_confirm",
      request_id: "req_cancel",
      cancel_reason: "稍后处理",
    } satisfies A2UICancelActionPayload;
    const submitAck = {
      session_id: "ses_1",
      interaction_id: "int_confirm",
      request_id: submit.request_id,
      status: "submitted",
      can_submit: false,
      idempotent: false,
      interaction: {
        interaction_id: "int_confirm",
        status: "submitted",
        can_submit: false,
        submit_request_id: submit.request_id,
        submit_result: submit.submit_result,
        resume_status: "deferred",
        resume_group_id: "group_1",
        pending_count: 1,
      },
      submit_result: submit.submit_result,
      resume: {
        status: "deferred",
        started: false,
        resume_group_id: "group_1",
        pending_count: 1,
        reason: "waiting_for_group",
      },
    } satisfies A2UIAckActionData;
    const cancelAck = {
      session_id: "ses_1",
      interaction_id: "int_confirm",
      request_id: cancel.request_id,
      status: "cancelled",
      can_submit: false,
      cancel_reason: cancel.cancel_reason,
      resume: { status: "started", started: true, pending_count: 0 },
    } satisfies A2UIAckActionData;
    const resume = {
      session_id: "ses_1",
      interaction_id: "int_confirm",
      resume_status: "succeeded",
      resume_group_id: "group_1",
      pending_count: 0,
      resume_payload: { status: "submitted", interaction_id: "int_confirm" },
      resume_items: [{ interaction_id: "int_confirm" }],
    } satisfies A2UIResumeActionData;

    expect([chart, confirm, choice, form].map((item) => item.render_key)).toEqual([
      "chart",
      "confirm",
      "choice",
      "form",
    ]);
    expect(created.a2ui.interaction?.interaction_id).toBe(waiting.interaction_id);
    expect(pending.can_submit).toBe(true);
    expect(stream.stream.json_parse_status).toBe("partial");
    expect(submitAck.resume?.status).toBe("deferred");
    expect(cancelAck.status).toBe("cancelled");
    expect(resume.resume_status).toBe("succeeded");
  });

  it("constructs tool and completed websocket payloads", () => {
    const toolStart = {
      session_id: "ses_1",
      run_id: "run_1",
      parent_run_id: null,
      tool: "apply_patch",
      params: { patch: "*** Begin Patch" },
      status: "running",
      trace_id: "trace_1",
      files: [{ path: "src/app.ts", added_lines: 2, deleted_lines: 1 }],
    } satisfies AgentToolEventData;

    const mcpToolStart = {
      session_id: "ses_1",
      run_id: "run_mcp",
      tool: "mcp__srv_1__search",
      kind: "mcp_tool",
      snapshot_id: "snap_1",
      server_id: "srv_1",
      server_name: "Ticket MCP",
      raw_tool_name: "search",
      model_tool_name: "mcp__srv_1__search",
      metadata: {
        mcp: {
          kind: "mcp_tool",
          snapshot_id: "snap_1",
          server_id: "srv_1",
          raw_tool_name: "search",
          model_tool_name: "mcp__srv_1__search",
        },
      },
    } satisfies AgentToolEventData;

    const completed = {
      action: "completed",
      data: {
        session_id: "ses_1",
        status: "completed",
        trace_id: "trace_1",
        trace_record_id: "trace_1",
        events: [
          { action: "tool_start", data: toolStart },
          {
            action: "tool_end",
            data: {
              run_id: "run_1",
              tool: "apply_patch",
              result: "ok",
              duration_ms: 18,
            },
          },
          { action: "reasoning_message", data: { kind: "progress_fact", text: "已分析" } },
        ],
        chain_token_usage: {
          input_tokens: 100,
          cache_read_tokens: 10,
          output_tokens: 30,
        },
        latest_llm_token_usage: {
          input_tokens: 60,
          output_tokens: 20,
        },
        trace_query_context: {
          trace_id: "trace_1",
          trace_record_id: "trace_1",
        },
        final_content: "完成",
      },
    } satisfies AgentActionEnvelope<"completed", AgentCompletedPayload>;

    expect(completed.data.events.map((item) => item.action)).toEqual([
      "tool_start",
      "tool_end",
      "reasoning_message",
    ]);
    expect(completed.data.latest_llm_token_usage?.output_tokens).toBe(20);
    expect(mcpToolStart.kind).toBe("mcp_tool");
    expect(mcpToolStart.metadata.mcp.server_id).toBe("srv_1");
  });

  it("constructs thread task websocket payloads", () => {
    const task = {
      id: "task_1",
      session_id: "ses_1",
      type: "goal",
      type_label: "目标",
      title: "目标",
      objective: "完成目标",
      status: "active",
      metadata: {},
      evidence: [],
      blocked_audit: {},
      system_stop_reason: null,
      current_run_id: "run_1",
      turn_count: 1,
      elapsed_seconds: 2,
      token_usage: { total_tokens: 42 },
      created_at: "2026-07-03T00:00:00Z",
      updated_at: "2026-07-03T00:01:00Z",
      deleted_at: null,
      is_open: true,
      is_terminal: false,
    } satisfies ThreadTask;
    const run = {
      id: "run_1",
      task_id: "task_1",
      session_id: "ses_1",
      turn_index: 3,
      trace_id: "trace_1",
      status: "running",
      summary: {},
      error: {},
      started_at: "2026-07-03T00:00:10Z",
      finished_at: null,
      created_at: "2026-07-03T00:00:10Z",
      updated_at: "2026-07-03T00:00:10Z",
      is_running: true,
    } satisfies ThreadTaskRun;

    const updated = {
      action: "task_updated",
      data: {
        session_id: "ses_1",
        task_id: task.id,
        task,
        run_id: run.id,
        trace_id: "trace_1",
        turn_index: 3,
      },
    } satisfies AgentActionEnvelope<"task_updated", ThreadTaskEventData>;
    const runStarted = {
      action: "task_run_started",
      data: {
        session_id: "ses_1",
        task_id: task.id,
        task,
        run_id: run.id,
        run,
        status: "running",
        reason: "auto_continue",
        trace_id: null,
        turn_index: null,
      },
    } satisfies AgentActionEnvelope<"task_run_started", ThreadTaskRunEventData>;
    const deleted = {
      action: "task_deleted",
      data: {
        session_id: "ses_1",
        task_id: task.id,
        task: { ...task, status: "cancelled", deleted_at: "2026-07-03T00:02:00Z" },
      },
    } satisfies AgentActionEnvelope<"task_deleted", ThreadTaskEventData>;
    const runFinished = {
      action: "task_run_finished",
      data: {
        session_id: "ses_1",
        task_id: task.id,
        task: { ...task, current_run_id: null },
        run_id: run.id,
        run: { ...run, status: "succeeded", is_running: false, finished_at: "2026-07-03T00:02:00Z" },
        run_status: "succeeded",
        trace_id: "trace_1",
        turn_index: 3,
      },
    } satisfies AgentActionEnvelope<"task_run_finished", ThreadTaskRunEventData>;
    const turnStarted = {
      action: "turn_started",
      data: {
        session_id: "ses_1",
        turn_index: 3,
        trace_id: "trace_1",
        source: "thread_task",
        source_label: "目标继续执行",
        thread_task: { task_id: task.id, run_id: run.id, trigger: "task_continue", type: "goal" },
      },
    } satisfies AgentActionEnvelope<"turn_started", AgentTurnStartedData>;
    const statusUpdated = {
      action: "thread_task_status",
      data: {
        session_id: "ses_1",
        turn_index: 3,
        trace_id: "trace_1",
        task_id: task.id,
        run_id: run.id,
        type: "goal",
        status: "complete",
        summary: "目标已完成",
        payload: { status: "complete", summary: "目标已完成" },
        task: { ...task, status: "complete" },
        ui_payload: { task: { ...task, status: "complete" } },
      },
    } satisfies AgentActionEnvelope<"thread_task_status", AgentThreadTaskStatusData>;

    expect(updated.data.task?.status).toBe("active");
    expect(runStarted.data.run.status).toBe("running");
    expect(deleted.data.task?.deleted_at).toBe("2026-07-03T00:02:00Z");
    expect(runFinished.data.run.status).toBe("succeeded");
    expect(turnStarted.data.thread_task?.trigger).toBe("task_continue");
    expect(statusUpdated.data.summary).toBe("目标已完成");
  });
});

function a2uiObject(
  renderKey: A2UIObject["render_key"],
  mode: A2UIObject["mode"],
  patch: Partial<A2UIObject> = {},
): A2UIObject {
  return {
    render_key: renderKey,
    mode,
    stream_id: `stream_${renderKey}`,
    tool_call_id: `tool_${renderKey}`,
    trace_id: "trace_a2ui",
    turn_index: 4,
    payload: { title: `${renderKey} title` },
    input_schema: { type: "object" },
    submit_schema: { type: "object" },
    interaction: mode === "interactive"
      ? {
          interaction_id: `int_${renderKey}`,
          status: "waiting_user_input",
          can_submit: true,
          resume_status: "not_started",
        }
      : null,
    ...patch,
  };
}

function message(
  role: AgentChatMessage["role"],
  content: string,
  patch: Partial<AgentChatMessage> = {},
): AgentChatMessage {
  return {
    id: `msg_${role}`,
    sessionId: "ses_1",
    role,
    content,
    timestamp: Date.UTC(2026, 5, 18),
    ...patch,
  };
}
