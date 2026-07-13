import { describe, expect, it } from "vitest";

import {
  MARKDOWN_SNAPSHOT_SCHEMA_VERSION,
  MarkdownSnapshotContractError,
  assertValidMarkdownSnapshot,
  cloneMarkdownSnapshot,
  createMarkdownSnapshot,
  deserializeMarkdownSnapshot,
  estimateMarkdownSnapshotBytes,
  serializeMarkdownSnapshot,
  type MarkdownSnapshot,
  type MarkdownSnapshotBlock,
  type MarkdownSnapshotBlockKind,
  type MarkdownSnapshotBlockMetadata,
  type MarkdownSnapshotInput,
} from "@/renderer/markdownRuntime/document/MarkdownSnapshot";

function emptyInput(surface: "file" | "message" = "file"): MarkdownSnapshotInput {
  return {
    surface,
    document_id: `${surface}:empty.md`,
    revision: "sha256:empty",
    renderer_profile: surface === "file" ? "file-preview" : "conversation",
    mode: "canonical",
    source_bytes: 0,
    source_characters: 0,
    logical_text: "",
    line_count: 0,
    blocks: [],
    outline: [],
    resources: [],
    stream: { kind: "canonical", finalized: true },
    indexes: indexRefs("sha256:empty"),
  };
}

function indexRefs(revision: string) {
  return {
    line_map_revision: revision,
    logical_projection_revision: revision,
    source_index_revision: revision,
    find_index_revision: null,
    annotation_index_revision: null,
  };
}

function mixedSnapshot(): MarkdownSnapshot {
  const parts: Array<{ kind: MarkdownSnapshotBlockKind; text: string; metadata?: MarkdownSnapshotBlockMetadata }> = [
    { kind: "frontmatter", text: "---\ntitle: Guide\n---", metadata: { frontmatter_language: "yaml" } },
    { kind: "heading", text: "# Guide", metadata: { heading_level: 1 } },
    { kind: "paragraph", text: "See [docs](guide.md) and ![logo](logo.png)." },
    { kind: "list", text: "- [x] shipped\n- [ ] pending", metadata: {
      list: { ordered: false, start: null, tight: true, item_count: 2 },
      task: { checked: null },
    } },
    { kind: "table", text: "| A | B |\n|:-|:-:|\n| 1 | 2 |", metadata: {
      table: { columns: 2, alignments: ["left", "center"] },
    } },
    { kind: "code", text: "```ts\nconst x = 1\n```", metadata: { language: "ts", fence_markup: "```" } },
    { kind: "mermaid", text: "```mermaid\ngraph TD; A-->B\n```", metadata: { language: "mermaid", fence_markup: "```" } },
    { kind: "math", text: "$$x^2$$" },
    { kind: "html", text: "<aside>safe</aside>", metadata: { html_policy: "sanitized" } },
    { kind: "blockquote", text: "> quoted" },
    { kind: "thematic-break", text: "---" },
  ];
  const source = parts.map((part) => part.text).join("\n");
  const blocks: MarkdownSnapshotBlock[] = [];
  let offset = 0;
  let line = 0;
  for (const [index, part] of parts.entries()) {
    const lineSpan = part.text.split("\n").length;
    blocks.push({
      id: `block-${index}`,
      identity_key: `${part.kind}:${index}`,
      content_hash: `hash:${part.kind}:${part.text.length}`,
      index,
      kind: part.kind,
      parent_id: null,
      depth: 0,
      source_start: offset,
      source_end: offset + part.text.length,
      logical_start: offset,
      logical_end: offset + part.text.length,
      line_start: line,
      line_end: line + lineSpan,
      inline_spans: part.kind === "paragraph" ? [{
        id: "inline-link",
        kind: "link",
        source_start: offset + 4,
        source_end: offset + 20,
        logical_start: offset + 4,
        logical_end: offset + 20,
        attributes: { href: "guide.md", title: null },
      }] : [],
      metadata: part.metadata ?? {},
    });
    offset += part.text.length + (index === parts.length - 1 ? 0 : 1);
    line += lineSpan;
  }
  const paragraph = blocks[2];
  const mermaid = blocks[6];
  const math = blocks[7];
  const html = blocks[8];
  return createMarkdownSnapshot({
    surface: "file",
    document_id: "file:mixed.md",
    revision: "sha256:mixed",
    renderer_profile: "file-preview",
    mode: "canonical",
    source_bytes: new TextEncoder().encode(source).byteLength,
    source_characters: source.length,
    logical_text: source,
    line_count: source.split("\n").length,
    blocks,
    outline: [{ id: "outline-guide", block_id: "block-1", level: 1, title: "Guide", source_line: 4 }],
    resources: [
      resource("image-resource", paragraph, "image", "logo.png", "logo"),
      resource("mermaid-resource", mermaid, "mermaid"),
      resource("math-resource", math, "math"),
      resource("html-resource", html, "html"),
    ],
    stream: { kind: "canonical", finalized: true },
    indexes: indexRefs("sha256:mixed"),
  });
}

