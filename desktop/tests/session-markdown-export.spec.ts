import { describe, expect, it } from "vitest";

import {
  buildSessionMarkdown,
  createSessionMarkdownFilename,
} from "@/renderer/utils/sessionMarkdownExport";
import type { AgentChatMessagePayload } from "@/types/protocol";

describe("session Markdown export", () => {
  it("keeps user, assistant, and reasoning text in chronological order", () => {
    const messages: AgentChatMessagePayload[] = [
      { role: "system", content: "系统提示" },
      { role: "user", content: "  第一条问题\r\n第二行  " },
      { role: "reasoning", content: "推理过程" },
      { role: "assistant", content: "**正文回答**" },
      { role: "tool", content: "", toolName: "shell", toolParams: { command: "pwd" } },
      { role: "subagent", content: "子代理细节" },
      { role: "a2ui", content: "A2UI 事件", contentType: "a2ui" },
      { role: "assistant", content: "A2UI 参数", content_type: "a2ui" },
      { role: "assistant", content: "   " },
      { role: "user", content: "继续" },
    ];

    expect(buildSessionMarkdown("  示例会话  ", messages)).toBe(
      "# 示例会话\n\n## 用户\n\n第一条问题\n第二行\n\n## 思考\n\n推理过程\n\n## 助手\n\n**正文回答**\n\n## 用户\n\n继续\n",
    );
  });

  it("returns an empty result when the session has no conversation body", () => {
    expect(
      buildSessionMarkdown("空会话", [
        { role: "tool", content: "工具结果" },
        { role: "assistant", content: "A2UI", contentType: "a2ui" },
      ]),
    ).toBe("");
  });

  it("creates a Windows-safe timestamped Markdown filename", () => {
    expect(
      createSessionMarkdownFilename(
        "  需求/评审: 第一版?  ",
        new Date("2026-07-13T08:09:10.123Z"),
      ),
    ).toBe("需求_评审_ 第一版_-2026-07-13T08-09-10-123Z.md");
  });
});
