import { expect, type Page, type Route } from "@playwright/test";

import type { SubagentRunSnapshot, SubagentRunState } from "../src/types/subagents";
import {
  APP_BASE,
  RICH_SESSION,
  createWorkbenchBackend,
  dispatchAgentEvent,
  installWebSocketMock,
  mockWorkbenchBackend,
} from "./workbench-e2e-fixtures";

const API_BASE = "http://127.0.0.1:8765";
const CREATED_AT = "2026-07-18T08:00:00.000Z";

export const SECOND_PARENT_SESSION = "e2e-session-b";
export const INTERNAL_CHILD_TITLE = "internal-child-must-stay-hidden";

export interface SubagentControlRecord {
  action: "steer" | "cancel" | "resume";
  parentSessionId: string;
  runId: string;
  body: Record<string, unknown>;
}

export interface SubagentE2EHarness {
  parentSessionId: string;
  runsByParent: Map<string, SubagentRunSnapshot[]>;
  childHistoryBySession: Map<string, string>;
  controls: SubagentControlRecord[];
  pageErrors: string[];
  approvalSessionById: Map<string, string>;
  publish(run: SubagentRunSnapshot): Promise<void>;
  snapshot(parentSessionId?: string): Promise<void>;
  openRun(runId: string): Promise<void>;
  setRun(run: SubagentRunSnapshot): void;
}

export function makeSubagentRun(
  options: {
    runId: string;
    role?: "explorer" | "worker";
    state?: SubagentRunState;
    parentSessionId?: string;
    subagentId?: string;
    childSessionId?: string;
    sequence?: number;
    version?: number;
    task?: string;
    blockedOn?: "approval" | "user_input" | "external_tool" | null;
    finalReport?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    parentTraceId?: string | null;
  },
): SubagentRunSnapshot {
  const state = options.state ?? "running";
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(state);
  const completed = state === "completed";
  const failed = state === "failed";
  const sequence = options.sequence ?? 1;
  const instant = new Date(Date.parse(CREATED_AT) + sequence * 1_000).toISOString();
  return {
    schema_version: 1,
    run_id: options.runId,
    subagent_id: options.subagentId ?? `subagent-${options.runId}`,
    child_session_id: options.childSessionId ?? `child-${options.runId}`,
    parent_session_id: options.parentSessionId ?? RICH_SESSION,
    parent_trace_id: options.parentTraceId ?? `trace-${options.runId}`,
    parent_tool_call_id: `delegate-${options.runId}`,
    parent_timeline_sequence: sequence,
    initiated_by: "main_agent",
    role: options.role ?? "explorer",
    task: options.task ?? `task-${options.runId}`,
    state,
    blocked_on: state === "running" ? (options.blockedOn ?? null) : null,
    version: options.version ?? 1,
    final_report: completed ? (options.finalReport ?? `report-${options.runId}`) : null,
    report_truncated: false,
    error_code: failed ? (options.errorCode ?? "SUBAGENT_FAILED") : null,
    error_message: failed ? (options.errorMessage ?? `failure-${options.runId}`) : null,
    created_at: instant,
    queued_at: instant,
    started_at: state === "queued" ? null : instant,
    finished_at: terminal ? new Date(Date.parse(instant) + 1_000).toISOString() : null,
    updated_at: new Date(Date.parse(instant) + (terminal ? 1_000 : 500)).toISOString(),
    cancel_requested_at: state === "cancelled" ? instant : null,
  };
}

export function transitionRun(
  run: SubagentRunSnapshot,
  state: SubagentRunState,
  options: {
    finalReport?: string;
    errorCode?: string;
    errorMessage?: string;
    blockedOn?: "approval" | "user_input" | "external_tool" | null;
  } = {},
): SubagentRunSnapshot {
  return makeSubagentRun({
    runId: run.run_id,
    role: run.role,
    state,
    parentSessionId: run.parent_session_id,
    subagentId: run.subagent_id,
    childSessionId: run.child_session_id,
    sequence: run.parent_timeline_sequence,
    version: run.version + 1,
    task: run.task,
    blockedOn: options.blockedOn,
    finalReport: options.finalReport,
    errorCode: options.errorCode,
    errorMessage: options.errorMessage,
    parentTraceId: run.parent_trace_id,
  });
}

