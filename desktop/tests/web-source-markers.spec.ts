import { describe, expect, it } from "vitest";

import {
  projectWebSourceMarkers,
  webSourceCitationHref,
  webSourceIdFromCitationHref,
} from "@/renderer/pages/conversation/messages/webSourceMarkers";
import type { WebTurnSourceRegistry } from "@/renderer/pages/conversation/messages/webSourceRegistry";
import type { WebActivitySource } from "@/types/protocol";

const FIRST: WebActivitySource = {
  source_id: "src_first",
  url: "https://one.example/docs",
  domain: "one.example",
  title: "First",
  truncated: false,
};
const SECOND: WebActivitySource = {
  source_id: "src_second",
  url: "https://two.example/docs",
  domain: "two.example",
  title: "Second",
  truncated: false,
};

describe("web source marker projection", () => {
  it("numbers valid markers by first reference and reuses a number for repeated sources", () => {
    const projection = projectWebSourceMarkers(
      "Second [[source:src_second]], first [[source:src_first]], second again [[source:src_second]].",
      registry(),
    );

    expect(projection.markdown).toBe(
      `Second [1](${webSourceCitationHref("src_second")}), first [2](${webSourceCitationHref("src_first")}), second again [1](${webSourceCitationHref("src_second")}).`,
    );
    expect(projection.referencedSourceIds).toEqual(["src_second", "src_first", "src_second"]);
    expect(projection.citations.map(({ sourceId, number }) => ({ sourceId, number }))).toEqual([
      { sourceId: "src_second", number: 1 },
      { sourceId: "src_first", number: 2 },
    ]);
  });

  it("deduplicates aliases that resolve to the same canonical source", () => {
    const value = registry();
    const bySourceId = new Map(value.bySourceId);
    bySourceId.set("src_alias", FIRST);
    const projection = projectWebSourceMarkers(
      "A [[source:src_alias]] and B [[source:src_first]].",
      { ...value, bySourceId },
    );

    expect(projection.markdown).toContain(`[1](${webSourceCitationHref("src_alias")})`);
    expect(projection.markdown).toContain(`[1](${webSourceCitationHref("src_first")})`);
    expect(projection.citations).toHaveLength(1);
    expect(projection.citations[0].sourceIds).toEqual(["src_alias", "src_first"]);
  });

  it("accepts harmless model formatting around a registered source marker", () => {
    const source = [
      "- list item",
      "  [[ source : src_first ]]",
      "Uppercase [[SOURCE：src_second]] and full-width 【【source：src_first】】.",
    ].join("\n");
    const projection = projectWebSourceMarkers(source, registry());

    expect(projection.markdown).toContain(`  [1](${webSourceCitationHref("src_first")})`);
    expect(projection.markdown).toContain(`[2](${webSourceCitationHref("src_second")})`);
    expect(projection.markdown).toContain(`full-width [1](${webSourceCitationHref("src_first")})`);
    expect(projection.referencedSourceIds).toEqual(["src_first", "src_second", "src_first"]);
  });

  it("hides unknown internal markers but preserves malformed, incomplete, and escaped text", () => {
    const source = String.raw`Unknown [[ source：missing ]], malformed [[source:bad id]], incomplete [[source:src_first and escaped \[[source:src_first]].`;
    const projection = projectWebSourceMarkers(source, registry());

    expect(projection.markdown).toBe(
      String.raw`Unknown, malformed [[source:bad id]], incomplete [[source:src_first and escaped \[[source:src_first]].`,
    );
    expect(projection.citations).toEqual([]);
  });

  it("removes adjacent unknown markers without leaving punctuation gaps", () => {
    const projection = projectWebSourceMarkers(
      "Claim [[source:missing_a]] [[source:missing_b]]. Next [[source:src_first]].",
      registry(),
    );

    expect(projection.markdown).toBe(
      `Claim. Next [1](${webSourceCitationHref("src_first")}).`,
    );
    expect(projection.referencedSourceIds).toEqual(["src_first"]);
  });

  it("does not interpret markers inside fenced code, inline code, or markdown links", () => {
    const source = [
      "Outside [[source:src_first]]",
      "`inline [[source:src_second]]`",
      "```text",
      "fenced [[source:src_second]]",
      "```",
      "[label [[source:src_second]]](https://example.com)",
      "[reference [[source:src_second]]][target]",
    ].join("\n");
    const projection = projectWebSourceMarkers(source, registry());

    expect(projection.citations).toHaveLength(1);
    expect(projection.markdown).toContain(`[1](${webSourceCitationHref("src_first")})`);
    expect(projection.markdown).toContain("`inline [[source:src_second]]`");
    expect(projection.markdown).toContain("fenced [[source:src_second]]");
    expect(projection.markdown).toContain("[label [[source:src_second]]](https://example.com)");
    expect(projection.markdown).toContain("[reference [[source:src_second]]][target]");
  });

  it("round-trips only controlled citation hrefs", () => {
    expect(webSourceIdFromCitationHref(webSourceCitationHref("src_a:1"))).toBe("src_a:1");
    expect(webSourceIdFromCitationHref("https://example.com/#keydex-web-source=src_a")).toBeNull();
    expect(webSourceIdFromCitationHref("#keydex-web-source=%E0%A4%A")).toBeNull();
    expect(webSourceIdFromCitationHref("#keydex-web-source=bad%20id")).toBeNull();
  });
});

function registry(): WebTurnSourceRegistry {
  return {
    turnKey: "turn:1",
    sources: [FIRST, SECOND],
    bySourceId: new Map([
      [FIRST.source_id, FIRST],
      [SECOND.source_id, SECOND],
    ]),
    activityMessageIdsBySourceId: new Map([
      [FIRST.source_id, ["activity-1"]],
      [SECOND.source_id, ["activity-1"]],
    ]),
  };
}
