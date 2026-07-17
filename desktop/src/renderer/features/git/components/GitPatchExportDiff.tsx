import { useMemo } from "react";

import type { GitPatchExport } from "@/runtime/git";
import { normalizeDiffSafely } from "@/renderer/components/diff/diagnostics";
import { PreviewDiffView } from "@/renderer/components/diff/wrappers/PreviewDiffView";

export function GitPatchExportDiff({ exported }: { readonly exported: GitPatchExport }) {
  const document = useMemo(() => normalizeDiffSafely(exported.patch, {
    source: "git",
    sourceVersion: exported.repositoryVersion,
    scopeFingerprint: [
      "git-patch-export",
      exported.repositoryId,
      exported.mode,
      exported.left ?? "",
      exported.right ?? "",
      exported.paths.join("\u0000"),
    ].join(":"),
  }).document, [exported]);

  return (
    <PreviewDiffView
      document={document}
      scrollScopeKey={`git-patch-export:${exported.repositoryId}:${exported.filename}`}
      actions={{
        copyPatch: async (patch) => {
          if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用");
          await navigator.clipboard.writeText(patch);
        },
      }}
    />
  );
}
