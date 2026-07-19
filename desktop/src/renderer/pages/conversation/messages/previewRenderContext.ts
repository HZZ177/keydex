import type { RuntimeBridge, WorkspaceScope } from "@/runtime";
import type { PreviewRenderContext } from "@/renderer/providers/PreviewProvider";

export function previewRenderContextFromWorkspaceScope(
  workspaceScope: WorkspaceScope | null | undefined,
  runtime: RuntimeBridge | undefined,
  onQuoteSelection: ((text: string, comment?: string) => void) | undefined,
  hostContext: PreviewRenderContext | null | undefined,
): PreviewRenderContext | undefined {
  if (hostContext?.workspaceAvailable && previewContextMatchesWorkspaceScope(hostContext, workspaceScope)) {
    return hostContext;
  }
  if (!workspaceScope) {
    return undefined;
  }
  const context: PreviewRenderContext = {
    workspaceAvailable: true,
  };
  if (hostContext?.panelScopeKey) {
    // A nested conversation reads files through its own Session, but previews still
    // belong to the panel that hosts it. Preserve that UI scope so opening a file,
    // Skill resource, or Markdown preview creates/activates a sibling tab instead
    // of replacing the current Sub-Agent tab with a child-session preview scope.
    context.panelScopeKey = hostContext.panelScopeKey;
  }
  if ("sessionId" in workspaceScope && workspaceScope.sessionId) {
    context.sessionId = workspaceScope.sessionId;
  }
  if ("workspaceId" in workspaceScope && workspaceScope.workspaceId) {
    context.workspaceId = workspaceScope.workspaceId;
  }
  if (runtime) {
    context.runtime = runtime;
  }
  if (onQuoteSelection) {
    context.onQuoteSelection = (request) => onQuoteSelection(request.selectedText, request.comment);
  }
  return context;
}

function previewContextMatchesWorkspaceScope(
  context: PreviewRenderContext,
  workspaceScope: WorkspaceScope | null | undefined,
): boolean {
  if (!workspaceScope) {
    return false;
  }
  if ("sessionId" in workspaceScope && workspaceScope.sessionId) {
    return context.sessionId === workspaceScope.sessionId;
  }
  if ("workspaceId" in workspaceScope && workspaceScope.workspaceId) {
    return context.workspaceId === workspaceScope.workspaceId;
  }
  return false;
}
