import { BROWSER_LIMITS, BROWSER_PROTOCOL_VERSIONS } from "../config";

export const BROWSER_EVENT_TOPIC = "keydex://browser-event" as const;
export const BROWSER_HOST_SCHEMA_VERSION = BROWSER_PROTOCOL_VERSIONS.browserHost;
export const BROWSER_HOST_MAX_ENVELOPE_BYTES = BROWSER_LIMITS.bridgeMaxMessageBytes;

const MAX_ID_LENGTH = 128;
const MAX_URL_LENGTH = 8_192;
const MAX_TEXT_LENGTH = 16_384;
const MAX_COLLECTION_SIZE = 50;

export type BrowserProfileMode = "persistent" | "incognito";
export type BrowserReloadMode = "normal" | "ignore_cache";
export type BrowserVisibilityReason =
  | "active"
  | "inactive_tab"
  | "sidebar_closed"
  | "window_hidden"
  | "occluded";

export interface BrowserSurfaceRef {
  readonly panelId: string;
  readonly surfaceId: string;
  readonly generation: number;
}

export interface BrowserLogicalRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserOverlayTokens {
  readonly accent: string;
  readonly surface: string;
  readonly text: string;
  readonly border: string;
  readonly focus: string;
  readonly warning: string;
  readonly danger: string;
}

export interface BrowserCommandPayloadByKind {
  readonly browser_create_surface: {
    readonly panelId: string;
    readonly generation: number;
    readonly profileMode: BrowserProfileMode;
    readonly initialUrl: string;
  };
  readonly browser_destroy_surface: BrowserSurfaceRef;
  readonly browser_set_bounds: BrowserSurfaceRef & { readonly rect: BrowserLogicalRect };
  readonly browser_set_visibility: BrowserSurfaceRef & {
    readonly visible: boolean;
    readonly reason: BrowserVisibilityReason;
  };
  readonly browser_navigate: BrowserSurfaceRef & {
    readonly navigationId: string;
    readonly url: string;
  };
  readonly browser_go_back: BrowserSurfaceRef;
  readonly browser_go_forward: BrowserSurfaceRef;
  readonly browser_reload: BrowserSurfaceRef & { readonly mode: BrowserReloadMode };
  readonly browser_stop: BrowserSurfaceRef;
  readonly browser_set_zoom: BrowserSurfaceRef & { readonly factor: number };
  readonly browser_set_resource_state: BrowserSurfaceRef & {
    readonly state: "visible" | "warm" | "native_suspended";
    readonly reason: string;
  };
  readonly browser_find: BrowserSurfaceRef & {
    readonly query: string;
    readonly matchCase: boolean;
    readonly backwards: boolean;
  };
  readonly browser_stop_find: BrowserSurfaceRef;
  readonly browser_respond_permission: BrowserSurfaceRef & {
    readonly permissionRequestId: string;
    readonly origin: string;
    readonly decision: "allow_once" | "deny";
  };
  readonly browser_respond_download: BrowserSurfaceRef & {
    readonly downloadId: string;
    readonly decision: "accept" | "cancel";
    readonly targetPath?: string;
  };
  readonly browser_start_selection: BrowserSurfaceRef & {
    readonly selectionRequestId: string;
    readonly mode: "text" | "element" | "region";
  };
  readonly browser_configure_overlay: BrowserSurfaceRef & {
    readonly theme: "light" | "dark";
    readonly tokens: BrowserOverlayTokens;
    readonly radiusPx: number;
    readonly motionMs: number;
    readonly reducedMotion: boolean;
  };
  readonly browser_cancel_selection: BrowserSurfaceRef;
  readonly browser_resolve_annotations: BrowserSurfaceRef & {
    readonly resolveRequestId: string;
    readonly targets: readonly {
      readonly annotationId: string;
      readonly target: unknown;
    }[];
  };
  readonly browser_render_highlights: BrowserSurfaceRef & {
    readonly resolutions: readonly {
      readonly annotationId: string;
      readonly target: unknown;
      readonly state: "resolved" | "changed";
    }[];
  };
  readonly browser_clear_highlights: BrowserSurfaceRef & {
    readonly annotationIds: readonly string[];
  };
  readonly browser_navigate_to_annotation_target: BrowserSurfaceRef & {
    readonly annotationId: string;
    readonly target: unknown;
  };
  readonly browser_capture_region: BrowserSurfaceRef & {
    readonly captureRequestId: string;
    readonly rect: BrowserLogicalRect;
    readonly viewport: { readonly width: number; readonly height: number };
  };
  readonly browser_discard_capture: BrowserSurfaceRef & { readonly captureRequestId: string };
  readonly browser_clear_profile_data: {
    readonly profileMode: BrowserProfileMode;
    readonly kinds: readonly ("cookies" | "cache" | "storage")[];
    readonly timeRange: "all" | "last_hour" | "last_day";
  };
}

