import { describe, expect, it } from "vitest";

import {
  createDiffDocumentId,
  createDiffFileCacheKey,
  createDiffFileId,
  createDiffScopeFingerprint,
  createDiffSourceVersion,
  diffAsyncIdentity,
  fingerprintDiffContent,
  matchesCurrentDiffAsyncIdentity,
} from "@/renderer/components/diff/identity";
import { createKeydexDiffDocument, createKeydexDiffFile } from "@/renderer/components/diff/model";

const secretWorkspace = "C:\\Users\\private-user\\secret-project";
const repository = "git-secret-repository-id";

function identities(patch = "@@ -1 +1 @@\n-old\n+new", revision = 1) {
  const scopeFingerprint = createDiffScopeFingerprint({
    source: "git",
    workspaceId: secretWorkspace,
    repositoryId: repository,
  });
  const sourceVersion = createDiffSourceVersion({ revision, content: patch });
  const fileId = createDiffFileId({
    scopeFingerprint,
    status: "modified",
    oldPath: "src/example.ts",
    newPath: "src/example.ts",
  });
  const cacheKey = createDiffFileCacheKey({
    fileId,
    sourceVersion,
    language: "typescript",
    patch,
  });
  const documentId = createDiffDocumentId({
    source: "git",
    scopeFingerprint,
    sourceVersion,
    fileIds: [fileId],
  });
  return { scopeFingerprint, sourceVersion, fileId, cacheKey, documentId, patch };
}

function document(identity = identities()) {
  return createKeydexDiffDocument({
    id: identity.documentId,
    source: "git",
    sourceVersion: identity.sourceVersion,
    files: [
      createKeydexDiffFile({
        id: identity.fileId,
        cacheKey: identity.cacheKey,
        oldPath: "src/example.ts",
        newPath: "src/example.ts",
        status: "modified",
        patch: identity.patch,
      }),
    ],
  });
}

describe("Diff identity and cache keys", () => {
  it("normalizes line endings while preserving meaningful patch changes", () => {
    expect(fingerprintDiffContent("a\r\nb\r\n")).toBe(fingerprintDiffContent("a\nb\n"));
    expect(fingerprintDiffContent("a\nb\n")).not.toBe(fingerprintDiffContent("a\nB\n"));
  });

  it("makes path case behavior explicit", () => {
    const scopeFingerprint = createDiffScopeFingerprint({ source: "preview", workspaceId: "one" });
    const lower = createDiffFileId({
      scopeFingerprint,
      status: "modified",
      oldPath: "src/file.ts",
      newPath: "src/file.ts",
    });
    const upper = createDiffFileId({
      scopeFingerprint,
      status: "modified",
      oldPath: "SRC/File.ts",
      newPath: "SRC/File.ts",
    });
    const insensitive = createDiffFileId({
      scopeFingerprint,
      status: "modified",
      oldPath: "SRC\\File.ts",
      newPath: "SRC\\File.ts",
      pathCaseSensitivity: "insensitive",
    });
    const insensitiveLower = createDiffFileId({
      scopeFingerprint,
      status: "modified",
      oldPath: "src/file.ts",
      newPath: "src/file.ts",
      pathCaseSensitivity: "insensitive",
    });

    expect(lower).not.toBe(upper);
    expect(insensitive).toBe(insensitiveLower);
  });

  it("separates repository, revision and content without leaking private input", () => {
    const base = identities();
    const otherRepositoryScope = createDiffScopeFingerprint({
      source: "git",
      workspaceId: secretWorkspace,
      repositoryId: "another-repository",
    });
    expect(base.scopeFingerprint).not.toBe(otherRepositoryScope);
    expect(base.sourceVersion).not.toBe(identities(base.patch, 2).sourceVersion);
    expect(base.cacheKey).not.toBe(identities("@@ -1 +1 @@\n-old\n+changed", 1).cacheKey);

    for (const value of Object.values(base)) {
      if (typeof value !== "string" || value === base.patch) continue;
      expect(value).not.toContain(secretWorkspace);
      expect(value).not.toContain(repository);
      expect(value).not.toContain("src/example.ts");
    }
  });

  it("rejects late worker results from an older document version or cache key", () => {
    const current = document();
    const currentIdentity = diffAsyncIdentity(current);
    expect(matchesCurrentDiffAsyncIdentity(current, currentIdentity)).toBe(true);

    const newer = document(identities("@@ -1 +1 @@\n-old\n+newer", 2));
    expect(matchesCurrentDiffAsyncIdentity(newer, currentIdentity)).toBe(false);
    expect(matchesCurrentDiffAsyncIdentity(current, diffAsyncIdentity(newer))).toBe(false);
  });

  it("increments streaming versions without making sequence values readable in cache keys", () => {
    const first = createDiffSourceVersion({ sequence: 1, content: "+partial" });
    const second = createDiffSourceVersion({ sequence: 2, content: "+partial" });
    expect(first).not.toBe(second);
    expect(first).not.toContain("partial");
    expect(second).not.toContain("partial");
  });
});
