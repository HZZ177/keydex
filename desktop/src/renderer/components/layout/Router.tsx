import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type PropsWithChildren } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { queueQuickChatSend } from "@/renderer/pages/conversation/quickSend";
import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import type { WorkspaceSelection } from "@/renderer/components/workspace";
import type { AgentSession, Workspace } from "@/types/protocol";

import {
  appModeFromPath,
  conversationPath,
  HOME_PATH,
  modeSwitchTargetsForPath,
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
const SettingsShell = lazy(() =>
  import("@/renderer/pages/settings/SettingsShell").then((module) => ({ default: module.SettingsShell })),
);
const GeneralSettingsPage = lazy(() =>
  import("@/renderer/pages/settings/general/GeneralSettingsPage").then((module) => ({
    default: module.GeneralSettingsPage,
  })),
);
const ModelSettingsPage = lazy(() =>
  import("@/renderer/pages/settings/model/ModelSettingsPage").then((module) => ({
    default: module.ModelSettingsPage,
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

export interface AppRouterProps {
  runtime?: RuntimeBridge;
}

export function AppRouter({ runtime = runtimeBridge }: AppRouterProps = {}) {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Navigate to={HOME_PATH} replace />} />
        <Route path="/guid" element={<HomeRoute runtime={runtime} />} />
        <Route path="/workbench" element={<WorkbenchRoute runtime={runtime} />} />
        <Route path="/workbench/:workspaceId" element={<WorkbenchRoute runtime={runtime} />} />
        <Route path="/workbench/:workspaceId/session/:sessionId" element={<WorkbenchRoute runtime={runtime} />} />
        <Route path="/conversation/:threadId" element={<ConversationRoute runtime={runtime} />} />
        <Route path="/__dev/event-replay" element={<EventReplayRoute />} />
        <Route path="/settings/model" element={<ModelSettingsRoute runtime={runtime} />} />
        <Route path="/settings/config" element={<ConfigSettingsRoute runtime={runtime} />} />
        <Route path="/settings/usage" element={<UsageSettingsRoute runtime={runtime} />} />
        <Route path="/settings/general" element={<GeneralSettingsRoute />} />
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

function WorkbenchRoute({ runtime }: { runtime: RuntimeBridge }) {
  const { workspaceId, sessionId } = useParams();
  const navigate = useNavigate();
  const layout = useLayoutState();
  const decodedWorkspaceId = safeDecodeParam(workspaceId);
  const decodedSessionId = safeDecodeParam(sessionId);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceSessions, setWorkspaceSessions] = useState<AgentSession[]>([]);

  useEffect(() => {
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
  }, [decodedWorkspaceId, runtime]);

  useEffect(() => {
    if (!decodedWorkspaceId) {
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
  }, [decodedWorkspaceId, runtime]);

  useEffect(() => {
    if (!decodedWorkspaceId || !decodedSessionId) {
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
  }, [decodedSessionId, decodedWorkspaceId, navigate, runtime]);

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
          });
          void navigate(conversationPath(threadId), {
            state: { initialModel, quickSendId: quickSend.id },
          });
        }}
        onOpenModelSettings={() => void navigate("/settings/model", { state: { from: location.pathname } })}
      />
    </RoutedLayout>
  );
}

function ConversationRoute({ runtime }: { runtime: RuntimeBridge }) {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as { initialModel?: string; quickSendId?: string; initialMessage?: string } | null;
  const initialModel = routeState?.initialModel ?? "";
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
        onQuickSendConsumed={clearQuickSend}
        onOpenModelSettings={() => void navigate("/settings/model", { state: { from: location.pathname } })}
      />
    </RoutedLayout>
  );
}

function GeneralSettingsRoute() {
  return (
    <SettingsShell activeSection="general">
      <GeneralSettingsPage />
    </SettingsShell>
  );
}

function ModelSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="model">
      <ModelSettingsPage runtime={runtime} />
    </SettingsShell>
  );
}

function UsageSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="usage">
      <UsageStatsPage runtime={runtime} />
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