export type BrowserCommandKind = keyof BrowserCommandPayloadByKind;

export type BrowserCommandEnvelope<K extends BrowserCommandKind = BrowserCommandKind> = {
  readonly schemaVersion: typeof BROWSER_HOST_SCHEMA_VERSION;
  readonly requestId: string;
  readonly command: K;
  readonly payload: BrowserCommandPayloadByKind[K];
};

export type BrowserCommandErrorCode =
  | "invalid_request"
  | "unauthorized_caller"
  | "surface_not_found"
  | "stale_generation"
  | "unsupported_operation"
  | "policy_denied"
  | "resource_limit"
  | "host_failure";

export interface BrowserCommandError {
  readonly code: BrowserCommandErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface BrowserNativeDomPathSegment {
  readonly childIndex: number;
  readonly shadowRoot: boolean;
}

export interface BrowserNativeElementTarget {
  readonly type: "element";
  readonly tag: string;
  readonly role?: string;
  readonly accessibleName?: string;
  readonly textSummary?: string;
  readonly stableAttributes: readonly {
    readonly name: "id" | "name" | "type" | "href" | "src" | "alt" | "title" | "aria-label" | "role";
    readonly value: string;
  }[];
  readonly path: readonly BrowserNativeDomPathSegment[];
  readonly shadowHostPath?: readonly BrowserNativeDomPathSegment[];
  readonly context: { readonly headingPath: readonly string[] };
  readonly rect: BrowserLogicalRect;
  readonly frame: {
    readonly url: string;
    readonly name?: string;
    readonly indexPath: readonly number[];
    readonly parentElementPath?: readonly BrowserNativeDomPathSegment[];
  };
}

export type BrowserCommandResponse =
  | { readonly ok: true; readonly requestId: string }
  | { readonly ok: false; readonly requestId: string; readonly error: BrowserCommandError };

export interface BrowserEventPayloadByKind {
  readonly "surface.ready": {
    readonly profileMode: BrowserProfileMode;
    readonly capabilities: readonly string[];
  };
  readonly "surface.destroyed": { readonly reason: string };
  readonly "navigation.started": { readonly url: string; readonly isMainFrame: boolean };
  readonly "navigation.committed": { readonly url: string; readonly isMainFrame: boolean };
  readonly "navigation.completed": { readonly url: string; readonly isMainFrame: boolean };
  readonly "navigation.failed": {
    readonly url: string;
    readonly isMainFrame: boolean;
    readonly errorCategory: string;
  };
  readonly "page.title": { readonly title: string };
  readonly "page.favicon": { readonly faviconUrl: string | null };
  readonly "page.source": { readonly url: string };
  readonly "page.history": { readonly canGoBack: boolean; readonly canGoForward: boolean };
  readonly "page.loading": { readonly loading: boolean };
  readonly "shortcut.requested": {
    readonly shortcut: "focus_address" | "reload" | "close_panel" | "find";
  };
  readonly "new_window.requested": {
    readonly url: string;
    readonly userGesture: boolean;
    readonly disposition: "tab" | "window" | "popup";
  };
  readonly "external_protocol.requested": { readonly scheme: string; readonly target: string };
  readonly "permission.requested": {
    readonly permissionRequestId: string;
    readonly origin: string;
    readonly permission: string;
    readonly deadline: string;
  };
  readonly "permission.expired": { readonly permissionRequestId: string };
  readonly "download.requested": {
    readonly downloadId: string;
    readonly url: string;
    readonly suggestedFilename: string;
    readonly totalBytes: number | null;
  };
  readonly "download.progress": {
    readonly downloadId: string;
    readonly receivedBytes: number;
    readonly totalBytes: number | null;
  };
  readonly "download.completed": { readonly downloadId: string; readonly stagedAssetId: string };
  readonly "download.failed": { readonly downloadId: string; readonly errorCategory: string };
  readonly "capture.completed": {
    readonly captureRequestId: string;
    readonly asset: {
      readonly assetId: string;
      readonly kind: "staged" | "managed_temp";
      readonly mimeType: "image/png";
      readonly width: number;
      readonly height: number;
      readonly byteLength: number;
      readonly sha256: string;
      readonly perceptualHash: string;
      readonly expiresAt: string;
    };
  };
  readonly "capture.failed": { readonly captureRequestId: string; readonly errorCategory: string };
  readonly "selection.result": {
    readonly selectionRequestId: string;
    readonly frameKey: string;
    readonly target: BrowserNativeElementTarget;
  };
  readonly "selection.cancelled": {
    readonly selectionRequestId: string;
    readonly reason: "user" | "navigation" | "surface_destroyed";
  };
  readonly "selection.failed": {
    readonly selectionRequestId: string;
    readonly errorCategory: string;
    readonly message: string;
  };
  readonly "process.failed": {
    readonly scope: "renderer" | "browser";
    readonly reasonCategory: string;
    readonly crashCount: number;
  };
  readonly "process.recovered": { readonly scope: "renderer" | "browser" };
  readonly "bridge.message": { readonly bridgeEnvelope: Readonly<Record<string, unknown>> };
  readonly "bridge.error": { readonly code: string };
  readonly "resource.state_changed": {
    readonly prior: "visible" | "warm" | "native_suspended" | "discarded";
    readonly next: "visible" | "warm" | "native_suspended" | "discarded";
    readonly reason: string;
  };
}

export type BrowserEventKind = keyof BrowserEventPayloadByKind;

export type BrowserEventEnvelope<K extends BrowserEventKind = BrowserEventKind> =
  K extends BrowserEventKind
    ? {
        readonly schemaVersion: typeof BROWSER_HOST_SCHEMA_VERSION;
        readonly kind: K;
        readonly panelId: string;
        readonly surfaceId: string;
        readonly generation: number;
        readonly sequence: number;
        readonly navigationId?: string;
        readonly occurredAt: string;
        readonly payload: BrowserEventPayloadByKind[K];
      }
    : never;

export interface BrowserEventCursor extends BrowserSurfaceRef {
  readonly lastSequence: number;
}

type Validator = (value: unknown, path: string) => void;

const commandValidators: Readonly<Record<BrowserCommandKind, Validator>> = {
  browser_create_surface: objectValidator(
    ["panelId", "generation", "profileMode", "initialUrl"],
    {
      panelId: idValidator,
      generation: generationValidator,
      profileMode: enumValidator(["persistent", "incognito"]),
      initialUrl: urlValidator,
    },
  ),
  browser_destroy_surface: surfaceRefValidator(),
  browser_set_bounds: surfaceRefValidator({ rect: rectValidator }),
  browser_set_visibility: surfaceRefValidator({
    visible: booleanValidator,
    reason: enumValidator(["active", "inactive_tab", "sidebar_closed", "window_hidden", "occluded"]),
  }),
  browser_navigate: surfaceRefValidator({ navigationId: idValidator, url: urlValidator }),
  browser_go_back: surfaceRefValidator(),
  browser_go_forward: surfaceRefValidator(),
  browser_reload: surfaceRefValidator({ mode: enumValidator(["normal", "ignore_cache"]) }),
  browser_stop: surfaceRefValidator(),
  browser_set_zoom: surfaceRefValidator({ factor: numberRangeValidator(0.5, 3) }),
  browser_set_resource_state: surfaceRefValidator({
    state: enumValidator(["visible", "warm", "native_suspended"]),
    reason: stringValidator(1, 128),
  }),
  browser_find: surfaceRefValidator({
    query: stringValidator(0, MAX_TEXT_LENGTH),
    matchCase: booleanValidator,
    backwards: booleanValidator,
  }),
  browser_stop_find: surfaceRefValidator(),
  browser_respond_permission: surfaceRefValidator({
    permissionRequestId: idValidator,
    origin: urlValidator,
    decision: enumValidator(["allow_once", "deny"]),
  }),
  browser_respond_download: surfaceRefValidator(
    {
      downloadId: idValidator,
      decision: enumValidator(["accept", "cancel"]),
      targetPath: optionalValidator(stringValidator(1, MAX_TEXT_LENGTH)),
    },
    ["targetPath"],
  ),
  browser_start_selection: surfaceRefValidator({
    selectionRequestId: idValidator,
    mode: enumValidator(["text", "element", "region"]),
  }),
  browser_configure_overlay: surfaceRefValidator({
    theme: enumValidator(["light", "dark"]),
    tokens: objectValidator(
      ["accent", "surface", "text", "border", "focus", "warning", "danger"],
      {
        accent: safeCssColorValidator,
        surface: safeCssColorValidator,
        text: safeCssColorValidator,
        border: safeCssColorValidator,
        focus: safeCssColorValidator,
        warning: safeCssColorValidator,
        danger: safeCssColorValidator,
      },
    ),
    radiusPx: numberRangeValidator(0, 32),
    motionMs: numberRangeValidator(0, 2_000),
    reducedMotion: booleanValidator,
  }),
  browser_cancel_selection: surfaceRefValidator(),
  browser_resolve_annotations: surfaceRefValidator({
    resolveRequestId: idValidator,
    targets: arrayValidator(
      objectValidator(["annotationId", "target"], {
        annotationId: idValidator,
        target: recordValidator,
      }),
      MAX_COLLECTION_SIZE,
    ),
  }),
  browser_render_highlights: surfaceRefValidator({
    resolutions: arrayValidator(
      objectValidator(["annotationId", "target", "state"], {
        annotationId: idValidator,
        target: recordValidator,
        state: enumValidator(["resolved", "changed"]),
      }),
      MAX_COLLECTION_SIZE,
    ),
  }),
  browser_clear_highlights: surfaceRefValidator({
    annotationIds: arrayValidator(idValidator, MAX_COLLECTION_SIZE),
  }),
  browser_navigate_to_annotation_target: surfaceRefValidator({
    annotationId: idValidator,
    target: recordValidator,
  }),
  browser_capture_region: captureRegionValidator,
  browser_discard_capture: surfaceRefValidator({ captureRequestId: idValidator }),
  browser_clear_profile_data: objectValidator(
    ["profileMode", "kinds", "timeRange"],
    {
      profileMode: enumValidator(["persistent", "incognito"]),
      kinds: arrayValidator(enumValidator(["cookies", "cache", "storage"]), 3),
      timeRange: enumValidator(["all", "last_hour", "last_day"]),
    },
  ),
};

export const BROWSER_COMMAND_KINDS = Object.freeze(
  Object.keys(commandValidators) as BrowserCommandKind[],
);

const eventValidators: Readonly<Record<BrowserEventKind, Validator>> = {
  "surface.ready": objectValidator(["profileMode", "capabilities"], {
    profileMode: enumValidator(["persistent", "incognito"]),
    capabilities: arrayValidator(stringValidator(1, 64), 32),
  }),
  "surface.destroyed": objectValidator(["reason"], { reason: stringValidator(1, 128) }),
  "navigation.started": navigationPayloadValidator(),
  "navigation.committed": navigationPayloadValidator(),
  "navigation.completed": navigationPayloadValidator(),
  "navigation.failed": navigationPayloadValidator({ errorCategory: stringValidator(1, 128) }),
  "page.title": objectValidator(["title"], { title: stringValidator(0, 4_096) }),
  "page.favicon": objectValidator(["faviconUrl"], { faviconUrl: nullableValidator(urlValidator) }),
  "page.source": objectValidator(["url"], { url: urlValidator }),
  "page.history": objectValidator(["canGoBack", "canGoForward"], {
    canGoBack: booleanValidator,
    canGoForward: booleanValidator,
  }),
  "page.loading": objectValidator(["loading"], { loading: booleanValidator }),
  "shortcut.requested": objectValidator(["shortcut"], {
    shortcut: enumValidator(["focus_address", "reload", "close_panel", "find"]),
  }),
  "new_window.requested": objectValidator(["url", "userGesture", "disposition"], {
    url: urlValidator,
    userGesture: booleanValidator,
    disposition: enumValidator(["tab", "window", "popup"]),
  }),
  "external_protocol.requested": objectValidator(["scheme", "target"], {
    scheme: stringValidator(1, 32),
    target: stringValidator(1, MAX_URL_LENGTH),
  }),
  "permission.requested": objectValidator(
    ["permissionRequestId", "origin", "permission", "deadline"],
    {
      permissionRequestId: idValidator,
      origin: urlValidator,
      permission: stringValidator(1, 128),
      deadline: dateValidator,
    },
  ),
  "permission.expired": objectValidator(["permissionRequestId"], { permissionRequestId: idValidator }),
  "download.requested": objectValidator(["downloadId", "url", "suggestedFilename", "totalBytes"], {
    downloadId: idValidator,
    url: urlValidator,
    suggestedFilename: stringValidator(1, 512),
    totalBytes: nullableValidator(nonNegativeIntegerValidator),
  }),
  "download.progress": objectValidator(["downloadId", "receivedBytes", "totalBytes"], {
    downloadId: idValidator,
    receivedBytes: nonNegativeIntegerValidator,
    totalBytes: nullableValidator(nonNegativeIntegerValidator),
  }),
  "download.completed": objectValidator(["downloadId", "stagedAssetId"], {
    downloadId: idValidator,
    stagedAssetId: idValidator,
  }),
  "download.failed": objectValidator(["downloadId", "errorCategory"], {
    downloadId: idValidator,
    errorCategory: stringValidator(1, 128),
  }),
  "capture.completed": objectValidator(["captureRequestId", "asset"], {
    captureRequestId: idValidator,
    asset: objectValidator(
      ["assetId", "kind", "mimeType", "width", "height", "byteLength", "sha256", "perceptualHash", "expiresAt"],
      {
        assetId: idValidator,
        kind: enumValidator(["staged", "managed_temp"]),
        mimeType: enumValidator(["image/png"]),
        width: positiveIntegerValidator,
        height: positiveIntegerValidator,
        byteLength: positiveIntegerValidator,
        sha256: sha256Validator,
        perceptualHash: perceptualHashValidator,
        expiresAt: dateValidator,
      },
    ),
  }),
  "capture.failed": objectValidator(["captureRequestId", "errorCategory"], {
    captureRequestId: idValidator,
    errorCategory: stringValidator(1, 128),
  }),
  "selection.result": objectValidator(["selectionRequestId", "frameKey", "target"], {
    selectionRequestId: idValidator,
    frameKey: idValidator,
    target: nativeElementTargetValidator,
  }),
  "selection.cancelled": objectValidator(["selectionRequestId", "reason"], {
    selectionRequestId: idValidator,
    reason: enumValidator(["user", "navigation", "surface_destroyed"]),
  }),
  "selection.failed": objectValidator(["selectionRequestId", "errorCategory", "message"], {
    selectionRequestId: idValidator,
    errorCategory: stringValidator(1, 128),
    message: stringValidator(1, 512),
  }),
  "process.failed": objectValidator(["scope", "reasonCategory", "crashCount"], {
    scope: enumValidator(["renderer", "browser"]),
    reasonCategory: stringValidator(1, 128),
    crashCount: nonNegativeIntegerValidator,
  }),
  "process.recovered": objectValidator(["scope"], { scope: enumValidator(["renderer", "browser"]) }),
  "bridge.message": objectValidator(["bridgeEnvelope"], { bridgeEnvelope: recordValidator }),
  "bridge.error": objectValidator(["code"], { code: stringValidator(1, 128) }),
  "resource.state_changed": objectValidator(["prior", "next", "reason"], {
    prior: enumValidator(["visible", "warm", "native_suspended", "discarded"]),
    next: enumValidator(["visible", "warm", "native_suspended", "discarded"]),
    reason: stringValidator(1, 128),
  }),
};

export function parseBrowserCommandEnvelope(value: unknown): BrowserCommandEnvelope {
  assertEnvelopeSize(value);
  const record = requireRecord(value, "command envelope");
  requireExactKeys(record, ["schemaVersion", "requestId", "command", "payload"], [], "command envelope");
  if (record.schemaVersion !== BROWSER_HOST_SCHEMA_VERSION) {
    throw new Error("browser command schema version is unsupported");
  }
  idValidator(record.requestId, "requestId");
  if (typeof record.command !== "string" || !(record.command in commandValidators)) {
    throw new Error("browser command kind is unsupported");
  }
  commandValidators[record.command as BrowserCommandKind](record.payload, "payload");
  return value as BrowserCommandEnvelope;
}

export function parseBrowserCommandResponse(value: unknown): BrowserCommandResponse {
  assertEnvelopeSize(value);
  const record = requireRecord(value, "command response");
  if (record.ok === true) {
    requireExactKeys(record, ["ok", "requestId"], [], "command response");
    idValidator(record.requestId, "requestId");
    return value as BrowserCommandResponse;
  }
  requireExactKeys(record, ["ok", "requestId", "error"], [], "command response");
  if (record.ok !== false) throw new Error("command response ok must be boolean");
  idValidator(record.requestId, "requestId");
  objectValidator(["code", "message", "retryable"], {
    code: enumValidator([
      "invalid_request",
      "unauthorized_caller",
      "surface_not_found",
      "stale_generation",
      "unsupported_operation",
      "policy_denied",
      "resource_limit",
      "host_failure",
    ]),
    message: stringValidator(1, 1_024),
    retryable: booleanValidator,
  })(record.error, "error");
  return value as BrowserCommandResponse;
}

export function parseBrowserEventEnvelope(value: unknown): BrowserEventEnvelope {
  assertEnvelopeSize(value);
  const record = requireRecord(value, "event envelope");
  requireExactKeys(
    record,
    ["schemaVersion", "kind", "panelId", "surfaceId", "generation", "sequence", "occurredAt", "payload"],
    ["navigationId"],
    "event envelope",
  );
  if (record.schemaVersion !== BROWSER_HOST_SCHEMA_VERSION) {
    throw new Error("browser event schema version is unsupported");
  }
  if (typeof record.kind !== "string" || !(record.kind in eventValidators)) {
    throw new Error("browser event kind is unsupported");
  }
  idValidator(record.panelId, "panelId");
  idValidator(record.surfaceId, "surfaceId");
  generationValidator(record.generation, "generation");
  nonNegativeIntegerValidator(record.sequence, "sequence");
  if (record.sequence === 0) throw new Error("sequence must be positive");
  dateValidator(record.occurredAt, "occurredAt");
  if (record.navigationId !== undefined) idValidator(record.navigationId, "navigationId");
  eventValidators[record.kind as BrowserEventKind](record.payload, "payload");
  return value as BrowserEventEnvelope;
}

export function eventBelongsToCursor(event: BrowserEventEnvelope, cursor: BrowserEventCursor): boolean {
  return event.panelId === cursor.panelId
    && event.surfaceId === cursor.surfaceId
    && event.generation === cursor.generation
    && event.sequence > cursor.lastSequence;
}

function assertEnvelopeSize(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("browser envelope is not serializable");
  }
  if (new TextEncoder().encode(serialized).byteLength > BROWSER_HOST_MAX_ENVELOPE_BYTES) {
    throw new Error("browser envelope exceeds the maximum size");
  }
}

