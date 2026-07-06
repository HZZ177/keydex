export type PreviewContentKind = "markdown" | "html" | "diff" | "json" | "code" | "text" | "mermaid";

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
    };