export async function openSubagentHarness(
  page: Page,
  initialRuns: SubagentRunSnapshot[] = [],
  options: {
    parentSessionId?: string;
    legacyHistory?: boolean;
    delegateInvocation?: {
      runId: string;
      role: "explorer" | "worker";
      task: string;
      status?: "running" | "completed" | "failed";
    };
  } = {},
): Promise<SubagentE2EHarness> {
  const parentSessionId = options.parentSessionId ?? RICH_SESSION;
  const parentHistory = options.legacyHistory
    ? [
        message(parentSessionId, "user", "legacy delegation request", "legacy-user"),
        message(parentSessionId, "subagent", "legacy subagent result", "legacy-subagent"),
      ]
    : [
        message(parentSessionId, "user", "delegate focused work", "parent-user"),
        message(parentSessionId, "assistant", "delegating now", "parent-assistant"),
        ...(options.delegateInvocation
          ? [delegateInvocationMessage(parentSessionId, options.delegateInvocation)]
          : []),
      ];
  const backend = createWorkbenchBackend({ historyBySession: { [parentSessionId]: parentHistory } });
  const runsByParent = new Map<string, SubagentRunSnapshot[]>();
  const childHistoryBySession = new Map<string, string>();
  const controls: SubagentControlRecord[] = [];
  const pageErrors: string[] = [];
  const approvalSessionById = new Map<string, string>();
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  let resumeSequence = 0;
  for (const run of initialRuns) addOrReplace(runsByParent, run);

  await page.setViewportSize({ width: 1440, height: 900 });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.route(`${API_BASE}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/health") {
      return json(route, { status: "ok" });
    }
    if (path === "/api/sessions" && method === "GET") {
      const visibleParent = sessionPayload(parentSessionId, "subagent-e2e-parent", false);
      const otherParent = sessionPayload(SECOND_PARENT_SESSION, "subagent-e2e-other-parent", false);
      const internal = sessionPayload("child-hidden-list-entry", INTERNAL_CHILD_TITLE, true);
      return json(route, { list: [visibleParent, otherParent, internal], total: 2, page: 1, page_size: 50 });
    }

    const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (approvalMatch && method === "POST") {
      const approvalId = decodeURIComponent(approvalMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      const sessionId = approvalSessionById.get(approvalId) ?? parentSessionId;
      return json(route, {
        id: approvalId,
        session_id: sessionId,
        tool_name: "run_cmd",
        kind: "exec",
        title: "child command approval",
        description: "deterministic approval",
        details: { command: "pnpm test", cwd: "D:/repo/keydex" },
        status: body.decision,
        decision: body.decision,
        trust_scope: body.trust_scope,
        created_at: CREATED_AT,
      });
    }

    const listMatch = path.match(/^\/api\/sessions\/([^/]+)\/subagents\/runs$/);
    if (listMatch && method === "GET") {
      const parentId = decodeURIComponent(listMatch[1]);
      return json(route, { list: runsByParent.get(parentId) ?? [] });
    }

    const controlledSessionMatch = path.match(
      /^\/api\/sessions\/([^/]+)\/subagents\/runs\/([^/]+)\/session$/,
    );
    if (controlledSessionMatch && method === "GET") {
      const parentId = decodeURIComponent(controlledSessionMatch[1]);
      const runId = decodeURIComponent(controlledSessionMatch[2]);
      const run = findRun(runsByParent, parentId, runId);
      if (!run) return json(route, { detail: "run not found" }, 404);
      const session = sessionPayload(run.child_session_id, `child detail ${run.run_id}`, true, run);
      const detail = childHistoryBySession.get(run.child_session_id) ?? `child transcript ${run.run_id}`;
      return json(route, {
        session,
        history: {
          session,
          list: [
            message(run.child_session_id, "user", run.task, `${run.run_id}-child-user`),
            message(run.child_session_id, "assistant", detail, `${run.run_id}-child-assistant`),
          ],
          next_cursor: null,
          has_more_older: false,
          total: 2,
          page: 1,
          page_size: 100,
          event_total: 2,
          turn_indexes: [1],
          pending_inputs: [],
        },
      });
    }

    const toolDetailsMatch = path.match(
      /^\/api\/sessions\/([^/]+)\/subagents\/runs\/([^/]+)\/session\/tool-details$/,
    );
    if (toolDetailsMatch && method === "GET") {
      return json(route, { detail: { status: "completed", toolResult: "child tool detail only" } });
    }

    const controlMatch = path.match(
      /^\/api\/sessions\/([^/]+)\/subagents\/runs\/([^/]+)\/(steer|cancel|resume)$/,
    );
    if (controlMatch && method === "POST") {
      const parentId = decodeURIComponent(controlMatch[1]);
      const runId = decodeURIComponent(controlMatch[2]);
      const action = controlMatch[3] as SubagentControlRecord["action"];
      const body = request.postDataJSON() as Record<string, unknown>;
      controls.push({ action, parentSessionId: parentId, runId, body });
      const run = findRun(runsByParent, parentId, runId);
      if (!run) return json(route, { detail: "run not found" }, 404);
      if (action === "steer") {
        const steered = transitionRun(run, "running");
        addOrReplace(runsByParent, steered);
        return json(route, { run: steered });
      }
      if (action === "cancel") {
        const cancelled = transitionRun(run, "cancelled");
        addOrReplace(runsByParent, cancelled);
        return json(route, { run: cancelled });
      }
      resumeSequence += 1;
      const resumed = makeSubagentRun({
        runId: `${run.run_id}-resume-${resumeSequence}`,
        role: run.role,
        state: "queued",
        parentSessionId: parentId,
        subagentId: run.subagent_id,
        childSessionId: run.child_session_id,
        sequence: run.parent_timeline_sequence + resumeSequence,
        task: String(body.task ?? "resumed task"),
        parentTraceId: run.parent_trace_id,
      });
      addOrReplace(runsByParent, resumed);
      return json(route, {
        handle: {
          schema_version: 1,
          subagent_id: resumed.subagent_id,
          run_id: resumed.run_id,
          child_session_id: resumed.child_session_id,
          parent_session_id: resumed.parent_session_id,
          role: resumed.role,
          initial_snapshot: resumed,
        },
      });
    }

    return route.fallback();
  });

  await page.goto(`${APP_BASE}/#/conversation/${parentSessionId}`, { waitUntil: "commit" });
  await expect(page.getByTestId("conversation-panel")).toBeVisible({ timeout: 30_000 });

  const harness: SubagentE2EHarness = {
    parentSessionId,
    runsByParent,
    childHistoryBySession,
    controls,
    pageErrors,
    approvalSessionById,
    async publish(run) {
      addOrReplace(runsByParent, run);
      await dispatchAgentEvent(page, {
        action: "subagent_run_updated",
        data: { ...run, session_id: run.parent_session_id },
      });
    },
    async snapshot(parentId = parentSessionId) {
      await dispatchAgentEvent(page, {
        action: "subagent_runs_snapshot",
        data: { session_id: parentId, list: runsByParent.get(parentId) ?? [] },
      });
    },
    async openRun(runId) {
      await page.getByTestId(`subagent-run-capsule:${runId}`).click();
      await expect(activeSidecar(page)).toBeVisible();
    },
    setRun(run) {
      addOrReplace(runsByParent, run);
    },
  };
  if (initialRuns.length) await harness.snapshot(parentSessionId);
  return harness;
}

export function capsule(page: Page, runId: string) {
  return page.getByTestId(`subagent-run-capsule:${runId}`);
}

export function activeSidecar(page: Page) {
  return page.locator('[data-testid="btw-conversation-panel"]:visible');
}

export async function wsMessages(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() =>
    ((window as Window & { __wsSentMessages?: Array<Record<string, unknown>> }).__wsSentMessages ?? []),
  );
}