function resource(
  id: string,
  block: MarkdownSnapshotBlock,
  kind: "image" | "mermaid" | "math" | "html",
  url: string | null = null,
  alt: string | null = null,
) {
  return {
    id,
    block_id: block.id,
    kind,
    cache_key: `${kind}:${block.content_hash}`,
    url,
    alt,
    content_hash: block.content_hash,
    source_start: block.source_start,
    source_end: block.source_end,
    logical_start: block.logical_start,
    logical_end: block.logical_end,
  } as const;
}

function singleBlockInput(size: number, surface: "file" | "message" = "file"): MarkdownSnapshotInput {
  const source = "x".repeat(size);
  const revision = `sha256:size-${size}`;
  return {
    surface,
    document_id: `${surface}:size-${size}.md`,
    revision,
    renderer_profile: surface === "file" ? "file-preview" : "conversation",
    mode: "canonical",
    source_bytes: size,
    source_characters: size,
    logical_text: source,
    line_count: 1,
    blocks: [{
      id: "block-stable",
      identity_key: "paragraph:stable",
      content_hash: `hash:${size}`,
      index: 0,
      kind: "paragraph",
      parent_id: null,
      depth: 0,
      source_start: 0,
      source_end: size,
      logical_start: 0,
      logical_end: size,
      line_start: 0,
      line_end: 1,
      inline_spans: [],
      metadata: {},
    }],
    outline: [],
    resources: [],
    stream: { kind: "canonical", finalized: true },
    indexes: indexRefs(revision),
  };
}

