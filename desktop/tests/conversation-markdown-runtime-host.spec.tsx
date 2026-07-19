import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationMarkdownAdapter } from "@/renderer/markdownRuntime/adapters";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { MarkdownRuntimeStore } from "@/renderer/markdownRuntime/MarkdownRuntimeStore";
import { StreamingTailParser } from "@/renderer/markdownRuntime/streaming";
import type { DocumentWorkerLike } from "@/renderer/markdownRuntime/worker/DocumentWorkerHost";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import { ConversationMarkdownRuntimeHost } from "@/renderer/pages/conversation/messages/ConversationMarkdownRuntimeHost";
import { createConversationMarkdownRendererRegistry } from "@/renderer/pages/conversation/messages/ConversationMarkdownRendererProfile";
import {
  configureConversationMarkdownRuntimeForTests,
  resetConversationMarkdownRuntimeForTests,
} from "@/renderer/pages/conversation/messages/conversationMarkdownRuntime";
import { MessageText } from "@/renderer/pages/conversation/messages/MessageText";
import { conversationBaselineDiagnostics } from "@/renderer/pages/conversation/messages/conversationBaselineDiagnostics";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

let harness: WorkerHarness;

beforeEach(() => {
  harness = new WorkerHarness();
  configureConversationMarkdownRuntimeForTests({
    store: new MarkdownRuntimeStore({ workerFactory: harness.factory }),
    adapter: new ConversationMarkdownAdapter(),
  });
  vi.stubGlobal("Worker", class TestWorkerMarker {});
});

afterEach(() => {
  conversationBaselineDiagnostics.enable(false);
  conversationBaselineDiagnostics.reset();
  resetConversationMarkdownRuntimeForTests();
  vi.unstubAllGlobals();
});

