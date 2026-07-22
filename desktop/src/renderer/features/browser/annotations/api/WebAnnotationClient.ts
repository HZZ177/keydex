import { isRuntimeHttpError } from "@/runtime";
import type { HttpClient } from "@/runtime/httpClient";

import type {
  DomPath,
  PersistedFrameLocator,
  WebAnnotationTarget,
} from "../../runtime";
import type {
  WebAnnotationAssetRecord,
  WebAnnotationAssetRegistrationInput,
  WebAnnotationCreateInput,
  WebAnnotationDetail,
  WebAnnotationEvidenceCloneInput,
  WebAnnotationEvidenceCloneResult,
  WebAnnotationItem,
  WebAnnotationListInput,
  WebAnnotationPage,
  WebAnnotationPatchInput,
  WebAnnotationResourceRecord,
  WebAnnotationRetargetInput,
  WebAnnotationScope,
  WebAnnotationSource,
  WebAnnotationTargetHistoryRecord,
  WebAnnotationTypedProperty,
} from "./types";

export interface WebAnnotationClient {
  list(input: WebAnnotationListInput): Promise<WebAnnotationPage>;
  get(annotationId: string, signal?: AbortSignal): Promise<WebAnnotationDetail>;
  create(input: WebAnnotationCreateInput): Promise<WebAnnotationDetail>;
  patch(annotationId: string, input: WebAnnotationPatchInput): Promise<WebAnnotationDetail>;
  retarget(annotationId: string, input: WebAnnotationRetargetInput): Promise<WebAnnotationDetail>;
  delete(annotationId: string): Promise<void>;
  registerAsset(input: WebAnnotationAssetRegistrationInput): Promise<WebAnnotationAssetRecord>;
  discardAsset(assetId: string): Promise<void>;
  cloneEvidence(
    annotationId: string,
    assetId: string,
    input: WebAnnotationEvidenceCloneInput,
  ): Promise<WebAnnotationEvidenceCloneResult>;
}

export function createWebAnnotationClient(http: HttpClient): WebAnnotationClient {
  return {
    async list(input) {
      const response = await http.request<ApiWebAnnotationPage>(
        `/api/web-annotations?${listSearchParams(input).toString()}`,
        { signal: input.signal },
      );
      return fromApiPage(response);
    },
    async get(annotationId, signal) {
      const response = await http.request<ApiWebAnnotationDetail>(annotationPath(annotationId), {
        signal,
      });
      return fromApiDetail(response);
    },
    async create(input) {
      const response = await http.request<ApiWebAnnotationDetail>("/api/web-annotations", {
        method: "POST",
        body: {
          schema_version: 1,
          scope: input.scope,
          source: toApiSource(input.source),
          target: toApiTarget(input.target),
          body_markdown: input.bodyMarkdown,
          tags: input.tags ?? [],
          properties: input.properties ?? [],
          staged_asset_ids: input.stagedAssetIds ?? [],
        },
      });
      return fromApiDetail(response);
    },
    async patch(annotationId, input) {
      const response = await http.request<ApiWebAnnotationDetail>(annotationPath(annotationId), {
        method: "PATCH",
        headers: { "If-Match": String(input.expectedRevision) },
        body: {
          schema_version: 1,
          expected_revision: input.expectedRevision,
          ...(input.bodyMarkdown === undefined ? {} : { body_markdown: input.bodyMarkdown }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.properties === undefined ? {} : { properties: input.properties }),
        },
      });
      return fromApiDetail(response);
    },
    async retarget(annotationId, input) {
      const response = await http.request<ApiWebAnnotationDetail>(
        `${annotationPath(annotationId)}/target`,
        {
          method: "PUT",
          headers: { "If-Match": String(input.expectedRevision) },
          body: {
            schema_version: 1,
            expected_revision: input.expectedRevision,
            target: toApiTarget(input.target),
            reason: "user_retarget",
            staged_asset_ids: input.stagedAssetIds ?? [],
          },
        },
      );
      return fromApiDetail(response);
    },
    delete(annotationId) {
      return http.request<void>(annotationPath(annotationId), { method: "DELETE" });
    },
    async registerAsset(input) {
      const response = await http.request<ApiWebAnnotationAssetRecord>(
        "/api/web-annotations/assets",
        {
          method: "POST",
          body: {
            schema_version: 1,
            scope: input.scope,
            source: toApiSource(input.source),
            asset: {
              asset_id: input.asset.assetId,
              kind: input.asset.kind,
              mime_type: input.asset.mimeType,
              width: input.asset.width,
              height: input.asset.height,
              byte_length: input.asset.byteLength,
              sha256: input.asset.sha256,
              expires_at: input.asset.expiresAt,
            },
          },
        },
      );
      return fromApiAsset(response);
    },
    discardAsset(assetId) {
      return http.request<void>(`/api/web-annotations/assets/${encodeURIComponent(assetId)}`, {
        method: "DELETE",
      });
    },
    async cloneEvidence(annotationId, assetId, input) {
      const response = await http.request<ApiWebAnnotationEvidenceCloneResult>(
        `${annotationPath(annotationId)}/evidence/${encodeURIComponent(assetId)}/message-attachment`,
        {
          method: "POST",
          signal: input.signal,
          body: {
            schema_version: 1,
            session_id: input.sessionId,
            context_digest: input.contextDigest,
          },
        },
      );
      return fromApiEvidenceClone(response);
    },
  };
}

