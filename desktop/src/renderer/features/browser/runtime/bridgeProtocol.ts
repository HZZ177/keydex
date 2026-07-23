import type { BrowserSurfaceRef } from "../domain";

export const WEB_ANNOTATION_BRIDGE_PROTOCOL = "keydex.web-annotation.v1" as const;
export const WEB_ANNOTATION_BRIDGE_MAX_MESSAGE_BYTES = 256 * 1024;
const OVERLAY_COLOR_TOKEN_NAMES = [
  "accent", "surface", "text", "border", "focus", "warning", "danger",
] as const;

export const HOST_TO_PAGE_BRIDGE_KINDS = [
  "selection.start",
  "selection.cancel",
  "overlay.configure",
  "annotation.resolve",
  "highlight.render",
  "highlight.clear",
  "navigate.toTarget",
] as const;

export const PAGE_TO_HOST_BRIDGE_KINDS = [
  "bridge.ready",
  "selection.candidate",
  "selection.result",
  "selection.cancelled",
  "annotation.submit",
  "annotation.cancelled",
  "highlight.action",
  "resolution.result",
  "geometry.changed",
  "page.changed",
  "page.interaction",
  "bridge.error",
] as const;

export type HostToPageBridgeKind = typeof HOST_TO_PAGE_BRIDGE_KINDS[number];
export type PageToHostBridgeKind = typeof PAGE_TO_HOST_BRIDGE_KINDS[number];
export type BrowserBridgeKind = HostToPageBridgeKind | PageToHostBridgeKind;
export type BrowserBridgeDirection = "host-to-page" | "page-to-host";
export type WebSelectionMode = "text" | "element" | "region";
export type WebAnnotationResolutionStatus = "resolved" | "changed" | "ambiguous" | "orphaned";

export interface CssRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DomPathSegment {
  readonly childIndex: number;
  readonly shadowRoot: boolean;
}

export type DomPath = readonly DomPathSegment[];

export interface PersistedFrameLocator {
  readonly url: string;
  readonly name?: string;
  readonly indexPath: readonly number[];
  readonly parentElementPath?: DomPath;
}

export interface WebTextTarget {
  readonly type: "text";
  readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
  readonly position?: { readonly start: number; readonly end: number; readonly textModelVersion: 1 };
  readonly domRange?: {
    readonly startPath: DomPath;
    readonly startOffset: number;
    readonly endPath: DomPath;
    readonly endOffset: number;
  };
  readonly context: {
    readonly headingPath: readonly string[];
    readonly containerRole?: string;
    readonly containerTextDigest?: string;
  };
  readonly rects: readonly CssRect[];
  readonly frame: PersistedFrameLocator;
}

export interface WebStableElementAttribute {
  readonly name: "id" | "name" | "type" | "href" | "src" | "alt" | "title" | "aria-label" | "role";
  readonly value: string;
}

export interface WebElementTarget {
  readonly type: "element";
  readonly tag: string;
  readonly role?: string;
  readonly accessibleName?: string;
  readonly textSummary?: string;
  readonly stableAttributes: readonly WebStableElementAttribute[];
  readonly path: DomPath;
  readonly shadowHostPath?: DomPath;
  readonly context: { readonly headingPath: readonly string[] };
  readonly rect: CssRect;
  readonly frame: PersistedFrameLocator;
}

export interface WebRegionTarget {
  readonly type: "region";
  readonly rect: CssRect;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly scroll: { readonly x: number; readonly y: number };
  readonly relativeElement?: {
    readonly path: DomPath;
    readonly rect: CssRect;
    readonly tag?: string;
    readonly role?: string;
    readonly accessibleName?: string;
    readonly textSummary?: string;
    readonly stableAttributes?: readonly WebStableElementAttribute[];
  };
  readonly visual?: {
    readonly fingerprintVersion: 1;
    readonly localDigest: string;
    readonly perceptualHash?: string;
  };
  readonly frame: PersistedFrameLocator;
}

export interface WebRegionCaptureGeometry {
  readonly rect: CssRect;
  readonly viewport: { readonly width: number; readonly height: number };
}

