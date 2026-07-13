import type {
  MarkdownSnapshot,
  MarkdownSnapshotBlock,
  MarkdownSnapshotBlockKind,
  MarkdownSnapshotResourceKind,
} from "./MarkdownSnapshot";

export type MarkdownDocumentIdentityInput =
  | {
      readonly surface: "file";
      readonly workspaceId: string;
      readonly path: string;
    }
  | {
      readonly surface: "message";
      readonly sessionId: string;
      readonly messageId: string;
    };

export interface MarkdownBlockIdentityCandidate {
  readonly kind: MarkdownSnapshotBlockKind;
  readonly contentHash: string;
}

export interface MarkdownBlockIdentity {
  readonly id: string;
  readonly identityKey: string;
  readonly reused: boolean;
}

export interface MarkdownSnapshotIdentityDiff {
  readonly reusableBlockIds: readonly string[];
  readonly insertedBlockIds: readonly string[];
  readonly removedBlockIds: readonly string[];
}

export interface MarkdownRevisionPublication {
  readonly generation: number;
  readonly revision: string;
}

export function createMarkdownDocumentIdentity(input: MarkdownDocumentIdentityInput): string {
  if (input.surface === "file") {
    required(input.workspaceId, "workspaceId");
    required(input.path, "path");
    return `file:${stableMarkdownIdentityHash(input.workspaceId)}:${normalizeDocumentPath(input.path)}`;
  }
  required(input.sessionId, "sessionId");
  required(input.messageId, "messageId");
  return `message:${stableMarkdownIdentityHash(input.sessionId)}:${encodeURIComponent(input.messageId)}`;
}

export function stableMarkdownIdentityHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

export function reconcileMarkdownBlockIdentities(
  documentId: string,
  candidates: readonly MarkdownBlockIdentityCandidate[],
  previousSnapshot?: MarkdownSnapshot | null,
): readonly MarkdownBlockIdentity[] {
  required(documentId, "documentId");
  const documentNamespace = stableMarkdownIdentityHash(documentId);
  const previousBySignature = new Map<string, MarkdownSnapshotBlock[]>();
  if (previousSnapshot?.document_id === documentId) {
    for (const block of previousSnapshot.blocks) {
      const signature = blockSignature(block.kind, block.content_hash);
      const entries = previousBySignature.get(signature) ?? [];
      entries.push(block);
      previousBySignature.set(signature, entries);
    }
  }
  const usedIds = new Set<string>();
  const matchedBySignature = new Map<string, number>();
  const allocatedBySignature = new Map<string, number>();
  return candidates.map((candidate) => {
    const signature = blockSignature(candidate.kind, candidate.contentHash);
    const previous = previousBySignature.get(signature) ?? [];
    const matchIndex = matchedBySignature.get(signature) ?? 0;
    const match = previous[matchIndex];
    matchedBySignature.set(signature, matchIndex + 1);
    if (match && !usedIds.has(match.id)) {
      usedIds.add(match.id);
      return Object.freeze({ id: match.id, identityKey: match.identity_key, reused: true });
    }

    let occurrence = (allocatedBySignature.get(signature) ?? previous.length) + 1;
    let id = blockIdentity(documentNamespace, candidate, occurrence);
    while (usedIds.has(id)) {
      occurrence += 1;
      id = blockIdentity(documentNamespace, candidate, occurrence);
    }
    allocatedBySignature.set(signature, occurrence);
    usedIds.add(id);
    return Object.freeze({ id, identityKey: id, reused: false });
  });
}

export function createMarkdownResourceIdentity(input: {
  readonly blockId: string;
  readonly kind: MarkdownSnapshotResourceKind;
  readonly contentHash: string;
  readonly url: string | null;
  readonly alt: string | null;
  readonly occurrence: number;
}): string {
  required(input.blockId, "blockId");
  if (!Number.isSafeInteger(input.occurrence) || input.occurrence < 1) {
    throw new Error("occurrence must be a positive integer");
  }
  const signature = [input.kind, input.contentHash, input.url ?? "", input.alt ?? ""].join("\u0000");
  return `${input.blockId}-resource-${stableMarkdownIdentityHash(signature)}-${input.occurrence}`;
}

export function diffMarkdownSnapshotIdentities(
  previous: MarkdownSnapshot,
  next: MarkdownSnapshot,
): MarkdownSnapshotIdentityDiff {
  const previousById = new Map(previous.blocks.map((block) => [block.id, block]));
  const nextById = new Map(next.blocks.map((block) => [block.id, block]));
  const reusableBlockIds = next.blocks
    .filter((block) => {
      const prior = previousById.get(block.id);
      return prior?.content_hash === block.content_hash && prior.kind === block.kind;
    })
    .map((block) => block.id);
  return Object.freeze({
    reusableBlockIds: Object.freeze(reusableBlockIds),
    insertedBlockIds: Object.freeze(next.blocks.filter((block) => !previousById.has(block.id)).map((block) => block.id)),
    removedBlockIds: Object.freeze(previous.blocks.filter((block) => !nextById.has(block.id)).map((block) => block.id)),
  });
}

export class MarkdownRevisionPublicationGate<T extends { readonly revision: string }> {
  private generation = 0;
  private value: T | null = null;

  issue(revision: string): MarkdownRevisionPublication {
    required(revision, "revision");
    this.generation += 1;
    return Object.freeze({ generation: this.generation, revision });
  }

  publish(publication: MarkdownRevisionPublication, value: T): boolean {
    if (publication.generation !== this.generation || publication.revision !== value.revision) return false;
    this.value = value;
    return true;
  }

  current(): T | null {
    return this.value;
  }

  evict(): void {
    this.value = null;
  }
}

function normalizeDocumentPath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  const platformNormalized = /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized;
  return encodeURI(platformNormalized);
}

function blockSignature(kind: MarkdownSnapshotBlockKind, contentHash: string): string {
  return `${kind}\u0000${contentHash}`;
}

function blockIdentity(
  documentNamespace: string,
  candidate: MarkdownBlockIdentityCandidate,
  occurrence: number,
): string {
  return `md-block-${documentNamespace}-${candidate.kind}-${candidate.contentHash}-${occurrence}`;
}

function required(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`);
}
