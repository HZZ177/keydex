import { createHash } from "node:crypto";

import {
  MARKDOWN_FIXTURE_GENERATOR_VERSION,
  type MarkdownFixtureProfile,
  type MarkdownFixtureSpec,
} from "./catalog";

export interface MarkdownFixtureMetadata extends MarkdownFixtureSpec {
  readonly generatorVersion: string;
  readonly hashAlgorithm: "sha256";
  readonly hash: string;
  readonly bytes: number;
  readonly lines: number;
  readonly blocks: number;
  readonly longestLineBytes: number;
  readonly featureTags: readonly string[];
}

export interface GeneratedMarkdownFixture {
  readonly source: string;
  readonly metadata: MarkdownFixtureMetadata;
}

interface FixtureBody {
  readonly base: string;
  readonly repeatChunk: string;
  readonly tail: string;
  readonly featureTags: readonly string[];
}

export function generateMarkdownRuntimeFixture(spec: MarkdownFixtureSpec): GeneratedMarkdownFixture {
  assertFixtureSpec(spec);
  const newline = spec.lineEnding === "crlf" ? "\r\n" : "\n";
  const body = buildFixtureBody(spec.profile, spec.seed, newline);
  const prefix = spec.bom ? "\uFEFF" : "";
  const initial = `${prefix}${body.base}`;
  const initialBytes = utf8Bytes(initial);
  const repeatBytes = utf8Bytes(body.repeatChunk);
  const tailBytes = utf8Bytes(body.tail);
  if (initialBytes + tailBytes > spec.targetBytes) {
    throw new Error(
      `Fixture ${spec.id} base and tail are ${initialBytes + tailBytes} bytes, above target ${spec.targetBytes}`,
    );
  }
  if (repeatBytes < 1) {
    throw new Error(`Fixture ${spec.id} has an empty repeat chunk`);
  }

  const repeatCount = Math.floor((spec.targetBytes - initialBytes - tailBytes) / repeatBytes);
  let source = initial + body.repeatChunk.repeat(repeatCount);
  const remainingBytes = spec.targetBytes - utf8Bytes(source) - tailBytes;
  source += deterministicAscii(spec.seed ^ repeatCount, remainingBytes) + body.tail;

  const bytes = utf8Bytes(source);
  if (bytes !== spec.targetBytes) {
    throw new Error(`Fixture ${spec.id} generated ${bytes} bytes, expected ${spec.targetBytes}`);
  }

  return Object.freeze({
    source,
    metadata: Object.freeze({
      ...spec,
      generatorVersion: MARKDOWN_FIXTURE_GENERATOR_VERSION,
      hashAlgorithm: "sha256" as const,
      hash: createHash("sha256").update(source, "utf8").digest("hex"),
      bytes,
      lines: countLines(source),
      blocks: countLogicalBlocks(source),
      longestLineBytes: longestLineBytes(source),
      featureTags: body.featureTags,
    }),
  });
}

function assertFixtureSpec(spec: MarkdownFixtureSpec): void {
  if (!spec.id.trim()) {
    throw new Error("Markdown fixture id is required");
  }
  if (!Number.isSafeInteger(spec.targetBytes) || spec.targetBytes <= 0) {
    throw new RangeError(`Invalid target byte size for ${spec.id}: ${spec.targetBytes}`);
  }
  if (!Number.isSafeInteger(spec.seed)) {
    throw new RangeError(`Invalid seed for ${spec.id}: ${spec.seed}`);
  }
}

function buildFixtureBody(profile: MarkdownFixtureProfile, seed: number, newline: string): FixtureBody {
  switch (profile) {
    case "giant-block":
      return {
        base: `# Giant Block ${seed.toString(16)}${newline}giant-line-start:`,
        repeatChunk: deterministicAscii(seed, 4096),
        tail: `:giant-line-end-${seedToken(seed)}`,
        featureTags: Object.freeze(["single-root-block", "ultra-long-line"]),
      };
    case "resources":
      return resourceFixture(seed, newline);
    case "complex-text":
      return complexTextFixture(seed, newline);
    case "annotations":
      return annotationFixture(seed, newline);
    case "mixed":
      return mixedFixture(seed, newline);
  }
}

function mixedFixture(seed: number, newline: string): FixtureBody {
  const token = seedToken(seed);
  const base = [
    `# Markdown Runtime Mixed ${token}`,
    "",
    "中文、emoji 👩🏽‍💻、combining e\u0301、RTL العربية and ASCII logical-text-target.",
    "",
    "- [x] completed task",
    "- [ ] pending task",
    "",
    "| Name | Value |",
    "| --- | ---: |",
    `| mixed-${token} | 42 |`,
    "",
    "```ts",
    `export const fixtureSeed = 0x${seed.toString(16)};`,
    "```",
    "",
    "Inline math $a^2 + b^2 = c^2$.",
    "",
    "$$",
    "\\int_0^1 x^2 dx",
    "$$",
    "",
    "```mermaid",
    "flowchart TD",
    "  A[Start] --> B[Stable]",
    "```",
    "",
    "![Valid relative](fixtures/images/workspace-image.png)",
    "![Invalid resource](https://invalid.invalid/keydex-fixture.png)",
    "",
    "<script>window.__fixtureUnsafeHtml = true</script>",
    "",
    `annotation-start-${token} target annotation-end-${token}`,
    "",
  ].join(newline);
  return {
    base,
    repeatChunk: repeatedMarkdownSection(seed, newline),
    tail: ["", `## Runtime Fixture Tail ${token}`, "", `runtime-fixture-tail-${token}`, ""].join(newline),
    featureTags: Object.freeze([
      "headings",
      "complex-text",
      "task-list",
      "table",
      "code",
      "math",
      "mermaid",
      "resources",
      "raw-html",
      "annotation-anchor",
    ]),
  };
}

