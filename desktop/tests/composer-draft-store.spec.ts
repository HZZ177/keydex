import { describe, expect, it } from "vitest";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  composerNewWorkspaceDraftScope,
  composerSessionDraftScope,
  createComposerDraftStore,
} from "@/renderer/features/composer";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("composer draft store", () => {
  it("restores text and composer context after recreating the frontend store", () => {
    const storage = new MemoryStorage();
    let timestamp = Date.UTC(2026, 6, 16, 8, 0, 0);
    const scope = composerSessionDraftScope("ses-1");
    const store = createComposerDraftStore({
      storage,
      persistDelayMs: 0,
      now: () => ++timestamp,
    });

    store.updateDraft(scope, {
      text: "继续完善缓存功能",
      selectedSkill: {
        name: "test-plan",
        description: "生成测试方案",
        source: "workspace",
        label: "Test plan",
        locator: "D:/repo/.codex/skills/test-plan/SKILL.md",
      },
      files: [
        {
          path: "D:/repo/README.md",
          name: "README.md",
          type: "file",
          source: "workspace",
        },
      ],
      quotes: [
        {
          id: "quote-1",
          text: "保留这段引用",
          preview: "保留这段引用",
          source: "selection",
        },
      ],
      attachments: [
        {
          id: "attachment-1",
          attachment_id: "attachment-1",
          type: "image",
          name: "draft.png",
          path: "attachments/draft.png",
          mime_type: "image/png",
          size: 128,
          source: "upload",
          previewUrl: "blob:keydex-draft-preview",
        },
      ],
      webAnnotations: [
        {
          annotationId: "annotation-1",
          selectedRevision: 3,
          selectedAt: "2026-07-22T08:00:00Z",
          sourcePanelId: "right-sidebar:browser:1",
        },
      ],
    });
    store.flush();
    store.dispose();

    const restored = createComposerDraftStore({ storage, now: () => timestamp + 1 }).getDraft(scope);

    expect(restored).toMatchObject({
      text: "继续完善缓存功能",
      selectedSkill: { name: "test-plan", source: "workspace" },
      files: [{ path: "D:/repo/README.md" }],
      quotes: [{ id: "quote-1", text: "保留这段引用" }],
      attachments: [{ attachment_id: "attachment-1", previewUrl: null }],
      webAnnotations: [{ annotationId: "annotation-1", selectedRevision: 3 }],
    });
    expect(JSON.parse(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "null")).toMatchObject({
      version: 1,
    });
  });

  it("keeps session and new-workspace drafts isolated and clears only the submitted scope", () => {
    const storage = new MemoryStorage();
    const store = createComposerDraftStore({ storage, persistDelayMs: 0 });
    const sessionA = composerSessionDraftScope("ses-a");
    const sessionB = composerSessionDraftScope("ses-b");
    const newWorkspace = composerNewWorkspaceDraftScope("workspace-1");

    store.updateDraft(sessionA, { text: "会话 A 草稿" });
    store.updateDraft(sessionB, { text: "会话 B 草稿" });
    store.updateDraft(newWorkspace, { text: "新会话草稿" });
    store.clearDraft(sessionA);

    expect(store.getDraft(sessionA).text).toBe("");
    expect(store.getDraft(sessionB).text).toBe("会话 B 草稿");
    expect(store.getDraft(newWorkspace).text).toBe("新会话草稿");
  });

  it("normalizes and deduplicates persisted web annotation references without persisting presentation content", () => {
    const storage = new MemoryStorage();
    const scope = composerSessionDraftScope("ses-web-annotations");
    const store = createComposerDraftStore({ storage, persistDelayMs: 0 });

    store.updateDraft(scope, {
      webAnnotations: [
        {
          annotationId: " annotation-1 ",
          selectedRevision: 2,
          selectedAt: "2026-07-22T08:00:00Z",
          sourcePanelId: " browser-1 ",
        },
        {
          annotationId: "annotation-1",
          selectedRevision: 99,
          selectedAt: "2026-07-22T09:00:00Z",
        },
      ],
    });
    store.flush();

    expect(store.getDraft(scope).webAnnotations).toEqual([{
      annotationId: "annotation-1",
      selectedRevision: 2,
      selectedAt: "2026-07-22T08:00:00Z",
      sourcePanelId: "browser-1",
    }]);
    const persisted = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "";
    expect(persisted).not.toContain("bodyMarkdown");
    expect(persisted).not.toContain("documentUrl");
  });

  it("persists an immutable replay snapshot separately from live annotation references", () => {
    const storage = new MemoryStorage();
    const scope = composerSessionDraftScope("ses-web-annotation-retry");
    const store = createComposerDraftStore({ storage, persistDelayMs: 0 });
    const snapshot = replaySnapshot();

    store.updateDraft(scope, {
      text: "重新发送",
      webAnnotations: [{
        annotationId: snapshot.reference.annotationId,
        selectedRevision: snapshot.reference.revision,
        selectedAt: snapshot.reference.assembledAt,
      }],
      replayedContextItems: [{
        id: `web-annotation:${snapshot.reference.annotationId}:${snapshot.integrity.digest}`,
        type: "web_annotation",
        label: "网页批注 · History",
        content: "发送时内容",
        metadata: {
          annotation_id: snapshot.reference.annotationId,
          snapshot_digest: snapshot.integrity.digest,
          snapshot,
        },
      }],
    });
    store.flush();

    const restored = createComposerDraftStore({ storage }).getDraft(scope);
    expect(restored.replayedContextItems).toHaveLength(1);
    expect(restored.replayedContextItems[0].metadata?.snapshot).toEqual(snapshot);
  });

  it("keeps incognito web references in runtime memory and excludes them from browser storage", () => {
    const storage = new MemoryStorage();
    const scope = composerSessionDraftScope("ses-incognito-runtime-only");
    const store = createComposerDraftStore({ storage, persistDelayMs: 0 });
    const snapshot = {
      ...replaySnapshot(),
      reference: {
        ...replaySnapshot().reference,
        annotationId: "incognito-web:runtime-only",
      },
    };
    const contextItem = {
      id: `web-annotation:${snapshot.reference.annotationId}:${snapshot.integrity.digest}`,
      type: "web_annotation",
      label: "无痕网页引用 · History",
      content: "仅在运行内存保存",
      metadata: {
        annotation_id: snapshot.reference.annotationId,
        snapshot_digest: snapshot.integrity.digest,
        incognito_source: true,
        snapshot,
      },
    };

    store.updateDraft(scope, {
      webAnnotations: [{
        annotationId: snapshot.reference.annotationId,
        selectedRevision: snapshot.reference.revision,
        selectedAt: snapshot.reference.assembledAt,
      }],
      replayedContextItems: [contextItem],
    });
    store.flush();

    expect(store.getDraft(scope).webAnnotations).toHaveLength(1);
    expect(store.getDraft(scope).replayedContextItems).toHaveLength(1);
    expect(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toBeNull();
    expect(createComposerDraftStore({ storage }).getDraft(scope).webAnnotations).toEqual([]);
  });

  it("persists folded paste ranges without duplicating their raw text", () => {
    const storage = new MemoryStorage();
    const scope = composerSessionDraftScope("ses-paste");
    const text = `0123456789${"x".repeat(180)}ABCDEFGHIJ`;
    const store = createComposerDraftStore({ storage, persistDelayMs: 0 });

    store.updateDraft(scope, {
      text,
      pastedTextFragments: [{ id: "paste-1", start: 0, end: text.length, collapsed: true }],
    });
    store.flush();

    const restored = createComposerDraftStore({ storage }).getDraft(scope);
    expect(restored.text).toBe(text);
    expect(restored.pastedTextFragments).toEqual([
      { id: "paste-1", start: 0, end: text.length, collapsed: true },
    ]);
    expect(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)?.match(new RegExp(text, "g"))?.length).toBe(1);
  });

  it("ignores malformed or incompatible persisted data", () => {
    const storage = new MemoryStorage();
    storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({ version: 999, drafts: { "session:ses-1": {} } }));

    const store = createComposerDraftStore({ storage });

    expect(store.getDraft(composerSessionDraftScope("ses-1")).text).toBe("");
  });
});