function addOrReplace(
  runsByParent: Map<string, SubagentRunSnapshot[]>,
  run: SubagentRunSnapshot,
) {
  const current = runsByParent.get(run.parent_session_id) ?? [];
  const next = current.filter((item) => item.run_id !== run.run_id);
  next.push(run);
  next.sort(
    (left, right) => left.parent_timeline_sequence - right.parent_timeline_sequence || left.run_id.localeCompare(right.run_id),
  );
  runsByParent.set(run.parent_session_id, next);
}

function findRun(
  runsByParent: Map<string, SubagentRunSnapshot[]>,
  parentSessionId: string,
  runId: string,
) {
  return (runsByParent.get(parentSessionId) ?? []).find((run) => run.run_id === runId) ?? null;
}

function message(sessionId: string, role: string, content: string, id: string) {
  return {
    id,
    sessionId,
    role,
    content,
    timestamp: Date.parse(CREATED_AT),
  };
}

function delegateInvocationMessage(
  sessionId: string,
  invocation: {
    runId: string;
    role: "explorer" | "worker";
    task: string;
    status?: "running" | "completed" | "failed";
  },
) {
  const toolCallId = `delegate-${invocation.runId}`;
  return {
    id: `invocation-${invocation.runId}`,
    sessionId,
    role: "tool",
    content: invocation.task,
    timestamp: Date.parse(CREATED_AT) + 500,
    runId: toolCallId,
    toolCallId,
    toolName: "delegate_subagent",
    toolParams: { type: invocation.role, task: invocation.task },
    toolResult: "",
    status: invocation.status ?? "running",
  };
}

function sessionPayload(
  id: string,
  title: string,
  internal: boolean,
  run?: SubagentRunSnapshot,
) {
  const root = "D:/repo/keydex";
  return {
    id,
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title,
    session_tag: "chat",
    session_type: "workspace",
    workspace_id: "workspace-a",
    cwd: root,
    workspace_roots: [root],
    workspace: {
      id: "workspace-a",
      name: "keydex",
      root_path: root,
      normalized_root_path: root.toLowerCase(),
      type: "local",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      last_opened_at: CREATED_AT,
      archived_at: null,
    },
    current_model_provider_id: null,
    current_model: null,
    pinned: internal,
    pinned_at: internal ? CREATED_AT : null,
    active_session_id: null,
    parent_session_id: run?.parent_session_id ?? null,
    child_session_id: null,
    source_trace_id: run?.parent_trace_id ?? null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    archived_at: null,
    archive_origin: null,
    is_debug: false,
    is_scheduled: false,
    is_current: false,
    visibility: internal ? "internal" : "visible",
    agent_kind: internal ? "subagent" : "main",
    subagent_id: run?.subagent_id ?? null,
    subagent_role: run?.role ?? null,
    subagent_closed_at: null,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}
