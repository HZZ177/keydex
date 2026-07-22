import type { RuntimeBridge } from "@/runtime";
import type { AgentContextItem, AgentFileAttachment } from "@/types/protocol";
import { webAnnotationContextItemFromSnapshot } from "@/renderer/utils/messageInjection";

import { sanitizeBrowserRestoreUrl, sanitizeBrowserTitle } from "../../domain/browserNavigation";
import type { WebAnnotationTarget } from "../../runtime/bridgeProtocol";
import type { WebAnnotationTypedProperty } from "../api";
import type { WebAnnotationDraft } from "../state/WebAnnotationSession";
import {
  finalizeWebAnnotationContextSnapshot,
  sanitizeWebAnnotationTargetForAgent,
  type SelectedWebAnnotationReference,
  type UnfinalizedWebAnnotationContextSnapshot,
  type WebAnnotationContextSnapshot,
} from "./WebAnnotationContextAssembler";
import type { WebAnnotationReferencePresentation } from "./WebAnnotationReferencePresentationRegistry";

const INCOGNITO_REFERENCE_PREFIX = "incognito-web:";
const MAX_NOTE_BYTES = 8 * 1024;
const MAX_QUOTE_BYTES = 8 * 1024;
const MAX_PROPERTIES_BYTES = 16 * 1024;

export interface IncognitoWebReferenceRegistrationInput {
  readonly panelId: string;
  readonly title: string;
  readonly url: string;
  readonly draft: WebAnnotationDraft;
  readonly bodyMarkdown: string;
  readonly tags: readonly string[];
  readonly properties: readonly WebAnnotationTypedProperty[];
  readonly evidenceBlob?: Blob;
  readonly now?: string;
}

export interface IncognitoWebReferenceRegistration {
  readonly reference: SelectedWebAnnotationReference;
  readonly contextItem: AgentContextItem;
  readonly presentation: WebAnnotationReferencePresentation;
}

export interface IncognitoWebReferencePreparation {
  readonly contextItems: readonly AgentContextItem[];
  readonly attachments: readonly AgentFileAttachment[];
}

interface PreparedEntry {
  readonly contextItem: AgentContextItem;
  readonly attachment: AgentFileAttachment | null;
  readonly runtime: RuntimeBridge | null;
}

interface IncognitoWebReferenceEntry {
  readonly draftId: string;
  readonly reference: SelectedWebAnnotationReference;
  readonly snapshot: WebAnnotationContextSnapshot;
  readonly evidenceBlob: Blob | null;
  readonly preparations: Map<string, Promise<PreparedEntry>>;
  state: "active" | "acknowledged" | "discarded";
}

export class IncognitoWebReferenceRegistry {
  readonly #entries = new Map<string, IncognitoWebReferenceEntry>();

  get size(): number {
    return this.#entries.size;
  }