export function readWebAnnotationConflict(error: unknown): {
  readonly expectedRevision: number;
  readonly current: WebAnnotationItem;
} | null {
  if (!isRuntimeHttpError(error) || error.code !== "web_annotation_revision_conflict") return null;
  const expectedRevision = error.details.expected_revision;
  const current = error.details.current;
  if (typeof expectedRevision !== "number" || !isRecord(current)) return null;
  try {
    return {
      expectedRevision,
      current: fromApiItem(current as unknown as ApiWebAnnotationItem),
    };
  } catch {
    return null;
  }
}

function listSearchParams(input: WebAnnotationListInput): URLSearchParams {
  const params = new URLSearchParams({ scope_kind: input.scope.kind });
  if (input.scope.kind === "global") {
    if (input.scope.id !== null) throw new Error("Global web annotation scope cannot have an id");
  } else {
    const scopeId = input.scope.id?.trim();
    if (!scopeId) throw new Error(`${input.scope.kind} web annotation scope requires an id`);
    params.set("scope_id", scopeId);
  }
  if (input.url !== undefined) params.set("url", input.url);
  if (input.documentUrl !== undefined) params.set("document_url", input.documentUrl);
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  params.set("limit", String(input.limit ?? 100));
  return params;
}

function annotationPath(annotationId: string): string {
  const normalized = annotationId.trim();
  if (!normalized) throw new Error("Web annotation id is required");
  return `/api/web-annotations/${encodeURIComponent(normalized)}`;
}

function toApiSource(source: WebAnnotationSource): ApiWebAnnotationSource {
  return {
    url: source.url,
    title: source.title,
    canonical_url: source.canonicalUrl ?? null,
    profile_mode: source.profileMode,
  };
}

function toApiTarget(target: WebAnnotationTarget): ApiWebAnnotationTarget {
  const frame = toApiFrame(target.frame);
  switch (target.type) {
    case "text":
      return {
        type: "text",
        quote: target.quote,
        position: target.position
          ? {
              start: target.position.start,
              end: target.position.end,
              text_model_version: target.position.textModelVersion,
            }
          : null,
        dom_range: target.domRange
          ? {
              start_path: toApiPath(target.domRange.startPath),
              start_offset: target.domRange.startOffset,
              end_path: toApiPath(target.domRange.endPath),
              end_offset: target.domRange.endOffset,
            }
          : null,
        context: {
          heading_path: target.context.headingPath,
          container_role: target.context.containerRole ?? null,
          container_text_digest: target.context.containerTextDigest ?? null,
        },
        rects: target.rects,
        frame,
      };
    case "element":
      return {
        type: "element",
        tag: target.tag,
        role: target.role ?? null,
        accessible_name: target.accessibleName ?? null,
        text_summary: target.textSummary ?? null,
        stable_attributes: target.stableAttributes,
        path: toApiPath(target.path),
        shadow_host_path: target.shadowHostPath ? toApiPath(target.shadowHostPath) : null,
        context: { heading_path: target.context.headingPath },
        rect: target.rect,
        frame,
      };
    case "region":
      return {
        type: "region",
        rect: target.rect,
        viewport: target.viewport,
        scroll: target.scroll,
        relative_element: target.relativeElement
          ? {
              path: toApiPath(target.relativeElement.path),
              rect: target.relativeElement.rect,
              tag: target.relativeElement.tag ?? null,
              role: target.relativeElement.role ?? null,
              accessible_name: target.relativeElement.accessibleName ?? null,
              text_summary: target.relativeElement.textSummary ?? null,
              stable_attributes: target.relativeElement.stableAttributes ?? [],
            }
          : null,
        visual: target.visual
          ? {
              fingerprint_version: target.visual.fingerprintVersion,
              local_digest: target.visual.localDigest,
              perceptual_hash: target.visual.perceptualHash ?? null,
            }
          : null,
        frame,
      };
  }
}

