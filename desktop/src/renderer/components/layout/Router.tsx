import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type PropsWithChildren } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import type { RuntimeSelectedModel } from "@/renderer/components/model";
import { subscribeSessionUpdated, type AgentSessionUpdate } from "@/renderer/events/sessionEvents";
import { queueQuickChatSend } from "@/renderer/pages/conversation/quickSend";
import { LayoutStateProvider, useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import type { WorkspaceSelection } from "@/renderer/components/workspace";
import type { AgentSession, Workspace } from "@/types/protocol";

import {
  appModeFromPath,
  conversationPath,
  HOME_PATH,
  modeSwitchTargetsForPath,
  PROJECT_PATH,
  workbenchPath,
  WORKBENCH_PATH,
} from "./appMode";
import { Layout } from "./Layout";
import type { SiderEntry } from "./Sider";
import type { WorkbenchWorkspaceSelectorProps } from "./workbenchWorkspaceSelector";

const EventReplayHarness = lazy(() =>
  import("@/renderer/devtools/EventReplayHarness").then((module) => ({ default: module.EventReplayHarness })),
);
const ConversationPage = lazy(() =>
  import("@/renderer/pages/conversation/ConversationPage").then((module) => ({ default: module.ConversationPage })),
);
const HomePage = lazy(() =>
  import("@/renderer/pages/home/HomePage").then((module) => ({ default: module.HomePage })),
);
const WorkbenchModePage = lazy(() =>
  import("@/renderer/pages/workbench/WorkbenchModePage").then((module) => ({
    default: module.WorkbenchModePage,
  })),
);
const ProjectModePage = lazy(() =>
  import("@/renderer/pages/project/ProjectModePage").then((module) => ({
    default: module.ProjectModePage,
  })),
);
const SettingsShell = lazy(() =>
  import("@/renderer/pages/settings/SettingsShell").then((module) => ({ default: module.SettingsShell })),
);
const GeneralSettingsPage = lazy(() =>
  import("@/renderer/pages/settings/general/GeneralSettingsPage").then((module) => ({
    default: module.GeneralSettingsPage,
  })),
);
const AppearanceSettingsPage = lazy(() =>
  import("@/renderer/pages/settings/appearance/AppearanceSettingsPage").then((module) => ({
    default: module.AppearanceSettingsPage,
  })),
);
const AboutSettingsPage = lazy(() =>
  import("@/renderer/pages/settings/about/AboutSettingsPage").then((module) => ({
    default: module.AboutSettingsPage,
  })),
);
const ModelSettingsPage = lazy(() =>
  import("@/renderer/pages/settings/model/ModelSettingsPage").then((module) => ({
    default: module.ModelSettingsPage,
  })),
);
const ModelDefaultSettingsPage = lazy(() =>
  import("@/renderer/pages/settings/modelDefaults/ModelDefaultSettingsPage").then((module) => ({
    default: module.ModelDefaultSettingsPage,
  })),
);
const ExtensionSettingsPage = lazy(() =>
  import("@/renderer/pages/settings/extensions/ExtensionSettingsPage").then((module) => ({
    default: module.ExtensionSettingsPage,
  })),
);
const UsageStatsPage = lazy(() =>
  import("@/renderer/pages/settings/usage/UsageStatsPage").then((module) => ({
    default: module.UsageStatsPage,
  })),
);
const ConfigSettingsPage = lazy(() =>
  import("@/renderer/pages/settings/config/ConfigSettingsPage").then((module) => ({
    default: module.ConfigSettingsPage,
  })),
);
const McpConsolePage = lazy(() =>
  import("@/renderer/pages/mcp/McpConsolePage").then((module) => ({
    default: module.McpConsolePage,
  })),
);

export interface AppRouterProps {
  runtime?: RuntimeBridge;
}

export function AppRouter({ runtime = runtimeBridge }: AppRouterProps = {}) {
  return (
    <LayoutStateProvider>
      <AppRoutes runtime={runtime} />
    </LayoutStateProvider>
  );
}

function AppRoutes({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Navigate to={HOME_PATH} replace />} />
        <Route path="/guid" element={<HomeRoute runtime={runtime} />} />
        <Route path="/workbench" element={<WorkbenchRoute runtime={runtime} />} />
        <Route path="/workbench/:workspaceId" element={<WorkbenchRoute runtime={runtime} />} />
        <Route path="/workbench/:workspaceId/session/:sessionId" element={<WorkbenchRoute runtime={runtime} />} />
        <Route path={PROJECT_PATH} element={<ProjectRoute />} />
        <Route path="/conversation/:threadId" element={<ConversationRoute runtime={runtime} />} />
        <Route path="/mcp" element={<Navigate to="/settings/mcp" replace />} />
        <Route path="/__dev/event-replay" element={<EventReplayRoute />} />
        <Route path="/settings/providers" element={<ProviderSettingsRoute runtime={runtime} />} />
        <Route path="/settings/model-defaults" element={<ModelDefaultSettingsRoute runtime={runtime} />} />
        <Route path="/settings/extensions" element={<ExtensionSettingsRoute runtime={runtime} />} />
        <Route path="/settings/policy-config" element={<ConfigSettingsRoute runtime={runtime} />} />
        <Route path="/settings/usage" element={<UsageSettingsRoute runtime={runtime} />} />
        <Route path="/settings/mcp" element={<McpSettingsRoute runtime={runtime} />} />
        <Route path="/settings/general" element={<GeneralSettingsRoute runtime={runtime} />} />
        <Route path="/settings/appearance" element={<AppearanceSettingsRoute />} />
        <Route path="/settings/about" element={<AboutSettingsRoute />} />
        <Route path="*" element={<Navigate to={HOME_PATH} replace />} />
      </Routes>
    </Suspense>
  );
}

