import type { MarkdownViewDescriptor, MarkdownViewKind } from "@/renderer/markdownRuntime/view";
import type { SkillSource } from "@/runtime";

export type PreviewContentKind = "markdown" | "html" | "diff" | "json" | "code" | "text" | "mermaid";

export type PreviewMarkdownViewKind = Extract<
  MarkdownViewKind,
  "preview" | "source" | "split-preview" | "split-source" | "sidebar" | "workbench"
>;

export type PreviewMarkdownViewDescriptor = Omit<MarkdownViewDescriptor, "kind"> & {
  readonly kind: PreviewMarkdownViewKind;
};

export type PreviewRequest =
  | { type: "file"; path: string }
  | { type: "local-file"; path: string }
  | { type: "diff"; path: string; diff: string }
  | {
      type: "content";
      title: string;
      content: string;
      contentType: PreviewContentKind;
      sourcePath?: string;
    }
  | {
      type: "skill-resource";
      title: string;
      content: string;
      contentType: PreviewContentKind;
      skillName: string;
      skillSource: SkillSource;
      resourcePath: string;
      locator: string;
      revision: string;
    };