  async register(
    input: IncognitoWebReferenceRegistrationInput,
  ): Promise<IncognitoWebReferenceRegistration> {
    const existing = this.registrationForDraft(input.draft.draftId);
    if (existing) return existing;
    const capturedAt = input.now ?? new Date().toISOString();
    const annotationId = `${INCOGNITO_REFERENCE_PREFIX}${createId()}`;
    const sourceUrl = sanitizeBrowserRestoreUrl(input.url).restoreUrl;
    if (!sourceUrl) throw new Error("当前无痕页面地址不能作为网页引用发送");
    const target = input.draft.target;
    validateBudgets(input.bodyMarkdown, input.properties, target);
    const evidenceBlob = input.evidenceBlob ?? null;
    if (target.type === "region" && (!evidenceBlob || evidenceBlob.type !== "image/png")) {
      throw new Error("无痕区域引用缺少可用的临时截图");
    }
    if (target.type !== "region" && evidenceBlob) {
      throw new Error("只有区域引用可以携带临时截图");
    }
    const url = new URL(sourceUrl);
    const snapshot = await finalizeWebAnnotationContextSnapshot({
      schemaVersion: 1,
      type: "web_annotation",
      annotationId,
      annotationRevision: 1,
      capturedAt,
      source: {
        title: sanitizeBrowserTitle(input.title),
        url: sourceUrl,
        urlKey: await sha256Hex(sourceUrl),
        origin: url.origin,
      },
      target: {
        type: target.type,
        summary: targetSummary(target),
        resolution: "resolved",
        freshness: "current",
      },
      evidence: targetEvidence(target),
      perception: {
        originalTarget: sanitizeWebAnnotationTargetForAgent(target, url.origin),
        currentTarget: sanitizeWebAnnotationTargetForAgent(target, url.origin),
        resolution: {
          navigationId: null,
          frameRevision: null,
          frameKey: null,
          reason: "user_selected",
          settledAt: capturedAt,
          candidateIds: [],
          change: {
            kinds: [],
            materialKinds: [],
            signals: [],
            material: false,
          },
          evidence: {
            strategy: target.type === "text"
              ? "dom_range"
              : target.type === "element"
                ? "stable_dom_path"
                : target.relativeElement
                  ? "relative_region"
                  : "coordinate_only_region",
            score: 1,
            rects: target.type === "text"
              ? target.rects.map((rect) => ({ ...rect }))
              : [{ ...target.rect }],
            candidateCount: 1,
            truncated: false,
            changedSignals: [],
          },
        },
      },
      annotation: {
        bodyMarkdown: input.bodyMarkdown.trim(),
        tags: [...input.tags].sort((left, right) => left.localeCompare(right)),
        properties: input.properties.map(sanitizeProperty).sort(propertyOrder),
      },
    });
    const reference: SelectedWebAnnotationReference = Object.freeze({
      annotationId,
      selectedRevision: 1,
      selectedAt: capturedAt,
      sourcePanelId: input.panelId,
    });
    this.#entries.set(annotationId, {
      draftId: input.draft.draftId,
      reference,
      snapshot,
      evidenceBlob,
      preparations: new Map(),
      state: "active",
    });
    return {
      reference,
      contextItem: incognitoContextItem(snapshot),
      presentation: presentation(snapshot),
    };
  }

  registrationForDraft(draftId: string): IncognitoWebReferenceRegistration | null {
    const entry = [...this.#entries.values()].find((item) => item.draftId === draftId);
    if (!entry) return null;
    return {
      reference: entry.reference,
      contextItem: incognitoContextItem(entry.snapshot),
      presentation: presentation(entry.snapshot),
    };
  }

  async prepare(
    references: readonly SelectedWebAnnotationReference[],
    runtime: RuntimeBridge,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<IncognitoWebReferencePreparation> {
    assertNotAborted(signal);
    const prepared = await Promise.all(references.map((reference) => {
      const entry = this.#entries.get(reference.annotationId);
      if (!entry || reference.selectedRevision !== entry.reference.selectedRevision) {
        throw new Error("无痕网页引用已过期，请重新选择后发送");
      }
      const key = sessionId.trim();
      if (!key) throw new Error("无痕网页引用必须绑定当前任务后才能发送");
      const cached = entry.preparations.get(key);
      if (cached) return cached;
      const operation = this.#prepareEntry(entry, runtime, key, signal).catch((error: unknown) => {
        if (entry.preparations.get(key) === operation) entry.preparations.delete(key);
        throw error;
      });
      entry.preparations.set(key, operation);
      return operation;
    }));
    assertNotAborted(signal);
    return Object.freeze({
      contextItems: Object.freeze(prepared.map((item) => item.contextItem)),
      attachments: Object.freeze(prepared.flatMap((item) => item.attachment ? [item.attachment] : [])),
    });
  }

  acknowledge(references: readonly SelectedWebAnnotationReference[]): void {
    for (const reference of references) {
      const entry = this.#entries.get(reference.annotationId);
      if (!entry) continue;
      entry.state = "acknowledged";
      this.#entries.delete(reference.annotationId);
    }
  }

  discard(annotationId: string): void {
    const entry = this.#entries.get(annotationId);
    if (entry) this.#discardEntry(annotationId, entry);
  }

  discardDraft(draftId: string): void {
    for (const [annotationId, entry] of this.#entries) {
      if (entry.draftId === draftId) this.#discardEntry(annotationId, entry);
    }
  }

  clear(): void {
    for (const [annotationId, entry] of this.#entries) {
      this.#discardEntry(annotationId, entry);
    }
  }

  async #prepareEntry(
    entry: IncognitoWebReferenceEntry,
    runtime: RuntimeBridge,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PreparedEntry> {
    if (!entry.evidenceBlob) {
      return { contextItem: incognitoContextItem(entry.snapshot), attachment: null, runtime: null };
    }
    assertNotAborted(signal);
    const record = await runtime.attachments.uploadImage(entry.evidenceBlob, {
      filename: "web-annotation.png",
      source: "web_annotation",
      sessionId,
    });
    const attachmentId = record.attachment_id || record.id;
    try {
      assertNotAborted(signal);
      const snapshot = await finalizeWebAnnotationContextSnapshot({
        ...withoutDigest(entry.snapshot),
        evidence: { ...entry.snapshot.evidence, attachmentId },
      });
      return {
        contextItem: incognitoContextItem(snapshot),
        attachment: Object.freeze({
          id: record.id,
          attachment_id: attachmentId,
          type: "image",
          source: "web_annotation",
          name: record.name,
          path: record.path,
          mime_type: record.mime_type,
          size: record.size,
        }),
        runtime,
      };
    } catch (error) {
      await cleanupUploadedAttachment(runtime, attachmentId);
      throw error;
    }
  }

  #discardEntry(annotationId: string, entry: IncognitoWebReferenceEntry): void {
    entry.state = "discarded";
    this.#entries.delete(annotationId);
    for (const preparation of new Set(entry.preparations.values())) {
      void preparation
        .then((prepared) => cleanupPreparedEntry(prepared))
        .catch(() => undefined);
    }
  }
}

