import {
  createDiffDocumentId,
  createDiffFileCacheKey,
  createDiffFileId,
  createDiffScopeFingerprint,
  createDiffSourceVersion,
  fingerprintDiffContent,
  type DiffPathCaseSensitivity,
} from "../identity";
import {
  createKeydexDiffDocument,
  createKeydexDiffFile,
  type KeydexDiffDiagnostic,
  type KeydexDiffContentKind,
  type KeydexDiffDocument,
  type KeydexDiffHunk,
  type KeydexDiffEol,
  type KeydexDiffSource,
  type KeydexDiffStatus,
} from "../model";
import { resolveDiffLanguage } from "../language";

export interface UnifiedPatchNormalizationOptions {
  readonly source?: KeydexDiffSource;
  readonly sourceVersion?: string;
  readonly workspaceId?: string | null;
  readonly repositoryId?: string | null;
  readonly sessionId?: string | null;
  readonly requestId?: string | null;
  readonly scopeFingerprint?: string;
  readonly truncated?: boolean;
  readonly precision?: "exact" | "approximate";
  readonly selectableForPatch?: boolean;
  readonly contentKind?: KeydexDiffContentKind;
  readonly binaryReason?: string | null;
  readonly pathCaseSensitivity?: DiffPathCaseSensitivity;
}

