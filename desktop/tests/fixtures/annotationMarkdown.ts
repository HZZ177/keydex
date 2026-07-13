import { createMarkdownTextModel as createRuntimeMarkdownTextModel } from "@/renderer/features/annotations/document/MarkdownTextModel";
import { serializeMarkdownLogicalText as serializeRuntimeMarkdownLogicalText } from "@/renderer/features/annotations/document/markdownLogicalText";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

export function annotationMarkdownSnapshot(source: string, revision = "snapshot:test") {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:annotation-test.md",
    revision,
    source,
    rendererProfile: "file-preview",
  });
}

export function createMarkdownTextModel(source: string, revision: string) {
  return createRuntimeMarkdownTextModel(source, revision, annotationMarkdownSnapshot(source, revision));
}

export function serializeMarkdownLogicalText(source: string) {
  return serializeRuntimeMarkdownLogicalText(source, annotationMarkdownSnapshot(source));
}
