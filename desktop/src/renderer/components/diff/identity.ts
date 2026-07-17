import type { KeydexDiffDocument, KeydexDiffSource, KeydexDiffStatus } from "./model";

const IDENTITY_SCHEMA_VERSION = "v1";

export type DiffPathCaseSensitivity = "sensitive" | "insensitive";

export interface DiffScopeIdentityInput {
  readonly source: KeydexDiffSource;
  readonly workspaceId?: string | null;
  readonly repositoryId?: string | null;
  readonly sessionId?: string | null;
  readonly requestId?: string | null;
}

export interface DiffSourceVersionInput {
  readonly revision?: string | number | null;
  readonly sequence?: string | number | null;
  readonly content?: string | null;
}

export interface DiffFileIdentityInput {
  readonly scopeFingerprint: string;
  readonly status: KeydexDiffStatus;
  readonly oldPath?: string | null;
  readonly newPath?: string | null;
  readonly pathCaseSensitivity?: DiffPathCaseSensitivity;
}

export interface DiffFileCacheKeyInput {
  readonly fileId: string;
  readonly sourceVersion: string;
  readonly language: string;
  readonly patch: string;
  readonly oldContent?: string;
  readonly newContent?: string;
  readonly binary?: boolean;
  readonly truncated?: boolean;
}

export interface DiffDocumentIdentityInput {
  readonly source: KeydexDiffSource;
  readonly scopeFingerprint: string;
  readonly sourceVersion: string;
  readonly fileIds: readonly string[];
}

export interface DiffAsyncIdentity {
  readonly documentId: string;
  readonly sourceVersion: string;
  readonly fileCacheKeys: readonly string[];
}

export function createDiffScopeFingerprint(input: DiffScopeIdentityInput): string {
  return fingerprint([
    IDENTITY_SCHEMA_VERSION,
    input.source,
    input.workspaceId ?? "",
    input.repositoryId ?? "",
    input.sessionId ?? "",
    input.requestId ?? "",
  ]);
}

export function createDiffSourceVersion(input: DiffSourceVersionInput): string {
  const revision = input.revision == null ? "" : String(input.revision);
  const sequence = input.sequence == null ? "" : String(input.sequence);
  const contentFingerprint = input.content == null ? "" : fingerprintText(input.content);
  return `diff-source:${IDENTITY_SCHEMA_VERSION}:${fingerprint([revision, sequence, contentFingerprint])}`;
}

export function createDiffFileId(input: DiffFileIdentityInput): string {
  const caseSensitivity = input.pathCaseSensitivity ?? "sensitive";
  const oldPath = normalizeIdentityPath(input.oldPath, caseSensitivity);
  const newPath = normalizeIdentityPath(input.newPath, caseSensitivity);
  return `diff-file:${IDENTITY_SCHEMA_VERSION}:${fingerprint([
    input.scopeFingerprint,
    input.status,
    oldPath,
    newPath,
  ])}`;
}

export function createDiffFileCacheKey(input: DiffFileCacheKeyInput): string {
  return `diff-cache:${IDENTITY_SCHEMA_VERSION}:${fingerprint([
    input.fileId,
    input.sourceVersion,
    input.language.trim().toLowerCase(),
    fingerprintText(input.patch),
    input.oldContent === undefined ? "" : fingerprintText(input.oldContent),
    input.newContent === undefined ? "" : fingerprintText(input.newContent),
    input.binary ? "binary" : "text",
    input.truncated ? "truncated" : "complete",
  ])}`;
}

export function createDiffDocumentId(input: DiffDocumentIdentityInput): string {
  return `diff-document:${IDENTITY_SCHEMA_VERSION}:${fingerprint([
    input.source,
    input.scopeFingerprint,
    input.sourceVersion,
    ...input.fileIds,
  ])}`;
}

export function diffAsyncIdentity(document: KeydexDiffDocument): DiffAsyncIdentity {
  return Object.freeze({
    documentId: document.id,
    sourceVersion: document.sourceVersion,
    fileCacheKeys: Object.freeze(document.files.map(({ cacheKey }) => cacheKey)),
  });
}

export function matchesCurrentDiffAsyncIdentity(
  document: KeydexDiffDocument,
  identity: DiffAsyncIdentity,
): boolean {
  if (document.id !== identity.documentId || document.sourceVersion !== identity.sourceVersion) {
    return false;
  }
  if (document.files.length !== identity.fileCacheKeys.length) {
    return false;
  }
  return document.files.every((file, index) => file.cacheKey === identity.fileCacheKeys[index]);
}

export function fingerprintDiffContent(value: string): string {
  return fingerprintText(value);
}

function normalizeIdentityPath(
  value: string | null | undefined,
  caseSensitivity: DiffPathCaseSensitivity,
): string {
  const normalized = (value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/^\.\//u, "");
  return caseSensitivity === "insensitive" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function fingerprintText(value: string): string {
  return fingerprint([value.replace(/\r\n?/gu, "\n")]);
}

function fingerprint(parts: readonly string[]): string {
  // Two independent 32-bit FNV-style accumulators keep the browser implementation synchronous
  // and deterministic without retaining the original path, repository id or content in a key.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const value = parts.map((part) => `${part.length}:${part}`).join("\u0000");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${unsignedHex(first)}${unsignedHex(second)}`;
}

function unsignedHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
