export type KeydexDiffStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "unknown";

export type KeydexDiffSource = "git" | "agent" | "reverse" | "preview" | "patch_exchange";

export type KeydexDiffPrecision = "exact" | "approximate";

export type KeydexDiffEol = "lf" | "crlf" | "mixed" | "none" | "unknown";

export type KeydexDiffContentKind = "text" | "binary" | "submodule" | "unknown_encoding";

export type KeydexDiffTruncationState = "complete" | "recoverable" | "unrecoverable";

export type KeydexDiffTruncationReason =
  | "producer_limit"
  | "viewer_budget"
  | "missing_source"
  | "unknown";

export interface KeydexDiffTruncation {
  readonly state: KeydexDiffTruncationState;
  readonly reason: KeydexDiffTruncationReason | null;
  readonly canLoadMore: boolean;
  readonly continuationToken: string | null;
  readonly loadedBytes: number | null;
  readonly totalBytes: number | null;
  readonly loadedLines: number | null;
  readonly totalLines: number | null;
}

export type KeydexDiffDiagnosticSeverity = "info" | "warning" | "error";

export interface KeydexDiffDiagnostic {
  readonly id: string;
  readonly severity: KeydexDiffDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly fileId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface KeydexDiffHunk {
  readonly id: string;
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export interface KeydexDiffFile {
  readonly id: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldOperationPath: string | null;
  readonly newOperationPath: string | null;
  readonly displayPath: string;
  readonly status: KeydexDiffStatus;
  readonly language: string;
  readonly contentKind: KeydexDiffContentKind;
  readonly binaryReason: string | null;
  readonly lfsPointer: boolean;
  readonly patch: string;
  readonly patchEol: KeydexDiffEol;
  readonly oldContent?: string;
  readonly newContent?: string;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly truncation: KeydexDiffTruncation;
  readonly precision: KeydexDiffPrecision;
  readonly selectableForPatch: boolean;
  readonly oldHasTrailingNewline: boolean | null;
  readonly newHasTrailingNewline: boolean | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly hunks: readonly KeydexDiffHunk[];
  readonly cacheKey: string;
}

export interface KeydexDiffDocument {
  readonly id: string;
  readonly source: KeydexDiffSource;
  readonly sourceVersion: string;
  readonly files: readonly KeydexDiffFile[];
  readonly diagnostics: readonly KeydexDiffDiagnostic[];
}

export type KeydexDiffFileInput = Omit<
  KeydexDiffFile,
  | "displayPath"
  | "oldOperationPath"
  | "newOperationPath"
  | "language"
  | "contentKind"
  | "binaryReason"
  | "lfsPointer"
  | "patchEol"
  | "oldMode"
  | "newMode"
  | "binary"
  | "truncated"
  | "truncation"
  | "precision"
  | "selectableForPatch"
  | "oldHasTrailingNewline"
  | "newHasTrailingNewline"
  | "additions"
  | "deletions"
  | "hunks"
> &
  Partial<
    Pick<
      KeydexDiffFile,
      | "displayPath"
      | "oldOperationPath"
      | "newOperationPath"
      | "language"
      | "contentKind"
      | "binaryReason"
      | "lfsPointer"
      | "patchEol"
      | "oldMode"
      | "newMode"
      | "binary"
      | "truncated"
      | "truncation"
      | "precision"
      | "selectableForPatch"
      | "oldHasTrailingNewline"
      | "newHasTrailingNewline"
      | "additions"
      | "deletions"
      | "hunks"
    >
  >;

export type KeydexDiffDocumentInput = Omit<KeydexDiffDocument, "diagnostics" | "files"> & {
  readonly files?: readonly (KeydexDiffFile | KeydexDiffFileInput)[];
  readonly diagnostics?: readonly KeydexDiffDiagnostic[];
};

export class KeydexDiffModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeydexDiffModelError";
  }
}