function resourceFixture(seed: number, newline: string): FixtureBody {
  const token = seedToken(seed);
  return {
    base: [
      `# Resource Matrix ${token}`,
      "",
      "![Relative image](fixtures/images/workspace-image.png)",
      "![Missing relative](fixtures/images/missing-image.png)",
      "![Invalid host](https://invalid.invalid/resource.png)",
      "![Data image](data:image/png;base64,broken)",
      "",
      "```mermaid",
      "flowchart LR",
      "  valid --> settled",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  broken -->",
      "```",
      "",
      "[same-file](./resource-matrix.md#tail)",
      "[missing-file](./does-not-exist.md#missing)",
      "",
    ].join(newline),
    repeatChunk: repeatedMarkdownSection(seed, newline),
    tail: ["", `## Resource Tail ${token}`, "", `resource-tail-${token}`, ""].join(newline),
    featureTags: Object.freeze(["image", "missing-image", "invalid-resource", "mermaid", "file-link"]),
  };
}

function complexTextFixture(seed: number, newline: string): FixtureBody {
  const token = seedToken(seed);
  return {
    base: [
      `# Complex Text ${token}`,
      "",
      "中文段落：快速定位与选择必须保持 UTF-16/source offset 一致。",
      "",
      "Emoji clusters: 👨‍👩‍👧‍👦 👩🏽‍💻 🏳️‍🌈.",
      "",
      "Combining: e\u0301 A\u030A n\u0303; RTL: العربية עברית; देवनागरी पाठ.",
      "",
      "Escapes: **bold _nested_** `inline code` &amp; <span>html</span>.",
      "",
    ].join(newline),
    repeatChunk: repeatedMarkdownSection(seed, newline),
    tail: ["", `## Complex Text Tail ${token}`, "", `complex-text-tail-${token}`, ""].join(newline),
    featureTags: Object.freeze(["cjk", "emoji-grapheme", "combining-mark", "rtl", "utf16-offset"]),
  };
}

function annotationFixture(seed: number, newline: string): FixtureBody {
  const token = seedToken(seed);
  return {
    base: [
      `# Annotation Anchors ${token}`,
      "",
      `annotation-exact-${token}: Alpha target phrase Omega`,
      "",
      `annotation-prefix-${token} repeated target repeated annotation-suffix-${token}`,
      "",
      "> annotation quote target",
      "",
      "| Anchor | Value |",
      "| --- | --- |",
      `| annotation-table-${token} | table target |`,
      "",
      "```text",
      `annotation-code-${token} code target`,
      "```",
      "",
    ].join(newline),
    repeatChunk: repeatedMarkdownSection(seed, newline),
    tail: ["", `## Annotation Tail ${token}`, "", `annotation-tail-${token}`, ""].join(newline),
    featureTags: Object.freeze(["annotation-anchor", "repeated-text", "quote", "table", "code"]),
  };
}

function repeatedMarkdownSection(seed: number, newline: string): string {
  const token = seedToken(seed ^ 0x9e37_79b9);
  return [
    `## Generated ${token}`,
    "",
    `Paragraph ${token} alpha beta gamma delta epsilon source-line-target.`,
    "",
    `- list-${token}-a`,
    `- list-${token}-b`,
    "",
    "```text",
    `code-${token}`,
    "```",
    "",
  ].join(newline);
}

function seedToken(seed: number): string {
  return (seed >>> 0).toString(36).padStart(7, "0");
}

function deterministicAscii(seed: number, length: number): string {
  if (length <= 0) {
    return "";
  }
  let state = seed >>> 0 || 0x6d2b_79f5;
  let pattern = "";
  for (let index = 0; index < 128; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pattern += String.fromCharCode(97 + ((state >>> 0) % 26));
  }
  return pattern.repeat(Math.floor(length / pattern.length)) + pattern.slice(0, length % pattern.length);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function countLines(value: string): number {
  if (!value.length) {
    return 0;
  }
  return (value.match(/\r\n|\r|\n/g) ?? []).length + 1;
}

function countLogicalBlocks(value: string): number {
  const withoutBom = value.startsWith("\uFEFF") ? value.slice(1) : value;
  return withoutBom.split(/(?:\r?\n)[\t ]*(?:\r?\n)+/).filter((part) => part.trim().length > 0).length;
}

function longestLineBytes(value: string): number {
  let longest = 0;
  for (const line of value.split(/\r\n|\r|\n/)) {
    longest = Math.max(longest, utf8Bytes(line));
  }
  return longest;
}
