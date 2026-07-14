import type {
  MarkdownRuntimeAttachment,
  MarkdownRuntimeDocumentBundle,
  MarkdownRuntimeLoadInput,
  MarkdownRuntimeStore,
} from "../MarkdownRuntimeStore";
import type { MarkdownDocumentIdentityInput } from "../document/identity";
import type { MarkdownSnapshot } from "../document/MarkdownSnapshot";
import type { MarkdownViewDescriptor } from "./types";
import {
  MarkdownViewStateStore,
  type MarkdownViewStateAttachment,
} from "./MarkdownViewStateStore";

export interface MarkdownRuntimeViewAttachment {
  readonly document: MarkdownRuntimeAttachment;
  readonly view: MarkdownViewStateAttachment;
  load(input: MarkdownRuntimeLoadInput): Promise<MarkdownSnapshot>;
  current(): MarkdownRuntimeDocumentBundle | null;
  detach(): void;
  close(): void;
}

export function attachMarkdownRuntimeView(options: {
  readonly runtimeStore: MarkdownRuntimeStore;
  readonly viewStateStore: MarkdownViewStateStore;
  readonly identity: MarkdownDocumentIdentityInput;
  readonly view: MarkdownViewDescriptor;
}): MarkdownRuntimeViewAttachment {
  const runtimeViewId = [
    options.view.scopeId,
    options.view.entryId,
    options.view.viewId,
    options.view.kind,
  ].join(":");
  const document = options.runtimeStore.attach(options.identity, runtimeViewId);
  let view: MarkdownViewStateAttachment;
  try {
    view = options.viewStateStore.attach(options.view);
  } catch (error) {
    document.detach();
    throw error;
  }
  let active = true;
  const release = (dispose: boolean) => {
    if (!active) return;
    active = false;
    document.detach();
    if (dispose) view.dispose();
    else view.detach();
  };
  return Object.freeze({
    document,
    view,
    load: async (input: MarkdownRuntimeLoadInput) => {
      if (!active) throw new Error("Markdown Runtime view attachment is closed");
      const snapshot = await document.load(input);
      reconcileMarkdownRuntimeViewRevision(view, snapshot);
      return snapshot;
    },
    current: () => active ? document.current() : null,
    detach: () => release(false),
    close: () => release(true),
  });
}

export function reconcileMarkdownRuntimeViewRevision(
  view: MarkdownViewStateAttachment,
  snapshot: MarkdownSnapshot,
): void {
  const current = view.snapshot();
  const candidates = new Set(current.foldedBlockIds);
  if (current.scrollAnchor?.blockId) candidates.add(current.scrollAnchor.blockId);
  const available = new Set<string>();
  if (candidates.size > 0) {
    for (const block of snapshot.blocks) {
      if (!candidates.delete(block.id)) continue;
      available.add(block.id);
      if (candidates.size === 0) break;
    }
  }
  view.reconcileRevision(snapshot.revision, {
    sourceCharacters: snapshot.source_characters,
    blockIds: available,
  });
}