describe("surface-neutral MarkdownSnapshot", () => {
  it.each(["file", "message"] as const)("creates an immutable empty %s snapshot", (surface) => {
    const snapshot = createMarkdownSnapshot(emptyInput(surface));

    expect(snapshot).toMatchObject({
      schema_version: MARKDOWN_SNAPSHOT_SCHEMA_VERSION,
      surface,
      blocks: [],
      resources: [],
      stream: { kind: "canonical", finalized: true },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.blocks)).toBe(true);
    expect(snapshot.estimated_bytes).toBeGreaterThan(0);
  });

  it("keeps special block metadata and resources without markdown-it token trees", () => {
    const snapshot = mixedSnapshot();

    expect(snapshot.blocks.map((block) => block.kind)).toEqual([
      "frontmatter", "heading", "paragraph", "list", "table", "code", "mermaid", "math",
      "html", "blockquote", "thematic-break",
    ]);
    expect(snapshot.blocks[3].metadata.list).toMatchObject({ item_count: 2, ordered: false });
    expect(snapshot.blocks[4].metadata.table).toEqual({ columns: 2, alignments: ["left", "center"] });
    expect(snapshot.resources.map((entry) => entry.kind)).toEqual(["image", "mermaid", "math", "html"]);
    expect(snapshot.blocks.every((block) => !("tokens" in block) && !("sourceText" in block))).toBe(true);
    expect(Object.isFrozen(snapshot.blocks[4].metadata.table?.alignments)).toBe(true);
    expect(Object.isFrozen(snapshot.blocks[2].inline_spans[0].attributes)).toBe(true);
  });

  it("marks a stable streaming prefix and mutable tail for conversation messages", () => {
    const input = singleBlockInput(12, "message");
    const snapshot = createMarkdownSnapshot({
      ...input,
      revision: "stream:12",
      mode: "stream-tail",
      stream: {
        kind: "streaming",
        epoch: 4,
        prefix_revision: "stream:8",
        prefix_block_count: 0,
        tail_block_start: 0,
        tail_source_start: 8,
        tail_complete: false,
      },
      indexes: indexRefs("stream:12"),
    });

    expect(snapshot).toMatchObject({
      surface: "message",
      mode: "stream-tail",
      stream: { prefix_revision: "stream:8", tail_source_start: 8, tail_complete: false },
    });
  });

  it("preserves stable block identity across document revisions", () => {
    const first = createMarkdownSnapshot(singleBlockInput(10));
    const second = createMarkdownSnapshot({
      ...singleBlockInput(12),
      revision: "sha256:next",
      indexes: indexRefs("sha256:next"),
    });

    expect(first.blocks[0].id).toBe(second.blocks[0].id);
    expect(first.blocks[0].identity_key).toBe(second.blocks[0].identity_key);
    expect(first.blocks[0].content_hash).not.toBe(second.blocks[0].content_hash);
  });

  it("serializes and structured-clones without losing immutable contract fields", () => {
    const snapshot = mixedSnapshot();
    const cloned = cloneMarkdownSnapshot(snapshot);
    const restored = deserializeMarkdownSnapshot(serializeMarkdownSnapshot(snapshot));

    expect(cloned).toEqual(snapshot);
    expect(restored).toEqual(snapshot);
    expect(cloned).not.toBe(snapshot);
    expect(Object.isFrozen(cloned)).toBe(true);
    expect(() => assertValidMarkdownSnapshot(structuredClone(snapshot))).not.toThrow();
  });

  it.each([1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024])(
    "estimates bounded retained memory for a %i-byte snapshot",
    (size) => {
      const snapshot = createMarkdownSnapshot(singleBlockInput(size));
      expect(snapshot.source_bytes).toBe(size);
      expect(snapshot.estimated_bytes).toBe(estimateMarkdownSnapshotBytes(snapshot));
      expect(snapshot.estimated_bytes).toBeGreaterThanOrEqual(size * 2);
      expect(snapshot.estimated_bytes).toBeLessThan(size * 3);
    },
    15_000,
  );

  it("rejects broken ranges, duplicate identity, missing resources, and invalid byte lengths", () => {
    const base = singleBlockInput(10);
    const failures: MarkdownSnapshotInput[] = [
      { ...base, source_bytes: -1 },
      { ...base, blocks: [{ ...base.blocks[0], source_end: 11 }] },
      { ...base, blocks: [base.blocks[0], { ...base.blocks[0], index: 1 }] },
      {
        ...base,
        resources: [{
          id: "missing", block_id: "other", kind: "image", cache_key: "k", url: "x.png", alt: null,
          content_hash: "h", source_start: 0, source_end: 1, logical_start: 0, logical_end: 1,
        }],
      },
    ];

    for (const value of failures) {
      expect(() => createMarkdownSnapshot(value)).toThrowError(MarkdownSnapshotContractError);
    }
  });

  it.each(["tokens", "parser", "dom", "glyph", "rect", "pixel", "display_command", "webgpu"])(
    "rejects forbidden parser or renderer state %s",
    (field) => {
      const base = singleBlockInput(10);
      const block = { ...base.blocks[0], metadata: { ...base.blocks[0].metadata, [field]: {} } };
      expect(() => createMarkdownSnapshot({ ...base, blocks: [block] as MarkdownSnapshotBlock[] }))
        .toThrowError(expect.objectContaining({ name: "MarkdownSnapshotContractError" }));
    },
  );
});
