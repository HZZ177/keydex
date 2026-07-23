import type { RuntimeBridge } from "@/runtime";
import type { AgentContextItem, AgentFileAttachment } from "@/types/protocol";
import { webAnnotationContextItemFromSnapshot } from "@/renderer/utils/messageInjection";

import { sanitizeBrowserRestoreUrl, sanitizeBrowserTitle } from "../../domain/browserNavigation";
import type { WebAnnotationTarget } from "../../runtime/bridgeProtocol";
import type { WebAnnotationTypedProperty } from "../api";
import type { WebAnnotationDraft } from "../state/WebAnnotationSession";
import {
  buildWebAnnotationEnvelopeAnchor,
  createWebAnnotationAnchorId,
  finalizeWebAnnotationContextSnapshot,
  sanitizeWebAnnotationTargetForAgent,
  type SelectedWebAnnotationReference,
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
}

interface IncognitoWebReferenceEntry {
  readonly draftId: string;
  readonly reference: SelectedWebAnnotationReference;
  readonly snapshot: WebAnnotationContextSnapshot;
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
    const url = new URL(sourceUrl);
    const urlKey = await sha256Hex(sourceUrl);
    const sanitizedTarget = sanitizeWebAnnotationTargetForAgent(target, url.origin);
    const snapshot = await finalizeWebAnnotationContextSnapshot({
      schemaVersion: 2,
      type: "web_annotation",
      reference: {
        annotationId,
        revision: 1,
        anchorId: await createWebAnnotationAnchorId(urlKey, sanitizedTarget),
        createdAt: capturedAt,
        assembledAt: capturedAt,
      },
      trust: {
        userComment: "user_instruction",
        pageEvidence: "untrusted_reference",
        hostObservation: "trusted_application_observation",
      },
      comment: {
        bodyMarkdown: input.bodyMarkdown.trim(),
        tags: [...input.tags].sort((left, right) => left.localeCompare(right)),
        properties: input.properties.map(sanitizeProperty).sort(propertyOrder),
      },
      page: {
        title: sanitizeBrowserTitle(input.title),
        documentUrl: sourceUrl,
        canonicalUrl: null,
        urlKey,
        origin: url.origin,
        frame: sanitizedTarget.frame,
      },
      anchor: buildWebAnnotationEnvelopeAnchor(sanitizedTarget),
      observation: {
        status: "exact",
        freshness: "live",
        observedAt: capturedAt,
        match: {
          strategy: target.type === "text"
            ? "dom_range"
            : target.type === "element"
              ? "stable_dom_path"
              : target.relativeElement
                ? "relative_region"
                : "coordinate_only_region",
          confidence: 1,
          candidateCount: 1,
        },
        currentTarget: sanitizedTarget,
        changes: {
          kinds: [],
          materialKinds: [],
          signals: [],
          material: false,
        },
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
    _runtime: RuntimeBridge,
    _sessionId: string,
    signal?: AbortSignal,
  ): Promise<PreparedEntry> {
    assertNotAborted(signal);
    return { contextItem: incognitoContextItem(entry.snapshot), attachment: null };
  }

  #discardEntry(annotationId: string, entry: IncognitoWebReferenceEntry): void {
    entry.state = "discarded";
    this.#entries.delete(annotationId);
    entry.preparations.clear();
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
    label: `无痕网页引用 · ${snapshot.page.title || snapshot.page.origin}`,
    metadata: Object.freeze({ ...item.metadata, incognito_source: true }),
  });
}

function presentation(snapshot: WebAnnotationContextSnapshot): WebAnnotationReferencePresentation {
  return Object.freeze({
    annotationId: snapshot.reference.annotationId,
    title: snapshot.page.title,
    summary: snapshot.anchor.display.label,
    bodyMarkdown: snapshot.comment.bodyMarkdown,
    origin: snapshot.page.origin,
    status: "resolved",
    updatedAt: snapshot.reference.assembledAt,
  });
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
