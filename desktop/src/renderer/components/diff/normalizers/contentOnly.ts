import { createDiffFileCacheKey, createDiffSourceVersion } from "../identity";
import {
  createKeydexDiffDocument,
  createKeydexDiffFile,
  type KeydexDiffDiagnostic,
  type KeydexDiffDocument,
} from "../model";
import {
  normalizeUnifiedPatch,
  type UnifiedPatchNormalizationOptions,
} from "./unifiedPatch";

export interface ContentOnlyDiffInput {
  readonly path: string;
  readonly content: string;
  readonly operation: "add" | "write";
}

export function normalizeContentOnlyAddedFile(
  input: ContentOnlyDiffInput,
  options: Omit<UnifiedPatchNormalizationOptions, "precision" | "selectableForPatch"> = {},
): KeydexDiffDocument {
  const path = input.path.trim().replaceAll("\\", "/");
  const normalizedContent = input.content.replace(/\r\n?/gu, "\n");
  const hasTrailingNewline = normalizedContent.endsWith("\n");
  const contentWithoutTrailingNewline = hasTrailingNewline
    ? normalizedContent.slice(0, -1)
    : normalizedContent;
  const contentLines = contentWithoutTrailingNewline ? contentWithoutTrailingNewline.split("\n") : [];
  const patchLines = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
  ];
  if (contentLines.length) {
    patchLines.push(`@@ -0,0 +1,${contentLines.length} @@`, ...contentLines.map((line) => `+${line}`));
    if (!hasTrailingNewline) patchLines.push("\\ No newline at end of file");
  }
  const patch = `${patchLines.join("\n")}\n`;
  const sourceVersion =
    options.sourceVersion ??
    createDiffSourceVersion({ revision: input.operation, content: `${path}\n${input.content}` });
  const normalized = normalizeUnifiedPatch(patch, {
    ...options,
    source: options.source ?? "agent",
    sourceVersion,
    precision: "exact",
    selectableForPatch: false,
  });
  const baseFile = normalized.files[0];
  if (!baseFile) return normalized;
  const file = createKeydexDiffFile({
    ...baseFile,
    newContent: input.content,
    cacheKey: createDiffFileCacheKey({
      fileId: baseFile.id,
      sourceVersion,
      language: baseFile.language,
      patch,
      newContent: input.content,
    }),
    selectableForPatch: false,
  });
  const diagnostics: KeydexDiffDiagnostic[] = [
    ...normalized.diagnostics,
    {
      id: "diff-diagnostic:content_synthesized:0",
      code: "content_synthesized",
      severity: "info",
      message: "已根据新文件内容生成差异预览。",
      fileId: file.id,
    },
    ...(!hasTrailingNewline && contentLines.length
      ? [
          {
            id: "diff-diagnostic:no_newline:content",
            code: "no_newline",
            severity: "info" as const,
            message: "文件末尾没有换行符。",
            fileId: file.id,
          },
        ]
      : []),
  ];
  return createKeydexDiffDocument({
    ...normalized,
    files: [file],
    diagnostics,
  });
}
