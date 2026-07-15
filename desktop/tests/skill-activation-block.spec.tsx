import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge, SkillResourceReadResponse, SkillSource } from "@/runtime";
import { MessageList } from "@/renderer/pages/conversation/messages";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("SkillActivationBlock", () => {
  it("renders load_skill activation as a skill message and opens the controlled skill preview", async () => {
    const runtime = skillRuntime("workspace", "SKILL.md");
    render(
      <PreviewProvider>
        <MessageList
          messages={[loadSkillMessage()]}
          workspaceRuntime={runtime}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <FilePanelProbe />
        <PreviewRequestProbe />
      </PreviewProvider>,
    );

    expect(screen.getByTestId("skill-activation-block")).not.toBeNull();
    expect(screen.queryByTestId("tool-call-block")).toBeNull();
    expect(screen.getByTestId("skill-activation-block").querySelector("svg.lucide-sparkles")).not.toBeNull();
    expect(screen.getByText("dev-plan")).not.toBeNull();
    expect(screen.getByText("项目级")).not.toBeNull();
    expect(screen.queryByText("已激活")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开 Skill dev-plan" }));

    await waitFor(() => {
      expect(screen.getByTestId("preview-request").textContent).toBe(
        "skill-resource:workspace:dev-plan:SKILL.md",
      );
    });
    expect(screen.getByTestId("file-panel-request").textContent).toBe("");
    expect(runtime.skills.readSessionResource).toHaveBeenCalledWith("ses-1", {
      skill_name: "dev-plan",
      source: "workspace",
      resource_path: "SKILL.md",
    });
  });

  it("opens a skill resource when load_skill is called with resource_path", async () => {
    const runtime = skillRuntime("workspace", "references/detail.md");
    render(
      <PreviewProvider>
        <MessageList
          messages={[
            loadSkillMessage({
              args: { skill_name: "dev-plan", resource_path: "references/detail.md" },
              result: {
                status: "success",
                model_content: JSON.stringify({
                  skill_name: "dev-plan",
                  resource_path: "references/detail.md",
                  found: true,
                  loaded: true,
                  injected: false,
                  message: "Skill resource file loaded.",
                }),
              },
            }),
          ]}
          workspaceRuntime={runtime}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <PreviewRequestProbe />
      </PreviewProvider>,
    );

    expect(screen.getByText("dev-plan / detail.md")).not.toBeNull();
    expect(screen.queryByText("资源已读取")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开 Skill dev-plan" }));

    await waitFor(() => {
      expect(screen.getByTestId("preview-request").textContent).toBe(
        "skill-resource:workspace:dev-plan:references/detail.md",
      );
    });
  });

  it("shows a system activation source without opening it through the workspace file preview", async () => {
    const runtime = skillRuntime("system", "references/detail.md");
    render(
      <PreviewProvider>
        <MessageList
          messages={[
            loadSkillMessage({
              args: { skill_name: "dev-plan", source: "system", resource_path: "references/detail.md" },
              result: {
                status: "success",
                model_content: JSON.stringify({
                  skill_name: "dev-plan",
                  source: "system",
                  resource_path: "references/detail.md",
                  found: true,
                  loaded: true,
                  injected: false,
                }),
              },
            }),
          ]}
          workspaceRuntime={runtime}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <FilePanelProbe />
        <PreviewRequestProbe />
      </PreviewProvider>,
    );

    const block = screen.getByTestId("skill-activation-block");
    expect(block.getAttribute("data-skill-source")).toBe("system");
    expect(screen.getByText("系统级")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开 Skill dev-plan" }));
    await waitFor(() => {
      expect(screen.getByTestId("preview-request").textContent).toBe(
        "skill-resource:system:dev-plan:references/detail.md",
      );
    });
    expect(screen.getByTestId("file-panel-request").textContent).toBe("");
  });

  it("preserves a builtin activation source and opens its packaged resource", async () => {
    const runtime = skillRuntime("builtin", "references/manual-index.md");
    render(
      <PreviewProvider>
        <MessageList
          messages={[
            loadSkillMessage({
              args: {
                skill_name: "dev-plan",
                source: "builtin",
                resource_path: "references/manual-index.md",
              },
            }),
          ]}
          workspaceRuntime={runtime}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <PreviewRequestProbe />
      </PreviewProvider>,
    );

    const block = screen.getByTestId("skill-activation-block");
    expect(block.getAttribute("data-skill-source")).toBe("builtin");
    expect(screen.getByText("内置")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开 Skill dev-plan" }));
    await waitFor(() => {
      expect(screen.getByTestId("preview-request").textContent).toBe(
        "skill-resource:builtin:dev-plan:references/manual-index.md",
      );
    });
  });

  it("unwraps the nested live tool projection before deriving the source", () => {
    render(
      <MessageList
        messages={[
          loadSkillMessage({
            args: { skill_name: "dev-plan" },
            result: {
              status: "success",
              model_content: "",
              ui_payload: {
                result: {
                  skill_name: "dev-plan",
                  source: "system",
                  found: true,
                  loaded: true,
                  injected: true,
                },
              },
            },
          }),
        ]}
      />,
    );

    const block = screen.getByTestId("skill-activation-block");
    expect(block.getAttribute("data-skill-source")).toBe("system");
    expect(screen.getByText("系统级")).not.toBeNull();
  });
});

function loadSkillMessage({
  args = { skill_name: "dev-plan" },
  result = {
    status: "success",
    model_content: JSON.stringify({
      skill_name: "dev-plan",
      found: true,
      loaded: true,
      injected: true,
      message: "skill 已激活。",
    }),
  },
}: {
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
} = {}): ConversationMessage {
  return {
    id: "skill-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "skill",
    itemType: "tool_call",
    status: "completed",
    content: "load_skill",
    payload: {
      call: {
        id: "call-1",
        name: "load_skill",
        arguments: args,
      },
      result,
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:02Z",
  };
}

function FilePanelProbe() {
  const preview = usePreview();
  const request = preview.filePanelRequest;
  return <output data-testid="file-panel-request">{request ? `${request.scopeKey}:${request.path}` : ""}</output>;
}

function PreviewRequestProbe() {
  const preview = usePreview();
  const request = preview.activeEntry?.request;
  return (
    <output data-testid="preview-request">
      {request?.type === "skill-resource"
        ? `${request.type}:${request.skillSource}:${request.skillName}:${request.resourcePath}`
        : request?.type ?? ""}
    </output>
  );
}

function skillRuntime(source: SkillSource, resourcePath: string): RuntimeBridge {
  const response: SkillResourceReadResponse = {
    skill_name: "dev-plan",
    source,
    resource_path: resourcePath,
    locator: `${source}:skills/dev-plan/${resourcePath}`,
    content: "# Skill resource",
    encoding: "utf-8",
    revision: `sha256:${source}:${resourcePath}`,
    fingerprint: "sha256:catalog",
  };
  return {
    skills: {
      readSessionResource: vi.fn().mockResolvedValue(response),
    },
  } as unknown as RuntimeBridge;
}