export function createKeydexDiffFile(input: KeydexDiffFileInput): KeydexDiffFile {
  const id = requiredText(input.id, "file.id");
  const cacheKey = requiredText(input.cacheKey, "file.cacheKey");
  const oldOperationPath = nullableOperationPath(input.oldOperationPath ?? input.oldPath);
  const newOperationPath = nullableOperationPath(input.newOperationPath ?? input.newPath);
  const oldPath = nullablePath(input.oldPath);
  const newPath = nullablePath(input.newPath);
  if (!oldPath && !newPath) {
    throw new KeydexDiffModelError(`${id}: at least one path is required`);
  }
  assertStatusPaths(id, input.status, oldPath, newPath);
  assertNonNegativeStat(id, "additions", input.additions);
  assertNonNegativeStat(id, "deletions", input.deletions);
  if (input.binary && (input.oldContent !== undefined || input.newContent !== undefined)) {
    throw new KeydexDiffModelError(`${id}: binary files cannot carry text content`);
  }
  const precision = input.precision ?? "exact";
  const binary = input.binary ?? false;
  const contentKind = input.contentKind ?? (binary ? "binary" : "text");
  if (binary !== (contentKind === "binary")) {
    throw new KeydexDiffModelError(`${id}: binary flag must match binary contentKind`);
  }
  const truncation = freezeTruncation(
    input.truncation ?? legacyTruncation(input.truncated ?? false),
    id,
  );
  const truncated = truncation.state !== "complete";
  const selectableForPatch =
    input.selectableForPatch ?? (precision === "exact" && !binary && !truncated);
  if (selectableForPatch && (precision !== "exact" || contentKind !== "text" || truncated)) {
    throw new KeydexDiffModelError(
      `${id}: patch selection requires exact, complete, non-binary content`,
    );
  }

  const hunks = Object.freeze((input.hunks ?? []).map(freezeHunk));
  return Object.freeze({
    id,
    oldPath,
    newPath,
    oldOperationPath,
    newOperationPath,
    displayPath: requiredText(input.displayPath ?? newPath ?? oldPath, "file.displayPath"),
    status: input.status,
    language: input.language?.trim() || "text",
    contentKind,
    binaryReason: nullableText(input.binaryReason),
    lfsPointer: input.lfsPointer ?? false,
    patch: input.patch,
    patchEol: input.patchEol ?? "unknown",
    ...(input.oldContent === undefined ? {} : { oldContent: input.oldContent }),
    ...(input.newContent === undefined ? {} : { newContent: input.newContent }),
    oldMode: nullableText(input.oldMode),
    newMode: nullableText(input.newMode),
    binary,
    truncated,
    truncation,
    precision,
    selectableForPatch,
    oldHasTrailingNewline: input.oldHasTrailingNewline ?? null,
    newHasTrailingNewline: input.newHasTrailingNewline ?? null,
    additions: input.additions ?? null,
    deletions: input.deletions ?? null,
    hunks,
    cacheKey,
  });
}

function legacyTruncation(truncated: boolean): KeydexDiffTruncation {
  return truncated
    ? {
        state: "unrecoverable",
        reason: "producer_limit",
        canLoadMore: false,
        continuationToken: null,
        loadedBytes: null,
        totalBytes: null,
        loadedLines: null,
        totalLines: null,
      }
    : {
        state: "complete",
        reason: null,
        canLoadMore: false,
        continuationToken: null,
        loadedBytes: null,
        totalBytes: null,
        loadedLines: null,
        totalLines: null,
      };
}