export type WebAnnotationTarget = WebTextTarget | WebElementTarget | WebRegionTarget;

export interface WebAnnotationLiveNodeBinding {
  readonly documentId: string;
  readonly nodeHandleId: string;
}

export interface WebAnnotationPageResolutionEvidence {
  readonly strategy:
    | "dom_range"
    | "text_position"
    | "exact_quote"
    | "fuzzy_quote"
    | "node_handle"
    | "stable_dom_path"
    | "unique_id"
    | "image_src_alt"
    | "role_name"
    | "stable_attributes"
    | "text_context"
    | "relative_region"
    | "region_semantic_search"
    | "coordinate_only_region"
    | "frame_unavailable";
  readonly score: number;
  readonly currentQuote?: string;
  readonly rects: readonly CssRect[];
  readonly candidateCount: number;
  readonly truncated: boolean;
  readonly changedSignals: readonly string[];
  readonly binding?: WebAnnotationLiveNodeBinding;
  readonly candidateSummaries?: readonly {
    readonly candidateId: string;
    readonly label: string;
    readonly tag: string;
    readonly role?: string;
  }[];
}

interface BridgePayloadByKind {
  readonly "selection.start": { readonly selectionId: string; readonly mode: WebSelectionMode };
  readonly "selection.cancel": {
    readonly selectionId: string;
    readonly reason: "user" | "navigation" | "surface_destroyed";
  };
  readonly "overlay.configure": {
    readonly theme: "light" | "dark";
    readonly tokens: {
      readonly accent: string;
      readonly surface: string;
      readonly text: string;
      readonly border: string;
      readonly focus: string;
      readonly warning: string;
      readonly danger: string;
    };
    readonly radiusPx: number;
    readonly motionMs: number;
    readonly reducedMotion: boolean;
  };
  readonly "annotation.resolve": {
    readonly annotationId: string;
    readonly target: WebAnnotationTarget;
    readonly binding?: WebAnnotationLiveNodeBinding;
  };
  readonly "highlight.render": {
    readonly annotationId: string;
    readonly target: WebAnnotationTarget;
    readonly state: WebAnnotationResolutionStatus;
    readonly bodyMarkdown?: string;
  };
  readonly "highlight.clear": { readonly annotationIds: readonly string[] };
  readonly "navigate.toTarget": { readonly annotationId: string; readonly target: WebAnnotationTarget };
  readonly "bridge.ready": { readonly href: string; readonly top: boolean };
  readonly "selection.candidate": {
    readonly selectionId: string;
    readonly mode: WebSelectionMode;
    readonly candidateId: string;
    readonly label: string;
    readonly rect: CssRect;
    readonly depth: number;
  };
  readonly "selection.result": {
    readonly selectionId: string;
    readonly target: WebAnnotationTarget;
    readonly captureGeometry?: WebRegionCaptureGeometry;
    readonly binding?: WebAnnotationLiveNodeBinding;
  };
  readonly "selection.cancelled": {
    readonly selectionId: string;
    readonly reason: "user" | "navigation" | "unsupported_frame" | "invalid_selection";
  };
  readonly "annotation.submit": {
    readonly selectionId: string;
    readonly bodyMarkdown: string;
  };
  readonly "annotation.cancelled": { readonly selectionId: string };
  readonly "highlight.action": {
    readonly annotationId: string;
    readonly action: "add_to_composer" | "delete_annotation" | "resume_selection";
  };
  readonly "resolution.result": {
    readonly annotationId: string;
    readonly status: WebAnnotationResolutionStatus;
    readonly target?: WebAnnotationTarget;
    readonly candidateIds?: readonly string[];
    readonly evidence?: WebAnnotationPageResolutionEvidence;
  };
  readonly "geometry.changed": { readonly annotationIds: readonly string[] };
  readonly "page.changed": {
    readonly reason: "dom";
    readonly revision: number;
    readonly annotationIds: readonly string[];
  };
  readonly "page.interaction": Record<string, never>;
  readonly "bridge.error": {
    readonly code: "unsupported_frame" | "invalid_selection" | "navigation_changed" | "protocol_mismatch" | "internal";
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type BrowserBridgeEnvelope<K extends BrowserBridgeKind = BrowserBridgeKind> = {
  readonly protocol: typeof WEB_ANNOTATION_BRIDGE_PROTOCOL;
  readonly kind: K;
  readonly panelId: string;
  readonly surfaceId: string;
  readonly generation: number;
  readonly navigationId: string;
  readonly frameKey: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly payload: BridgePayloadByKind[K];
};

export type BrowserBridgeValidationError =
  | "invalid_json"
  | "oversize"
  | "invalid_fields"
  | "unsupported_protocol"
  | "unsupported_kind"
  | "invalid_value"
  | "stale_surface"
  | "stale_navigation"
  | "stale_frame"
  | "out_of_order";

export type BrowserBridgeValidationResult =
  | { readonly ok: true; readonly envelope: BrowserBridgeEnvelope }
  | { readonly ok: false; readonly error: BrowserBridgeValidationError };

export function parseBrowserBridgeEnvelope(
  input: unknown,
  direction: BrowserBridgeDirection,
): BrowserBridgeValidationResult {
  let value = input;
  if (typeof input === "string") {
    if (byteLength(input) > WEB_ANNOTATION_BRIDGE_MAX_MESSAGE_BYTES) return { ok: false, error: "oversize" };
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, error: "invalid_json" };
    }
  } else {
    try {
      if (byteLength(JSON.stringify(input)) > WEB_ANNOTATION_BRIDGE_MAX_MESSAGE_BYTES) {
        return { ok: false, error: "oversize" };
      }
    } catch {
      return { ok: false, error: "invalid_value" };
    }
  }
  if (!isExactRecord(value, [
    "protocol", "kind", "panelId", "surfaceId", "generation", "navigationId",
    "frameKey", "requestId", "sequence", "payload",
  ])) return { ok: false, error: "invalid_fields" };
  if (value.protocol !== WEB_ANNOTATION_BRIDGE_PROTOCOL) return { ok: false, error: "unsupported_protocol" };
  if (typeof value.kind !== "string" || !kindAllowed(value.kind, direction)) {
    return { ok: false, error: "unsupported_kind" };
  }
  if (
    !isBoundedId(value.panelId)
    || !isBoundedId(value.surfaceId)
    || !isPositiveInteger(value.generation)
    || !isBoundedId(value.navigationId)
    || !isBoundedId(value.frameKey)
    || !isBoundedId(value.requestId)
    || !isPositiveInteger(value.sequence)
    || !validatePayload(value.kind, value.payload)
  ) return { ok: false, error: "invalid_value" };
  return { ok: true, envelope: value as unknown as BrowserBridgeEnvelope };
}