interface ParsedUnifiedFile {
  oldPath: string | null;
  newPath: string | null;
  status: KeydexDiffStatus;
  oldOperationPath: string | null;
  newOperationPath: string | null;
  oldMode: string | null;
  newMode: string | null;
  patchEol: KeydexDiffEol;
  oldHasTrailingNewline: boolean | null;
  newHasTrailingNewline: boolean | null;
  contentKind: KeydexDiffContentKind;
  binaryReason: string | null;
  lfsPointer: boolean;
  patch: string;
  additions: number;
  deletions: number;
  hunks: KeydexDiffHunk[];
  diagnostics: KeydexDiffDiagnostic[];
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/u;

export function normalizeUnifiedPatch(
  patch: string,
  options: UnifiedPatchNormalizationOptions = {},
): KeydexDiffDocument {
  const source = options.source ?? "preview";
  const sourceVersion =
    options.sourceVersion ?? createDiffSourceVersion({ revision: "patch", content: patch });
  const scopeFingerprint = options.scopeFingerprint ?? createDiffScopeFingerprint({
    source,
    workspaceId: options.workspaceId,
    repositoryId: options.repositoryId,
    sessionId: options.sessionId,
    requestId: options.requestId,
  });
  const split = splitUnifiedPatch(patch);
  const files: ReturnType<typeof createKeydexDiffFile>[] = [];
  const diagnostics: KeydexDiffDiagnostic[] = [];
  const fileIdOccurrences = new Map<string, number>();
  if (split.preamble.trim()) {
    diagnostics.push(
      diagnostic("format_patch_preamble", "已忽略补丁邮件头，仅展示文件差异。", "info"),
    );
  }

  split.sections.forEach((section, sectionIndex) => {
    const parsed = parseSingleUnifiedFile(section);
    diagnostics.push(
      ...parsed.diagnostics.map((item) => ({ ...item, id: `${item.id}:section-${sectionIndex}` })),
    );
    if (!parsed.oldPath && !parsed.newPath) {
      diagnostics.push(
        diagnostic(
          "unparseable_patch",
          "无法从差异内容中识别文件路径。",
          "error",
          sectionIndex,
        ),
      );
      return;
    }
    const baseFileId = createDiffFileId({
      scopeFingerprint,
      status: parsed.status,
      oldPath: parsed.oldPath,
      newPath: parsed.newPath,
      pathCaseSensitivity: options.pathCaseSensitivity,
    });
    const occurrence = fileIdOccurrences.get(baseFileId) ?? 0;
    fileIdOccurrences.set(baseFileId, occurrence + 1);
    const fileId =
      occurrence === 0
        ? baseFileId
        : `diff-file:duplicate:${fingerprintDiffContent(`${baseFileId}:${occurrence}`)}`;
    const cacheKey = createDiffFileCacheKey({
      fileId,
      sourceVersion,
      language: "text",
      patch: parsed.patch,
      truncated: options.truncated,
    });
    files.push(
      createKeydexDiffFile({
        id: fileId,
        cacheKey,
        oldPath: parsed.oldPath,
        newPath: parsed.newPath,
        oldOperationPath: parsed.oldOperationPath,
        newOperationPath: parsed.newOperationPath,
        status: parsed.status,
        language: resolveDiffLanguage({ path: parsed.newPath ?? parsed.oldPath }),
        contentKind: options.contentKind ?? parsed.contentKind,
        binaryReason: options.binaryReason ?? parsed.binaryReason,
        lfsPointer: parsed.lfsPointer,
        patch: parsed.patch,
        patchEol: parsed.patchEol,
        oldMode: parsed.oldMode,
        newMode: parsed.newMode,
        binary: (options.contentKind ?? parsed.contentKind) === "binary",
        truncated: options.truncated ?? false,
        precision: options.precision ?? "exact",
        selectableForPatch:
          (options.contentKind ?? parsed.contentKind) === "text"
            ? options.selectableForPatch
            : false,
        oldHasTrailingNewline: parsed.oldHasTrailingNewline,
        newHasTrailingNewline: parsed.newHasTrailingNewline,
        additions: parsed.additions,
        deletions: parsed.deletions,
        hunks: parsed.hunks,
      }),
    );
  });
  if (!split.sections.length) {
    diagnostics.push(diagnostic("unparseable_patch", "差异内容为空。", "error"));
  }
  return createDocument(source, sourceVersion, scopeFingerprint, files, diagnostics);
}

export function splitUnifiedPatch(patch: string): {
  readonly preamble: string;
  readonly sections: readonly string[];
} {
  if (!patch) return { preamble: "", sections: [] };
  const diffStarts = [...patch.matchAll(/^diff --git /gmu)].map((match) => match.index ?? 0);
  if (diffStarts.length) {
    return {
      preamble: patch.slice(0, diffStarts[0]),
      sections: diffStarts.map((start, index) => patch.slice(start, diffStarts[index + 1])),
    };
  }

  const headerStarts = [
    ...patch.matchAll(
      /^---\s+(?:[ab]\/|\/dev\/null|"[ab]\/).*(?:\r?\n)\+\+\+\s+(?:[ab]\/|\/dev\/null|"[ab]\/).*$/gmu,
    ),
  ].map((match) => match.index ?? 0);
  if (headerStarts.length > 1) {
    return {
      preamble: patch.slice(0, headerStarts[0]),
      sections: headerStarts.map((start, index) => patch.slice(start, headerStarts[index + 1])),
    };
  }
  return { preamble: "", sections: [patch] };
}

function createDocument(
  source: KeydexDiffSource,
  sourceVersion: string,
  scopeFingerprint: string,
  files: readonly ReturnType<typeof createKeydexDiffFile>[],
  diagnostics: readonly KeydexDiffDiagnostic[],
): KeydexDiffDocument {
  return createKeydexDiffDocument({
    id: createDiffDocumentId({
      source,
      scopeFingerprint,
      sourceVersion,
      fileIds: files.map(({ id }) => id),
    }),
    source,
    sourceVersion,
    files,
    diagnostics,
  });
}

function parseSingleUnifiedFile(patch: string): ParsedUnifiedFile {
  const parseablePatch = patch.startsWith("\uFEFF") ? patch.slice(1) : patch;
  const lines = parseablePatch.replace(/\r\n?/gu, "\n").split("\n");
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let status: KeydexDiffStatus = "modified";
  let oldMode: string | null = null;
  let newMode: string | null = null;
  let metadataOldPath: string | null = null;
  let metadataNewPath: string | null = null;
  let oldHasTrailingNewline: boolean | null = null;
  let newHasTrailingNewline: boolean | null = null;
  let contentKind: KeydexDiffContentKind = "text";
  let binaryReason: string | null = null;
  let additions = 0;
  let deletions = 0;
  const hunks: KeydexDiffHunk[] = [];
  const diagnostics: KeydexDiffDiagnostic[] = [];

  const diffHeader = lines.find((line) => line.startsWith("diff --git "));
  if (diffHeader) {
    [oldPath, newPath] = diffHeaderPaths(diffHeader);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^index\s+\S+\.\.\S+\s+160000$/u.test(line)) {
      oldMode = "160000";
      newMode = "160000";
      continue;
    }
    if (line.startsWith("new file mode ")) {
      status = "added";
      newMode = line.slice("new file mode ".length).trim() || null;
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      contentKind = "binary";
      binaryReason = line === "GIT binary patch" ? "git_binary_patch" : "binary_files_marker";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      status = "deleted";
      oldMode = line.slice("deleted file mode ".length).trim() || null;
      continue;
    }
    if (line.startsWith("old mode ")) {
      status = "type_changed";
      oldMode = line.slice("old mode ".length).trim() || null;
      continue;
    }
    if (line.startsWith("new mode ")) {
      status = "type_changed";
      newMode = line.slice("new mode ".length).trim() || null;
      continue;
    }
    if (line.startsWith("rename from ")) {
      status = "renamed";
      metadataOldPath = unquoteGitPath(line.slice("rename from ".length).trim());
      continue;
    }
    if (line.startsWith("rename to ")) {
      status = "renamed";
      metadataNewPath = unquoteGitPath(line.slice("rename to ".length).trim());
      continue;
    }
    if (line.startsWith("copy from ")) {
      status = "copied";
      metadataOldPath = unquoteGitPath(line.slice("copy from ".length).trim());
      continue;
    }
    if (line.startsWith("copy to ")) {
      status = "copied";
      metadataNewPath = unquoteGitPath(line.slice("copy to ".length).trim());
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = patchPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = patchPath(line.slice(4));
      continue;
    }
    if (!line.startsWith("@@")) continue;

    const match = HUNK_HEADER.exec(line);
    if (!match) {
      diagnostics.push(
        diagnostic("malformed_hunk", `无法解析变更块头：${line}`, "error", hunks.length),
      );
      continue;
    }
    const hunkLines: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const candidate = lines[cursor] ?? "";
      if (candidate.startsWith("@@") || candidate.startsWith("diff --git ")) break;
      if (candidate.startsWith("\\ No newline") && hunkLines.length) {
        const previous = hunkLines[hunkLines.length - 1] ?? "";
        if (previous.startsWith("-")) oldHasTrailingNewline = false;
        if (previous.startsWith("+")) newHasTrailingNewline = false;
      }
      if (candidate.startsWith("+")) {
        additions += 1;
      } else if (candidate.startsWith("-")) {
        deletions += 1;
      }
      if (candidate !== "" || cursor < lines.length - 1) hunkLines.push(candidate);
      cursor += 1;
    }
    const header = match[0];
    hunks.push({
      id: `diff-hunk:${fingerprintDiffContent(`${header}:${hunks.length}:${hunkLines.join("\n")}`)}`,
      header: line,
      oldStart: Number(match[1]),
      oldLines: Number(match[2] ?? "1"),
      newStart: Number(match[3]),
      newLines: Number(match[4] ?? "1"),
      lines: hunkLines,
    });
    index = cursor - 1;
  }

  oldPath = metadataOldPath ?? oldPath;
  newPath = metadataNewPath ?? newPath;
  if (oldMode === "160000" || newMode === "160000") {
    contentKind = "submodule";
    binaryReason = "gitlink_mode_160000";
  }
  const lfsPointer = lines.some((line) => line.includes("version https://git-lfs.github.com/spec/v1"));
  const oldOperationPath = oldPath;
  const newOperationPath = newPath;
  if (status === "modified") {
    if (oldPath === null && newPath !== null) status = "added";
    else if (newPath === null && oldPath !== null) status = "deleted";
    else if (oldPath && newPath && oldPath !== newPath) status = "renamed";
  }

  return {
    oldPath,
    newPath,
    oldOperationPath,
    newOperationPath,
    status,
    oldMode,
    newMode,
    patchEol: detectEol(patch),
    oldHasTrailingNewline,
    newHasTrailingNewline,
    contentKind,
    binaryReason,
    lfsPointer,
    patch,
    additions,
    deletions,
    hunks,
    diagnostics,
  };
}

