import type {
  MarkdownSnapshot,
  MarkdownSnapshotBlock,
  MarkdownSnapshotBlockKind,
  MarkdownSnapshotInlineSpan,
  MarkdownSnapshotResource,
} from "../document/MarkdownSnapshot";

export interface MarkdownRendererProfile {
  readonly id: "file-preview" | "conversation";
  readonly surface: "file" | "message";
  readonly linkNavigation: "host" | "native";
  readonly codeActions: boolean;
  readonly imageActivation: "preview" | "native";
}

export const FILE_MARKDOWN_RENDERER_PROFILE: MarkdownRendererProfile = Object.freeze({
  id: "file-preview",
  surface: "file",
  linkNavigation: "host",
  codeActions: true,
  imageActivation: "preview",
});

export const CONVERSATION_MARKDOWN_RENDERER_PROFILE: MarkdownRendererProfile = Object.freeze({
  id: "conversation",
  surface: "message",
  linkNavigation: "host",
  codeActions: true,
  imageActivation: "preview",
});

export interface MarkdownRendererInteractionHandlers {
  readonly onLinkActivate?: (event: MouseEvent, input: {
    readonly href: string;
    readonly block: MarkdownSnapshotBlock;
  }) => void;
  readonly onImageActivate?: (event: MouseEvent, input: {
    readonly src: string;
    readonly alt: string;
    readonly block: MarkdownSnapshotBlock;
  }) => void;
  readonly onCodeCopy?: (input: {
    readonly code: string;
    readonly language: string | null;
    readonly block: MarkdownSnapshotBlock;
  }) => void | Promise<void>;
  readonly onMermaidPreview?: (input: {
    readonly code: string;
    readonly block: MarkdownSnapshotBlock;
  }) => void;
}

export interface MarkdownRendererResourceLifecycle {
  mount(
    resource: MarkdownSnapshotResource,
    element: HTMLElement,
    context: MarkdownBlockRendererContext,
  ): void | (() => void);
}

export interface MarkdownBlockRendererContext {
  readonly ownerDocument: Document;
  readonly snapshot: MarkdownSnapshot;
  readonly block: MarkdownSnapshotBlock;
  readonly logicalText: string;
  readonly resources: readonly MarkdownSnapshotResource[];
  readonly profile: MarkdownRendererProfile;
  readonly interactions: MarkdownRendererInteractionHandlers;
  readonly resourceLifecycle?: MarkdownRendererResourceLifecycle;
}

export interface MarkdownBlockSourceMap {
  readonly blockId: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly inline: readonly {
    readonly span: MarkdownSnapshotInlineSpan;
    readonly element: HTMLElement | null;
  }[];
}

export interface MarkdownBlockMeasurement {
  readonly width: number;
  readonly height: number;
}

export type MarkdownBlockUpdateResult = "reused" | "updated";

export interface MarkdownBlockDomInstance {
  readonly element: HTMLElement;
  update(context: MarkdownBlockRendererContext): MarkdownBlockUpdateResult;
  sourceMap(): MarkdownBlockSourceMap;
  measure(): MarkdownBlockMeasurement;
  destroy(): void;
}

export interface MarkdownBlockRendererDefinition {
  create(context: MarkdownBlockRendererContext): MarkdownBlockDomInstance;
}

export type MarkdownBlockRendererDefinitions = Partial<
  Record<MarkdownSnapshotBlockKind, MarkdownBlockRendererDefinition>
>;
