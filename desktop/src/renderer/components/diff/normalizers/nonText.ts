import {
  createKeydexDiffDocument,
  createKeydexDiffFile,
  type KeydexDiffContentKind,
  type KeydexDiffDocument,
} from "../model";
import {
  normalizeUnifiedPatch,
  type UnifiedPatchNormalizationOptions,
} from "./unifiedPatch";

export function normalizeNonTextPatch(
  patch: string,
  kind: Exclude<KeydexDiffContentKind, "text">,
  options: UnifiedPatchNormalizationOptions & { readonly reason: string },
): KeydexDiffDocument {
  const normalized = normalizeUnifiedPatch(patch, {
    ...options,
    contentKind: kind,
    binaryReason: options.reason,
    selectableForPatch: false,
  });
  const diagnostics = [
    ...normalized.diagnostics,
    {
      id: `diff-diagnostic:${kind}:0`,
      code: kind,
      severity: "info" as const,
      message: nonTextMessage(kind),
      fileId: normalized.files[0]?.id,
    },
  ];
  return createKeydexDiffDocument({
    ...normalized,
    files: normalized.files.map((file) =>
      file.contentKind === kind
        ? file
        : createKeydexDiffFile({
            ...file,
            contentKind: kind,
            binary: kind === "binary",
            binaryReason: options.reason,
            selectableForPatch: false,
          }),
    ),
    diagnostics,
  });
}

function nonTextMessage(kind: Exclude<KeydexDiffContentKind, "text">): string {
  if (kind === "binary") return "二进制文件不提供文本差异。";
  if (kind === "submodule") return "子模块变更仅显示引用信息。";
  return "文件编码无法安全识别，已停止文本渲染。";
}
