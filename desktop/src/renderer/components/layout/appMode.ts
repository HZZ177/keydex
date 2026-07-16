export type AppMode = "agent" | "workbench" | "project";

export const HOME_PATH = "/guid";
export const WORKBENCH_PATH = "/workbench";
export const PROJECT_PATH = "/project";

export interface WorkbenchRouteParams {
  workspaceId?: string;
  sessionId?: string;
  surface?: "git";
}

export function appModeFromPath(pathname: string): AppMode {
  if (isProjectPath(pathname)) {
    return "project";
  }
  return isWorkbenchPath(pathname) ? "workbench" : "agent";
}

export function isWorkbenchPath(pathname: string): boolean {
  const path = stripQuery(pathname);
  return path === WORKBENCH_PATH || path.startsWith(`${WORKBENCH_PATH}/`);
}

export function isProjectPath(pathname: string): boolean {
  const path = stripQuery(pathname);
  return path === PROJECT_PATH || path.startsWith(`${PROJECT_PATH}/`);
}

export function conversationPath(sessionId: string): string {
  return `/conversation/${encodeURIComponent(sessionId)}`;
}

export function gitPath(workspaceId: string): string {
  return `/git/${encodeURIComponent(workspaceId)}`;
}

export function workbenchPath(workspaceId?: string, sessionId?: string): string {
  if (!workspaceId) {
    return WORKBENCH_PATH;
  }
  const base = `${WORKBENCH_PATH}/${encodeURIComponent(workspaceId)}`;
  return sessionId ? `${base}/session/${encodeURIComponent(sessionId)}` : base;
}

export function workbenchGitPath(workspaceId: string): string {
  return `${WORKBENCH_PATH}/${encodeURIComponent(workspaceId)}/git`;
}

export function workbenchFilePreviewPath(path: string, workspaceId?: string): string {
  const query = new URLSearchParams();
  query.set("file", path);
  return `${workbenchPath(workspaceId)}?${query.toString()}`;
}

export function parseWorkbenchPath(pathname: string): WorkbenchRouteParams | null {
  const path = stripQuery(pathname);
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "workbench") {
    return null;
  }
  const workspaceId = decodeSegment(segments[1]);
  const sessionId = segments[2] === "session" ? decodeSegment(segments[3]) : undefined;
  const surface = segments[2] === "git" ? "git" : undefined;
  return {
    workspaceId,
    ...(sessionId ? { sessionId } : {}),
    ...(surface ? { surface } : {}),
  };
}

export function newPromptConversationPath(params: { sessionType?: string; workspaceId?: string } = {}): string {
  const query = new URLSearchParams();
  if (params.sessionType) {
    query.set("sessionType", params.sessionType);
  }
  if (params.workspaceId) {
    query.set("workspaceId", params.workspaceId);
  }
  query.set("focus", "prompt");
  return `${HOME_PATH}?${query.toString()}`;
}

export function modeSwitchTargetsForPath(
  pathname: string,
  lastWorkbenchWorkspaceId?: string | null,
  lastModePaths: Record<string, string | undefined> = {},
): Record<AppMode, string> {
  const mode = appModeFromPath(pathname);
  const workbenchRoute = parseWorkbenchPath(pathname);
  const rememberedAgentPath = isAgentPrimaryPath(lastModePaths.agent) ? lastModePaths.agent : null;
  const rememberedWorkbenchPath = isWorkbenchPath(lastModePaths.workbench ?? "") ? lastModePaths.workbench : null;
  const rememberedProjectPath = isProjectPath(lastModePaths.project ?? "") ? lastModePaths.project : null;
  const agentTarget = rememberedAgentPath ?? (workbenchRoute?.sessionId ? conversationPath(workbenchRoute.sessionId) : HOME_PATH);
  const workbenchTarget = rememberedWorkbenchPath
    ? rememberedWorkbenchPath
    : lastWorkbenchWorkspaceId
      ? workbenchPath(lastWorkbenchWorkspaceId)
      : WORKBENCH_PATH;
  return {
    agent: mode === "agent" ? pathname : agentTarget,
    workbench: mode === "workbench" ? pathname : workbenchTarget,
    project: mode === "project" ? pathname : (rememberedProjectPath ?? PROJECT_PATH),
  };
}

export function rememberableModePath(mode: AppMode, pathname: string, search = ""): string | null {
  const fullPath = `${pathname}${search}`;
  if (mode === "agent") {
    return isAgentPrimaryPath(pathname) ? fullPath : null;
  }
  if (mode === "workbench") {
    return isWorkbenchPath(pathname) ? fullPath : null;
  }
  if (mode === "project") {
    return isProjectPath(pathname) ? fullPath : null;
  }
  return null;
}

function stripQuery(pathname: string): string {
  return pathname.split("?")[0] ?? pathname;
}

function isAgentPrimaryPath(pathname: string | undefined): pathname is string {
  if (!pathname) {
    return false;
  }
  const path = stripQuery(pathname);
  return path === HOME_PATH || path.startsWith("/conversation/") || path.startsWith("/git/");
}

function decodeSegment(segment: string | undefined): string | undefined {
  if (!segment) {
    return undefined;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
