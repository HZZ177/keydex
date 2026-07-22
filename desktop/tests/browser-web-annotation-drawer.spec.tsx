import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createWebAnnotationStore,
  WebAnnotationDrawer,
  WebAnnotationEditor,
  WebAnnotationSession,
  type WebAnnotationClient,
  type WebAnnotationDetail,
  type WebAnnotationItem,
  type WebAnnotationPage,
  type WebAnnotationSessionPort,
  type WebAnnotationCoordinatorResolution,
  type WebAnnotationVisibleStatus,
} from "@/renderer/features/browser/annotations";
import type { BrowserSurfaceRef } from "@/renderer/features/browser/domain";
import {
  BrowserOcclusionProvider,
  useBrowserOcclusionSnapshot,
  type BrowserBridgeEnvelope,
  type WebTextTarget,
} from "@/renderer/features/browser/runtime";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";

const surface: BrowserSurfaceRef = {
  panelId: "browser-1",
  surfaceId: "surface-1",
  generation: 1,
};
const textTarget: WebTextTarget = {
  type: "text",
  quote: { exact: "Selected text", prefix: "", suffix: "" },
  position: { start: 0, end: 13, textModelVersion: 1 },
  context: { headingPath: ["Heading"] },
  rects: [{ x: 10, y: 20, width: 120, height: 18 }],
  frame: { url: "https://example.test/article", indexPath: [] },
};
const replacementTextTarget: WebTextTarget = {
  ...textTarget,
  quote: { exact: "Replacement text", prefix: "Before", suffix: "After" },
  position: { start: 42, end: 58, textModelVersion: 1 },
  rects: [{ x: 12, y: 64, width: 144, height: 18 }],
};

