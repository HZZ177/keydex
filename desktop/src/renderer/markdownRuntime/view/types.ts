export const MARKDOWN_VIEW_STATE_SCHEMA_VERSION = "markdown-view-state/v1";

export type MarkdownViewKind =
  | "preview"
  | "source"
  | "split-preview"
  | "split-source"
  | "sidebar"
  | "workbench"
  | "conversation";

export interface MarkdownViewDescriptor {
  readonly scopeId: string;
  readonly entryId: string;
  readonly viewId: string;
  readonly kind: MarkdownViewKind;
}

export interface MarkdownViewScrollAnchor {
  readonly blockId: string | null;
  readonly sourceOffset: number;
  readonly alignment: "start" | "center" | "end" | "nearest";
  readonly offsetPx: number;
}

export interface MarkdownViewSelection {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly direction: "forward" | "backward" | "none";
}

export interface MarkdownViewFindState {
  readonly open: boolean;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly activeMatchId: string | null;
  readonly activeMatchIndex: number | null;
  readonly matchCount: number;
}

export interface MarkdownViewFocusState {
  readonly target: "none" | "content" | "source" | "find" | "annotation";
  readonly keyboardVisible: boolean;
}

export type MarkdownViewRevealTarget =
  | { readonly kind: "block"; readonly blockId: string }
  | { readonly kind: "source-offset"; readonly sourceOffset: number }
  | { readonly kind: "source-line"; readonly line: number; readonly column?: number }
  | { readonly kind: "find"; readonly matchId: string }
  | { readonly kind: "annotation"; readonly annotationId: string }
  | { readonly kind: "turn"; readonly turnId: string }
  | { readonly kind: "capsule"; readonly capsuleId: string; readonly sourceOffset?: number };

export interface MarkdownViewPendingReveal {
  readonly id: number;
  readonly target: MarkdownViewRevealTarget;
  readonly behavior: "auto" | "instant" | "smooth";
  readonly requestedRevision: string | null;
  readonly requestedAt: number;
}

export interface MarkdownViewState {
  readonly schemaVersion: typeof MARKDOWN_VIEW_STATE_SCHEMA_VERSION;
  readonly key: string;
  readonly scopeId: string;
  readonly entryId: string;
  readonly viewId: string;
  readonly kind: MarkdownViewKind;
  readonly revision: string | null;
  readonly scrollAnchor: MarkdownViewScrollAnchor | null;
  readonly selection: MarkdownViewSelection | null;
  readonly find: MarkdownViewFindState;
  readonly foldedBlockIds: readonly string[];
  readonly focus: MarkdownViewFocusState;
  readonly pendingReveal: MarkdownViewPendingReveal | null;
  readonly version: number;
  readonly updatedAt: number;
}

export interface MarkdownViewRevisionContext {
  readonly sourceCharacters: number;
  readonly blockIds: ReadonlySet<string>;
}
