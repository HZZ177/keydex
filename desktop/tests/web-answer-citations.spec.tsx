import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageList } from "@/renderer/pages/conversation/messages";
import { MessageText } from "@/renderer/pages/conversation/messages/MessageText";
import type { WebTurnSourceRegistry } from "@/renderer/pages/conversation/messages/webSourceRegistry";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { WebActivitySource } from "@/types/protocol";

const SOURCE_A: WebActivitySource = {
  source_id: "src_a",
  url: "https://a.example/article",
  domain: "a.example",
  title: "Source A",
  snippet: "A",
  favicon: "https://a.example/favicon.ico",
  truncated: false,
};
const SOURCE_B: WebActivitySource = {
  source_id: "src_b",
  url: "https://b.example/article",
  domain: "b.example",
  title: "Source B",
  snippet: "B",
  favicon: null,
  truncated: false,
};

describe("assistant web source citations", () => {
  it("renders controlled inline citations and a first-reference ordered source section", async () => {
    render(
      <MessageText
        message={message("Answer B [[source:src_b]], then A [[source:src_a]], B again [[source:src_b]].")}
        showActionRow={false}
        webSourceRegistry={registry()}
      />,
    );

    await waitFor(() => expect(screen.getAllByRole("link", { name: "查看来源 1" })).toHaveLength(2));
    expect(screen.getByRole("link", { name: "查看来源 2" })).not.toBeNull();
    const inlineCitations = screen.getAllByRole("link", { name: "查看来源 1" });
    expect(inlineCitations).toHaveLength(2);
    expect(inlineCitations.every((citation) => citation.getAttribute("title") === null)).toBe(true);
    expect(inlineCitations.every((citation) => citation.dataset.tooltipLabel === "查看对应来源")).toBe(true);
    const sources = screen.getByTestId("web-answer-sources");
    expect(within(sources).getAllByRole("listitem")).toHaveLength(2);
    const sourceLinks = within(sources).getAllByRole("link");
    expect(sourceLinks[0].getAttribute("aria-label")).toContain("Source B");
    expect(sourceLinks[1].getAttribute("aria-label")).toContain("Source A");
    expect(sourceLinks[0].getAttribute("target")).toBe("_blank");
    expect(sourceLinks[0].getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("activates and focuses the matching source without opening the fragment as an external URL", async () => {
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      render(
        <MessageText
          message={message("Claim [[source:src_a]].")}
          showActionRow={false}
          webSourceRegistry={registry()}
        />,
      );

      const citation = await screen.findByRole("link", { name: "查看来源 1" });
      fireEvent.click(citation);
      const source = screen.getByRole("link", { name: "打开来源 1：Source A" });
      await waitFor(() => expect(source.getAttribute("data-active")).toBe("true"));
      expect(document.activeElement).toBe(source);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });

      fireEvent.pointerDown(document.body);
      await waitFor(() => expect(source.getAttribute("data-active")).toBe("false"));
      expect(document.activeElement).not.toBe(source);

      fireEvent.click(citation);
      await waitFor(() => expect(source.getAttribute("data-active")).toBe("true"));
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(source.getAttribute("data-active")).toBe("false"));
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: previousScrollIntoView,
      });
    }
  });

  it("focuses the canonical source row when a later marker uses a same-URL source alias", async () => {
    const value = registry();
    const aliasedRegistry = {
      ...value,
      bySourceId: new Map([...value.bySourceId, ["src_a_alias", SOURCE_A]]),
    };
    render(
      <MessageText
        message={message("Alias [[source:src_a_alias]], canonical [[source:src_a]].")}
        showActionRow={false}
        webSourceRegistry={aliasedRegistry}
      />,
    );

    const citations = await screen.findAllByRole("link", { name: "查看来源 1" });
    fireEvent.click(citations[1]);
    const source = screen.getByRole("link", { name: "打开来源 1：Source A" });
    await waitFor(() => expect(source.getAttribute("data-active")).toBe("true"));
    expect(document.activeElement).toBe(source);
    expect(within(screen.getByTestId("web-answer-sources")).getAllByRole("listitem")).toHaveLength(1);
  });

  it("hides unknown internal markers and does not render an ungrounded source section", async () => {
    render(
      <MessageText
        message={message("No source [[source:unknown]].")}
        showActionRow={false}
        webSourceRegistry={registry()}
      />,
    );

    await waitFor(() => expect(screen.getByText("No source.")).not.toBeNull());
    expect(screen.queryByText(/\[\[source:unknown\]\]/u)).toBeNull();
    expect(screen.queryByTestId("web-answer-sources")).toBeNull();
  });

  it("never parses source markers in user-authored messages", async () => {
    render(
      <MessageText
        message={{ ...message("Please explain [[source:src_a]]."), kind: "user" }}
        showActionRow={false}
        webSourceRegistry={registry()}
      />,
    );

    await waitFor(() => expect(screen.getByText(/\[\[source:src_a\]\]/u)).not.toBeNull());
    expect(screen.queryByRole("link", { name: "查看来源 1" })).toBeNull();
    expect(screen.queryByTestId("web-answer-sources")).toBeNull();
  });

  it("renders a tolerant citation to the twentieth search result", async () => {
    const sources = Array.from({ length: 20 }, (_, index): WebActivitySource => ({
      source_id: `src_${index}`,
      url: `https://source-${index}.example/article`,
      domain: `source-${index}.example`,
      title: `Source ${index}`,
      truncated: false,
    }));
    const activity = {
      ...webActivityMessage("web-twenty", "thread-citations", "turn-twenty", sources[0]),
      payload: {
        web_activity: {
          kind: "web_activity",
          schema_version: 1,
          activity_type: "search",
          status: "completed",
          query: "research",
          requested_urls: [],
          sources,
          items: [],
          error: null,
        },
      },
    } satisfies ConversationMessage;
    const answer = {
      ...message("Twentieth result\n  [[ source：src_19 ]]."),
      turnId: "turn-twenty",
    };

    render(<MessageList messages={[activity, answer]} />);

    expect(await screen.findByRole("link", { name: "查看来源 1" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "打开来源 1：Source 19" })).not.toBeNull();
    expect(screen.queryByText(/\[\[ source：src_19 \]\]/u)).toBeNull();
  });

  it("rebuilds source context on session switches without leaking an identical source id", async () => {
    const activityA = webActivityMessage("web-a", "session-a", "turn-a", SOURCE_A);
    const answerA = { ...message("A [[source:src_a]]."), threadId: "session-a", turnId: "turn-a" };
    const { rerender } = render(<MessageList messages={[activityA, answerA]} />);
    await waitFor(() => expect(screen.getByRole("link", { name: "打开来源 1：Source A" })).not.toBeNull());

    const replacement = { ...SOURCE_B, source_id: "src_a" };
    const activityB = webActivityMessage("web-b", "session-b", "turn-b", replacement);
    const answerB = { ...message("B [[source:src_a]]."), id: "answer-b", itemId: "answer-b", threadId: "session-b", turnId: "turn-b" };
    rerender(<MessageList messages={[activityB, answerB]} />);

    await waitFor(() => expect(screen.getByRole("link", { name: "打开来源 1：Source B" })).not.toBeNull());
    expect(screen.queryByRole("link", { name: "打开来源 1：Source A" })).toBeNull();
    expect(screen.getByRole("link", { name: "打开来源 1：Source B" }).getAttribute("href")).toBe(SOURCE_B.url);
  });
});

