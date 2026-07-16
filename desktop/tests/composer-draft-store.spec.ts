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