function EventReplayRoute() {
  return (
    <RoutedLayout title="事件回放">
      <EventReplayHarness />
    </RoutedLayout>
  );
}

function RoutedLayout({
  title,
  contentMode = "reading",
  projects,
  conversations,
  showChatBucket,
  newConversationPath,
  deleteActiveFallbackPath,
  getSessionPath,
  getWorkspaceNewConversationPath,
  workbenchWorkspaceSelector,
  resetRightSidebarOnEnter = false,
  children,
}: PropsWithChildren<{
  title: string;
  contentMode?: "reading" | "full";
  projects?: SiderEntry[];
  conversations?: SiderEntry[];
  showChatBucket?: boolean;
  newConversationPath?: string;
  deleteActiveFallbackPath?: string;
  getSessionPath?: (sessionId: string) => string;
  getWorkspaceNewConversationPath?: (workspaceId?: string) => string;
  workbenchWorkspaceSelector?: WorkbenchWorkspaceSelectorProps;
  resetRightSidebarOnEnter?: boolean;
}>) {
  const navigate = useNavigate();
  const location = useLocation();
  const layout = useLayoutState();
  const appMode = appModeFromPath(location.pathname);
  const modeSwitchTargets = useMemo(
    () => modeSwitchTargetsForPath(location.pathname, layout.state.lastWorkbenchWorkspaceId),
    [layout.state.lastWorkbenchWorkspaceId, location.pathname],
  );

  const handleNavigate = (path: string) => {
    if (path.startsWith("/settings")) {
      void navigate(path, { state: { from: location.pathname } });
      return;
    }
    void navigate(path);
  };

  return (
    <Layout
      title={title}
      appMode={appMode}
      activePath={location.pathname}
      contentMode={contentMode}
      projects={projects}
      conversations={conversations}
      showChatBucket={showChatBucket}
      newConversationPath={newConversationPath}
      deleteActiveFallbackPath={deleteActiveFallbackPath}
      getSessionPath={getSessionPath}
      getWorkspaceNewConversationPath={getWorkspaceNewConversationPath}
      workbenchWorkspaceSelector={workbenchWorkspaceSelector}
      modeSwitchTargets={modeSwitchTargets}
      resetRightSidebarKey={resetRightSidebarOnEnter ? location.key : undefined}
      onNavigate={handleNavigate}
    >
      {children}
    </Layout>
  );
}

function ProjectRoute() {
  return (
    <RoutedLayout title="" contentMode="full">
      <ProjectModePage />
    </RoutedLayout>
  );
}

