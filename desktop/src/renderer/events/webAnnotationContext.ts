import type {
  SelectedWebAnnotationReference,
  WebAnnotationContextSnapshot,
  WebAnnotationReferencePresentation,
} from "@/renderer/features/browser/annotations/chat";
import { webAnnotationReferencePresentations } from "@/renderer/features/browser/annotations/chat";
import type { AgentContextItem } from "@/types/protocol";

export const APP_ADD_WEB_ANNOTATION_TO_COMPOSER_EVENT = "keydex:add-web-annotation-to-composer";
export const APP_NAVIGATE_TO_WEB_ANNOTATION_EVENT = "keydex:navigate-to-web-annotation";

export type AddWebAnnotationToComposerResult = "added" | "duplicate" | "limit" | "unhandled";

export interface AddWebAnnotationToComposerDetail {
  readonly composerScopeKey: string;
  readonly reference: SelectedWebAnnotationReference;
  readonly presentation: WebAnnotationReferencePresentation;
  readonly replayedContextItem?: AgentContextItem;
  result?: AddWebAnnotationToComposerResult;
}

export interface NavigateToWebAnnotationDetail {
  readonly snapshot: WebAnnotationContextSnapshot;
}

export function emitAddWebAnnotationToComposer(
  input: Omit<AddWebAnnotationToComposerDetail, "result">,
): AddWebAnnotationToComposerResult {
  webAnnotationReferencePresentations.upsert(input.presentation);
  const detail: AddWebAnnotationToComposerDetail = { ...input };
  document.dispatchEvent(new CustomEvent<AddWebAnnotationToComposerDetail>(
    APP_ADD_WEB_ANNOTATION_TO_COMPOSER_EVENT,
    { detail },
  ));
  return detail.result ?? "unhandled";
}

export function subscribeAddWebAnnotationToComposer(
  listener: (detail: AddWebAnnotationToComposerDetail) => void,
): () => void {
  const handle = (event: Event) => {
    listener((event as CustomEvent<AddWebAnnotationToComposerDetail>).detail);
  };
  document.addEventListener(APP_ADD_WEB_ANNOTATION_TO_COMPOSER_EVENT, handle);
  return () => document.removeEventListener(APP_ADD_WEB_ANNOTATION_TO_COMPOSER_EVENT, handle);
}

export function emitNavigateToWebAnnotation(snapshot: WebAnnotationContextSnapshot): void {
  document.dispatchEvent(new CustomEvent<NavigateToWebAnnotationDetail>(
    APP_NAVIGATE_TO_WEB_ANNOTATION_EVENT,
    { detail: { snapshot } },
  ));
}

export function subscribeNavigateToWebAnnotation(
  listener: (detail: NavigateToWebAnnotationDetail) => void,
): () => void {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<NavigateToWebAnnotationDetail>).detail;
    if (detail?.snapshot?.type === "web_annotation") listener(detail);
  };
  document.addEventListener(APP_NAVIGATE_TO_WEB_ANNOTATION_EVENT, handle);
  return () => document.removeEventListener(APP_NAVIGATE_TO_WEB_ANNOTATION_EVENT, handle);
}