function fromApiTarget(target: ApiWebAnnotationTarget): WebAnnotationTarget {
  const frame = fromApiFrame(target.frame);
  switch (target.type) {
    case "text":
      return {
        type: "text",
        quote: target.quote,
        ...(target.position
          ? {
              position: {
                start: target.position.start,
                end: target.position.end,
                textModelVersion: target.position.text_model_version,
              },
            }
          : {}),
        ...(target.dom_range
          ? {
              domRange: {
                startPath: fromApiPath(target.dom_range.start_path),
                startOffset: target.dom_range.start_offset,
                endPath: fromApiPath(target.dom_range.end_path),
                endOffset: target.dom_range.end_offset,
              },
            }
          : {}),
        context: {
          headingPath: target.context.heading_path,
          ...(target.context.container_role === null
            ? {}
            : { containerRole: target.context.container_role }),
          ...(target.context.container_text_digest === null
            ? {}
            : { containerTextDigest: target.context.container_text_digest }),
        },
        rects: target.rects,
        frame,
      };
    case "element":
      return {
        type: "element",
        tag: target.tag,
        ...(target.role === null ? {} : { role: target.role }),
        ...(target.accessible_name === null ? {} : { accessibleName: target.accessible_name }),
        ...(target.text_summary === null ? {} : { textSummary: target.text_summary }),
        stableAttributes: target.stable_attributes,
        path: fromApiPath(target.path),
        ...(target.shadow_host_path
          ? { shadowHostPath: fromApiPath(target.shadow_host_path) }
          : {}),
        context: { headingPath: target.context.heading_path },
        rect: target.rect,
        frame,
      };
    case "region":
      return {
        type: "region",
        rect: target.rect,
        viewport: target.viewport,
        scroll: target.scroll,
        ...(target.relative_element
          ? {
              relativeElement: {
                path: fromApiPath(target.relative_element.path),
                rect: target.relative_element.rect,
                ...(target.relative_element.tag == null ? {} : { tag: target.relative_element.tag }),
                ...(target.relative_element.role == null ? {} : { role: target.relative_element.role }),
                ...(target.relative_element.accessible_name == null
                  ? {}
                  : { accessibleName: target.relative_element.accessible_name }),
                ...(target.relative_element.text_summary == null
                  ? {}
                  : { textSummary: target.relative_element.text_summary }),
                ...((target.relative_element.stable_attributes?.length ?? 0) === 0
                  ? {}
                  : { stableAttributes: target.relative_element.stable_attributes }),
              },
            }
          : {}),
        ...(target.visual
          ? {
              visual: {
                fingerprintVersion: target.visual.fingerprint_version,
                localDigest: target.visual.local_digest,
                ...(target.visual.perceptual_hash === null
                  ? {}
                  : { perceptualHash: target.visual.perceptual_hash }),
              },
            }
          : {}),
        frame,
      };
  }
}

function toApiFrame(frame: PersistedFrameLocator): ApiPersistedFrameLocator {
  return {
    url: frame.url,
    name: frame.name ?? null,
    index_path: frame.indexPath,
    parent_element_path: frame.parentElementPath ? toApiPath(frame.parentElementPath) : null,
  };
}

function fromApiFrame(frame: ApiPersistedFrameLocator): PersistedFrameLocator {
  return {
    url: frame.url,
    ...(frame.name === null ? {} : { name: frame.name }),
    indexPath: frame.index_path,
    ...(frame.parent_element_path
      ? { parentElementPath: fromApiPath(frame.parent_element_path) }
      : {}),
  };
}

function toApiPath(path: DomPath): ApiDomPath {
  return path.map((segment) => ({
    child_index: segment.childIndex,
    shadow_root: segment.shadowRoot,
  }));
}

