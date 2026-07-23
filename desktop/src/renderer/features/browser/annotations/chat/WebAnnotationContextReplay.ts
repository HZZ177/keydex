import type { AgentContextItem } from "@/types/protocol";

import {
  summarizeWebAnnotationChanges,
  visibleWebAnnotationStatus,
} from "../domain";
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
  const reference = record(snapshot?.reference);
  const trust = record(snapshot?.trust);
  const comment = record(snapshot?.comment);
  const page = record(snapshot?.page);
  const anchor = record(snapshot?.anchor);
  const machineTarget = record(anchor?.machineTarget);
  const observation = record(snapshot?.observation);
  const changes = record(observation?.changes);
  const integrity = record(snapshot?.integrity);
  if (
    snapshot?.schemaVersion !== 2
    || snapshot.type !== "web_annotation"
    || !reference
    || !nonEmptyString(reference.annotationId)
    || !positiveInteger(reference.revision)
    || !nonEmptyString(reference.anchorId)
    || !nonEmptyString(reference.createdAt)
    || !nonEmptyString(reference.assembledAt)
    || !trust
    || trust.userComment !== "user_instruction"
    || trust.pageEvidence !== "untrusted_reference"
    || trust.hostObservation !== "trusted_application_observation"
    || !comment
    || typeof comment.bodyMarkdown !== "string"
    || !stringArray(comment.tags)
    || !Array.isArray(comment.properties)
    || !page
    || typeof page.title !== "string"
    || !nonEmptyString(page.documentUrl)
    || !nonEmptyString(page.urlKey)
    || !nonEmptyString(page.origin)
    || !record(page.frame)
    || !anchor
    || !webAnnotationTargetType(anchor.kind)
    || !record(anchor.display)
    || !machineTarget
    || !webAnnotationTargetType(machineTarget.type)
    || !observation
    || !observationStatus(observation.status)
    || !observationFreshness(observation.freshness)
    || (observation.currentTarget !== null && !webAnnotationTargetType(record(observation.currentTarget)?.type))
    || !changes
    || !stringArray(changes.kinds)
    || !stringArray(changes.materialKinds)
    || !stringArray(changes.signals)
    || typeof changes.material !== "boolean"
    || !integrity
    || integrity.canonicalization !== "keydex-json-c14n/v1"
    || !nonEmptyString(integrity.digest)
  ) {
    return null;
  }
  const metadataAnnotationId = optionalString(metadata?.annotation_id);
  const metadataDigest = optionalString(metadata?.snapshot_digest);
  if (
    (metadataAnnotationId && metadataAnnotationId !== reference.annotationId)
    || (metadataDigest && metadataDigest !== integrity.digest)
  ) {
    return null;
  }
  return snapshot as unknown as WebAnnotationContextSnapshot;
}

export function webAnnotationPresentationFromSnapshot(
  snapshot: WebAnnotationContextSnapshot,
): WebAnnotationReferencePresentation {
  return {
    annotationId: snapshot.reference.annotationId,
    title: snapshot.page.title,
    summary: snapshot.anchor.display.label,
    bodyMarkdown: snapshot.comment.bodyMarkdown,
    origin: snapshot.page.origin,
    status: visibleWebAnnotationStatus(replayResolutionStatus(snapshot.observation.status)),
    change: summarizeWebAnnotationChanges(snapshot.observation.changes.signals),
    updatedAt: snapshot.reference.assembledAt,
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

function observationStatus(value: unknown): boolean {
  return value === "exact" || value === "relocated" || value === "changed" || value === "ambiguous" || value === "missing";
}

function observationFreshness(value: unknown): boolean {
  return value === "live" || value === "last_known" || value === "captured_only";
}

function replayResolutionStatus(
  status: WebAnnotationContextSnapshot["observation"]["status"],
): "resolved" | "changed" | "ambiguous" | "orphaned" {
  if (status === "exact" || status === "relocated") return "resolved";
  if (status === "missing") return "orphaned";
  return status;
}