function replaySnapshot() {
  const machineTarget = {
    type: "text" as const,
    quote: { exact: "历史片段", prefix: "", suffix: "" },
    context: { headingPath: [] },
    rects: [{ x: 0, y: 0, width: 80, height: 20 }],
    frame: { url: "https://example.test/history", indexPath: [] },
  };
  return {
    schemaVersion: 2 as const,
    type: "web_annotation" as const,
    reference: {
      annotationId: "annotation-replay-1",
      revision: 2,
      anchorId: "wa_replay000000001",
      createdAt: "2026-07-22T08:00:00Z",
      assembledAt: "2026-07-22T08:00:00Z",
    },
    trust: {
      userComment: "user_instruction" as const,
      pageEvidence: "untrusted_reference" as const,
      hostObservation: "trusted_application_observation" as const,
    },
    comment: { bodyMarkdown: "发送时正文", tags: [], properties: [] },
    page: {
      title: "History",
      documentUrl: "https://example.test/history",
      canonicalUrl: null,
      urlKey: "c".repeat(64),
      origin: "https://example.test",
      frame: machineTarget.frame,
    },
    anchor: {
      kind: "text" as const,
      display: { label: "历史片段", quote: "历史片段" },
      semantic: { stableAttributes: [] },
      content: { exactText: "历史片段", prefix: "", suffix: "" },
      structure: {
        locators: [{ kind: "text_quote" as const, stability: "medium" as const, value: "历史片段" }],
        headingPath: [],
      },
      geometry: { rects: machineTarget.rects },
      machineTarget,
    },
    observation: {
      status: "exact" as const,
      freshness: "live" as const,
      observedAt: "2026-07-22T08:00:00Z",
      match: { strategy: "exact_quote" as const, confidence: 1, candidateCount: 1 },
      currentTarget: machineTarget,
      changes: { kinds: [], materialKinds: [], signals: [], material: false },
    },
    integrity: {
      canonicalization: "keydex-json-c14n/v1" as const,
      digest: `sha256:${"e".repeat(64)}`,
    },
  };
}