export class BrowserBridgeEnvelopeGate {
  readonly #surface: BrowserSurfaceRef;
  readonly #navigationId: string;
  readonly #frameKeys: ReadonlySet<string>;
  readonly #lastSequence = new Map<string, number>();

  constructor(input: {
    readonly surface: BrowserSurfaceRef;
    readonly navigationId: string;
    readonly frameKeys: ReadonlySet<string>;
  }) {
    this.#surface = input.surface;
    this.#navigationId = input.navigationId;
    this.#frameKeys = input.frameKeys;
  }

  accept(input: unknown, direction: BrowserBridgeDirection): BrowserBridgeValidationResult {
    const parsed = parseBrowserBridgeEnvelope(input, direction);
    if (!parsed.ok) return parsed;
    const { envelope } = parsed;
    if (
      envelope.panelId !== this.#surface.panelId
      || envelope.surfaceId !== this.#surface.surfaceId
      || envelope.generation !== this.#surface.generation
    ) return { ok: false, error: "stale_surface" };
    if (envelope.navigationId !== this.#navigationId) return { ok: false, error: "stale_navigation" };
    if (!this.#frameKeys.has(envelope.frameKey)) return { ok: false, error: "stale_frame" };
    const last = this.#lastSequence.get(envelope.frameKey) ?? 0;
    if (envelope.sequence <= last) return { ok: false, error: "out_of_order" };
    this.#lastSequence.set(envelope.frameKey, envelope.sequence);
    return parsed;
  }
}

function kindAllowed(kind: string, direction: BrowserBridgeDirection): kind is BrowserBridgeKind {
  return (direction === "host-to-page" ? HOST_TO_PAGE_BRIDGE_KINDS : PAGE_TO_HOST_BRIDGE_KINDS)
    .includes(kind as never);
}

function validatePayload(kind: BrowserBridgeKind, payload: unknown): boolean {
  switch (kind) {
    case "selection.start":
      return isExactRecord(payload, ["selectionId", "mode"])
        && isBoundedId(payload.selectionId) && isSelectionMode(payload.mode);
    case "selection.cancel":
      return isExactRecord(payload, ["selectionId", "reason"])
        && isBoundedId(payload.selectionId)
        && isOneOf(payload.reason, ["user", "navigation", "surface_destroyed"]);
    case "overlay.configure":
      return isExactRecord(payload, ["theme", "tokens", "radiusPx", "motionMs", "reducedMotion"])
        && isOneOf(payload.theme, ["light", "dark"])
        && validateOverlayTokens(payload.tokens)
        && isNumberInRange(payload.radiusPx, 0, 32)
        && isNumberInRange(payload.motionMs, 0, 2_000)
        && typeof payload.reducedMotion === "boolean";
    case "annotation.resolve":
      return isRecordWithOptional(payload, ["annotationId", "target"], ["binding"])
        && isBoundedId(payload.annotationId) && validateTarget(payload.target)
        && (payload.binding === undefined || validateLiveNodeBinding(payload.binding));
    case "navigate.toTarget":
      return isExactRecord(payload, ["annotationId", "target"])
        && isBoundedId(payload.annotationId) && validateTarget(payload.target);
    case "highlight.render":
      return isRecordWithOptional(payload, ["annotationId", "target", "state"], ["bodyMarkdown"])
        && isBoundedId(payload.annotationId) && validateTarget(payload.target)
        && isResolutionStatus(payload.state)
        && (payload.bodyMarkdown === undefined
          || isBoundedUnicodeString(payload.bodyMarkdown, 32 * 1024));
    case "highlight.clear":
    case "geometry.changed":
      return isExactRecord(payload, ["annotationIds"])
        && validateIds(payload.annotationIds, 50);
    case "page.changed":
      return isExactRecord(payload, ["reason", "revision", "annotationIds"])
        && payload.reason === "dom"
        && isNonNegativeInteger(payload.revision)
        && validateIds(payload.annotationIds, 50);
    case "page.interaction":
      return isExactRecord(payload, []);
    case "bridge.ready":
      return isExactRecord(payload, ["href", "top"])
        && isSafePageUrl(payload.href) && typeof payload.top === "boolean";
    case "selection.candidate":
      return isExactRecord(payload, ["selectionId", "mode", "candidateId", "label", "rect", "depth"])
        && isBoundedId(payload.selectionId) && isSelectionMode(payload.mode)
        && isBoundedId(payload.candidateId) && isBoundedString(payload.label, 1_024)
        && validateRect(payload.rect) && isNonNegativeInteger(payload.depth);
    case "selection.result":
      return isRecordWithOptional(payload, ["selectionId", "target"], ["captureGeometry", "binding"])
        && isBoundedId(payload.selectionId) && validateTarget(payload.target)
        && (payload.binding === undefined || validateLiveNodeBinding(payload.binding))
        && (payload.captureGeometry === undefined
          || (isPlainRecord(payload.target) && payload.target.type === "region"
            && validateCaptureGeometry(payload.captureGeometry)));
    case "selection.cancelled":
      return isExactRecord(payload, ["selectionId", "reason"])
        && isBoundedId(payload.selectionId)
        && isOneOf(payload.reason, ["user", "navigation", "unsupported_frame", "invalid_selection"]);
    case "annotation.submit":
      return isExactRecord(payload, ["selectionId", "bodyMarkdown"])
        && isBoundedId(payload.selectionId)
        && isBoundedUnicodeString(payload.bodyMarkdown, 32 * 1024, 1);
    case "annotation.cancelled":
      return isExactRecord(payload, ["selectionId"])
        && isBoundedId(payload.selectionId);
    case "highlight.action":
      return isExactRecord(payload, ["annotationId", "action"])
        && isBoundedId(payload.annotationId)
        && isOneOf(payload.action, ["add_to_composer", "delete_annotation", "resume_selection"]);
    case "resolution.result": {
      if (!isRecordWithOptional(payload, ["annotationId", "status"], ["target", "candidateIds", "evidence"])) return false;
      if (!isBoundedId(payload.annotationId) || !isResolutionStatus(payload.status)) return false;
      if (payload.target !== undefined && !validateTarget(payload.target)) return false;
      if (payload.candidateIds !== undefined && !validateIds(payload.candidateIds, 20)) return false;
      if (payload.evidence !== undefined && !validateResolutionEvidence(payload.evidence)) return false;
      if ((payload.status === "resolved" || payload.status === "changed") && payload.target === undefined) return false;
      if (payload.status === "ambiguous" && payload.candidateIds === undefined) return false;
      return true;
    }
    case "bridge.error":
      return isExactRecord(payload, ["code", "message", "retryable"])
        && isOneOf(payload.code, [
          "unsupported_frame", "invalid_selection", "navigation_changed", "protocol_mismatch", "internal",
        ])
        && isBoundedString(payload.message, 512) && typeof payload.retryable === "boolean";
  }
}

function validateResolutionEvidence(value: unknown): value is WebAnnotationPageResolutionEvidence {
  if (!isRecordWithOptional(
    value,
    ["strategy", "score", "rects", "candidateCount", "truncated", "changedSignals"],
    ["currentQuote", "candidateSummaries", "binding"],
  )) return false;
  return isOneOf(value.strategy, [
    "dom_range", "text_position", "exact_quote", "fuzzy_quote", "node_handle", "stable_dom_path", "unique_id",
    "image_src_alt", "role_name", "stable_attributes", "text_context", "frame_unavailable",
    "relative_region", "region_semantic_search", "coordinate_only_region",
  ])
    && isNumberInRange(value.score, 0, 1)
    && (value.currentQuote === undefined || isBoundedString(value.currentQuote, 8_192, 1))
    && Array.isArray(value.rects)
    && value.rects.length <= 128
    && value.rects.every(validateRect)
    && isNonNegativeInteger(value.candidateCount)
    && value.candidateCount <= 256
    && typeof value.truncated === "boolean"
    && Array.isArray(value.changedSignals)
    && value.changedSignals.length <= 8
    && value.changedSignals.every((signal) => isBoundedString(signal, 64, 1))
    && (value.binding === undefined || validateLiveNodeBinding(value.binding))
    && (value.candidateSummaries === undefined || (
      Array.isArray(value.candidateSummaries)
      && value.candidateSummaries.length <= 20
      && value.candidateSummaries.every((summary) => isRecordWithOptional(
        summary,
        ["candidateId", "label", "tag"],
        ["role"],
      )
        && isBoundedId(summary.candidateId)
        && isBoundedString(summary.label, 256, 1)
        && isBoundedString(summary.tag, 64, 1)
        && (summary.role === undefined || isBoundedString(summary.role, 128, 1)))
    ));
}

function validateLiveNodeBinding(value: unknown): value is WebAnnotationLiveNodeBinding {
  return isExactRecord(value, ["documentId", "nodeHandleId"])
    && isBoundedId(value.documentId)
    && isBoundedId(value.nodeHandleId);
}

function validateTarget(value: unknown): value is WebAnnotationTarget {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") {
    if (!isRecordWithOptional(value, ["type", "quote", "context", "rects", "frame"], ["position", "domRange"])) return false;
    if (!isExactRecord(value.quote, ["exact", "prefix", "suffix"])) return false;
    if (!isBoundedString(value.quote.exact, 8_192, 1) || !isBoundedString(value.quote.prefix, 256) || !isBoundedString(value.quote.suffix, 256)) return false;
    if (!isRecordWithOptional(value.context, ["headingPath"], ["containerRole", "containerTextDigest"])) return false;
    if (!validateStrings(value.context.headingPath, 16, 256)) return false;
    if (value.context.containerRole !== undefined && !isBoundedString(value.context.containerRole, 128)) return false;
    if (value.context.containerTextDigest !== undefined && !isBoundedString(value.context.containerTextDigest, 128)) return false;
    if (value.position !== undefined && (!isExactRecord(value.position, ["start", "end", "textModelVersion"])
      || !isNonNegativeInteger(value.position.start) || !isNonNegativeInteger(value.position.end)
      || value.position.end < value.position.start || value.position.textModelVersion !== 1)) return false;
    if (value.domRange !== undefined && (!isExactRecord(value.domRange, ["startPath", "startOffset", "endPath", "endOffset"])
      || !validateDomPath(value.domRange.startPath) || !validateDomPath(value.domRange.endPath)
      || !isNonNegativeInteger(value.domRange.startOffset) || !isNonNegativeInteger(value.domRange.endOffset))) return false;
    return validateRects(value.rects) && validateFrame(value.frame);
  }
  if (value.type === "element") {
    if (!isRecordWithOptional(value, ["type", "tag", "stableAttributes", "path", "context", "rect", "frame"], [
      "role", "accessibleName", "textSummary", "shadowHostPath",
    ])) return false;
    if (!isBoundedString(value.tag, 64, 1) || value.tag !== value.tag.toLowerCase()) return false;
    if (value.role !== undefined && !isBoundedString(value.role, 128)) return false;
    if (value.accessibleName !== undefined && !isBoundedString(value.accessibleName, 1_024)) return false;
    if (value.textSummary !== undefined && !isBoundedString(value.textSummary, 1_024)) return false;
    if (!Array.isArray(value.stableAttributes) || value.stableAttributes.length > 20 || value.stableAttributes.some((entry) =>
      !isExactRecord(entry, ["name", "value"])
      || !isOneOf(entry.name, ["id", "name", "type", "href", "src", "alt", "title", "aria-label", "role"])
      || !isBoundedString(entry.value, 2_048))) return false;
    if (!validateDomPath(value.path) || (value.shadowHostPath !== undefined && !validateDomPath(value.shadowHostPath))) return false;
    return isExactRecord(value.context, ["headingPath"])
      && validateStrings(value.context.headingPath, 16, 256)
      && validateRect(value.rect) && validateFrame(value.frame);
  }
  if (value.type === "region") {
    if (!isRecordWithOptional(value, ["type", "rect", "viewport", "scroll", "frame"], ["relativeElement", "visual"])) return false;
    if (!validateRect(value.rect) || value.rect.width * value.rect.height <= 0) return false;
    if (!isExactRecord(value.viewport, ["width", "height"])
      || !isPositiveFinite(value.viewport.width) || !isPositiveFinite(value.viewport.height)) return false;
    if (!isExactRecord(value.scroll, ["x", "y"])
      || !isFiniteNumber(value.scroll.x) || !isFiniteNumber(value.scroll.y)) return false;
    if (value.relativeElement !== undefined && (!isRecordWithOptional(value.relativeElement, ["path", "rect"], [
      "tag", "role", "accessibleName", "textSummary", "stableAttributes",
    ])
      || !validateDomPath(value.relativeElement.path) || !validateRect(value.relativeElement.rect)
      || (value.relativeElement.tag !== undefined && !isBoundedString(value.relativeElement.tag, 64, 1))
      || (value.relativeElement.role !== undefined && !isBoundedString(value.relativeElement.role, 128, 1))
      || (value.relativeElement.accessibleName !== undefined && !isBoundedString(value.relativeElement.accessibleName, 1_024, 1))
      || (value.relativeElement.textSummary !== undefined && !isBoundedString(value.relativeElement.textSummary, 1_024, 1))
      || (value.relativeElement.stableAttributes !== undefined && !validateStableAttributes(value.relativeElement.stableAttributes)))) return false;
    if (value.visual !== undefined && (!isRecordWithOptional(
      value.visual,
      ["fingerprintVersion", "localDigest"],
      ["perceptualHash"],
    )
      || value.visual.fingerprintVersion !== 1
      || typeof value.visual.localDigest !== "string"
      || !/^fnv1a32:[0-9a-f]{8}$/u.test(value.visual.localDigest)
      || (value.visual.perceptualHash !== undefined
        && typeof value.visual.perceptualHash !== "string")
      || (typeof value.visual.perceptualHash === "string"
        && !/^dhash64:[0-9a-f]{16}$/u.test(value.visual.perceptualHash)))) return false;
    return validateFrame(value.frame);
  }
  return false;
}

function validateStableAttributes(value: unknown): value is readonly WebStableElementAttribute[] {
  return Array.isArray(value) && value.length <= 20 && value.every((entry) =>
    isExactRecord(entry, ["name", "value"])
    && isOneOf(entry.name, ["id", "name", "type", "href", "src", "alt", "title", "aria-label", "role"])
    && isBoundedString(entry.value, 2_048));
}

function validateCaptureGeometry(value: unknown): value is WebRegionCaptureGeometry {
  return isExactRecord(value, ["rect", "viewport"])
    && validateRect(value.rect)
    && value.rect.width > 0
    && value.rect.height > 0
    && isExactRecord(value.viewport, ["width", "height"])
    && isPositiveFinite(value.viewport.width)
    && isPositiveFinite(value.viewport.height);
}

function validateRect(value: unknown): value is CssRect {
  return isExactRecord(value, ["x", "y", "width", "height"])
    && isFiniteNumber(value.x) && isFiniteNumber(value.y)
    && isFiniteNumber(value.width) && value.width >= 0
    && isFiniteNumber(value.height) && value.height >= 0;
}

function validateRects(value: unknown): value is readonly CssRect[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every(validateRect);
}

function validateDomPath(value: unknown): value is DomPath {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every((segment) =>
    isExactRecord(segment, ["childIndex", "shadowRoot"])
    && isNonNegativeInteger(segment.childIndex) && typeof segment.shadowRoot === "boolean");
}

function validateFrame(value: unknown): value is PersistedFrameLocator {
  if (!isRecordWithOptional(value, ["url", "indexPath"], ["name", "parentElementPath"])) return false;
  if (!isSafePageUrl(value.url) || !Array.isArray(value.indexPath) || value.indexPath.length > 32
    || value.indexPath.some((index) => !isNonNegativeInteger(index))) return false;
  if (value.name !== undefined && !isBoundedString(value.name, 256)) return false;
  return value.parentElementPath === undefined || validateDomPath(value.parentElementPath);
}

function isSafePageUrl(value: unknown): value is string {
  if (!isBoundedString(value, 4_096, 1)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || value === "about:blank";
  } catch {
    return value === "about:blank";
  }
}

function validateIds(value: unknown, max: number): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= max && value.every(isBoundedId)
    && new Set(value).size === value.length;
}