describe("WebAnnotationDrawer", () => {
  it("uses AppDialog occlusion and shows the current-page empty state", async () => {
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    }));
    await activate(store);

    renderDrawer(store, session(), { open: true });

    expect(screen.getByRole("dialog", { name: "网页批注" })).not.toBeNull();
    expect(screen.getByText("当前页面还没有批注")).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("occlusion-state").textContent).toBe("occluded");
    });
    expect(screen.getByRole("button", { name: "选择文本" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "选择元素" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "选择区域" })).not.toBeNull();
  });

  it("closes when the user clicks outside the annotation drawer", async () => {
    const onClose = vi.fn();
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    }));
    await activate(store);

    renderDrawer(store, session(), { open: true, onClose });

    const dialog = screen.getByRole("dialog", { name: "网页批注" });
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("can be used as a saved-annotation viewer without selection actions", async () => {
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(item("annotation-view", "需要复核这段内容"))),
    }));
    await activate(store);

    renderDrawer(store, session(), { open: true, showCreationActions: false });

    expect(screen.getByText("需要复核这段内容")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "选择文本" })).toBeNull();
    expect(screen.queryByRole("button", { name: "选择元素" })).toBeNull();
    expect(screen.queryByRole("button", { name: "选择区域" })).toBeNull();
    expect(screen.queryByText("点击顶部批注按钮，然后在页面中选择元素。")).toBeNull();
  });

  it("describes the single top-button element workflow in an empty saved-annotation viewer", async () => {
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    }));
    await activate(store);

    renderDrawer(store, session(), { open: true, showCreationActions: false });

    expect(screen.getByText("点击顶部批注按钮，然后在页面中选择元素。")).not.toBeNull();
    expect(screen.queryByText("从上方选择文本、元素或区域开始。")).toBeNull();
  });

  it("creates a selected text draft and returns the session to idle", async () => {
    const create = vi.fn().mockImplementation(async (input) => detail({
      ...item("annotation-created", "Draft body"),
      annotation: {
        ...item("annotation-created", "Draft body").annotation,
        target: input.target,
        bodyMarkdown: input.bodyMarkdown,
      },
    }));
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      create,
    }));
    await activate(store);
    const annotationSession = session();
    await annotationSession.startSelection("text");
    annotationSession.applyBridgeEnvelope(selectionResult());

    renderDrawer(store, annotationSession, { open: true });
    fireEvent.change(screen.getByRole("textbox", { name: "批注内容" }), {
      target: { value: "Draft body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建批注" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      bodyMarkdown: "Draft body",
      scope: { kind: "session", id: "session-1" },
      target: textTarget,
    })));
    await waitFor(() => expect(annotationSession.getSnapshot().status).toBe("idle"));
    expect(screen.getByText("网页批注已创建")).not.toBeNull();
  });

  it("requires explicit confirmation for an incognito one-time reference and never creates a DB annotation", async () => {
    const create = vi.fn();
    const onCreateTemporaryReference = vi.fn().mockResolvedValue("added");
    const store = createWebAnnotationStore(client({ create }));
    const annotationSession = session();
    await annotationSession.startSelection("text");
    annotationSession.applyBridgeEnvelope(selectionResult());

    renderDrawer(store, annotationSession, {
      open: true,
      profileMode: "incognito",
      onCreateTemporaryReference,
    });
    expect(screen.getByText("无痕页面仅支持一次性引用")).not.toBeNull();
    expect(screen.queryByText("当前页面")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "批注内容" }), {
      target: { value: "Private one-time note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加到输入框" }));

    expect(screen.getByRole("dialog", { name: "添加无痕网页引用？" })).not.toBeNull();
    expect(onCreateTemporaryReference).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认并添加" }));

    await waitFor(() => expect(onCreateTemporaryReference).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: "draft:selection-1", target: textTarget }),
      expect.objectContaining({ bodyMarkdown: "Private one-time note" }),
    ));
    await waitFor(() => expect(annotationSession.getSnapshot().status).toBe("idle"));
    expect(create).not.toHaveBeenCalled();
  });

  it("edits fields with revision and deletes only after ConfirmDialog", async () => {
    const original = item("annotation-1", "Original body");
    const patch = vi.fn().mockResolvedValue(detail(item("annotation-1", "Updated body", 2)));
    const remove = vi.fn().mockResolvedValue(undefined);
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(original)),
      patch,
      delete: remove,
    }));
    await activate(store);
    renderDrawer(store, session(), { open: true });

    fireEvent.click(screen.getByRole("button", { name: "编辑网页批注" }));
    fireEvent.change(screen.getByRole("textbox", { name: "批注内容" }), {
      target: { value: "Updated body" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "批注标签" }), {
      target: { value: "review, owner" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(patch).toHaveBeenCalledWith("annotation-1", {
      expectedRevision: 1,
      bodyMarkdown: "Updated body",
      tags: ["review", "owner"],
      properties: [{ key: "owner", type: "text", value: "Keydex" }],
    }));
    expect(await screen.findByText("Updated body")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "删除网页批注" }));
    expect(screen.getByRole("dialog", { name: "删除网页批注？" })).not.toBeNull();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("annotation-1"));
    await waitFor(() => expect(screen.queryByText("Updated body")).toBeNull());
  });

  it("adds an annotation to the composer only through the explicit card action", async () => {
    const original = item("annotation-1", "Reference this note");
    const onAddToComposer = vi.fn().mockReturnValue("added");
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(original)),
    }));
    await activate(store);
    renderDrawer(store, session(), { open: true, onAddToComposer });

    expect(onAddToComposer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "添加网页批注到输入框" }));

    expect(onAddToComposer).toHaveBeenCalledWith(original);
    expect(screen.getByText("网页批注已添加到输入框")).not.toBeNull();
  });

  it("shows bounded ambiguous candidates and requires a full new selection before retarget", async () => {
    const original = item("annotation-1", "Preserved body");
    const replacement: WebAnnotationItem = {
      ...original,
      annotation: {
        ...original.annotation,
        target: replacementTextTarget,
        revision: 2,
      },
    };
    const retarget = vi.fn().mockResolvedValue(detail(replacement));
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(original)),
      retarget,
    }));
    await activate(store);
    const annotationSession = session();
    renderDrawer(store, annotationSession, {
      open: true,
      resolutions: { "annotation-1": "ambiguous" },
      resolutionDetails: { "annotation-1": ambiguousResolution() },
    });

    expect(screen.getByRole("button", { name: /候选 1/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /候选 6/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /候选 1/ }));
    expect(annotationSession.getSnapshot().status).toBe("starting");

    act(() => {
      annotationSession.applyBridgeEnvelope(selectionResult(replacementTextTarget));
    });
    const comparison = screen.getByLabelText("重新绑定网页批注");
    expect(within(comparison).getByText("原目标")).not.toBeNull();
    expect(within(comparison).getByText("新目标")).not.toBeNull();
    expect(comparison.textContent).toContain("Selected text");
    expect(comparison.textContent).toContain("Replacement text");
    expect(comparison.textContent).toContain("正文、标签和结构化属性保持不变");
    expect(retarget).not.toHaveBeenCalled();

    fireEvent.click(within(comparison).getByRole("button", { name: "确认重新绑定" }));
    await waitFor(() => expect(retarget).toHaveBeenCalledWith("annotation-1", {
      expectedRevision: 1,
      target: replacementTextTarget,
      stagedAssetIds: undefined,
    }));
    expect(retarget.mock.calls[0][1]).not.toHaveProperty("candidateId");
    expect(retarget.mock.calls[0][1]).not.toHaveProperty("bodyMarkdown");
    await waitFor(() => expect(annotationSession.getSnapshot().status).toBe("idle"));
    expect(screen.getByText("网页批注目标已更新")).not.toBeNull();
    expect(screen.getByText("Preserved body")).not.toBeNull();
  });

  it("supports manual orphan retarget selection and leaves the original untouched on cancel", async () => {
    const original = item("annotation-orphan", "Original orphan note");
    const retarget = vi.fn();
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(original)),
      retarget,
    }));
    await activate(store);
    const annotationSession = session();
    renderDrawer(store, annotationSession, {
      open: true,
      resolutions: { "annotation-orphan": "orphaned" },
    });

    fireEvent.click(screen.getByRole("button", { name: "重新选择目标" }));
    act(() => {
      annotationSession.applyBridgeEnvelope(selectionResult(replacementTextTarget));
    });
    const flow = screen.getByLabelText("重新绑定网页批注");
    fireEvent.click(within(flow).getByRole("button", { name: "取消" }));

    expect(annotationSession.getSnapshot().status).toBe("idle");
    expect(retarget).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("重新绑定网页批注")).toBeNull();
    expect(screen.getByText("Original orphan note")).not.toBeNull();
  });

  it("shows location and material change as separate statuses", async () => {
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(item("annotation-1", "检查变化"))),
    }));
    await activate(store);

    renderDrawer(store, session(), {
      open: true,
      resolutions: { "annotation-1": "resolved" },
      resolutionDetails: { "annotation-1": changedResolution(["quote_changed", "heading_changed"]) },
    });

    expect(screen.getByText("已定位")).not.toBeNull();
    expect(screen.getByText("文本变化")).not.toBeNull();
    expect(screen.queryByText("内容变化")).toBeNull();
  });

  it("enforces tag/property limits and keyboard cancellation without a second modal system", () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(
      <WebAnnotationEditor
        pending={false}
        submitLabel="保存修改"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "批注内容" }), {
      target: { value: "Body" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "批注标签" }), {
      target: { value: Array.from({ length: 21 }, (_, index) => `tag-${index}`).join(",") },
    });
    expect(screen.getByRole("alert").textContent).toContain("20");
    expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "批注内容" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a retryable load error and publishes it through NotificationProvider", async () => {
    const list = vi.fn().mockRejectedValue(new Error("network offline"));
    const store = createWebAnnotationStore(client({ list }));
    await activate(store);

    renderDrawer(store, session(), { open: true });

    expect(screen.getAllByRole("alert").some((element) => (
      element.textContent?.includes("network offline")
    ))).toBe(true);
    expect(screen.getByText("网页批注操作失败")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

function renderDrawer(
  store: ReturnType<typeof createWebAnnotationStore>,
  annotationSession: WebAnnotationSession,
  input: {
    readonly open: boolean;
    readonly resolutions?: Readonly<Record<string, WebAnnotationVisibleStatus | undefined>>;
    readonly resolutionDetails?: Readonly<Record<string, WebAnnotationCoordinatorResolution | undefined>>;
    readonly onAddToComposer?: (item: WebAnnotationItem) => "added" | "duplicate" | "limit" | "unhandled";
    readonly profileMode?: "persistent" | "incognito";
    readonly onCreateTemporaryReference?: Parameters<typeof WebAnnotationDrawer>[0]["onCreateTemporaryReference"];
    readonly showCreationActions?: boolean;
    readonly onClose?: () => void;
  },
) {
  return render(
    <BrowserOcclusionProvider>
      <NotificationProvider>
        <WebAnnotationDrawer
          open={input.open}
          resolutions={input.resolutions}
          resolutionDetails={input.resolutionDetails}
          profileMode={input.profileMode}
          showCreationActions={input.showCreationActions}
          session={annotationSession}
          store={store}
          onAddToComposer={input.onAddToComposer}
          onCreateTemporaryReference={input.onCreateTemporaryReference}
          onClose={input.onClose ?? vi.fn()}
        />
        <OcclusionState />
      </NotificationProvider>
    </BrowserOcclusionProvider>,
  );
}

function OcclusionState() {
  const state = useBrowserOcclusionSnapshot();
  return <span data-testid="occlusion-state">{state.count > 0 ? "occluded" : "visible"}</span>;
}

function session(): WebAnnotationSession {
  const port: WebAnnotationSessionPort = {
    startSelection: vi.fn().mockResolvedValue(undefined),
    cancelSelection: vi.fn().mockResolvedValue(undefined),
    captureRegion: vi.fn().mockResolvedValue(undefined),
    discardCapture: vi.fn().mockResolvedValue(undefined),
    setProtection: vi.fn(),
  };
  return new WebAnnotationSession({
    surface,
    port,
    requestId: () => "selection-1",
    now: () => "2026-07-22T00:00:00Z",
  });
}

async function activate(store: ReturnType<typeof createWebAnnotationStore>) {
  await store.getState().activatePage({
    scope: { kind: "session", id: "session-1" },
    url: "https://example.test/article",
    title: "Article",
    canonicalUrl: null,
    profileMode: "persistent",
    surface,
    navigationId: "navigation-1",
  });
}

function client(overrides: Partial<WebAnnotationClient>): WebAnnotationClient {
  return {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    get: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    retarget: vi.fn(),
    delete: vi.fn(),
    registerAsset: vi.fn(),
    discardAsset: vi.fn(),
    cloneEvidence: vi.fn(),
    ...overrides,
  };
}

function item(annotationId: string, bodyMarkdown: string, revision = 1): WebAnnotationItem {
  return {
    resource: {
      id: "resource-1",
      scope: { kind: "session", id: "session-1" },
      normalizationVersion: 1,
      urlKey: "a".repeat(64),
      urlNormalized: "https://example.test/article",
      documentUrl: "https://example.test/article",
      canonicalUrl: null,
      origin: "https://example.test",
      title: "Article",
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:00:00Z",
    },
    annotation: {
      id: annotationId,
      resourceId: "resource-1",
      targetSchemaVersion: 1,
      target: textTarget,
      bodyMarkdown,
      tags: ["review"],
      properties: [{ key: "owner", type: "text", value: "Keydex" }],
      revision,
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:00:00Z",
    },
  };
}

function detail(value: WebAnnotationItem): WebAnnotationDetail {
  return { ...value, targetHistory: [], assets: [] };
}

function page(value: WebAnnotationItem): WebAnnotationPage {
  return { items: [value], nextCursor: null };
}

function selectionResult(target: WebTextTarget = textTarget): BrowserBridgeEnvelope<"selection.result"> {
  return {
    protocol: "keydex.web-annotation.v1",
    kind: "selection.result",
    ...surface,
    navigationId: "navigation-1",
    frameKey: "main",
    requestId: "selection-1",
    sequence: 1,
    payload: { selectionId: "selection-1", target },
  };
}

function ambiguousResolution(): WebAnnotationCoordinatorResolution {
  const identity = {
    resourceId: "resource-1",
    annotationId: "annotation-1",
    navigationId: "navigation-1",
    frameRevision: 1,
  };
  return {
    status: "ambiguous",
    identity,
    frameKey: "main",
    reason: "ambiguous_candidates",
    lastKnown: null,
    settled: {
      status: "ambiguous",
      identity,
      frameKey: "main",
      target: null,
      candidateIds: Array.from({ length: 6 }, (_, index) => `candidate-${index + 1}`),
      evidence: {
        strategy: "text_context",
        score: 0.8,
        rects: [],
        candidateCount: 6,
        truncated: false,
        changedSignals: [],
        candidateSummaries: Array.from({ length: 6 }, (_, index) => ({
          candidateId: `candidate-${index + 1}`,
          label: `候选 ${index + 1}`,
          tag: "mark",
          role: "note",
        })),
      },
      settledAt: "2026-07-22T00:00:00Z",
    },
  };
}

function changedResolution(changedSignals: readonly string[]): WebAnnotationCoordinatorResolution {
  const identity = {
    resourceId: "resource-1",
    annotationId: "annotation-1",
    navigationId: "navigation-1",
    frameRevision: 1,
  };
  const settled = {
    status: "changed" as const,
    identity,
    frameKey: "main",
    target: textTarget,
    candidateIds: [],
    evidence: {
      strategy: "exact_quote" as const,
      score: 1,
      rects: textTarget.rects,
      candidateCount: 1,
      truncated: false,
      changedSignals,
    },
    settledAt: "2026-07-22T00:00:00Z",
  };
  return {
    status: "changed",
    identity,
    frameKey: "main",
    reason: "content_changed",
    lastKnown: settled,
    settled,
  };
}