describe("ConversationMarkdownRuntimeHost", () => {
  it("renders a settled assistant MessageText through the Worker-backed conversation profile", async () => {
    const assistant = message("assistant-settled", "# Runtime heading\n\nSettled **answer**.", "completed");
    const { container, unmount } = render(<MessageText message={assistant} />);

    await waitFor(() => {
      expect(container.querySelector('[data-message-markdown-runtime-status="ready"]')).not.toBeNull();
      expect(container.querySelector("h1")?.textContent).toBe("Runtime heading");
    });
    expect(container.querySelector('[data-message-markdown-mode="runtime"]')).not.toBeNull();
    expect(container.textContent).toContain("Settled answer.");
    expect(harness.canonicalParses).toBe(1);
    unmount();
  });

  it("renders user Markdown through the same runtime while preserving context, attachments shell and steer badge", async () => {
    const reverse = vi.fn();
    const user = {
      ...message("user-runtime", "# User heading\n\nPlease inspect this.", "completed"),
      kind: "user" as const,
      payload: {
        contextItems: [{ id: "ctx-1", type: "file", label: "README.md", path: "README.md" }],
        pendingInputId: "pending-1",
        deliveryMode: "steer",
        messageEventId: "event-user-1",
      },
    };
    const rendered = render(<MessageText message={user} onReverseFromMessage={reverse} />);
    await ready(rendered.container, "Please inspect this.");

    expect(rendered.container.querySelector('[data-message-markdown-mode="runtime"]')).not.toBeNull();
    const userCursor = rendered.container.querySelector<HTMLElement>('[data-streaming-markdown-cursor="true"]');
    expect(userCursor?.hidden).toBe(true);
    expect(userCursor?.style.display).toBe("none");
    expect((rendered.container.querySelector('[data-runtime-user-bubble-sizer="true"]') as HTMLElement | null)?.dataset.runtimeUserBubbleSizerText)
      .toBe("# User heading\n\nPlease inspect this.");
    expect(screen.getByRole("heading", { name: "User heading" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "打开文件引用 README.md" })).not.toBeNull();
    expect(screen.getByTestId("steer-delivery-badge")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "回溯到此处" }));
    expect(reverse).toHaveBeenCalledWith(user);
  });

  it("keeps protocol redaction, file-link line metadata, terminal badges and ghost footer around runtime Markdown", async () => {
    const terminal = {
      ...message(
        "assistant-shell",
        'Before\n\n<tool_call>{"name":"read_file"}</tool_call>\n<tool_result>secret</tool_result>\n\nSee [notes.md](<D:/Docs/notes.md:7>)',
        "cancelled",
      ),
      payload: { duration_ms: 2340, ghostStats: { inputTokens: 1, outputTokens: 2 } },
    };
    const rendered = render(<MessageText message={terminal} />);
    await ready(rendered.container, "Before");

    expect(screen.getByRole("note").textContent).toContain("不是后端真实工具执行结果");
    expect(rendered.container.textContent).not.toContain("read_file");
    expect(rendered.container.textContent).not.toContain("secret");
    const link = screen.getByRole("link", { name: "notes.md" });
    expect(link.getAttribute("data-keydex-file-path")).toBe("D:/Docs/notes.md");
    expect(link.querySelector('[data-keydex-file-link-line-badge="true"]')?.textContent).toBe("L7");
    expect(screen.getByText("已取消")).not.toBeNull();
    expect(screen.getByTestId("message-ghost-footer").textContent).toContain("耗时 2.3 秒");
  });

  it("opens a runtime file link with the exact local path and line reveal", async () => {
    const rendered = render(
      <PreviewProvider>
        <MessageText message={message("assistant-link", "See [notes.md](<D:/Docs/local notes.md:17>)", "completed")} />
        <RuntimePreviewProbe />
      </PreviewProvider>,
    );
    await ready(rendered.container, "notes.md");
    fireEvent.click(screen.getByRole("link", { name: "notes.md" }));
    expect(JSON.parse(screen.getByTestId("runtime-preview-entry").textContent ?? "{}"))
      .toMatchObject({
        request: { type: "local-file", path: "D:/Docs/local notes.md" },
        revealTarget: { lineStart: 17, lineEnd: 17 },
      });
  });

  it("opens a Windows file link through a dot-prefixed directory without dropping its separator", async () => {
    const path = "D:\\Pycharm Projects\\kt-pm-platform\\.ktaicoding\\des\\DES-20260712-001-Keydex项目模式任务闭环与云端接入.md";
    const rendered = render(
      <PreviewProvider>
        <MessageText message={message("assistant-dot-directory", `[DES-20260712-001](<${path}>)`, "completed")} />
        <RuntimePreviewProbe />
      </PreviewProvider>,
    );
    await ready(rendered.container, "DES-20260712-001");
    fireEvent.click(screen.getByRole("link", { name: "DES-20260712-001" }));
    expect(JSON.parse(screen.getByTestId("runtime-preview-entry").textContent ?? "{}"))
      .toMatchObject({
        request: { type: "local-file", path },
      });
  });

  it("quotes and asks from a native runtime selection without replacing the selected DOM", async () => {
    const quote = vi.fn();
    const ask = vi.fn();
    const rendered = render(
      <MessageText
        message={message("assistant-selection", "Runtime selection text", "completed")}
        onQuoteSelection={quote}
        onAskSelectionInBtwConversation={ask}
      />,
    );
    await ready(rendered.container, "Runtime selection text");
    const markdown = rendered.container.querySelector(".keydex-markdown")!;
    const selection = mockRuntimeSelection(markdown, "Runtime selection text");
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
    fireEvent.click(await screen.findByRole("button", { name: "引用选中文本" }));
    expect(quote).toHaveBeenCalledWith("Runtime selection text");
    selection.restore();

    const secondSelection = mockRuntimeSelection(markdown, "Runtime selection text");
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
    fireEvent.click(await screen.findByRole("button", { name: "在旁路对话中询问选中文本" }));
    expect(ask).toHaveBeenCalledWith("Runtime selection text");
    secondSelection.restore();
  });

  it("does not rebuild a stable runtime MessageText when a parent rerenders", async () => {
    const stable = message("assistant-stable", "Stable answer", "completed");
    conversationBaselineDiagnostics.enable();
    const rendered = render(<MessageText message={stable} />);
    await ready(rendered.container, "Stable answer");
    conversationBaselineDiagnostics.reset();
    rendered.rerender(<MessageText message={stable} />);
    expect(conversationBaselineDiagnostics.snapshot().events.filter((event) => event.stage === "message-text-render"))
      .toHaveLength(0);
    expect(harness.canonicalParses).toBe(1);
    conversationBaselineDiagnostics.enable(false);
    conversationBaselineDiagnostics.reset();
  });

  it("publishes a retained settled Snapshot during remount layout without reparsing", async () => {
    const registry = createConversationMarkdownRendererRegistry();
    const settled = message("assistant-warm-remount", "Warm retained answer", "completed");
    const first = render(
      <ConversationMarkdownRuntimeHost message={settled} registry={registry} showCursor={false} source={settled.content} />,
    );
    await ready(first.container, "Warm retained answer");
    expect(harness.canonicalParses).toBe(1);
    first.unmount();

    const second = render(
      <ConversationMarkdownRuntimeHost message={settled} registry={registry} showCursor={false} source={settled.content} />,
    );

    expect(second.container.querySelector('[data-message-markdown-runtime-status="ready"]')).not.toBeNull();
    expect(second.container.textContent).toContain("Warm retained answer");
    expect(harness.canonicalParses).toBe(1);
  });

  it("publishes append-only tails including lists, preserves prefix DOM, corrects by epoch, and canonically completes", async () => {
    const registry = createConversationMarkdownRendererRegistry();
    const running = message("assistant-stream", "Alpha\n\nBeta", "running");
    const { container, rerender } = render(
      <ConversationMarkdownRuntimeHost message={running} registry={registry} showCursor source={running.content} />,
    );
    await ready(container, "Beta");
    const alpha = findBlock(container, "Alpha");
    const cursor = container.querySelector<HTMLElement>('[data-testid="streaming-cursor"]');
    expect(cursor).not.toBeNull();
    expect(cursor?.hidden).toBe(false);
    expect(cursor?.className).not.toBe("");
    const cursorDots = cursor?.querySelectorAll<HTMLElement>('[data-streaming-cursor-dot="true"]') ?? [];
    expect(cursorDots).toHaveLength(3);
    expect([...cursorDots].every((dot) => Boolean(dot.className))).toBe(true);

    const appendedSource = "Alpha\n\nBeta\n\nGamma";
    rerender(
      <ConversationMarkdownRuntimeHost
        message={{ ...running, content: appendedSource }}
        registry={registry}
        showCursor
        source={appendedSource}
      />,
    );
    await ready(container, "Gamma");
    expect(findBlock(container, "Alpha")).toBe(alpha);
    expect(harness.tailParses).toBeGreaterThanOrEqual(2);

    const listSource = `${appendedSource}\n\n- First streamed item\n- Second streamed item`;
    rerender(
      <ConversationMarkdownRuntimeHost
        message={{ ...running, content: listSource }}
        registry={registry}
        showCursor
        source={listSource}
      />,
    );
    await ready(container, "Second streamed item");
    expect([...container.querySelectorAll<HTMLElement>("[data-markdown-list-content]")]
      .map((element) => element.textContent))
      .toEqual(["First streamed item", "Second streamed item"]);

    const correctedSource = "Alpha\n\nCorrected";
    rerender(
      <ConversationMarkdownRuntimeHost
        message={{ ...running, content: correctedSource }}
        registry={registry}
        showCursor
        source={correctedSource}
      />,
    );
    await ready(container, "Corrected");
    expect(container.textContent).not.toContain("Gamma");

    const completed = { ...running, content: correctedSource, status: "completed" as const };
    rerender(
      <ConversationMarkdownRuntimeHost message={completed} registry={registry} showCursor={false} source={correctedSource} />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-markdown-retained-document="true"]')?.getAttribute("data-markdown-revision"))
        .toContain("conversation-settled:");
    });
    expect(container.querySelector('[data-testid="streaming-cursor"]')).toBeNull();
    const completedCursor = container.querySelector<HTMLElement>('[data-streaming-markdown-cursor="true"]');
    expect(completedCursor?.hidden).toBe(true);
    expect(completedCursor?.style.display).toBe("none");
    expect(harness.canonicalParses).toBe(2);
  });

  it("coalesces rapid desired updates instead of parsing every React render", async () => {
    const registry = createConversationMarkdownRendererRegistry();
    const running = message("assistant-burst", "A", "running");
    const rendered = render(
      <ConversationMarkdownRuntimeHost message={running} registry={registry} showCursor source="A" />,
    );
    for (let index = 2; index <= 100; index += 1) {
      const source = "A".repeat(index);
      rendered.rerender(
        <ConversationMarkdownRuntimeHost
          message={{ ...running, content: source }}
          registry={registry}
          showCursor
          source={source}
        />,
      );
    }
    await ready(rendered.container, "A".repeat(100));
    expect(harness.tailParses).toBeLessThan(100);
    expect(rendered.container.textContent).toContain("A".repeat(100));
  });

  it.each(["cancelled", "failed"] as const)("canonically renders a %s assistant without a streaming cursor", async (status) => {
    const registry = createConversationMarkdownRendererRegistry();
    const terminal = message(`assistant-${status}`, `# ${status}\n\nPartial answer`, status);
    const rendered = render(
      <ConversationMarkdownRuntimeHost message={terminal} registry={registry} showCursor={false} source={terminal.content} />,
    );
    await ready(rendered.container, "Partial answer");
    expect(rendered.container.querySelector("h1")?.textContent).toBe(status);
    expect(rendered.container.querySelector('[data-testid="streaming-cursor"]')).toBeNull();
    expect(rendered.container.querySelector('[data-markdown-retained-document="true"]')?.getAttribute("data-markdown-revision"))
      .toContain(`:${status}:`);
  });
});