export const incognitoWebReferenceRegistry = new IncognitoWebReferenceRegistry();

export function isIncognitoWebAnnotationId(annotationId: string): boolean {
  return annotationId.startsWith(INCOGNITO_REFERENCE_PREFIX);
}

function incognitoContextItem(snapshot: WebAnnotationContextSnapshot): AgentContextItem {
  const item = webAnnotationContextItemFromSnapshot(snapshot);
  return Object.freeze({
    ...item,
    label: `无痕网页引用 · ${snapshot.source.title || snapshot.source.origin}`,
    metadata: Object.freeze({ ...item.metadata, incognito_source: true }),
  });
}

function presentation(snapshot: WebAnnotationContextSnapshot): WebAnnotationReferencePresentation {
  return Object.freeze({
    annotationId: snapshot.annotationId,
    title: snapshot.source.title,
    summary: snapshot.target.summary,
    bodyMarkdown: snapshot.annotation.bodyMarkdown,
    origin: snapshot.source.origin,
    status: "resolved",
    updatedAt: snapshot.capturedAt,
  });
}

function targetEvidence(target: WebAnnotationTarget): UnfinalizedWebAnnotationContextSnapshot["evidence"] {
  if (target.type === "text") return { originalQuote: target.quote.exact };
  if (target.type === "element") {
    return {
      ...(target.role ? { elementRole: target.role } : {}),
      ...(target.accessibleName ? { elementName: target.accessibleName } : {}),
    };
  }
  return {};
}

function targetSummary(target: WebAnnotationTarget): string {
  if (target.type === "text") return target.quote.exact;
  if (target.type === "element") return target.accessibleName || target.textSummary || `<${target.tag}>`;
  return `页面区域 ${Math.round(target.rect.width)} × ${Math.round(target.rect.height)}`;
}

function validateBudgets(
  bodyMarkdown: string,
  properties: readonly WebAnnotationTypedProperty[],
  target: WebAnnotationTarget,
): void {
  if (!bodyMarkdown.trim()) throw new Error("网页引用说明不能为空");
  if (utf8Size(bodyMarkdown) > MAX_NOTE_BYTES) throw new Error("网页引用说明超过 8 KiB，请缩减后重试");
  if (target.type === "text" && utf8Size(target.quote.exact) > MAX_QUOTE_BYTES) {
    throw new Error("所选网页文字超过 8 KiB，请缩短选择范围");
  }
  if (utf8Size(JSON.stringify(properties)) > MAX_PROPERTIES_BYTES) {
    throw new Error("结构化属性超过 16 KiB，请缩减后重试");
  }
}

function sanitizeProperty(property: WebAnnotationTypedProperty): WebAnnotationTypedProperty {
  if (property.type !== "url") return { ...property };
  return {
    ...property,
    value: sanitizeBrowserRestoreUrl(property.value).restoreUrl ?? "[无效或不安全的 URL]",
  };
}

function propertyOrder(left: WebAnnotationTypedProperty, right: WebAnnotationTypedProperty): number {
  return left.key.localeCompare(right.key)
    || left.type.localeCompare(right.type)
    || String(left.value).localeCompare(String(right.value));
}

function withoutDigest(
  snapshot: WebAnnotationContextSnapshot,
): UnfinalizedWebAnnotationContextSnapshot {
  const { digest: _digest, ...rest } = snapshot;
  return rest;
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("无法生成无痕网页引用摘要");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

async function cleanupPreparedEntry(prepared: PreparedEntry): Promise<void> {
  const attachmentId = prepared.attachment?.attachment_id || prepared.attachment?.id;
  if (!attachmentId || !prepared.runtime) return;
  await cleanupUploadedAttachment(prepared.runtime, attachmentId);
}

async function cleanupUploadedAttachment(runtime: RuntimeBridge, attachmentId: string): Promise<void> {
  try {
    await runtime.attachments.deleteUnreferencedWebAnnotation(attachmentId);
  } catch {
    console.warn("[IncognitoWebReference] Failed to clean abandoned attachment", {
      attachmentId,
    });
  }
}