function WorkbenchRoute({ runtime }: { runtime: RuntimeBridge }) {
  const { workspaceId, sessionId } = useParams();
  const navigate = useNavigate();
  const layout = useLayoutState();
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const backendError = runtimeConnection?.status === "error";
  const backendErrorMessage = runtimeConnection?.error?.message ?? "本地服务连接失败";
  const decodedWorkspaceId = safeDecodeParam(workspaceId);
  const decodedSessionId = safeDecodeParam(sessionId);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceSessions, setWorkspaceSessions] = useState<AgentSession[]>([]);

  useEffect(() => {
    if (!backendReady) {
      setWorkspaceLoading(!backendError);
      setWorkspaceError(backendError ? backendErrorMessage : null);
      if (backendError) {
        setWorkspaces([]);
      }
      return;
    }

    let active = true;
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    void runtime.workspaces
      .list()
      .then(async (response) => {
        if (!active) {
          return;
        }
        let nextWorkspaces = response.list;
        if (decodedWorkspaceId && !nextWorkspaces.some((workspace) => workspace.id === decodedWorkspaceId)) {
          try {
            const workspace = await runtime.workspaces.get(decodedWorkspaceId);
            nextWorkspaces = [workspace, ...nextWorkspaces.filter((item) => item.id !== workspace.id)];
          } catch (reason) {
            if (active) {
              setWorkspaceError(errorMessage(reason));
            }
          }
        }
        if (active) {
          setWorkspaces(nextWorkspaces);
        }
      })
      .catch((reason) => {
        if (active) {
          setWorkspaceError(errorMessage(reason));
          setWorkspaces([]);
        }
      })
      .finally(() => {
        if (active) {
          setWorkspaceLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [backendError, backendErrorMessage, backendReady, decodedWorkspaceId, runtime]);

  useEffect(() => {
    if (!backendReady || !decodedWorkspaceId) {
      setWorkspaceSessions([]);
      return;
    }
    let active = true;
    void runtime.conversation
      .listSessions({
        sessionType: "workspace",
        workspaceId: decodedWorkspaceId,
        pageSize: 50,
      })
      .then((response) => {
        if (active) {
          setWorkspaceSessions(response.list);
        }
      })
      .catch(() => {
        if (active) {
          setWorkspaceSessions([]);
        }
      });
    return () => {
      active = false;
    };
  }, [backendReady, decodedWorkspaceId, runtime]);

  useEffect(() => {
    if (!decodedWorkspaceId) {
      return undefined;
    }
    return subscribeSessionUpdated((session) => {
      setWorkspaceSessions((current) => mergeWorkspaceSessionUpdate(current, session, decodedWorkspaceId));
    });
  }, [decodedWorkspaceId]);

  useEffect(() => {
    if (!backendReady || !decodedWorkspaceId || !decodedSessionId) {
      return;
    }
    let active = true;
    void runtime.conversation
      .getSession(decodedSessionId)
      .then((session) => {
        if (!active) {
          return;
        }
        if (session.session_type !== "workspace" || session.workspace_id !== decodedWorkspaceId) {
          void navigate(workbenchPath(decodedWorkspaceId), { replace: true });
        }
      })
      .catch(() => {
        if (active) {
          void navigate(workbenchPath(decodedWorkspaceId), { replace: true });
        }
      });
    return () => {
      active = false;
    };
  }, [backendReady, decodedSessionId, decodedWorkspaceId, navigate, runtime]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === decodedWorkspaceId) ?? null,
    [decodedWorkspaceId, workspaces],
  );
  const workspaceProjectEntries = useMemo<SiderEntry[]>(
    () =>
      selectedWorkspace
        ? [
            {
              id: selectedWorkspace.id,
              title: selectedWorkspace.name || selectedWorkspace.root_path || selectedWorkspace.id,
              updatedAt: selectedWorkspace.updated_at,
            },
          ]
        : [],
    [selectedWorkspace],
  );
  const workspaceConversationEntries = useMemo<SiderEntry[]>(
    () =>
      workspaceSessions.map((session) => ({
        id: session.id,
        title: session.title || session.id,
        updatedAt: session.updated_at,
        pinnedAt: session.pinned_at ?? (session.pinned ? session.updated_at : undefined),
        forked: Boolean(session.fork_source),
      })),
    [workspaceSessions],
  );
  const workspaceSelectorValue = useMemo<WorkspaceSelection>(
    () => (selectedWorkspace ? { type: "workspace", workspace: selectedWorkspace } : { type: "chat" }),
    [selectedWorkspace],
  );
  const getWorkbenchSessionPath = useCallback(
    (id: string) => workbenchPath(decodedWorkspaceId, id),
    [decodedWorkspaceId],
  );
  const getWorkbenchNewPath = useCallback(
    (id?: string) => workbenchPath(id ?? decodedWorkspaceId),
    [decodedWorkspaceId],
  );
  const navigateToWorkspace = useCallback(
    (workspace: Workspace) => {
      layout.actions.setLastWorkbenchWorkspaceId(workspace.id);
      void navigate(workbenchPath(workspace.id));
    },
    [layout.actions, navigate],
  );
  const addWorkspace = useCallback(
    async (rootPath: string) => {
      const workspace = await runtime.workspaces.create({ rootPath });
      setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
      navigateToWorkspace(workspace);
    },
    [navigateToWorkspace, runtime],
  );
  const pickWorkspacePath = useCallback(async () => {
    const selectedPath = await runtime.desktopPicker.pickDirectory();
    if (selectedPath) {
      return selectedPath;
    }
    if (!runtime.desktopPicker.isDirectoryPickerAvailable()) {
      throw new Error("当前环境无法打开文件夹选择器，请手动输入项目路径");
    }
    return null;
  }, [runtime]);

  useEffect(() => {
    if (decodedWorkspaceId) {
      layout.actions.setLastWorkbenchWorkspaceId(decodedWorkspaceId);
    }
  }, [decodedWorkspaceId, layout.actions]);

  const handleWorkbenchSessionCreated = useCallback((session: AgentSession) => {
    setWorkspaceSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
  }, []);
  const handleWorkbenchSessionSelected = useCallback(
    (nextSessionId: string) => {
      if (!decodedWorkspaceId) {
        return;
      }
      void navigate(workbenchPath(decodedWorkspaceId, nextSessionId));
    },
    [decodedWorkspaceId, navigate],
  );
  const handleWorkbenchNewSessionRequested = useCallback(() => {
    if (!decodedWorkspaceId) {
      return;
    }
    void navigate(workbenchPath(decodedWorkspaceId));
  }, [decodedWorkspaceId, navigate]);

  return (
    <RoutedLayout
      title=""
      contentMode="full"
      projects={workspaceProjectEntries}
      conversations={decodedWorkspaceId ? workspaceConversationEntries : []}
      showChatBucket={false}
      newConversationPath={decodedWorkspaceId ? workbenchPath(decodedWorkspaceId) : WORKBENCH_PATH}
      deleteActiveFallbackPath={decodedWorkspaceId ? workbenchPath(decodedWorkspaceId) : WORKBENCH_PATH}
      getSessionPath={getWorkbenchSessionPath}
      getWorkspaceNewConversationPath={getWorkbenchNewPath}
      workbenchWorkspaceSelector={
        decodedWorkspaceId
          ? {
              value: workspaceSelectorValue,
              workspaces,
              loading: workspaceLoading,
              allowProjectFreeChat: false,
              onSelectWorkspace: navigateToWorkspace,
              onAddWorkspace: addWorkspace,
              onPickWorkspacePath: pickWorkspacePath,
            }
          : undefined
      }
    >
      <WorkbenchModePage
        runtime={runtime}
        workspaceId={decodedWorkspaceId}
        selectedSessionId={decodedSessionId}
        selectedWorkspace={selectedWorkspace}
        workspaces={workspaces}
        workspaceLoading={workspaceLoading}
        workspaceError={workspaceError}
        onSelectWorkspace={navigateToWorkspace}
        onAddWorkspace={addWorkspace}
        onPickWorkspacePath={pickWorkspacePath}
        onSessionSelected={handleWorkbenchSessionSelected}
        onSessionCreated={handleWorkbenchSessionCreated}
        onRequestNewSession={handleWorkbenchNewSessionRequested}
      />
    </RoutedLayout>
  );
}

function safeDecodeParam(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mergeWorkspaceSessionUpdate(
  sessions: AgentSession[],
  update: AgentSessionUpdate,
  workspaceId: string,
): AgentSession[] {
  const existing = sessions.find((session) => session.id === update.id);
  if (!existing) {
    return sessions;
  }
  const merged = { ...existing, ...definedSessionUpdate(update) };
  const next =
    merged.session_type === "workspace" && merged.workspace_id === workspaceId
      ? [merged, ...sessions.filter((session) => session.id !== update.id)]
      : sessions.filter((session) => session.id !== update.id);
  return next.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

function definedSessionUpdate(update: AgentSessionUpdate): AgentSessionUpdate {
  return Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) as AgentSessionUpdate;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "操作失败";
}

function HomeRoute({ runtime }: { runtime: RuntimeBridge }) {
  const navigate = useNavigate();
  const location = useLocation();
  const routeParams = new URLSearchParams(location.search);
  const initialWorkspaceId = routeParams.get("workspaceId") ?? undefined;
  const initialSessionType = routeParams.get("sessionType") === "chat" ? "chat" : undefined;
  const autoFocusInputKey = routeParams.get("focus") === "prompt" ? location.key : undefined;

  return (
    <RoutedLayout title="新对话" contentMode="full" resetRightSidebarOnEnter>
      <HomePage
        key={`${initialSessionType ?? "workspace"}:${initialWorkspaceId ?? "default"}`}
        runtime={runtime}
        initialWorkspaceId={initialWorkspaceId}
        initialSessionType={initialSessionType}
        autoFocusInputKey={autoFocusInputKey}
        onNavigateToConversation={(threadId, initialModel, initialMessage, options) => {
          const quickSend = queueQuickChatSend({
            sessionId: threadId,
            model: initialModel,
            message: initialMessage,
            runtimeParams: options?.runtimeParams,
            contextItems: options?.contextItems,
            attachments: options?.attachments,
          });
          void navigate(conversationPath(threadId), {
            state: { initialModel, quickSendId: quickSend.id },
          });
        }}
        onOpenModelSettings={() => void navigate("/settings/model-defaults", { state: { from: location.pathname } })}
      />
    </RoutedLayout>
  );
}

function ConversationRoute({ runtime }: { runtime: RuntimeBridge }) {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const focusTurnIndex = parseConversationTurnIndex(searchParams.get("turnIndex"));
  const focusTurnRequestId = parseConversationFocusRequestId(searchParams.get("focus"));
  const routeState = location.state as {
    initialModel?: RuntimeSelectedModel;
    quickSendId?: string;
    initialMessage?: string;
  } | null;
  const initialModel = routeState?.initialModel ?? null;
  const quickSendId = routeState?.quickSendId ?? "";
  const clearQuickSend = useCallback(() => {
    if (!routeState?.quickSendId && !routeState?.initialMessage) {
      return;
    }
    const nextInitialModel = routeState?.initialModel;
    void navigate(location.pathname, {
      replace: true,
      state: nextInitialModel ? { initialModel: nextInitialModel } : null,
    });
  }, [location.pathname, navigate, routeState?.initialMessage, routeState?.initialModel, routeState?.quickSendId]);

  return (
    <RoutedLayout title="" contentMode="full">
      <ConversationPage
        threadId={threadId ?? ""}
        runtime={runtime}
        initialModel={initialModel}
        quickSendId={quickSendId}
        focusTurnIndex={focusTurnIndex}
        focusTurnRequestId={focusTurnRequestId}
        onQuickSendConsumed={clearQuickSend}
        onOpenModelSettings={() => void navigate("/settings/model-defaults", { state: { from: location.pathname } })}
        onNavigateToConversation={(nextThreadId) => void navigate(conversationPath(nextThreadId))}
      />
    </RoutedLayout>
  );
}

function GeneralSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="general">
      <GeneralSettingsPage runtime={runtime} />
    </SettingsShell>
  );
}

function AppearanceSettingsRoute() {
  return (
    <SettingsShell activeSection="appearance">
      <AppearanceSettingsPage />
    </SettingsShell>
  );
}

function AboutSettingsRoute() {
  return (
    <SettingsShell activeSection="about">
      <AboutSettingsPage />
    </SettingsShell>
  );
}

function ProviderSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="providers">
      <ModelSettingsPage runtime={runtime} />
    </SettingsShell>
  );
}

function ModelDefaultSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <SettingsShell activeSection="modelDefaults">
      <ModelDefaultSettingsPage
        runtime={runtime}
        onOpenProviderSettings={() => void navigate("/settings/providers", { state: { from: location.pathname } })}
      />
    </SettingsShell>
  );
}

function ExtensionSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <SettingsShell activeSection="extensions">
      <ExtensionSettingsPage
        runtime={runtime}
        onOpenModelConfig={() => void navigate("/settings/model-defaults", { state: { from: location.pathname } })}
      />
    </SettingsShell>
  );
}

function UsageSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  const navigate = useNavigate();
  const navigateToConversationTurn = useCallback(
    ({ sessionId, turnIndex }: { sessionId: string; turnIndex: number }) => {
      const params = new URLSearchParams();
      params.set("turnIndex", String(turnIndex));
      params.set("focus", Date.now().toString(36));
      void navigate(`${conversationPath(sessionId)}?${params.toString()}`);
    },
    [navigate],
  );
  return (
    <SettingsShell activeSection="usage">
      <UsageStatsPage runtime={runtime} onNavigateToConversationTurn={navigateToConversationTurn} />
    </SettingsShell>
  );
}

function McpSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="mcp">
      <McpConsolePage runtime={runtime} />
    </SettingsShell>
  );
}

function ConfigSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="config">
      <ConfigSettingsPage runtime={runtime} />
    </SettingsShell>
  );
}

function parseConversationTurnIndex(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parseConversationFocusRequestId(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}
