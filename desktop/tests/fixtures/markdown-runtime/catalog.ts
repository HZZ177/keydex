export const MARKDOWN_FIXTURE_GENERATOR_VERSION = "markdown-runtime-fixtures/v1";

export const KIB = 1024;
export const MIB = 1024 * KIB;

export type MarkdownFixtureExtension = ".md" | ".markdown" | ".mdx";
export type MarkdownFixtureLineEnding = "lf" | "crlf";
export type MarkdownFixtureProfile =
  | "mixed"
  | "giant-block"
  | "resources"
  | "complex-text"
  | "annotations";
export type MarkdownFixtureTier = "quick" | "performance" | "stress";

export interface MarkdownFixtureSpec {
  readonly id: string;
  readonly targetBytes: number;
  readonly seed: number;
  readonly extension: MarkdownFixtureExtension;
  readonly lineEnding: MarkdownFixtureLineEnding;
  readonly bom: boolean;
  readonly profile: MarkdownFixtureProfile;
  readonly tier: MarkdownFixtureTier;
}

function fixture(
  id: string,
  targetBytes: number,
  seed: number,
  options: Partial<Omit<MarkdownFixtureSpec, "id" | "targetBytes" | "seed">> = {},
): MarkdownFixtureSpec {
  return Object.freeze({
    id,
    targetBytes,
    seed,
    extension: options.extension ?? ".md",
    lineEnding: options.lineEnding ?? "lf",
    bom: options.bom ?? false,
    profile: options.profile ?? "mixed",
    tier: options.tier ?? "quick",
  });
}

export const markdownRuntimeFixtureCatalog: readonly MarkdownFixtureSpec[] = Object.freeze([
  fixture("mixed-10k", 10 * KIB, 0x10_2026),
  fixture("mixed-250k", 250 * KIB, 0x25_2026, { tier: "performance" }),
  fixture("boundary-512k-minus-1", 512 * KIB - 1, 0x51_2001),
  fixture("boundary-512k", 512 * KIB, 0x51_2002),
  fixture("boundary-512k-plus-1", 512 * KIB + 1, 0x51_2003),
  fixture("mixed-1m", MIB, 0x01_2026, { tier: "performance" }),
  fixture("mixed-5m", 5 * MIB, 0x05_2026, { tier: "performance" }),
  fixture("mixed-10m", 10 * MIB, 0x0a_2026, { tier: "performance" }),
  fixture("mixed-20m-stress", 20 * MIB, 0x20_2026, { tier: "stress" }),
  fixture("giant-block-1m", MIB, 0x61_2026, { profile: "giant-block", tier: "performance" }),
  fixture("resources-250k", 250 * KIB, 0x62_2026, { profile: "resources", tier: "performance" }),
  fixture("complex-text-250k", 250 * KIB, 0x63_2026, { profile: "complex-text", tier: "performance" }),
  fixture("annotations-250k", 250 * KIB, 0x64_2026, { profile: "annotations", tier: "performance" }),
  fixture("line-endings-lf-10k", 10 * KIB, 0x65_2026),
  fixture("line-endings-crlf-10k", 10 * KIB, 0x66_2026, { lineEnding: "crlf" }),
  fixture("bom-lf-10k", 10 * KIB, 0x67_2026, { bom: true }),
  fixture("extension-md-10k", 10 * KIB, 0x68_2026, { extension: ".md" }),
  fixture("extension-markdown-10k", 10 * KIB, 0x69_2026, { extension: ".markdown" }),
  fixture("extension-mdx-10k", 10 * KIB, 0x6a_2026, { extension: ".mdx" }),
]);

const fixtureById = new Map(markdownRuntimeFixtureCatalog.map((spec) => [spec.id, spec]));

export function markdownRuntimeFixtureSpec(id: string): MarkdownFixtureSpec {
  const spec = fixtureById.get(id);
  if (!spec) {
    throw new Error(`Unknown Markdown runtime fixture: ${id}`);
  }
  return spec;
}

export const quickMarkdownRuntimeFixtureIds = Object.freeze(
  markdownRuntimeFixtureCatalog.filter((spec) => spec.tier === "quick").map((spec) => spec.id),
);

