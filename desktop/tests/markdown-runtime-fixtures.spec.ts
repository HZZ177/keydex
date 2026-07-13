import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  KIB,
  MARKDOWN_FIXTURE_GENERATOR_VERSION,
  generateMarkdownRuntimeFixture,
  markdownRuntimeFixtureCatalog,
  markdownRuntimeFixtureSpec,
  quickMarkdownRuntimeFixtureIds,
} from "./fixtures/markdown-runtime";

describe("Markdown runtime fixture corpus", () => {
  it("generates deterministic source, metadata, and hashes", () => {
    const spec = markdownRuntimeFixtureSpec("mixed-250k");
    const first = generateMarkdownRuntimeFixture(spec);
    const second = generateMarkdownRuntimeFixture(spec);

    expect(first.source).toBe(second.source);
    expect(first.metadata).toEqual(second.metadata);
    expect(first.metadata).toMatchObject({
      generatorVersion: MARKDOWN_FIXTURE_GENERATOR_VERSION,
      seed: spec.seed,
      bytes: 250 * KIB,
      targetBytes: 250 * KIB,
      hashAlgorithm: "sha256",
    });
    expect(first.metadata.hash).toBe(createHash("sha256").update(first.source, "utf8").digest("hex"));
    expect(first.metadata.lines).toBeGreaterThan(100);
    expect(first.metadata.blocks).toBeGreaterThan(50);
  });

  it("generates the 512 KiB boundary at minus one, exact, and plus one byte", () => {
    const ids = ["boundary-512k-minus-1", "boundary-512k", "boundary-512k-plus-1"];
    const sizes = ids.map((id) => generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec(id)).metadata.bytes);

    expect(sizes).toEqual([512 * KIB - 1, 512 * KIB, 512 * KIB + 1]);
  });

  it("keeps LF, CRLF, and BOM variants exact and reproducible", () => {
    const lf = generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec("line-endings-lf-10k"));
    const crlf = generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec("line-endings-crlf-10k"));
    const bom = generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec("bom-lf-10k"));

    expect(lf.source).toContain("\n");
    expect(lf.source).not.toContain("\r\n");
    expect(crlf.source).toContain("\r\n");
    expect(crlf.source.replaceAll("\r\n", "")).not.toContain("\n");
    expect(bom.source.startsWith("\uFEFF")).toBe(true);
    expect([lf.metadata.bytes, crlf.metadata.bytes, bom.metadata.bytes]).toEqual([10 * KIB, 10 * KIB, 10 * KIB]);
  });

  it("covers mixed, giant block, resource, complex text, and annotation profiles", () => {
    expect(new Set(markdownRuntimeFixtureCatalog.map((spec) => spec.profile))).toEqual(
      new Set(["mixed", "giant-block", "resources", "complex-text", "annotations"]),
    );

    const giant = generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec("giant-block-1m"));
    expect(giant.metadata.longestLineBytes).toBeGreaterThan(900 * KIB);
    expect(giant.metadata.blocks).toBe(1);

    const resources = generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec("resources-250k"));
    expect(resources.source).toContain("https://invalid.invalid/resource.png");
    expect(resources.source).toContain("broken -->");

    const annotations = generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec("annotations-250k"));
    expect(annotations.source).toContain("annotation-exact-");
    expect(annotations.metadata.featureTags).toContain("annotation-anchor");
  });

  it("includes reproducible .md, .markdown, and .mdx identities", () => {
    const extensionSpecs = ["extension-md-10k", "extension-markdown-10k", "extension-mdx-10k"].map(
      markdownRuntimeFixtureSpec,
    );
    expect(extensionSpecs.map((spec) => spec.extension)).toEqual([".md", ".markdown", ".mdx"]);
    expect(extensionSpecs.map((spec) => generateMarkdownRuntimeFixture(spec).metadata.hash)).toHaveLength(3);
  });

  it("keeps the 20 MiB fixture stress-only and out of the quick catalog", () => {
    const stress = markdownRuntimeFixtureSpec("mixed-20m-stress");
    expect(stress).toMatchObject({ targetBytes: 20 * 1024 * KIB, tier: "stress" });
    expect(quickMarkdownRuntimeFixtureIds).not.toContain(stress.id);
  });

  it.runIf(process.env.KEYDEX_MARKDOWN_FIXTURE_STRESS === "1")(
    "materializes the exact 20 MiB stress fixture outside the quick suite",
    () => {
      const generated = generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec("mixed-20m-stress"));
      expect(generated.metadata.bytes).toBe(20 * 1024 * KIB);
      expect(generated.metadata.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(generated.metadata.lines).toBeGreaterThan(10_000);
      expect(generated.metadata.blocks).toBeGreaterThan(10_000);
    },
  );
});
