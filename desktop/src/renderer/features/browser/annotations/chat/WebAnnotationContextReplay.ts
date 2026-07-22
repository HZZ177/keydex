import type { AgentContextItem } from "@/types/protocol";

import type { WebAnnotationVisibleStatus } from "../domain";
import type { WebAnnotationContextSnapshot } from "./WebAnnotationContextAssembler";
import type { WebAnnotationReferencePresentation } from "./WebAnnotationReferencePresentationRegistry";

export interface ReplayedWebAnnotationContext {
  readonly item: AgentContextItem;
  readonly snapshot: WebAnnotationContextSnapshot;
}

export function replayedWebAnnotationContexts(
  items: readonly AgentContextItem[],
): readonly ReplayedWebAnnotationContext[] {
  return items.flatMap((item) => {
    const snapshot = webAnnotationSnapshotFromContextItem(item);
    return snapshot ? [{ item, snapshot }] : [];
  });
}

export function webAnnotationSnapshotFromContextItem(
  item: AgentContextItem,
): WebAnnotationContextSnapshot | null {
  if (item.type !== "web_annotation") return null;
  const metadata = record(item.metadata);
  const snapshot = record(metadata?.snapshot);
  const source = record(snapshot?.source);
  const target = record(snapshot?.target);
  const evidence = record(snapshot?.evidence);
  const annotation = record(snapshot?.annotation);
  if (
    snapshot?.schemaVersion !== 1
    || snapshot.type !== "web_annotation"
    || !nonEmptyString(snapshot.annotationId)
    || !positiveInteger(snapshot.annotationRevision)
    || !nonEmptyString(snapshot.capturedAt)
    || !nonEmptyString(snapshot.digest)
    || !source
    || typeof source.title !== "string"
    || !nonEmptyString(source.url)
    || !nonEmptyString(source.urlKey)
    || !nonEmptyString(source.origin)
    || !target
    || !webAnnotationTargetType(target.type)
    || typeof target.summary !== "string"
    || !settledStatus(target.resolution)
    || (target.freshness !== "current" && target.freshness !== "last-known")
    || !evidence
    || !annotation
    || typeof annotation.bodyMarkdown !== "string"
    || !stringArray(annotation.tags)
    || !Array.isArray(annotation.properties)
  ) {
    return null;
  }
  const metadataAnnotationId = optionalString(metadata?.annotation_id);
  const metadataDigest = optionalString(metadata?.snapshot_digest);
  if (
    (metadataAnnotationId && metadataAnnotationId !== snapshot.annotationId)
    || (metadataDigest && metadataDigest !== snapshot.digest)
  ) {
    return null;
  }
  return snapshot as unknown as WebAnnotationContextSnapshot;
}

export function webAnnotationPresentationFromSnapshot(
  snapshot: WebAnnotationContextSnapshot,
): WebAnnotationReferencePresentation {
  return {
    annotationId: snapshot.annotationId,
    title: snapshot.source.title,
    summary: snapshot.target.summary,
    bodyMarkdown: snapshot.annotation.bodyMarkdown,
    origin: snapshot.source.origin,
    status: snapshot.target.resolution as WebAnnotationVisibleStatus,
    updatedAt: snapshot.capturedAt,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function webAnnotationTargetType(value: unknown): boolean {
  return value === "text" || value === "element" || value === "region";
}

function settledStatus(value: unknown): boolean {
  return value === "resolved" || value === "changed" || value === "ambiguous" || value === "orphaned";
}
