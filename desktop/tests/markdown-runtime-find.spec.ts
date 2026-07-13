import { describe, expect, it, vi } from "vitest";

import {
  buildMarkdownFindIndex,
  MarkdownFindCancelledError,
  MarkdownFindController,
} from "@/renderer/markdownRuntime/find";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownFindMatchPayload,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";

function parse(source: string, revision = "r1") {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:find.md",
    revision,
    source,
    rendererProfile: "file-preview",
  });
}

const SOURCE = [
  "# Alpha",
  "",
  "alpha alphabet ALPHA",
  "",
  "中文 中文词",
  "",
  "Emoji 😀 alpha",
  "",
  "Repeat repeat repeat",
].join("\n");

describe("Worker Markdown find index", () => {
  it("returns zero, one, and many stable block-local matches", () => {
    const snapshot = parse(SOURCE);
    expect(buildMarkdownFindIndex(snapshot, "missing").matches).toEqual([]);
    expect(buildMarkdownFindIndex(snapshot, "😀").matches).toHaveLength(1);
    const many = buildMarkdownFindIndex(snapshot, "alpha");

    expect(many.matches).toHaveLength(5);
    expect(many.matches[0]).toMatchObject({
      blockId: snapshot.blocks[0].id,
      blockIndex: 0,
      blockLocalStart: 0,
      blockLocalEnd: 5,
      matchText: "Alpha",
    });
    expect(new Set(many.matches.map((match) => match.id)).size).toBe(many.matches.length);
    expect(buildMarkdownFindIndex(snapshot, "alpha").matches.map((match) => match.id))
      .toEqual(many.matches.map((match) => match.id));
  });

  it("preserves current case-insensitive behavior and supports explicit case sensitivity", () => {
    const snapshot = parse(SOURCE);
    expect(buildMarkdownFindIndex(snapshot, "ALPHA").matches).toHaveLength(5);
    expect(buildMarkdownFindIndex(snapshot, "ALPHA", { caseSensitive: true }).matches).toHaveLength(1);
    expect(buildMarkdownFindIndex(snapshot, "Alpha", { caseSensitive: true }).matches).toHaveLength(1);
  });

  it("matches rendered selections across equivalent spaces and line breaks", () => {
    const snapshot = parse("First line target\nsecond line end\n\nFirst line target second line end", "find-whitespace");
    const index = buildMarkdownFindIndex(snapshot, "First line target\nsecond line end");

    expect(index.matches).toHaveLength(2);
    expect(index.matches.map((match) => match.matchText)).toEqual([
      "First line target\nsecond line end",
      "First line target second line end",
    ]);
  });

  it("applies Unicode-aware whole-word boundaries for Latin and Chinese", () => {
    const snapshot = parse(SOURCE);
    expect(buildMarkdownFindIndex(snapshot, "alpha", { wholeWord: true }).matches).toHaveLength(4);
    expect(buildMarkdownFindIndex(snapshot, "中文", { wholeWord: true }).matches).toHaveLength(1);
    expect(buildMarkdownFindIndex(snapshot, "中文", { wholeWord: false }).matches).toHaveLength(2);
  });

  it("maps rendered logical matches back through Markdown syntax to exact source ranges", () => {
    const source = "Use **bold** and [link](https://example.test).";
    const snapshot = parse(source);
    const bold = buildMarkdownFindIndex(snapshot, "bold").matches[0]!;
    const link = buildMarkdownFindIndex(snapshot, "link").matches[0]!;

    expect(source.slice(bold.sourceStart, bold.sourceEnd)).toBe("bold");
    expect(source.slice(link.sourceStart, link.sourceEnd)).toBe("link");
    expect(buildMarkdownFindIndex(snapshot, "https://example.test").matches).toHaveLength(0);
  });

  it("handles Chinese, emoji, repeated text, trim, limits, and cancellation", () => {
    const snapshot = parse(SOURCE);
    expect(buildMarkdownFindIndex(snapshot, " 中文 ").matches).toHaveLength(2);
    expect(buildMarkdownFindIndex(snapshot, "😀").matches[0].matchText).toBe("😀");
    expect(buildMarkdownFindIndex(snapshot, "repeat").matches).toHaveLength(3);
    expect(buildMarkdownFindIndex(snapshot, "repeat", { limit: 2 })).toMatchObject({ limited: true, matches: [{}, {}] });
    expect(buildMarkdownFindIndex(snapshot, "", { limit: 100 }).matches).toEqual([]);
    expect(() => buildMarkdownFindIndex(snapshot, "alpha", { shouldCancel: () => true }))
      .toThrow(MarkdownFindCancelledError);
  });
});

function payload(index: ReturnType<typeof buildMarkdownFindIndex>): MarkdownFindMatchPayload[] {
  return index.matches.map((match) => ({
    id: match.id,
    block_id: match.blockId,
    block_index: match.blockIndex,
    block_local_start: match.blockLocalStart,
    block_local_end: match.blockLocalEnd,
    logical_start: match.logicalStart,
    logical_end: match.logicalEnd,
    source_start: match.sourceStart,
    source_end: match.sourceEnd,
    match_text: match.matchText,
    snippet: match.snippet,
  }));
}