function freezeTruncation(
  truncation: KeydexDiffTruncation,
  fileId: string,
): KeydexDiffTruncation {
  if (truncation.state === "complete" && (truncation.reason || truncation.canLoadMore)) {
    throw new KeydexDiffModelError(`${fileId}: complete diff cannot carry truncation recovery state`);
  }
  if (truncation.state === "recoverable" && !truncation.canLoadMore) {
    throw new KeydexDiffModelError(`${fileId}: recoverable truncation must allow loading more`);
  }
  if (truncation.state !== "complete" && !truncation.reason) {
    throw new KeydexDiffModelError(`${fileId}: truncated diff requires a reason`);
  }
  for (const [name, value] of [
    ["loadedBytes", truncation.loadedBytes],
    ["totalBytes", truncation.totalBytes],
    ["loadedLines", truncation.loadedLines],
    ["totalLines", truncation.totalLines],
  ] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new KeydexDiffModelError(`${fileId}: truncation.${name} must be a non-negative integer or null`);
    }
  }
  return Object.freeze({ ...truncation });
}

export function createKeydexDiffDocument(input: KeydexDiffDocumentInput): KeydexDiffDocument {
  const id = requiredText(input.id, "document.id");
  const sourceVersion = requiredText(input.sourceVersion, "document.sourceVersion");
  const files = Object.freeze(
    (input.files ?? []).map((file) =>
      Object.isFrozen(file) ? (file as KeydexDiffFile) : createKeydexDiffFile(file),
    ),
  );
  assertUnique(files.map((file) => file.id), `${id}: duplicate file id`);
  assertUnique(files.map((file) => file.cacheKey), `${id}: duplicate file cacheKey`);
  const diagnostics = Object.freeze((input.diagnostics ?? []).map(freezeDiagnostic));
  assertUnique(diagnostics.map((diagnostic) => diagnostic.id), `${id}: duplicate diagnostic id`);

  return Object.freeze({
    id,
    source: input.source,
    sourceVersion,
    files,
    diagnostics,
  });
}

function freezeHunk(hunk: KeydexDiffHunk): KeydexDiffHunk {
  const id = requiredText(hunk.id, "hunk.id");
  for (const [name, value] of [
    ["oldStart", hunk.oldStart],
    ["oldLines", hunk.oldLines],
    ["newStart", hunk.newStart],
    ["newLines", hunk.newLines],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new KeydexDiffModelError(`${id}: ${name} must be a non-negative integer`);
    }
  }
  return Object.freeze({
    ...hunk,
    id,
    lines: Object.freeze([...hunk.lines]),
  });
}

function freezeDiagnostic(diagnostic: KeydexDiffDiagnostic): KeydexDiffDiagnostic {
  return Object.freeze({
    ...diagnostic,
    id: requiredText(diagnostic.id, "diagnostic.id"),
    code: requiredText(diagnostic.code, "diagnostic.code"),
    message: requiredText(diagnostic.message, "diagnostic.message"),
    ...(diagnostic.details ? { details: Object.freeze({ ...diagnostic.details }) } : {}),
  });
}

function assertStatusPaths(
  id: string,
  status: KeydexDiffStatus,
  oldPath: string | null,
  newPath: string | null,
) {
  if (status === "added" && !newPath) {
    throw new KeydexDiffModelError(`${id}: added files require newPath`);
  }
  if (status === "deleted" && !oldPath) {
    throw new KeydexDiffModelError(`${id}: deleted files require oldPath`);
  }
  if ((status === "renamed" || status === "copied") && (!oldPath || !newPath)) {
    throw new KeydexDiffModelError(`${id}: ${status} files require oldPath and newPath`);
  }
}

function assertNonNegativeStat(id: string, name: string, value: number | null | undefined) {
  if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) {
    throw new KeydexDiffModelError(`${id}: ${name} must be a non-negative integer or null`);
  }
}

function assertUnique(values: readonly string[], message: string) {
  if (new Set(values).size !== values.length) {
    throw new KeydexDiffModelError(message);
  }
}

function nullablePath(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.replaceAll("\\", "/") : null;
}

function nullableOperationPath(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function requiredText(value: string | null | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new KeydexDiffModelError(`${name} is required`);
  }
  return normalized;
}
