import type { PreviewRequest } from "@/renderer/providers/previewTypes";

import { normalizeDiffSafely } from "../diagnostics";

export type DiffDocumentPreviewRequest = Extract<PreviewRequest, { type: "diff-document" }>;

export function normalizeDiffPreviewRequest(request: PreviewRequest): PreviewRequest {
  if (request.type === "diff-document") return request;
  if (request.type === "diff") {
    return documentRequest(request.path.split(/[\\/]/u).pop() || request.path, request.diff, request.path, request.path);
  }
  if ((request.type === "content" || request.type === "skill-resource") && request.contentType === "diff") {
    const sourcePath = request.type === "content" ? request.sourcePath : request.resourcePath;
    const sourceLabel = request.type === "skill-resource"
      ? `Skill · ${request.skillName}/${request.resourcePath}`
      : request.sourcePath ?? "消息内容";
    return documentRequest(request.title, request.content, sourcePath, sourceLabel);
  }
  return request;
}

export function diffDocumentRawSource(request: DiffDocumentPreviewRequest): string {
  return request.rawSource || request.document.files.map((file) => file.patch).filter(Boolean).join("\n");
}

function documentRequest(
  title: string,
  rawSource: string,
  sourcePath?: string,
  sourceLabel?: string,
): DiffDocumentPreviewRequest {
  return {
    type: "diff-document",
    title,
    rawSource,
    sourcePath,
    sourceLabel,
    document: normalizeDiffSafely(rawSource, {
      source: "preview",
      scopeFingerprint: `preview:${sourcePath ?? title}`,
    }).document,
  };
}