function navigationPayloadValidator(extra: Readonly<Record<string, Validator>> = {}): Validator {
  return objectValidator(["url", "isMainFrame", ...Object.keys(extra)], {
    url: urlValidator,
    isMainFrame: booleanValidator,
    ...extra,
  });
}

function surfaceRefValidator(
  extra: Readonly<Record<string, Validator>> = {},
  optional: readonly string[] = [],
): Validator {
  return objectValidator(
    ["panelId", "surfaceId", "generation", ...Object.keys(extra).filter((key) => !optional.includes(key))],
    { panelId: idValidator, surfaceId: idValidator, generation: generationValidator, ...extra },
    optional,
  );
}

function rectValidator(value: unknown, path: string): void {
  objectValidator(["x", "y", "width", "height"], {
    x: finiteNumberValidator,
    y: finiteNumberValidator,
    width: numberRangeValidator(0, 100_000),
    height: numberRangeValidator(0, 100_000),
  })(value, path);
}

function captureRegionValidator(value: unknown, path: string): void {
  surfaceRefValidator({
    captureRequestId: idValidator,
    rect: rectValidator,
    viewport: objectValidator(["width", "height"], {
      width: numberRangeValidator(Number.EPSILON, 100_000),
      height: numberRangeValidator(Number.EPSILON, 100_000),
    }),
  })(value, path);
  const payload = value as BrowserCommandPayloadByKind["browser_capture_region"];
  const { rect, viewport } = payload;
  if (
    rect.x < 0
    || rect.y < 0
    || rect.width < 8
    || rect.height < 8
    || rect.width * rect.height < 256
    || rect.x + rect.width > viewport.width + 0.01
    || rect.y + rect.height > viewport.height + 0.01
  ) throw new Error(`${path}.rect is outside the capture viewport or below the minimum area`);
}