async function ready(container: HTMLElement, text: string) {
  await waitFor(() => {
    expect(container.querySelector('[data-message-markdown-runtime-status="ready"]')).not.toBeNull();
    expect(container.textContent).toContain(text);
  }, { timeout: 5_000 });
}

function findBlock(container: HTMLElement, text: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>("[data-markdown-block-id]")]
    .find((element) => element.textContent === text) ?? null;
}

function message(id: string, content: string, status: ConversationMessage["status"]): ConversationMessage {
  return {
    id,
    threadId: "session-runtime",
    turnId: "turn-runtime",
    itemId: id,
    kind: "assistant",
    status,
    content,
    payload: {},
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

class InProcessWorker implements DocumentWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  private terminated = false;

  constructor(private readonly harness: WorkerHarness) {}

  postMessage(request: MarkdownWorkerRequest): void {
    if (request.type === "cancel") {
      queueMicrotask(() => this.emit({ ...identity(request), type: "cancelled", payload: { target_request_id: request.payload.target_request_id } }));
      return;
    }
    const key = documentKey(request);
    if (request.type === "dispose") {
      this.harness.snapshots.delete(key);
      this.harness.sources.delete(key);
      this.harness.parsers.delete(key);
      return;
    }
    if (request.type === "hydrate-snapshot") {
      this.harness.snapshots.set(key, request.payload.snapshot);
      this.harness.sources.set(key, request.payload.source);
      queueMicrotask(() => this.emit({ ...identity(request), type: "hydrated", payload: { estimated_bytes: request.payload.snapshot.estimated_bytes } }));
      return;
    }
    if (request.type === "parse-canonical") {
      this.harness.canonicalParses += 1;
      queueMicrotask(() => {
        const source = sourceText(request.payload.source);
        const snapshot = parseCanonicalMarkdownSnapshot({
          surface: request.surface,
          documentId: request.document_id,
          revision: request.revision,
          source,
          rendererProfile: request.payload.options.renderer_profile,
        }, { previousSnapshot: this.harness.snapshots.get(key) });
        this.harness.snapshots.set(key, snapshot);
        this.harness.sources.set(key, source);
        this.harness.parsers.delete(key);
        this.emit({ ...identity(request), type: "snapshot-result", payload: snapshot });
      });
      return;
    }
    if (request.type === "parse-stream-tail") {
      this.harness.tailParses += 1;
      queueMicrotask(() => {
        const baseSource = this.harness.sources.get(key) ?? "";
        const baseSnapshot = this.harness.snapshots.get(key);
        if (!baseSnapshot || baseSnapshot.revision !== request.payload.base_revision) throw new Error("bad base revision");
        const baseBytes = new TextEncoder().encode(baseSource).slice(0, request.payload.base_source_bytes);
        const appendBytes = new TextEncoder().encode(sourceText(request.payload.append));
        const bytes = new Uint8Array(baseBytes.length + appendBytes.length);
        bytes.set(baseBytes);
        bytes.set(appendBytes, baseBytes.length);
        const source = new TextDecoder().decode(bytes);
        const parser = this.harness.parsers.get(key) ?? new StreamingTailParser({
          surface: request.surface,
          documentId: request.document_id,
          rendererProfile: request.payload.options.renderer_profile,
          initialSource: baseSource,
          initialSnapshot: baseSnapshot,
          initialEpoch: baseSnapshot.stream.kind === "streaming" ? baseSnapshot.stream.epoch : request.payload.stream_epoch,
        });
        this.harness.parsers.set(key, parser);
        const snapshot = parser.update({
          source,
          revision: request.revision,
          epoch: request.payload.stream_epoch,
          final: request.payload.final,
        }).snapshot;
        this.harness.snapshots.set(key, snapshot);
        this.harness.sources.set(key, source);
        this.emit({ ...identity(request), type: "snapshot-result", payload: snapshot });
      });
    }
  }

  terminate(): void { this.terminated = true; }
  private emit(response: MarkdownWorkerResponse) {
    if (!this.terminated) this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }
}

class WorkerHarness {
  readonly snapshots = new Map<string, MarkdownSnapshot>();
  readonly sources = new Map<string, string>();
  readonly parsers = new Map<string, StreamingTailParser>();
  canonicalParses = 0;
  tailParses = 0;
  factory = () => new InProcessWorker(this);
}

function identity(request: MarkdownWorkerRequest) {
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface: request.surface,
    document_id: request.document_id,
    revision: request.revision,
    request_id: request.request_id,
  } as const;
}

function documentKey(request: MarkdownWorkerRequest): string {
  return `${request.surface}\u0000${request.document_id}`;
}

function sourceText(source: { kind: "text"; content: string } | { kind: "utf8-buffer"; data: ArrayBuffer }): string {
  return source.kind === "text" ? source.content : new TextDecoder().decode(source.data);
}

function RuntimePreviewProbe() {
  const preview = usePreview();
  const entry = preview.entries.at(-1);
  return (
    <output data-testid="runtime-preview-entry">
      {entry ? JSON.stringify({ request: entry.request, revealTarget: entry.revealTarget }) : ""}
    </output>
  );
}

function mockRuntimeSelection(container: Element, text: string) {
  const removeAllRanges = vi.fn();
  const range = {
    commonAncestorContainer: container,
    getBoundingClientRect: () => ({
      left: 120,
      top: 140,
      right: 220,
      bottom: 160,
      width: 100,
      height: 20,
      x: 120,
      y: 140,
      toJSON: () => ({}),
    }),
  };
  const spy = vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges,
  } as unknown as Selection);
  return { restore: () => spy.mockRestore() };
}
