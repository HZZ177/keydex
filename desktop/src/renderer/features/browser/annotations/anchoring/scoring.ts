import scoringPolicyV1 from "./scoringPolicyV1.json";

export interface WebAnnotationScoringPolicy {
  readonly schemaVersion: number;
  readonly policyId: `keydex.web-annotation.scoring.v${number}`;
  readonly weights: Readonly<{
    quoteSimilarity: number;
    prefixSuffix: number;
    domContext: number;
    heading: number;
    position: number;
  }>;
  readonly acceptThreshold: number;
  readonly ambiguityGap: number;
}

export const WEB_ANNOTATION_SCORING_POLICY_V1: WebAnnotationScoringPolicy = Object.freeze({
  ...scoringPolicyV1,
  policyId: scoringPolicyId(scoringPolicyV1.policyId),
  weights: Object.freeze({ ...scoringPolicyV1.weights }),
});

export interface WebAnnotationScoreSignals {
  readonly quoteSimilarity: number;
  readonly prefixSuffix: number;
  readonly domContext: number;
  readonly heading: number;
  readonly position: number;
}

export interface WebAnnotationCandidateScore {
  readonly policyId: WebAnnotationScoringPolicy["policyId"];
  readonly total: number;
  readonly signals: WebAnnotationScoreSignals;
}

export interface ScoredAnchoringCandidate {
  readonly candidateId: string;
  readonly score: WebAnnotationCandidateScore;
}

export type AnchoringScoreDecision<TCandidate extends ScoredAnchoringCandidate> =
  | {
      readonly kind: "accepted";
      readonly selected: TCandidate;
      readonly ranked: readonly TCandidate[];
      readonly margin: number | null;
    }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly TCandidate[];
      readonly ranked: readonly TCandidate[];
      readonly margin: number;
    }
  | {
      readonly kind: "rejected";
      readonly reason: "no_candidate" | "below_accept_threshold";
      readonly ranked: readonly TCandidate[];
    };

export function scoreAnchoringCandidate(
  signals: WebAnnotationScoreSignals,
  policy: WebAnnotationScoringPolicy = WEB_ANNOTATION_SCORING_POLICY_V1,
): WebAnnotationCandidateScore {
  validatePolicy(policy);
  for (const [name, value] of Object.entries(signals)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`Web annotation score signal ${name} must be between 0 and 1`);
    }
  }
  const total = roundScore(
    signals.quoteSimilarity * policy.weights.quoteSimilarity
      + signals.prefixSuffix * policy.weights.prefixSuffix
      + signals.domContext * policy.weights.domContext
      + signals.heading * policy.weights.heading
      + signals.position * policy.weights.position,
  );
  return Object.freeze({
    policyId: policy.policyId,
    total,
    signals: Object.freeze({ ...signals }),
  });
}

export function rankAnchoringCandidates<TCandidate extends ScoredAnchoringCandidate>(
  candidates: readonly TCandidate[],
  policy: WebAnnotationScoringPolicy = WEB_ANNOTATION_SCORING_POLICY_V1,
): AnchoringScoreDecision<TCandidate> {
  validatePolicy(policy);
  const ranked = Object.freeze([...candidates].sort((left, right) => (
    right.score.total - left.score.total || left.candidateId.localeCompare(right.candidateId)
  )));
  const first = ranked[0];
  if (!first) return Object.freeze({ kind: "rejected", reason: "no_candidate", ranked });
  if (first.score.total < policy.acceptThreshold) {
    return Object.freeze({ kind: "rejected", reason: "below_accept_threshold", ranked });
  }
  const second = ranked[1];
  const margin = second ? roundScore(first.score.total - second.score.total) : null;
  if (
    second
    && second.score.total >= policy.acceptThreshold
    && margin !== null
    && margin < policy.ambiguityGap
  ) {
    const ambiguousCandidates = Object.freeze(ranked.filter((candidate) => (
      candidate.score.total >= policy.acceptThreshold
      && first.score.total - candidate.score.total < policy.ambiguityGap
    )));
    return Object.freeze({
      kind: "ambiguous",
      candidates: ambiguousCandidates,
      ranked,
      margin,
    });
  }
  return Object.freeze({ kind: "accepted", selected: first, ranked, margin });
}

function validatePolicy(policy: WebAnnotationScoringPolicy): void {
  const weightTotal = Object.values(policy.weights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(weightTotal - 1) > 0.000001) {
    throw new RangeError("Web annotation scoring weights must sum to 1");
  }
  if (
    !Number.isFinite(policy.acceptThreshold)
    || policy.acceptThreshold < 0
    || policy.acceptThreshold > 1
    || !Number.isFinite(policy.ambiguityGap)
    || policy.ambiguityGap < 0
    || policy.ambiguityGap > 1
  ) {
    throw new RangeError("Web annotation scoring thresholds must be between 0 and 1");
  }
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function scoringPolicyId(value: string): WebAnnotationScoringPolicy["policyId"] {
  if (!/^keydex\.web-annotation\.scoring\.v\d+$/.test(value)) {
    throw new Error("Invalid web annotation scoring policy id");
  }
  return value as WebAnnotationScoringPolicy["policyId"];
}
