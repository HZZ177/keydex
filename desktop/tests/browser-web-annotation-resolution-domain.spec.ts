import { describe, expect, it } from "vitest";

import {
  currentSettledWebAnnotationResolution,
  isWebAnnotationResolutionCurrent,
  orphanWebAnnotationResolution,
  rankAnchoringCandidates,
  scoreAnchoringCandidate,
  settleWebAnnotationResolution,
  summarizeWebAnnotationChanges,
  visibleWebAnnotationResolutionStatus,
  WEB_ANNOTATION_RESOLUTION_REASON_CODES,
  WEB_ANNOTATION_SCORING_POLICY_V1,
  type WebAnnotationResolutionCandidate,
  type WebAnnotationResolutionIdentity,
  type WebAnnotationResolutionState,
} from "@/renderer/features/browser/annotations";
import type { WebTextTarget } from "@/renderer/features/browser/runtime";

const identity: WebAnnotationResolutionIdentity = {
  resourceId: "resource-1",
  annotationId: "annotation-1",
  navigationId: "navigation-1",
  frameRevision: 1,
};
const target: WebTextTarget = {
  type: "text",
  quote: { exact: "Selected text", prefix: "", suffix: "" },
  position: { start: 0, end: 13, textModelVersion: 1 },
  context: { headingPath: ["Heading"] },
  rects: [{ x: 10, y: 20, width: 120, height: 18 }],
  frame: { url: "https://example.test/article", indexPath: [] },
};

describe("web annotation resolution domain", () => {
  it("centralizes the versioned scoring contract and accepts the threshold boundary", () => {
    expect(WEB_ANNOTATION_SCORING_POLICY_V1).toEqual({
      schemaVersion: 1,
      policyId: "keydex.web-annotation.scoring.v1",
      weights: {
        quoteSimilarity: 0.45,
        prefixSuffix: 0.2,
        domContext: 0.2,
        heading: 0.1,
        position: 0.05,
      },
      acceptThreshold: 0.82,
      ambiguityGap: 0.08,
    });

    const accepted = settleWebAnnotationResolution(identity, [candidate("threshold", 0.82)]);
    const rejected = settleWebAnnotationResolution(identity, [candidate("below", 0.819999)]);

    expect(accepted).toMatchObject({ status: "resolved", reason: "exact_match" });
    expect(rejected).toMatchObject({ status: "orphaned", reason: "below_accept_threshold" });
  });

  it("marks ties and margins below the gap as ambiguous without auto-selecting", () => {
    const tie = settleWebAnnotationResolution(identity, [
      candidate("b", 0.9),
      candidate("a", 0.9),
    ]);
    const belowGap = settleWebAnnotationResolution(identity, [
      candidate("first", 0.899999),
      candidate("second", 0.82),
    ]);
    const atGap = settleWebAnnotationResolution(identity, [
      candidate("first", 0.9),
      candidate("second", 0.82),
    ]);

    expect(tie).toMatchObject({ status: "ambiguous", reason: "ambiguous_candidates", selected: null });
    expect(tie.candidates.map((value) => value.candidateId)).toEqual(["a", "b"]);
    expect(belowGap.status).toBe("ambiguous");
    expect(atGap).toMatchObject({ status: "resolved", selected: { candidateId: "first" } });
  });

  it("does not let a below-threshold runner-up create false ambiguity", () => {
    const decision = rankAnchoringCandidates([
      candidate("accepted", 0.84),
      candidate("rejected", 0.819999),
    ]);

    expect(decision).toMatchObject({ kind: "accepted", selected: { candidateId: "accepted" } });
  });

  it("always reports a fuzzy match as changed even at a perfect score", () => {
    const outcome = settleWebAnnotationResolution(identity, [candidate("fuzzy", 1, {
      fuzzy: true,
      changed: false,
    })]);

    expect(outcome).toMatchObject({
      status: "changed",
      reason: "fuzzy_match",
      selected: { candidateId: "fuzzy", fuzzy: true },
    });
  });

  it("uses a stable frame-unavailable reason and never invents a candidate", () => {
    const outcome = orphanWebAnnotationResolution(
      identity,
      "frame_unavailable",
      () => "2026-07-22T00:00:00Z",
    );

    expect(outcome).toEqual(expect.objectContaining({
      status: "orphaned",
      reason: "frame_unavailable",
      selected: null,
      candidates: [],
      resolvedAt: "2026-07-22T00:00:00Z",
    }));
    expect(WEB_ANNOTATION_RESOLUTION_REASON_CODES).toContain("frame_unavailable");
  });

  it("shows a last-known status while refreshing but rejects it after identity drift", () => {
    const previous = settleWebAnnotationResolution(identity, [candidate("changed", 1, { changed: true })]);
    const refreshing: WebAnnotationResolutionState = {
      status: "resolving",
      reason: "dom_changed",
      identity,
      requestId: "resolve-2",
      startedAt: "2026-07-22T00:01:00Z",
      lastKnown: previous,
    };
    const nextNavigation = { ...identity, navigationId: "navigation-2" };
    const stale: WebAnnotationResolutionState = { ...refreshing, identity: nextNavigation };

    expect(visibleWebAnnotationResolutionStatus(refreshing)).toBe("resolved");
    expect(currentSettledWebAnnotationResolution(refreshing, identity)).toBe(previous);
    expect(isWebAnnotationResolutionCurrent(previous, nextNavigation)).toBe(false);
    expect(currentSettledWebAnnotationResolution(stale, nextNavigation)).toBeNull();
  });

  it("rejects invalid score signals before they enter the resolver", () => {
    expect(() => scoreAnchoringCandidate({
      quoteSimilarity: 1.01,
      prefixSuffix: 1,
      domContext: 1,
      heading: 1,
      position: 1,
    })).toThrow(RangeError);
  });

  it("separates material target changes from layout and surrounding-context drift", () => {
    expect(summarizeWebAnnotationChanges([
      "quote_changed",
      "anchor_position_changed",
      "heading_changed",
    ])).toMatchObject({
      kinds: ["content", "layout", "context"],
      materialKinds: ["content"],
      material: true,
    });
    expect(summarizeWebAnnotationChanges([
      "anchor_size_changed",
      "prefix_changed",
    ])).toMatchObject({
      kinds: ["layout", "context"],
      materialKinds: [],
      material: false,
    });
  });
});

function candidate(
  candidateId: string,
  score: number,
  flags: { readonly changed?: boolean; readonly fuzzy?: boolean } = {},
): WebAnnotationResolutionCandidate {
  return {
    candidateId,
    target,
    score: scoreAnchoringCandidate({
      quoteSimilarity: score,
      prefixSuffix: score,
      domContext: score,
      heading: score,
      position: score,
    }),
    evidence: {
      strategy: flags.fuzzy ? "fuzzy_quote" : "exact_quote",
      frameKey: "main",
      rects: target.rects,
      summary: "text candidate",
      changedSignals: flags.changed ? ["text"] : [],
    },
    changed: flags.changed ?? false,
    fuzzy: flags.fuzzy ?? false,
  };
}
