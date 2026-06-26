import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { selectedQuoteFromText } from "@/renderer/components/chat/SendBox";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import type { AgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { WorkbenchAssistantSurface } from "@/renderer/pages/workbench/WorkbenchAssistantSurface";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import type { AgentSession, Workspace } from "@/types/protocol";

describe("WorkbenchAssistantSurface", () => {
  it("opens the composer when an external quote chip is injected", async () => {
    render(
      <LayoutStateProvider>
        <WorkbenchQuoteInjectionHarness />
      </LayoutStateProvider>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(screen.queryByLabelText("工作台助手输入")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "注入引用片段" }));

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });
    expect(await screen.findByLabelText("工作台助手输入")).not.toBeNull();
    expect(await screen.findByText("guide.md · L3")).not.toBeNull();
  });
});

function WorkbenchQuoteInjectionHarness() {
  const [quoteChipRequest, setQuoteChipRequest] = useState<AgentSessionController["quoteChipRequest"]>(null);
  const runtime = useMemo(() => fakeRuntime(), []);
  const controller = fakeController({ quoteChipRequest });
  const quote = selectedQuoteFromText("Target text", {
    source: "annotation",
    annotationComment: "Explain this paragraph",
    file: {
      path: "docs/guide.md",
      name: "guide.md",
      lineStart: 3,
      lineEnd: 3,
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!quote) {
            return;
          }
          setQuoteChipRequest((current) => ({
            requestId: (current?.requestId ?? 0) + 1,
            quote,
          }));
        }}
      >
        注入引用片段
      </button>
      <WorkbenchAssistantSurface
        runtime={runtime}
        workspaceId="ws-1"
        workspace={workspace()}
        controller={controller}
      />
    </>
  );
}

function fakeController({
  quoteChipRequest,
}: {
  quoteChipRequest: AgentSessionController["quoteChipRequest"];
}): AgentSessionController {
  return {
    state: {},
    dispatch: vi.fn(),
    session: session(),
    sessionViewState: null,
    agentMessages: [],
    runtimeState: "idle" as ConversationRuntimeState,
    pendingApproval: null,
    draft: "",
    setDraft: vi.fn(),
    selectedSkill: null,
    setSelectedSkill: vi.fn(),
    fileChipRequest: null,
    quoteChipRequest,
    loading: false,
    loadingOlderHistory: false,
    wsStatus: "open",
    runtimeDetail: null,
    setRuntimeDetail: vi.fn(),
    connectionReady: true,
    canSend: true,
    canStop: false,
    usingSharedRuntime: false,
    quoteSelection: vi.fn(),
    startChatFromAnnotation: vi.fn(),
    loadOlderHistory: vi.fn(),
    sendText: vi.fn(),
    send: vi.fn(),
    stop: vi.fn(),
    submitApproval: vi.fn(),
    approvalSubmitting: false,
    approvalError: null,
  } as unknown as AgentSessionController;
}

function fakeRuntime(): RuntimeBridge {
  return {
    settings: {
      getSettings: () =>
        Promise.resolve({
          model: {
            base_url: "https://api.example/v1",
            model: "qwen-coder",
            timeout_seconds: 60,
            api_key_set: true,
            api_key_preview: "sk-***",
          },
        }),
    },
    models: {
      listModels: () => Promise.resolve({ models: [{ id: "qwen-coder" }], cached: true }),
    },
    workspace: {
      listSkills: () =>
        Promise.resolve({
          workspace_root: "D:/repo/keydex",
          skills: [],
          diagnostics: [],
          fingerprint: "empty",
          loaded_at: "2026-06-26T00:00:00Z",
        }),
      search: vi.fn().mockResolvedValue([]),
      listDirectory: vi.fn().mockResolvedValue({ root: "", entries: [] }),
    },
  } as unknown as RuntimeBridge;
}

function workspace(): Workspace {
  return {
    id: "ws-1",
    name: "keydex",
    root_path: "D:/repo/keydex",
    created_at: "2026-06-26T00:00:00Z",
    updated_at: "2026-06-26T00:00:00Z",
  } as Workspace;
}

function session(): AgentSession {
  return {
    id: "ses-1",
    title: "Workbench",
    session_type: "workspace",
    workspace_id: "ws-1",
    workspace: workspace(),
    created_at: "2026-06-26T00:00:00Z",
    updated_at: "2026-06-26T00:00:00Z",
  } as AgentSession;
}
