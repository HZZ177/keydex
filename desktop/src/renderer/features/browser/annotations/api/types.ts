import type { BrowserProfileMode } from "../../domain";
import type { WebAnnotationTarget } from "../../runtime";

export type WebAnnotationScopeKind = "session" | "workspace" | "global";
export type WebAnnotationSourceKind = "web" | "local_file";

export interface WebAnnotationScope {
  readonly kind: WebAnnotationScopeKind;
  readonly id: string | null;
}

export interface WebAnnotationSource {
  readonly sourceKind?: WebAnnotationSourceKind;
  readonly url: string;
  readonly title: string;
  readonly canonicalUrl?: string | null;
  readonly profileMode: BrowserProfileMode;
}

export type WebAnnotationTypedProperty =
  | { readonly key: string; readonly type: "text"; readonly value: string }
  | { readonly key: string; readonly type: "number"; readonly value: number }
  | { readonly key: string; readonly type: "boolean"; readonly value: boolean }
  | { readonly key: string; readonly type: "date"; readonly value: string }
  | { readonly key: string; readonly type: "url"; readonly value: string };

export interface WebAnnotationResourceRecord {
  readonly id: string;
  readonly scope: WebAnnotationScope;
  readonly sourceKind?: WebAnnotationSourceKind;
  readonly normalizationVersion: 1 | 2;
  readonly urlKey: string;
  readonly urlNormalized: string;
  readonly documentUrl: string;
  readonly canonicalUrl: string | null;
  readonly origin: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebAnnotationRecord {
  readonly id: string;
  readonly resourceId: string;
  readonly targetSchemaVersion: 1;
  readonly target: WebAnnotationTarget;
  readonly bodyMarkdown: string;
  readonly tags: readonly string[];
  readonly properties: readonly WebAnnotationTypedProperty[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebAnnotationTargetHistoryRecord {
  readonly id: string;
  readonly annotationId: string;
  readonly priorRevision: number;
  readonly targetSchemaVersion: 1;
  readonly target: WebAnnotationTarget;
  readonly reason: "user_retarget" | "migration";
  readonly createdAt: string;
}

export interface WebAnnotationAssetRecord {
  readonly id: string;
  readonly resourceId: string;
  readonly annotationId: string | null;
  readonly assetKind: "region_screenshot";
  readonly state: "staged" | "attached";
  readonly storagePath: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebAnnotationItem {
  readonly resource: WebAnnotationResourceRecord;
  readonly annotation: WebAnnotationRecord;
}

export interface WebAnnotationDetail extends WebAnnotationItem {
  readonly targetHistory: readonly WebAnnotationTargetHistoryRecord[];
  readonly assets: readonly WebAnnotationAssetRecord[];
}

export interface WebAnnotationPage {
  readonly items: readonly WebAnnotationItem[];
  readonly nextCursor: string | null;
}

export interface WebAnnotationListInput {
  readonly scope: WebAnnotationScope;
  readonly sourceKind?: WebAnnotationSourceKind;
  readonly url?: string;
  readonly documentUrl?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface WebAnnotationCreateInput {
  readonly scope: WebAnnotationScope;
  readonly source: WebAnnotationSource;
  readonly target: WebAnnotationTarget;
  readonly bodyMarkdown: string;
  readonly tags?: readonly string[];
  readonly properties?: readonly WebAnnotationTypedProperty[];
  readonly stagedAssetIds?: readonly string[];
}

export interface WebAnnotationPatchInput {
  readonly expectedRevision: number;
  readonly bodyMarkdown?: string;
  readonly tags?: readonly string[];
  readonly properties?: readonly WebAnnotationTypedProperty[];
}

export interface WebAnnotationRetargetInput {
  readonly expectedRevision: number;
  readonly target: WebAnnotationTarget;
  readonly stagedAssetIds?: readonly string[];
}

export interface WebAnnotationAssetRegistrationInput {
  readonly scope: WebAnnotationScope;
  readonly source: WebAnnotationSource;
  readonly asset: {
    readonly assetId: string;
    readonly kind: "staged";
    readonly mimeType: "image/png";
    readonly width: number;
    readonly height: number;
    readonly byteLength: number;
    readonly sha256: string;
    readonly expiresAt: string;
  };
}

export interface WebAnnotationEvidenceCloneInput {
  readonly sessionId: string;
  readonly contextDigest: string;
  readonly signal?: AbortSignal;
}

export interface WebAnnotationMessageAttachment {
  readonly id: string;
  readonly attachmentId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly type: "image";
  readonly source: "web_annotation";
  readonly name: string;
  readonly path: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly size: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebAnnotationEvidenceCloneResult {
  readonly schemaVersion: 1;
  readonly annotationId: string;
  readonly assetId: string;
  readonly contextDigest: string;
  readonly reused: boolean;
  readonly attachment: WebAnnotationMessageAttachment;
}

export type WebAnnotationMutationResult =
  | { readonly status: "saved"; readonly detail: WebAnnotationDetail }
  | {
      readonly status: "conflict";
      readonly current: WebAnnotationItem;
      readonly expectedRevision: number;
    };