function diffHeaderPaths(line: string): [string | null, string | null] {
  const payload = line.slice("diff --git ".length).trim();
  const quoted = payload.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/u);
  if (quoted?.[1] && quoted[2]) {
    return [stripAB(unquoteGitPath(quoted[1])), stripAB(unquoteGitPath(quoted[2]))];
  }
  const separator = payload.lastIndexOf(" b/");
  if (payload.startsWith("a/") && separator > 1) {
    return [stripAB(payload.slice(0, separator)), stripAB(payload.slice(separator + 1))];
  }
  return [null, null];
}

function patchPath(value: string): string | null {
  const path = unquoteGitPath(value.trim());
  if (path === "/dev/null") return null;
  return stripAB(path);
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return decodeGitQuotedPath(value.slice(1, -1));
  }
}

function decodeGitQuotedPath(value: string): string {
  let result = "";
  let bytes: number[] = [];
  const flushBytes = () => {
    if (!bytes.length) return;
    result += new TextDecoder().decode(Uint8Array.from(bytes));
    bytes = [];
  };
  const escapes: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    v: "\v",
    "\\": "\\",
    '"': '"',
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      flushBytes();
      result += character;
      continue;
    }
    const next = value[index + 1] ?? "";
    const octal = value.slice(index + 1).match(/^[0-7]{1,3}/u)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    flushBytes();
    result += escapes[next] ?? next;
    index += 1;
  }
  flushBytes();
  return result;
}

function detectEol(value: string): KeydexDiffEol {
  if (!value) return "none";
  const crlf = (value.match(/\r\n/gu) ?? []).length;
  const loneLf = (value.match(/(?<!\r)\n/gu) ?? []).length;
  const loneCr = (value.match(/\r(?!\n)/gu) ?? []).length;
  if (crlf && (loneLf || loneCr)) return "mixed";
  if (crlf) return "crlf";
  if (loneLf || loneCr) return "lf";
  return "none";
}

function stripAB(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function diagnostic(
  code: string,
  message: string,
  severity: KeydexDiffDiagnostic["severity"],
  index = 0,
): KeydexDiffDiagnostic {
  return {
    id: `diff-diagnostic:${code}:${index}`,
    code,
    message,
    severity,
  };
}
