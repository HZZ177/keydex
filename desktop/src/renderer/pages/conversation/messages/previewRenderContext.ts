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
