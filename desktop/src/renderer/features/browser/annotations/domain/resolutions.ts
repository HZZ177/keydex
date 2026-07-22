import type { CssRect, WebAnnotationTarget } from "../../runtime";
import {
  rankAnchoringCandidates,
  WEB_ANNOTATION_SCORING_POLICY_V1,
  type WebAnnotationCandidateScore,
  type WebAnnotationScoringPolicy,
} from "../anchoring";

export const WEB_ANNOTATION_RESOLUTION_REASON_CODES = [
  "bridge_not_ready",
  "bridge_ready",
  "navigation_changed",
  "annotation_set_changed",
  "retargeted",
  "dom_changed",
  "page_loading",
  "frame_rebuilding",
  "surface_discarded",
  "resolver_timeout",
  "exact_match",
  "content_changed",
  "fuzzy_match",
  "ambiguous_candidates",
  "no_candidate",
  "below_accept_threshold",
  "frame_unavailable",
  "coordinate_only_region",
] as const;

export type WebAnnotationResolutionReasonCode =
  typeof WEB_ANNOTATION_RESOLUTION_REASON_CODES[number];

export type WebAnnotationSettledStatus = "resolved" | "changed" | "ambiguous" | "orphaned";
export type WebAnnotationTransientStatus = "pending" | "resolving" | "temporarily_unavailable";
export type WebAnnotationVisibleStatus = WebAnnotationSettledStatus | WebAnnotationTransientStatus;

export type WebAnnotationChangeKind =
  | "content"
  | "structure"
  | "attributes"
  | "visual"
  | "layout"
  | "context"
  | "unknown";

export interface WebAnnotationChangeSummary {
  readonly kinds: readonly WebAnnotationChangeKind[];
  readonly materialKinds: readonly WebAnnotationChangeKind[];
  readonly signals: readonly string[];
  readonly material: boolean;
}

const CHANGE_KIND_ORDER: readonly WebAnnotationChangeKind[] = [
  "content",
  "structure",
  "attributes",
  "visual",
  "layout",
  "context",
  "unknown",
];

const CHANGE_SIGNAL_KINDS: Readonly<Record<string, WebAnnotationChangeKind>> = Object.freeze({
  quote_changed: "content",
  accessible_name_changed: "content",
  text_changed: "content",
  anchor_name_changed: "content",
  anchor_text_changed: "content",
  tag_changed: "structure",
  role_changed: "structure",
  anchor_tag_changed: "structure",
  anchor_role_changed: "structure",
  stable_attributes_changed: "attributes",
  anchor_attributes_changed: "attributes",
  local_fingerprint_changed: "visual",
  anchor_position_changed: "layout",
  anchor_size_changed: "layout",
  prefix_changed: "context",
  suffix_changed: "context",
  container_changed: "context",
  heading_changed: "context",
});

const MATERIAL_CHANGE_KINDS = new Set<WebAnnotationChangeKind>([
  "content",
  "structure",
  "attributes",
  "visual",
  "unknown",
]);

