import { describe, expect, it } from "vitest";

import {
  MarkdownRevisionPublicationGate,
  createMarkdownDocumentIdentity,
  diffMarkdownSnapshotIdentities,
} from "@/renderer/markdownRuntime/document/identity";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

function parse(
  source: string,
  revision: string,
  previousSnapshot?: MarkdownSnapshot,
  documentId = "file:workspace-a:README.md",
) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId,
    revision,
    source,
    rendererProfile: "file-preview",
  }, { previousSnapshot });
}

function blockText(snapshot: MarkdownSnapshot, index: number): string {
  const block = snapshot.blocks[index];
  return snapshot.logical_text.slice(block.logical_start, block.logical_end);
}

function identitiesByText(snapshot: MarkdownSnapshot): Map<string, string> {
  return new Map(snapshot.blocks.map((block, index) => [blockText(snapshot, index), block.id]));
}

describe("Markdown revision and stable identity", () => {
  it.each([
    ["head", "Inserted\n\nAlpha\n\nBeta\n\nGamma"],
    ["middle", "Alpha\n\nBeta\n\nInserted\n\nGamma"],
    ["tail", "Alpha\n\nBeta\n\nGamma\n\nInserted"],
  ])("preserves unrelated block identities after a %s insertion", (_, nextSource) => {
    const previous = parse("Alpha\n\nBeta\n\nGamma", "r1");
    const next = parse(nextSource, "r2", previous);
    const previousIds = identitiesByText(previous);
    const nextIds = identitiesByText(next);

    for (const text of ["Alpha", "Beta", "Gamma"]) expect(nextIds.get(text)).toBe(previousIds.get(text));
    expect(nextIds.get("Inserted")).toBeDefined();
    expect(diffMarkdownSnapshotIdentities(previous, next)).toMatchObject({
      reusableBlockIds: expect.arrayContaining([...previousIds.values()]),
      insertedBlockIds: [nextIds.get("Inserted")],
      removedBlockIds: [],
    });
  });

  it("invalidates only an edited block and preserves head/middle/tail deletions", () => {
    const previous = parse("Alpha\n\nBeta\n\nGamma\n\nDelta", "r1");
    const next = parse("Alpha\n\nBeta changed\n\nDelta", "r2", previous);
    const previousIds = identitiesByText(previous);
    const nextIds = identitiesByText(next);
    const diff = diffMarkdownSnapshotIdentities(previous, next);

    expect(nextIds.get("Alpha")).toBe(previousIds.get("Alpha"));
    expect(nextIds.get("Delta")).toBe(previousIds.get("Delta"));
    expect(nextIds.get("Beta changed")).not.toBe(previousIds.get("Beta"));
    expect(diff.removedBlockIds).toEqual(expect.arrayContaining([
      previousIds.get("Beta"),
      previousIds.get("Gamma"),
    ]));
    expect(diff.insertedBlockIds).toEqual([nextIds.get("Beta changed")]);
  });

  it.each([
    ["head", "Beta\n\nGamma\n\nDelta"],
    ["middle", "Alpha\n\nBeta\n\nDelta"],
    ["tail", "Alpha\n\nBeta\n\nGamma"],
  ])("preserves every remaining block identity after a %s deletion", (_, nextSource) => {
    const previous = parse("Alpha\n\nBeta\n\nGamma\n\nDelta", "r1");
    const next = parse(nextSource, "r2", previous);
    const previousIds = identitiesByText(previous);
    const nextIds = identitiesByText(next);

    for (const [text, id] of nextIds) expect(id).toBe(previousIds.get(text));
    const diff = diffMarkdownSnapshotIdentities(previous, next);
    expect(diff.reusableBlockIds).toHaveLength(3);
    expect(diff.insertedBlockIds).toEqual([]);
    expect(diff.removedBlockIds).toHaveLength(1);
  });

  it("keeps a moved heading and its outline key reusable", () => {
    const previous = parse("# One\n\nAlpha\n\n## Two\n\nBeta", "r1");
    const next = parse("## Two\n\nBeta\n\n# One\n\nAlpha", "r2", previous);
    const previousIds = identitiesByText(previous);
    const nextIds = identitiesByText(next);

    expect(nextIds.get("One")).toBe(previousIds.get("One"));
    expect(nextIds.get("Two")).toBe(previousIds.get("Two"));
    expect(new Set(next.outline.map((entry) => entry.id))).toEqual(
      new Set(previous.outline.map((entry) => entry.id)),
    );
  });

  it("gives duplicate text unique keys while reusing every existing instance", () => {
    const previous = parse("Same\n\nSame\n\nSame", "r1");
    const next = parse("Same\n\nSame\n\nSame\n\nSame", "r2", previous);
    const previousIds = previous.blocks.map((block) => block.id);
    const nextIds = next.blocks.map((block) => block.id);

    expect(new Set(previousIds).size).toBe(3);
    expect(new Set(nextIds).size).toBe(4);
    expect(nextIds.slice(0, 3)).toEqual(previousIds);
    expect(diffMarkdownSnapshotIdentities(previous, next)).toMatchObject({
      reusableBlockIds: previousIds,
      insertedBlockIds: [nextIds[3]],
      removedBlockIds: [],
    });
  });

  it("preserves an unchanged resource key and invalidates changed resource content", () => {
    const previous = parse("Intro\n\n![logo](a.png)", "r1");
    const unrelatedEdit = parse("New intro\n\nIntro\n\n![logo](a.png)", "r2", previous);
    const changedResource = parse("New intro\n\nIntro\n\n![logo](b.png)", "r3", unrelatedEdit);

    expect(unrelatedEdit.resources[0].id).toBe(previous.resources[0].id);
    expect(unrelatedEdit.resources[0].block_id).toBe(previous.resources[0].block_id);
    expect(changedResource.resources[0].id).not.toBe(unrelatedEdit.resources[0].id);
    expect(changedResource.resources[0].cache_key).not.toBe(unrelatedEdit.resources[0].cache_key);
  });

  it("namespaces identical content by document path and workspace", () => {
    const firstDocument = createMarkdownDocumentIdentity({
      surface: "file",
      workspaceId: "workspace-a",
      path: "D:\\Repo\\README.md",
    });
    const normalizedSameDocument = createMarkdownDocumentIdentity({
      surface: "file",
      workspaceId: "workspace-a",
      path: "D:/Repo/README.md",
    });
    const otherWorkspace = createMarkdownDocumentIdentity({
      surface: "file",
      workspaceId: "workspace-b",
      path: "D:/Repo/README.md",
    });
    const otherPath = createMarkdownDocumentIdentity({
      surface: "file",
      workspaceId: "workspace-a",
      path: "D:/Repo/docs/README.md",
    });
    const first = parse("Same", "same-revision", undefined, firstDocument);
    const second = parse("Same", "same-revision", undefined, otherWorkspace);
    const third = parse("Same", "same-revision", undefined, otherPath);

    expect(normalizedSameDocument).toBe(firstDocument);
    expect(otherWorkspace).not.toBe(firstDocument);
    expect(second.blocks[0].id).not.toBe(first.blocks[0].id);
    expect(third.blocks[0].id).not.toBe(first.blocks[0].id);
  });

  it("publishes only the latest issued revision as one atomic value", () => {
    const gate = new MarkdownRevisionPublicationGate<{ revision: string; blocks: readonly string[] }>();
    const first = gate.issue("r1");
    expect(gate.publish(first, { revision: "r1", blocks: ["old"] })).toBe(true);
    const slow = gate.issue("r2");
    const latest = gate.issue("r3");

    expect(gate.current()).toEqual({ revision: "r1", blocks: ["old"] });
    expect(gate.publish(slow, { revision: "r2", blocks: ["stale"] })).toBe(false);
    expect(gate.publish(latest, { revision: "wrong", blocks: ["mixed"] })).toBe(false);
    expect(gate.current()).toEqual({ revision: "r1", blocks: ["old"] });
    expect(gate.publish(latest, { revision: "r3", blocks: ["new-a", "new-b"] })).toBe(true);
    expect(gate.current()).toEqual({ revision: "r3", blocks: ["new-a", "new-b"] });
  });
});
