import type { WebAnnotationVisibleStatus } from "../domain";

export interface WebAnnotationReferencePresentation {
  readonly annotationId: string;
  readonly title: string;
  readonly summary: string;
  readonly bodyMarkdown: string;
  readonly origin: string;
  readonly status?: WebAnnotationVisibleStatus;
  readonly updatedAt: string;
}

export type WebAnnotationReferencePresentationSnapshot = Readonly<
  Record<string, WebAnnotationReferencePresentation | undefined>
>;

export class WebAnnotationReferencePresentationRegistry {
  readonly #listeners = new Set<() => void>();
  #snapshot: WebAnnotationReferencePresentationSnapshot = Object.freeze({});

  getSnapshot = (): WebAnnotationReferencePresentationSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  upsert(presentation: WebAnnotationReferencePresentation): void {
    const normalized = normalizePresentation(presentation);
    const current = this.#snapshot[normalized.annotationId];
    if (current && samePresentation(current, normalized)) return;
    this.#snapshot = Object.freeze({ ...this.#snapshot, [normalized.annotationId]: normalized });
    this.#listeners.forEach((listener) => listener());
  }

  clear(): void {
    if (!Object.keys(this.#snapshot).length) return;
    this.#snapshot = Object.freeze({});
    this.#listeners.forEach((listener) => listener());
  }
}

export const webAnnotationReferencePresentations = new WebAnnotationReferencePresentationRegistry();

function normalizePresentation(
  value: WebAnnotationReferencePresentation,
): WebAnnotationReferencePresentation {
  const annotationId = value.annotationId.trim();
  if (!annotationId) throw new Error("Web annotation presentation id is required");
  return Object.freeze({
    annotationId,
    title: value.title.trim().slice(0, 512),
    summary: value.summary.trim().replace(/\s+/gu, " ").slice(0, 512),
    bodyMarkdown: value.bodyMarkdown.slice(0, 8_192),
    origin: value.origin.trim().slice(0, 2_048),
    ...(value.status ? { status: value.status } : {}),
    updatedAt: value.updatedAt,
  });
}

function samePresentation(
  left: WebAnnotationReferencePresentation,
  right: WebAnnotationReferencePresentation,
): boolean {
  return left.annotationId === right.annotationId
    && left.title === right.title
    && left.summary === right.summary
    && left.bodyMarkdown === right.bodyMarkdown
    && left.origin === right.origin
    && left.status === right.status
    && left.updatedAt === right.updatedAt;
}