export function summarizeWebAnnotationChanges(
  signals: readonly string[] | null | undefined,
): WebAnnotationChangeSummary {
  const normalizedSignals = [...new Set(
    (signals ?? []).map((signal) => signal.trim()).filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
  const kinds = CHANGE_KIND_ORDER.filter((kind) => normalizedSignals.some(
    (signal) => (CHANGE_SIGNAL_KINDS[signal] ?? "unknown") === kind,
  ));
  const materialKinds = kinds.filter((kind) => MATERIAL_CHANGE_KINDS.has(kind));
  return Object.freeze({
    kinds: Object.freeze(kinds),
    materialKinds: Object.freeze(materialKinds),
    signals: Object.freeze(normalizedSignals),
    material: materialKinds.length > 0,
  });
}

export function visibleWebAnnotationStatus(
  status: WebAnnotationSettledStatus | WebAnnotationTransientStatus,
): WebAnnotationVisibleStatus {
  return status === "changed" ? "resolved" : status;
}

export interface WebAnnotationResolutionIdentity {
  readonly resourceId: string;
  readonly annotationId: string;
  readonly navigationId: string;
  readonly frameRevision: number;
}

export type WebAnnotationResolutionStrategy =
  | "dom_range"
  | "text_position"
  | "exact_quote"
  | "fuzzy_quote"
  | "stable_dom_path"
  | "unique_id"
  | "semantic_element"
  | "relative_region"
  | "region_semantic_search"
  | "coordinate_only_region"
  | "visual_region_suggestion";

export interface WebAnnotationResolutionEvidence {
  readonly strategy: WebAnnotationResolutionStrategy;
  readonly frameKey: string;
  readonly rects: readonly CssRect[];
  readonly summary: string;
  readonly changedSignals: readonly string[];
}

export interface WebAnnotationResolutionCandidate {
  readonly candidateId: string;
  readonly target: WebAnnotationTarget;
  readonly score: WebAnnotationCandidateScore;
  readonly evidence: WebAnnotationResolutionEvidence;
  readonly changed: boolean;
  readonly fuzzy: boolean;
}

export interface WebAnnotationResolutionOutcome {
  readonly status: WebAnnotationSettledStatus;
  readonly identity: WebAnnotationResolutionIdentity;
  readonly reason: WebAnnotationResolutionReasonCode;
  readonly policyId: WebAnnotationScoringPolicy["policyId"];
  readonly selected: WebAnnotationResolutionCandidate | null;
  readonly candidates: readonly WebAnnotationResolutionCandidate[];
  readonly resolvedAt: string;
}

interface WebAnnotationTransientResolutionBase {
  readonly identity: WebAnnotationResolutionIdentity;
  readonly lastKnown: WebAnnotationResolutionOutcome | null;
  readonly startedAt: string;
}

export type WebAnnotationResolutionState =
  | (WebAnnotationTransientResolutionBase & {
      readonly status: "pending";
      readonly reason: "bridge_not_ready" | "navigation_changed";
    })
  | (WebAnnotationTransientResolutionBase & {
      readonly status: "resolving";
      readonly reason:
        | "bridge_ready"
        | "navigation_changed"
        | "annotation_set_changed"
        | "retargeted"
        | "dom_changed";
      readonly requestId: string;
    })
  | (WebAnnotationTransientResolutionBase & {
      readonly status: "temporarily_unavailable";
      readonly reason: "page_loading" | "frame_rebuilding" | "surface_discarded" | "resolver_timeout";
    })
  | WebAnnotationResolutionOutcome;

export function settleWebAnnotationResolution(
  identity: WebAnnotationResolutionIdentity,
  candidates: readonly WebAnnotationResolutionCandidate[],
  options: {
    readonly policy?: WebAnnotationScoringPolicy;
    readonly now?: () => string;
  } = {},
): WebAnnotationResolutionOutcome {
  const policy = options.policy ?? WEB_ANNOTATION_SCORING_POLICY_V1;
  const decision = rankAnchoringCandidates(candidates, policy);
  const resolvedAt = (options.now ?? (() => new Date().toISOString()))();
  if (decision.kind === "rejected") {
    return freezeOutcome({
      status: "orphaned",
      identity,
      reason: decision.reason,
      policyId: policy.policyId,
      selected: null,
      candidates: [],
      resolvedAt,
    });
  }
  if (decision.kind === "ambiguous") {
    return freezeOutcome({
      status: "ambiguous",
      identity,
      reason: "ambiguous_candidates",
      policyId: policy.policyId,
      selected: null,
      candidates: decision.candidates,
      resolvedAt,
    });
  }
  const selected = decision.selected;
  const changed = selected.fuzzy || selected.changed;
  return freezeOutcome({
    status: changed ? "changed" : "resolved",
    identity,
    reason: selected.fuzzy ? "fuzzy_match" : changed ? "content_changed" : "exact_match",
    policyId: policy.policyId,
    selected,
    candidates: [selected],
    resolvedAt,
  });
}

export function orphanWebAnnotationResolution(
  identity: WebAnnotationResolutionIdentity,
  reason: "frame_unavailable" | "coordinate_only_region" | "resolver_timeout" | "no_candidate",
  now: () => string = () => new Date().toISOString(),
): WebAnnotationResolutionOutcome {
  return freezeOutcome({
    status: "orphaned",
    identity,
    reason,
    policyId: WEB_ANNOTATION_SCORING_POLICY_V1.policyId,
    selected: null,
    candidates: [],
    resolvedAt: now(),
  });
}

export function visibleWebAnnotationResolutionStatus(
  state: WebAnnotationResolutionState,
): WebAnnotationVisibleStatus {
  if (isSettledResolution(state)) return visibleWebAnnotationStatus(state.status);
  return visibleWebAnnotationStatus(state.lastKnown?.status ?? state.status);
}

export function isWebAnnotationResolutionCurrent(
  resolution: Pick<WebAnnotationResolutionState, "identity">,
  identity: WebAnnotationResolutionIdentity,
): boolean {
  return resolution.identity.resourceId === identity.resourceId
    && resolution.identity.annotationId === identity.annotationId
    && resolution.identity.navigationId === identity.navigationId
    && resolution.identity.frameRevision === identity.frameRevision;
}

export function currentSettledWebAnnotationResolution(
  state: WebAnnotationResolutionState,
  identity: WebAnnotationResolutionIdentity,
): WebAnnotationResolutionOutcome | null {
  if (!isWebAnnotationResolutionCurrent(state, identity)) return null;
  if (isSettledResolution(state)) return state;
  return state.lastKnown && isWebAnnotationResolutionCurrent(state.lastKnown, identity)
    ? state.lastKnown
    : null;
}

function isSettledResolution(
  state: WebAnnotationResolutionState,
): state is WebAnnotationResolutionOutcome {
  return state.status === "resolved"
    || state.status === "changed"
    || state.status === "ambiguous"
    || state.status === "orphaned";
}

function freezeOutcome(input: WebAnnotationResolutionOutcome): WebAnnotationResolutionOutcome {
  return Object.freeze({
    ...input,
    identity: Object.freeze({ ...input.identity }),
    candidates: Object.freeze([...input.candidates]),
  });
}
