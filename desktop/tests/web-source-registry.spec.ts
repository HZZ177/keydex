import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import {
  buildWebTurnSourceRegistries,
  sourceNumbersByFirstReference,
} from "@/renderer/pages/conversation/messages/webSourceRegistry";
import { processMessages } from "@/renderer/pages/conversation/messages/processMessages";

describe("turn web source registry", () => {
  it("deduplicates Search to Fetch by canonical URL and keeps source aliases", () => {
    const registries = buildWebTurnSourceRegistries([
      webMessage("search", 1, searchActivity("src_search", "https://Example.com/article/#top")),
      webMessage("fetch", 1, fetchActivity("src_fetch", "https://example.com/article")),
    ]);
    const registry = registries.get("turn:1");

    expect(registry?.sources).toHaveLength(1);
    expect(registry?.bySourceId.get("src_search")?.snippet).toBe("Fetched preview");
    expect(registry?.bySourceId.get("src_fetch")?.source_id).toBe("src_search");
    expect(registry?.activityMessageIdsBySourceId.get("src_fetch")).toEqual(["search", "fetch"]);
  });

  it("keeps different paths and different turns isolated", () => {
    const registries = buildWebTurnSourceRegistries([
      webMessage("a", 1, searchActivity("src_a", "https://example.com/a")),
      webMessage("b", 1, searchActivity("src_b", "https://example.com/b")),
      webMessage("c", 2, searchActivity("src_a", "https://example.com/a")),
    ]);

    expect(registries.get("turn:1")?.sources).toHaveLength(2);
    expect(registries.get("turn:2")?.sources).toHaveLength(1);
    expect(registries.get("turn:2")?.activityMessageIdsBySourceId.get("src_a")).toEqual(["c"]);
  });

  it("keeps all twenty agent-visible search sources available to citations", () => {
    const sources = Array.from({ length: 20 }, (_, index) => (
      source(`src_${index}`, `https://example.com/article/${index}`)
    ));
    const registry = buildWebTurnSourceRegistries([
      webMessage("search", 1, {
        ...searchActivity("unused", "https://example.com/unused"),
        sources,
      }),
    ]).get("turn:1");

    expect(registry?.sources).toHaveLength(20);
    expect(registry?.bySourceId.get("src_19")?.url).toBe("https://example.com/article/19");
  });

  it("numbers only known sources by first reference and reuses URL numbers", () => {
    const registry = buildWebTurnSourceRegistries([
      webMessage("search", 1, searchActivity("src_a", "https://example.com/a")),
      webMessage("fetch", 1, fetchActivity("src_alias", "https://example.com/a")),
      webMessage("other", 1, searchActivity("src_b", "https://example.com/b")),
    ]).get("turn:1");

    expect(registry).toBeDefined();
    const numbers = sourceNumbersByFirstReference(registry!, ["unknown", "src_b", "src_alias", "src_a"]);
    expect([...numbers]).toEqual([
      ["src_b", 1],
      ["src_alias", 2],
      ["src_a", 2],
    ]);
  });

  it("attaches only the current turn registry to activity and assistant history items", () => {
    const firstActivity = webMessage("activity-one", 1, searchActivity("same_id", "https://one.example/article"));
    const firstAnswer = assistantMessage("answer-one", 1, "First [[source:same_id]]");
    const secondActivity = webMessage("activity-two", 2, searchActivity("same_id", "https://two.example/article"));
    const secondAnswer = assistantMessage("answer-two", 2, "Second [[source:same_id]]");
    const items = processMessages([firstActivity, firstAnswer, secondActivity, secondAnswer]);

    expect(items[0].webSourceRegistry?.bySourceId.get("same_id")?.url).toBe("https://one.example/article");
    expect(items[1].webSourceRegistry?.bySourceId.get("same_id")?.url).toBe("https://one.example/article");
    expect(items[2].webSourceRegistry?.bySourceId.get("same_id")?.url).toBe("https://two.example/article");
    expect(items[3].webSourceRegistry?.bySourceId.get("same_id")?.url).toBe("https://two.example/article");
  });

  it("safely leaves old assistant markers unbound when no valid activity payload exists", () => {
    const oldActivity = {
      ...webMessage("old-activity", 1, searchActivity("old", "https://old.example/article")),
      payload: { turnIndex: 1, web_activity: { kind: "web_activity", schema_version: 0 } },
    };
    const items = processMessages([oldActivity, assistantMessage("old-answer", 1, "Old [[source:old]]")]);

    expect(items.every((item) => item.webSourceRegistry === undefined)).toBe(true);
  });
});

function webMessage(id: string, turnIndex: number, webActivity: Record<string, unknown>): ConversationMessage {
  return {
    id,
    threadId: "thread-1",
    turnId: `turn-${turnIndex}`,
    itemId: id,
    kind: "web_activity",
    content: "",
    payload: { turnIndex, web_activity: webActivity },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function assistantMessage(id: string, turnIndex: number, content: string): ConversationMessage {
  return {
    id,
    threadId: "thread-1",
    turnId: `turn-${turnIndex}`,
    itemId: id,
    kind: "assistant",
    status: "completed",
    content,
    payload: { turnIndex },
    createdAt: "2026-07-15T00:00:01.000Z",
    updatedAt: "2026-07-15T00:00:01.000Z",
  };
}

function source(sourceId: string, url: string, snippet = "Search summary") {
  return {
    source_id: sourceId,
    url,
    domain: "example.com",
    title: "Example",
    snippet,
    favicon: null,
    published_at: null,
    truncated: false,
  };
}

function searchActivity(sourceId: string, url: string) {
  return {
    kind: "web_activity",
    schema_version: 1,
    activity_type: "search",
    status: "completed",
    query: "query",
    requested_urls: [],
    sources: [source(sourceId, url)],
    items: [],
    error: null,
  };
}

function fetchActivity(sourceId: string, url: string) {
  return {
    kind: "web_activity",
    schema_version: 1,
    activity_type: "fetch",
    status: "completed",
    query: null,
    requested_urls: [url],
    sources: [],
    items: [
      {
        requested_url: url,
        status: "success",
        source: source(sourceId, url, "Fetched preview"),
        error: null,
      },
    ],
    error: null,
  };
}
