import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageText } from "@/renderer/pages/conversation/messages";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { RuntimeBridge, SkillResourceReadResponse, SkillSource } from "@/runtime";

describe("MessageText skill context items", () => {
  it("renders a selected skill context item as a non-file chip with description preview", async () => {
    render(
      <MessageText
        message={message("user", "implement this design", "completed", {
          contextItems: [
            {
              id: "skill:dev-plan",
              type: "skill",
              label: "/dev-plan",
              skill_name: "dev-plan",
              description: "Plan work from a design doc",
              source: "workspace",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("dev-plan")).not.toBeNull();
    expect(screen.getByText("项目级")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /dev-plan/ })).toBeNull();

    const wrapper = screen.getByText("dev-plan").closest("[data-preview-open]");
    if (!wrapper) {
      throw new Error("skill chip wrapper not found");
    }
    fireEvent.mouseEnter(wrapper);

    await waitFor(() => {
      expect(screen.getByText("Plan work from a design doc")).not.toBeNull();
    });
  });

  it("renders historical skill context metadata without requiring the current catalog", () => {
    render(
      <MessageText
        message={message("user", "", "completed", {
          contextItems: [
            {
              id: "skill:dev-plan",
              type: "skill",
              label: "dev-plan",
              content: "Keydex Skill: dev-plan",
              metadata: {
                skill_name: "dev-plan",
                description: "Historical plan skill",
                source: "workspace",
              },
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("dev-plan")).not.toBeNull();
  });

  it("opens a historical skill definition when locator metadata is available", async () => {
    const runtime = skillRuntime("workspace");
    render(
      <PreviewProvider>
        <MessageText
          message={message("user", "", "completed", {
            contextItems: [
              {
                id: "skill:dev-plan",
                type: "skill",
                label: "dev-plan",
                metadata: {
                  skill_name: "dev-plan",
                  description: "Historical plan skill",
                  locator: ".keydex/skills/dev-plan/SKILL.md",
                  source: "workspace",
                },
              },
            ],
          })}
          workspaceRuntime={runtime}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <PreviewRequestProbe />
      </PreviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开 Skill dev-plan" }));

    await waitFor(() => {
      expect(screen.getByTestId("preview-request").textContent).toBe(
        "skill-resource:workspace:dev-plan:SKILL.md",
      );
    });
    expect(runtime.skills.readSessionResource).toHaveBeenCalledWith("ses-1", {
      skill_name: "dev-plan",
      source: "workspace",
      resource_path: "SKILL.md",
    });
    expect(document.querySelector('[data-context-chip-icon="skill"]')).not.toBeNull();
  });

  it("shows a historical system skill source without treating its locator as a workspace file", async () => {
    const runtime = skillRuntime("system");
    render(
      <PreviewProvider>
        <MessageText
          message={message("user", "", "completed", {
            contextItems: [
              {
                id: "skill:system:dev-plan",
                type: "skill",
                label: "dev-plan",
                metadata: {
                  skill_name: "dev-plan",
                  description: "Historical system skill",
                  locator: "system:skills/dev-plan/SKILL.md",
                  source: "system",
                },
              },
            ],
          })}
          workspaceRuntime={runtime}
          workspaceScope={{ sessionId: "ses-1" }}
        />
        <FilePanelProbe />
        <PreviewRequestProbe />
      </PreviewProvider>,
    );

    expect(screen.getByText("系统级")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开 Skill dev-plan" }));
    await waitFor(() => {
      expect(screen.getByTestId("preview-request").textContent).toBe(
        "skill-resource:system:dev-plan:SKILL.md",
      );
    });
    expect(runtime.skills.readSessionResource).toHaveBeenCalledWith("ses-1", {
      skill_name: "dev-plan",
      source: "system",
      resource_path: "SKILL.md",
    });
    expect(screen.getByTestId("file-panel-request").textContent).toBe("");
    expect(screen.getByText("dev-plan").closest("[data-skill-source]")?.getAttribute("data-skill-source")).toBe(
      "system",
    );
  });

  it("restores the builtin source badge from historical context metadata", () => {
    render(
      <MessageText
        message={message("user", "", "completed", {
          contextItems: [
            {
              id: "skill:builtin:keydex-guide",
              type: "skill",
              label: "keydex-guide",
              metadata: {
                skill_name: "keydex-guide",
                description: "Use Keydex",
                locator: "builtin/skills/keydex-guide/SKILL.md",
                source: "builtin",
              },
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("内置")).not.toBeNull();
    expect(
      screen.getByText("keydex-guide").closest("[data-skill-source]")?.getAttribute(
        "data-skill-source",
      ),
    ).toBe("builtin");
  });
});

function message(
  kind: ConversationMessage["kind"],
  content: string,
  status: ConversationMessage["status"],
  payload: Record<string, unknown> = {},
): ConversationMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind,
    status,
    content,
    payload,
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:01:00Z",
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

function skillRuntime(source: SkillSource, resourcePath = "SKILL.md"): RuntimeBridge {
  const response: SkillResourceReadResponse = {
    skill_name: "dev-plan",
    source,
    resource_path: resourcePath,
    locator: `${source}:skills/dev-plan/${resourcePath}`,
    content: "# Dev plan",
    encoding: "utf-8",
    revision: "sha256:skill",
    fingerprint: "sha256:catalog",
  };
  return {
    skills: {
      readSessionResource: vi.fn().mockResolvedValue(response),
    },
  } as unknown as RuntimeBridge;
}