function validateStrings(value: unknown, maxItems: number, maxLength: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => isBoundedString(item, maxLength));
}

function isSelectionMode(value: unknown): value is WebSelectionMode {
  return isOneOf(value, ["text", "element", "region"]);
}

function isResolutionStatus(value: unknown): value is WebAnnotationResolutionStatus {
  return isOneOf(value, ["resolved", "changed", "ambiguous", "orphaned"]);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isBoundedId(value: unknown): value is string {
  return isBoundedString(value, 128, 1) && /^[A-Za-z0-9._:@/-]+$/.test(value);
}

function isBoundedString(value: unknown, max: number, min = 0): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isBoundedUnicodeString(value: unknown, max: number, min = 0): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length >= min && length <= max;
}

function isSafeCssColor(value: unknown): value is string {
  return isBoundedString(value, 128, 1)
    && !/[;{}'"\\]/.test(value)
    && !/url\s*\(/i.test(value);
}

function validateOverlayTokens(value: unknown): boolean {
  return isExactRecord(value, OVERLAY_COLOR_TOKEN_NAMES)
    && OVERLAY_COLOR_TOKEN_NAMES.every((name) => isSafeCssColor(value[name]));
}

function isNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return isFiniteNumber(value) && value >= minimum && value <= maximum;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRecordWithOptional<R extends string, O extends string>(
  value: unknown,
  required: readonly R[],
  optional: readonly O[],
): value is Record<R, unknown> & Partial<Record<O, unknown>> {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set<string>([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every((key) => allowed.has(key));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