function registry(): WebTurnSourceRegistry {
  return {
    turnKey: "id:turn-citations",
    sources: [SOURCE_A, SOURCE_B],
    bySourceId: new Map([
      [SOURCE_A.source_id, SOURCE_A],
      [SOURCE_B.source_id, SOURCE_B],
    ]),
    activityMessageIdsBySourceId: new Map([
      [SOURCE_A.source_id, ["web-a"]],
      [SOURCE_B.source_id, ["web-b"]],
    ]),
  };
}

function message(content: string): ConversationMessage {
  return {
    id: "assistant-citations",
    threadId: "thread-citations",
    turnId: "turn-citations",
    itemId: "assistant-citations",
    kind: "assistant",
    status: "completed",
    content,
    payload: {},
    createdAt: "2026-07-15T02:00:00Z",
    updatedAt: "2026-07-15T02:00:00Z",
  };
}

function webActivityMessage(
  id: string,
  threadId: string,
  turnId: string,
  source: WebActivitySource,
): ConversationMessage {
  return {
    id,
    threadId,
    turnId,
    itemId: id,
    kind: "web_activity",
    status: "completed",
    content: "",
    payload: {
      web_activity: {
        kind: "web_activity",
        schema_version: 1,
        activity_type: "search",
        status: "completed",
        query: "query",
        requested_urls: [],
        sources: [source],
        items: [],
        error: null,
      },
    },
    createdAt: "2026-07-15T01:59:59Z",
    updatedAt: "2026-07-15T01:59:59Z",
  };
}