function fromApiPath(path: ApiDomPath): DomPath {
  return path.map((segment) => ({
    childIndex: segment.child_index,
    shadowRoot: segment.shadow_root,
  }));
}

function fromApiPage(page: ApiWebAnnotationPage): WebAnnotationPage {
  return Object.freeze({
    items: Object.freeze(page.items.map(fromApiItem)),
    nextCursor: page.next_cursor,
  });
}

function fromApiDetail(detail: ApiWebAnnotationDetail): WebAnnotationDetail {
  return Object.freeze({
    ...fromApiItem(detail),
    targetHistory: Object.freeze(detail.target_history.map(fromApiHistory)),
    assets: Object.freeze(detail.assets.map(fromApiAsset)),
  });
}

function fromApiItem(item: ApiWebAnnotationItem): WebAnnotationItem {
  return Object.freeze({
    resource: fromApiResource(item.resource),
    annotation: Object.freeze({
      id: item.annotation.id,
      resourceId: item.annotation.resource_id,
      targetSchemaVersion: item.annotation.target_schema_version,
      target: fromApiTarget(item.annotation.target),
      bodyMarkdown: item.annotation.body_markdown,
      tags: Object.freeze([...item.annotation.tags]),
      properties: Object.freeze([...item.annotation.properties]),
      revision: item.annotation.revision,
      createdAt: item.annotation.created_at,
      updatedAt: item.annotation.updated_at,
    }),
  });
}

function fromApiResource(resource: ApiWebAnnotationResourceRecord): WebAnnotationResourceRecord {
  return Object.freeze({
    id: resource.id,
    scope: Object.freeze({ ...resource.scope }),
    normalizationVersion: resource.normalization_version,
    urlKey: resource.url_key,
    urlNormalized: resource.url_normalized,
    documentUrl: resource.document_url,
    canonicalUrl: resource.canonical_url,
    origin: resource.origin,
    title: resource.title,
    createdAt: resource.created_at,
    updatedAt: resource.updated_at,
  });
}

function fromApiHistory(history: ApiWebAnnotationTargetHistoryRecord): WebAnnotationTargetHistoryRecord {
  return Object.freeze({
    id: history.id,
    annotationId: history.annotation_id,
    priorRevision: history.prior_revision,
    targetSchemaVersion: history.target_schema_version,
    target: fromApiTarget(history.target),
    reason: history.reason,
    createdAt: history.created_at,
  });
}

function fromApiAsset(asset: ApiWebAnnotationAssetRecord): WebAnnotationAssetRecord {
  return Object.freeze({
    id: asset.id,
    resourceId: asset.resource_id,
    annotationId: asset.annotation_id,
    assetKind: asset.asset_kind,
    state: asset.state,
    storagePath: asset.storage_path,
    mimeType: asset.mime_type,
    sizeBytes: asset.size_bytes,
    sha256: asset.sha256,
    width: asset.width,
    height: asset.height,
    expiresAt: asset.expires_at,
    createdAt: asset.created_at,
    updatedAt: asset.updated_at,
  });
}