function nativeElementTargetValidator(value: unknown, path: string): void {
  const target = requireRecord(value, path);
  requireExactKeys(
    target,
    ["type", "tag", "stableAttributes", "path", "context", "rect", "frame"],
    ["role", "accessibleName", "textSummary", "shadowHostPath"],
    path,
  );
  if (target.type !== "element") throw new Error(`${path}.type is invalid`);
  stringValidator(1, 64)(target.tag, `${path}.tag`);
  if (target.tag !== (target.tag as string).toLowerCase()) throw new Error(`${path}.tag must be lowercase`);
  optionalValidator(stringValidator(1, 128))(target.role, `${path}.role`);
  optionalValidator(stringValidator(1, 1_024))(target.accessibleName, `${path}.accessibleName`);
  optionalValidator(stringValidator(1, 1_024))(target.textSummary, `${path}.textSummary`);
  arrayValidator(objectValidator(["name", "value"], {
    name: enumValidator(["id", "name", "type", "href", "src", "alt", "title", "aria-label", "role"]),
    value: stringValidator(0, 2_048),
  }), 20)(target.stableAttributes, `${path}.stableAttributes`);
  nativeDomPathValidator(target.path, `${path}.path`);
  if (target.shadowHostPath !== undefined) {
    nativeDomPathValidator(target.shadowHostPath, `${path}.shadowHostPath`);
  }
  objectValidator(["headingPath"], {
    headingPath: arrayValidator(stringValidator(0, 256), 16),
  })(target.context, `${path}.context`);
  rectValidator(target.rect, `${path}.rect`);
  const frame = requireRecord(target.frame, `${path}.frame`);
  requireExactKeys(frame, ["url", "indexPath"], ["name", "parentElementPath"], `${path}.frame`);
  urlValidator(frame.url, `${path}.frame.url`);
  arrayValidator(nonNegativeIntegerValidator, 32)(frame.indexPath, `${path}.frame.indexPath`);
  optionalValidator(stringValidator(0, 256))(frame.name, `${path}.frame.name`);
  if (frame.parentElementPath !== undefined) {
    nativeDomPathValidator(frame.parentElementPath, `${path}.frame.parentElementPath`);
  }
}