function response(request: MarkdownWorkerRequest, matches: MarkdownFindMatchPayload[]): MarkdownWorkerResponse {
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface: request.surface,
    document_id: request.document_id,
    revision: request.revision,
    request_id: request.request_id,
    type: "find-result",
    payload: { query: request.type === "query-find" ? request.payload.query : "", matches },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Markdown find view controller", () => {
  it("publishes only the latest rapid query and discards an older result", async () => {
    const snapshot = parse(SOURCE);
    const first = deferred<MarkdownWorkerResponse>();
    const second = deferred<MarkdownWorkerResponse>();
    const requests: MarkdownWorkerRequest[] = [];
    const controller = new MarkdownFindController({
      snapshot,
      attachment: {
        request: (request) => {
          requests.push(request);
          return request.type === "query-find" && request.payload.query === "a" ? first.promise : second.promise;
        },
      },
    });
    const older = controller.query("a");
    const latest = controller.query("alpha");
    second.resolve(response(requests[1]!, payload(buildMarkdownFindIndex(snapshot, "alpha"))));
    await latest;
    first.resolve(response(requests[0]!, payload(buildMarkdownFindIndex(snapshot, "a"))));

    await expect(older).rejects.toBeInstanceOf(Error);
    expect(controller.current()).toMatchObject({ query: "alpha", pending: false, matches: { length: 5 } });
  });

  it("navigates next/previous with first-tail wrap and RevealController source targets", async () => {
    const snapshot = parse(SOURCE);
    const index = buildMarkdownFindIndex(snapshot, "repeat");
    const reveal = vi.fn();
    const controller = new MarkdownFindController({
      snapshot,
      reveal,
      attachment: { request: async (request) => response(request, payload(index)) },
    });
    await controller.query("repeat");
    expect(controller.current().activeIndex).toBe(0);
    await controller.previous();
    expect(controller.current().activeIndex).toBe(2);
    await controller.next();
    expect(controller.current().activeIndex).toBe(0);
    await controller.next();
    expect(controller.current().activeIndex).toBe(1);
    expect(reveal).toHaveBeenLastCalledWith({
      kind: "source-offset",
      sourceOffset: index.matches[1].sourceStart,
    });
  });

  it("returns highlights only for the requested mounted block and marks the active match", async () => {
    const snapshot = parse(SOURCE);
    const index = buildMarkdownFindIndex(snapshot, "alpha");
    const controller = new MarkdownFindController({
      snapshot,
      attachment: { request: async (request) => response(request, payload(index)) },
    });
    await controller.query("alpha");
    const targetBlock = index.matches[1].blockId;
    const highlights = controller.highlightsForBlock(targetBlock);

    expect(highlights.length).toBeGreaterThan(1);
    expect(highlights[0]).toMatchObject({ blockLocalStart: 0, blockLocalEnd: 5, active: false });
    expect(controller.highlightsForBlock("unmounted-or-unrelated")).toEqual([]);
    await controller.activate(1);
    expect(controller.highlightsForBlock(targetBlock).some((item) => item.active)).toBe(true);
  });

  it("reports only affected blocks when query or active match changes", async () => {
    const snapshot = parse(SOURCE);
    const alpha = buildMarkdownFindIndex(snapshot, "alpha");
    const repeat = buildMarkdownFindIndex(snapshot, "repeat");
    const changes: Set<string>[] = [];
    const controller = new MarkdownFindController({
      snapshot,
      onChange: (_state, blocks) => changes.push(new Set(blocks)),
      attachment: {
        request: async (request) => response(
          request,
          payload(request.type === "query-find" && request.payload.query === "alpha" ? alpha : repeat),
        ),
      },
    });
    await controller.query("alpha");
    await controller.query("repeat");

    const finalChanged = changes.at(-1)!;
    expect(finalChanged).toEqual(new Set([
      ...alpha.matches.map((match) => match.blockId),
      ...repeat.matches.map((match) => match.blockId),
    ]));
  });

  it("clears and aborts stale query state on revision change", async () => {
    const snapshot = parse(SOURCE);
    const pending = deferred<MarkdownWorkerResponse>();
    const controller = new MarkdownFindController({
      snapshot,
      attachment: { request: () => pending.promise },
    });
    const query = controller.query("alpha");
    const next = parse(`${SOURCE}\n\nNew alpha`, "r2");
    controller.updateSnapshot(next);
    pending.resolve(response({
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: "file",
      document_id: snapshot.document_id,
      revision: "r1",
      request_id: "old",
      type: "query-find",
      payload: { query: "alpha", case_sensitive: false, whole_word: false, limit: 100 },
    }, []));

    await expect(query).rejects.toBeInstanceOf(Error);
    expect(controller.current()).toMatchObject({ revision: "r2", query: "", matches: [] });
  });
});