function fromApiEvidenceClone(
  result: ApiWebAnnotationEvidenceCloneResult,
): WebAnnotationEvidenceCloneResult {
  const attachment = result.attachment;
  return Object.freeze({
    schemaVersion: result.schema_version,
    annotationId: result.annotation_id,
    assetId: result.asset_id,
    contextDigest: result.context_digest,
    reused: result.reused,
    attachment: Object.freeze({
      id: attachment.id,
      attachmentId: attachment.attachment_id,
      sessionId: attachment.session_id,
      userId: attachment.user_id,
      type: attachment.type,
      source: attachment.source,
      name: attachment.name,
      path: attachment.path,
      mimeType: attachment.mime_type,
      size: attachment.size,
      createdAt: attachment.created_at,
      updatedAt: attachment.updated_at,
    }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type ApiDomPath = readonly { readonly child_index: number; readonly shadow_root: boolean }[];

interface ApiPersistedFrameLocator {
  readonly url: string;
  readonly name: string | null;
  readonly index_path: readonly number[];
  readonly parent_element_path: ApiDomPath | null;
}

type ApiWebAnnotationTarget =
  | {
      readonly type: "text";
      readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
      readonly position: {
        readonly start: number;
        readonly end: number;
        readonly text_model_version: 1;
      } | null;
      readonly dom_range: {
        readonly start_path: ApiDomPath;
        readonly start_offset: number;
        readonly end_path: ApiDomPath;
        readonly end_offset: number;
      } | null;
      readonly context: {
        readonly heading_path: readonly string[];
        readonly container_role: string | null;
        readonly container_text_digest: string | null;
      };
      readonly rects: readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
      readonly frame: ApiPersistedFrameLocator;
    }
  | {
      readonly type: "element";
      readonly tag: string;
      readonly role: string | null;
      readonly accessible_name: string | null;
      readonly text_summary: string | null;
      readonly stable_attributes: readonly {
        readonly name: "id" | "name" | "type" | "href" | "src" | "alt" | "title" | "aria-label" | "role";
        readonly value: string;
      }[];
      readonly path: ApiDomPath;
      readonly shadow_host_path: ApiDomPath | null;
      readonly context: { readonly heading_path: readonly string[] };
      readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
      readonly frame: ApiPersistedFrameLocator;
    }
  | {
      readonly type: "region";
      readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
      readonly viewport: { readonly width: number; readonly height: number };
      readonly scroll: { readonly x: number; readonly y: number };
      readonly relative_element: {
        readonly path: ApiDomPath;
        readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
        readonly tag: string | null;
        readonly role: string | null;
        readonly accessible_name: string | null;
        readonly text_summary: string | null;
        readonly stable_attributes: readonly {
          readonly name: "id" | "name" | "type" | "href" | "src" | "alt" | "title" | "aria-label" | "role";
          readonly value: string;
        }[];
      } | null;
      readonly visual: {
        readonly fingerprint_version: 1;
        readonly local_digest: string;
        readonly perceptual_hash: string | null;
      } | null;
      readonly frame: ApiPersistedFrameLocator;
    };

interface ApiWebAnnotationSource {
  readonly url: string;
  readonly title: string;
  readonly canonical_url: string | null;
  readonly profile_mode: "persistent" | "incognito";
}

interface ApiWebAnnotationResourceRecord {
  readonly id: string;
  readonly scope: WebAnnotationScope;
  readonly normalization_version: 1;
  readonly url_key: string;
  readonly url_normalized: string;
  readonly document_url: string;
  readonly canonical_url: string | null;
  readonly origin: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ApiWebAnnotationRecord {
  readonly id: string;
  readonly resource_id: string;
  readonly target_schema_version: 1;
  readonly target: ApiWebAnnotationTarget;
  readonly body_markdown: string;
  readonly tags: readonly string[];
  readonly properties: readonly WebAnnotationTypedProperty[];
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ApiWebAnnotationItem {
  readonly resource: ApiWebAnnotationResourceRecord;
  readonly annotation: ApiWebAnnotationRecord;
}

interface ApiWebAnnotationTargetHistoryRecord {
  readonly id: string;
  readonly annotation_id: string;
  readonly prior_revision: number;
  readonly target_schema_version: 1;
  readonly target: ApiWebAnnotationTarget;
  readonly reason: "user_retarget" | "migration";
  readonly created_at: string;
}

interface ApiWebAnnotationAssetRecord {
  readonly id: string;
  readonly resource_id: string;
  readonly annotation_id: string | null;
  readonly asset_kind: "region_screenshot";
  readonly state: "staged" | "attached";
  readonly storage_path: string;
  readonly mime_type: "image/png" | "image/jpeg" | "image/webp";
  readonly size_bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ApiWebAnnotationDetail extends ApiWebAnnotationItem {
  readonly target_history: readonly ApiWebAnnotationTargetHistoryRecord[];
  readonly assets: readonly ApiWebAnnotationAssetRecord[];
}

interface ApiWebAnnotationEvidenceCloneResult {
  readonly schema_version: 1;
  readonly annotation_id: string;
  readonly asset_id: string;
  readonly context_digest: string;
  readonly reused: boolean;
  readonly attachment: {
    readonly id: string;
    readonly attachment_id: string;
    readonly session_id: string;
    readonly user_id: string;
    readonly type: "image";
    readonly source: "web_annotation";
    readonly name: string;
    readonly path: string;
    readonly mime_type: "image/png" | "image/jpeg" | "image/webp";
    readonly size: number;
    readonly created_at: string;
    readonly updated_at: string;
  };
}

interface ApiWebAnnotationPage {
  readonly items: readonly ApiWebAnnotationItem[];
  readonly next_cursor: string | null;
}
