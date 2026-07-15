import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { MessageList } from "@/renderer/pages/conversation/messages";
import { WebActivityBlock } from "@/renderer/pages/conversation/messages/WebActivityBlock";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { WebActivityPayload, WebActivitySource } from "@/types/protocol";

const SOURCE: WebActivitySource = {
  source_id: "src_docs",
  url: "https://docs.example.com/guide?utm_source=test",
  domain: "docs.example.com",
  title: "Example guide",
  snippet: "A concise result snippet.",
  favicon: "https://docs.example.com/favicon.ico",
  published_at: "2026-07-14",
  truncated: true,
};

describe("WebActivityBlock", () => {
  it("renders a compact search lifecycle without provider parameters or raw JSON", () => {
    render(
      <WebActivityBlock
        message={activityMessage({ activity_type: "search", status: "running", query: "Keydex native web search" })}
      />,
    );

    const activity = screen.getByTestId("web-activity");
    expect(activity.getAttribute("data-state")).toBe("running");
    expect(within(activity).getByRole("status").textContent).toContain("正在搜索“Keydex native web search”");
    expect(activity.textContent).not.toContain("Tavily");
    expect(activity.textContent).not.toContain("search_depth");
    expect(activity.textContent).not.toContain("schema_version");
  });

  it("expands completed search sources with safe links, metadata, and truncation state", () => {
    render(
      <WebActivityBlock
        message={activityMessage({ activity_type: "search", status: "completed", query: "result", sources: [SOURCE] })}
      />,
    );

    expect(screen.getByText("已搜索“result” · 1 个来源")).not.toBeNull();
    expect(screen.getByText("1 个已截断")).not.toBeNull();
    const toggle = screen.getByRole("button", { name: "展开网络活动详情" });
    expect(toggle.tagName).toBe("BUTTON");
    expect(within(toggle).queryByRole("button")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByText("已搜索“result” · 1 个来源"));

    const link = screen.getByRole("link", { name: "打开来源：Example guide" });
    expect(link.getAttribute("href")).toBe(SOURCE.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("docs.example.com")).not.toBeNull();
    expect(screen.getByText("A concise result snippet.")).not.toBeNull();
    expect(screen.getByText("内容已截断")).not.toBeNull();
    expect(screen.getByRole("button", { name: "复制全部来源链接" })).not.toBeNull();
  });

  it("uses only the domain in a single-page fetch summary", () => {
    render(
      <WebActivityBlock
        message={activityMessage({
          activity_type: "fetch",
          status: "completed",
          requested_urls: [SOURCE.url],
          items: [{ requested_url: SOURCE.url, status: "success", source: SOURCE, error: null }],
        })}
      />,
    );

    const summaryRow = screen.getByRole("button", { name: "展开网络活动详情" });
    expect(summaryRow.textContent).toContain("已读取 docs.example.com");
    expect(summaryRow.textContent).not.toContain("utm_source");
  });

  it("summarizes partial fetch failures and exposes a friendly per-item reason", () => {
    render(
      <WebActivityBlock
        message={activityMessage({
          activity_type: "fetch",
          status: "partial_failure",
          requested_urls: [SOURCE.url, "https://offline.example.org/private?token=secret"],
          items: [
            { requested_url: SOURCE.url, status: "success", source: SOURCE, error: null },
            {
              requested_url: "https://offline.example.org/private?token=secret",
              status: "failed",
              source: null,
              error: { code: "request_timeout", message: "upstream token=secret", retryable: true },
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("已读取 1 个网页，1 个失败")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开网络活动详情" }));
    expect(screen.getByText("offline.example.org")).not.toBeNull();
    expect(screen.getByText("网络请求超时")).not.toBeNull();
    expect(screen.getByTestId("web-activity").textContent).not.toContain("token=secret");
  });

  it("maps terminal failures to consumer copy while retaining a stable diagnostic code", () => {
    render(
      <WebActivityBlock
        message={activityMessage({
          activity_type: "search",
          status: "failed",
          query: "latest release",
          error: {
            code: "rate_limited",
            message: "raw provider response with api_key=secret",
            retryable: true,
            retry_after_seconds: 12,
          },
        })}
      />,
    );

    expect(screen.getByText("搜索“latest release”失败")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开网络活动详情" }));
    expect(screen.getByText("网络请求过于频繁")).not.toBeNull();
    expect(screen.getByText("12 秒后可重试")).not.toBeNull();
    expect(screen.getByText("rate_limited")).not.toBeNull();
    expect(screen.getByTestId("web-activity").textContent).not.toContain("api_key");
  });

  it("covers empty, cancelled, and clipped search summaries", () => {
    const { rerender } = render(
      <WebActivityBlock
        message={activityMessage({ activity_type: "search", status: "empty", query: "missing result" })}
      />,
    );
    expect(screen.getByText("未找到“missing result”的相关来源")).not.toBeNull();

    rerender(
      <WebActivityBlock
        message={activityMessage({ activity_type: "search", status: "cancelled", query: "stopped request" })}
      />,
    );
    expect(screen.getByText("已停止搜索“stopped request”")).not.toBeNull();

    const longQuery = "q".repeat(90);
    rerender(
      <WebActivityBlock message={activityMessage({ activity_type: "search", status: "completed", query: longQuery })} />,
    );
    expect(screen.getByRole("status").textContent).toContain(`${"q".repeat(71)}…`);
    expect(screen.getByRole("status").getAttribute("title")).toBeNull();
  });

  it("does not create navigable links for non-http source URLs", () => {
    render(
      <WebActivityBlock
        message={activityMessage({
          activity_type: "search",
          status: "completed",
          query: "unsafe",
          sources: [{ ...SOURCE, url: "javascript:alert(1)", favicon: "data:text/html,bad" }],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "展开网络活动详情" }));
    expect(screen.queryByRole("link", { name: /Example guide/ })).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps an explicit expansion choice across running-to-completed replacement", () => {
    const running = activityMessage({
      activity_type: "fetch",
      status: "running",
      requested_urls: [SOURCE.url],
      items: [{ requested_url: SOURCE.url, status: "success", source: SOURCE, error: null }],
    });
    const { rerender } = render(<WebActivityBlock message={running} />);
    fireEvent.click(screen.getByRole("button", { name: "展开网络活动详情" }));
    expect(screen.getByRole("button", { name: "收起网络活动详情" }).getAttribute("aria-expanded")).toBe("true");

    rerender(<WebActivityBlock message={activityMessage({
      activity_type: "fetch",
      status: "completed",
      requested_urls: [SOURCE.url],
      items: [{ requested_url: SOURCE.url, status: "success", source: SOURCE, error: null }],
    })} />);
    expect(screen.getByRole("button", { name: "收起网络活动详情" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles the whole summary row with native keyboard button behavior", async () => {
    const user = userEvent.setup();
    render(
      <WebActivityBlock
        message={activityMessage({ activity_type: "search", status: "completed", query: "keyboard", sources: [SOURCE] })}
      />,
    );

    const toggle = screen.getByRole("button", { name: "展开网络活动详情" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "收起网络活动详情" }).getAttribute("aria-expanded")).toBe("true");

    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "展开网络活动详情" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("MessageList web activity dispatch", () => {
  it("uses the dedicated renderer for web activity and keeps ordinary tools on ToolCallBlock", () => {
    const web = activityMessage({ activity_type: "search", status: "completed", query: "dispatch", sources: [SOURCE] });
    const tool: ConversationMessage = {
      ...baseMessage("local-tool", "tool"),
      content: "Read file",
      payload: { toolName: "read_file", toolCallId: "call-local" },
    };
    render(<MessageList messages={[web, tool]} />);

    expect(screen.getByTestId("web-activity")).not.toBeNull();
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
  });
});

function activityMessage(
  overrides: Partial<WebActivityPayload> & Pick<WebActivityPayload, "activity_type" | "status">,
): ConversationMessage {
  const { activity_type, status, ...optionalOverrides } = overrides;
  const payload: WebActivityPayload = {
    kind: "web_activity",
    schema_version: 1,
    activity_type,
    status,
    query: null,
    requested_urls: [],
    sources: [],
    items: [],
    error: null,
    started_at_ms: 1,
    ended_at_ms: status === "running" ? null : 2,
    duration_ms: status === "running" ? null : 1,
    ...optionalOverrides,
  };
  return {
    ...baseMessage(`web-${payload.activity_type}-${payload.status}`, "web_activity"),
    status: payload.status === "running" ? "running" : payload.status === "failed" ? "failed" : "completed",
    payload: { web_activity: payload },
  };
}

function baseMessage(id: string, kind: ConversationMessage["kind"]): ConversationMessage {
  return {
    id,
    threadId: "thread-web",
    turnId: "turn-web",
    itemId: id,
    kind,
    status: "completed",
    content: "",
    payload: {},
    createdAt: "2026-07-15T01:00:00Z",
    updatedAt: "2026-07-15T01:00:00Z",
  };
}