function nativeDomPathValidator(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new Error(`${path} is invalid`);
  }
  value.forEach((segment, index) => objectValidator(["childIndex", "shadowRoot"], {
    childIndex: nonNegativeIntegerValidator,
    shadowRoot: booleanValidator,
  })(segment, `${path}[${index}]`));
}

function sha256Validator(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`);
  }
}

function perceptualHashValidator(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^dhash64:[0-9a-f]{16}$/u.test(value)) {
    throw new Error(`${path} must be a lowercase dHash64 fingerprint`);
  }
}

function positiveIntegerValidator(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
}

function objectValidator(
  required: readonly string[],
  validators: Readonly<Record<string, Validator>>,
  optional: readonly string[] = [],
): Validator {
  return (value, path) => {
    const record = requireRecord(value, path);
    requireExactKeys(record, required, optional, path);
    for (const [key, validator] of Object.entries(validators)) {
      if (record[key] !== undefined || required.includes(key)) validator(record[key], `${path}.${key}`);
    }
  };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${path} fields are invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValidator(value: unknown, path: string): void {
  requireRecord(value, path);
}

function stringValidator(minLength: number, maxLength: number): Validator {
  return (value, path) => {
    if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
      throw new Error(`${path} is invalid`);
    }
  };
}

function idValidator(value: unknown, path: string): void {
  stringValidator(1, MAX_ID_LENGTH)(value, path);
}

function urlValidator(value: unknown, path: string): void {
  stringValidator(1, MAX_URL_LENGTH)(value, path);
}

function safeCssColorValidator(value: unknown, path: string): void {
  stringValidator(1, 128)(value, path);
  if (/[;{}'"\\]/.test(value as string) || /url\s*\(/i.test(value as string)) {
    throw new Error(`${path} must be a safe CSS color`);
  }
}

function booleanValidator(value: unknown, path: string): void {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
}

function finiteNumberValidator(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be finite`);
}

function nonNegativeIntegerValidator(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

function generationValidator(value: unknown, path: string): void {
  nonNegativeIntegerValidator(value, path);
  if (value === 0) throw new Error(`${path} must be positive`);
}

function numberRangeValidator(minimum: number, maximum: number): Validator {
  return (value, path) => {
    finiteNumberValidator(value, path);
    if ((value as number) < minimum || (value as number) > maximum) throw new Error(`${path} is out of range`);
  };
}

function enumValidator<T extends string>(values: readonly T[]): Validator {
  return (value, path) => {
    if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${path} is invalid`);
  };
}

function arrayValidator(itemValidator: Validator, maximum: number): Validator {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > maximum) throw new Error(`${path} is invalid`);
    value.forEach((item, index) => itemValidator(item, `${path}[${index}]`));
  };
}

function nullableValidator(validator: Validator): Validator {
  return (value, path) => {
    if (value !== null) validator(value, path);
  };
}

function optionalValidator(validator: Validator): Validator {
  return (value, path) => {
    if (value !== undefined) validator(value, path);
  };
}

function dateValidator(value: unknown, path: string): void {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${path} must be an ISO timestamp`);
  }
}
