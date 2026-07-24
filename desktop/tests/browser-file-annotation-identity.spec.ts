import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalizeBrowserFileAddress } from "@/renderer/features/browser/domain";

interface IdentityVector {
  name: string;
  source_kind: "web" | "local_file";
  normalization_version: 1 | 2;
  input: string;
  url_normalized: string;
  document_url: string;
  origin: string;
  url_key: string;
}

const vectors = (
  JSON.parse(readFileSync(resolve(
    process.cwd(),
    "..",
    ".dev",
    "test",
    "2026-07-23_21-12-15-workbench-browser-file-preview-annotations",
    "file-identity-vectors.json",
  ), "utf8")) as { vectors: IdentityVector[] }
).vectors;

describe("file annotation identity v2", () => {
  it.each(vectors.filter((item) => item.source_kind === "local_file"))(
    "matches shared vector $name",
    (vector) => {
      const canonical = canonicalizeBrowserFileAddress(vector.input);
      const documentUrl = canonical.url.replace(/#.*$/u, "");
      const digest = createHash("sha256")
        .update(`2\n${canonical.url.toLocaleLowerCase("en-US")}`)
        .digest("hex");

      expect(canonical.url).toBe(vector.url_normalized);
      expect(documentUrl).toBe(vector.document_url);
      expect(canonical.authority ? `file://${canonical.authority}` : "file://").toBe(vector.origin);
      expect(digest).toBe(vector.url_key);
    },
  );

  it("keeps the web v1 shared digest byte-for-byte unchanged", () => {
    const vector = vectors.find((item) => item.name === "web-v1-baseline")!;
    const digest = createHash("sha256")
      .update(`${vector.normalization_version}\n${vector.url_normalized}`)
      .digest("hex");

    expect(digest).toBe(vector.url_key);
  });
});
