import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import {
  listenForAssociatedFileOpenRequested,
  runtimeBridge,
  takeAssociatedFileOpenPaths,
  type RuntimeBridge,
} from "@/runtime";
import type { RuntimeSelectedModel } from "@/renderer/components/model";
import { subscribeSessionUpdated, type AgentSessionUpdate } from "@/renderer/events/sessionEvents";
import { createLifecycleEventGate, subscribeLifecycleEvents } from "@/renderer/events/lifecycleEvents";
import { queueQuickChatSend } from "@/renderer/pages/conversation/quickSend";
import { LayoutStateProvider, useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import {
  ActiveProjectCoordinatorProvider,
  activeProjectDiscoveryFromWorkspace,
  usePublishActiveProjectDiscovery,
} from "@/renderer/providers/ActiveProjectCoordinatorProvider";
import { GitProvider } from "@/renderer/providers/GitProvider";
import type { WorkspaceSelection } from "@/renderer/components/workspace";
import type { AgentSession, Workspace } from "@/types/protocol";

import {
  appModeFromPath,
  conversationPath,
  HOME_PATH,
  modeSwitchTargetsForPath,
  parseWorkbenchPath,
  PROJECT_PATH,
  rememberableModePath,
  workbenchFilePreviewPath,
  workbenchGitPath,
  workbenchPath,
  WORKBENCH_PATH,
} from "./appMode";
import { Layout } from "./Layout";
import type { SiderEntry } from "./Sider";
import type { WorkbenchWorkspaceSelectorProps } from "./workbenchWorkspaceSelector";
import {
  initialLaunchIntent,
  launchIntentReducer,
  selectAssociatedFilePath,
} from "@/renderer/components/startup/launchIntent";
import { NormalStartupBoundary } from "@/renderer/components/startup/NormalStartupBoundary";
import { SettingsRuntimeGate } from "@/renderer/pages/settings/SettingsRuntimeGate";
import { LoadingSkeleton } from "@/renderer/components/loading";

import styles from "./Router.module.css";

const EventReplayHarness = lazy(() =>
  import("@/renderer/devtools/EventReplayHarness").then((module) => ({ default: module.EventReplayHarness })),
);
const ConversationPage = lazy(() =>
  import("@/renderer/pages/conversation/ConversationPage").then((module) => ({ default: module.ConversationPage })),
);
const HomePage = lazy(() =>
  import("@/renderer/pages/home/HomePage").then((module) => ({ default: module.HomePage })),
);
const loadWorkbenchModePage = () =>
  import("@/renderer/pages/workbench/WorkbenchModePage").then((module) => ({
    default: module.WorkbenchModePage,
  }));
const WorkbenchModePage = lazy(loadWorkbenchModePage);
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
const ProjectManagementPage = lazy(() =>
  import("@/renderer/pages/settings/projects/ProjectManagementPage").then((module) => ({
    default: module.ProjectManagementPage,
  })),
);
const ArchiveManagementPage = lazy(() =>
  import("@/renderer/pages/settings/archive/ArchiveManagementPage").then((module) => ({
    default: module.ArchiveManagementPage,
  })),
);
const workbenchSidebarInitializedByRuntime = new WeakSet<RuntimeBridge>();

export interface AppRouterProps {
  runtime?: RuntimeBridge;
  associatedFileOpen?: Pick<AssociatedFileOpenControllerProps, "listen" | "takePaths">;
}

export function AppRouter({ runtime = runtimeBridge, associatedFileOpen }: AppRouterProps = {}) {
  return (
    <LayoutStateProvider>
      <ActiveProjectCoordinatorProvider>
        <GitProvider runtime={runtime.git}>
          <AppRoutes runtime={runtime} associatedFileOpen={associatedFileOpen} />
        </GitProvider>
      </ActiveProjectCoordinatorProvider>
    </LayoutStateProvider>
  );
}

function AppRoutes({
  runtime,
  associatedFileOpen,
}: {
  runtime: RuntimeBridge;
  associatedFileOpen?: Pick<AssociatedFileOpenControllerProps, "listen" | "takePaths">;
}) {
  const location = useLocation();
  const runtimeConnection = useOptionalRuntimeConnection();
  const [launchIntent, dispatchLaunchIntent] = useReducer(
    launchIntentReducer,
    location.search,
    initialLaunchIntent,
  );
  const markExternalFileLaunch = useCallback(() => {
    dispatchLaunchIntent({ type: "external-file-detected" });
  }, []);
  const completeInitialLaunchResolution = useCallback(() => {
    dispatchLaunchIntent({ type: "initial-resolution-complete" });
  }, []);

  useEffect(() => {
    const preload = () => {
      void loadWorkbenchModePage().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(preload, { timeout: 2_000 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = window.setTimeout(preload, 500);
    return () => window.clearTimeout(timeoutId);
  }, []);

  return (
    <>
      <AssociatedFileOpenController
        {...associatedFileOpen}
        onExternalFileDetected={markExternalFileLaunch}
        onInitialResolutionComplete={completeInitialLaunchResolution}
      />
      <Suspense fallback={null}>
        <NormalStartupBoundary
          launchIntent={launchIntent}
          onRetry={runtimeConnection?.retry}
          runtimeStatus={runtimeConnection?.status ?? "ready"}
        >
          <Routes>
            <Route
              path="/"
              element={launchIntent === "normal" ? <Navigate to={HOME_PATH} replace /> : null}
            />
            <Route element={<AgentShellRoute runtime={runtime} />}>
              <Route path="/guid" element={<HomeRoute runtime={runtime} />} />
              <Route path="/git/:workspaceId" element={<GitRoute runtime={runtime} />} />
              <Route path="/conversation/:threadId" element={<ConversationRoute runtime={runtime} />} />
            </Route>
            <Route path="/workbench" element={<WorkbenchRoute runtime={runtime} />} />
            <Route path="/workbench/:workspaceId" element={<WorkbenchRoute runtime={runtime} />} />
            <Route path="/workbench/:workspaceId/git" element={<WorkbenchRoute runtime={runtime} />} />
            <Route path="/workbench/:workspaceId/session/:sessionId" element={<WorkbenchRoute runtime={runtime} />} />
            <Route path={PROJECT_PATH} element={<ProjectRoute />} />
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
            <Route path="/settings/projects" element={<ProjectSettingsRoute runtime={runtime} />} />
            <Route path="/settings/archive" element={<ArchiveSettingsRoute runtime={runtime} />} />
            <Route path="/settings/about" element={<AboutSettingsRoute />} />
            <Route path="*" element={<Navigate to={HOME_PATH} replace />} />
          </Routes>
        </NormalStartupBoundary>
      </Suspense>
    </>
  );
}

export interface AssociatedFileOpenControllerProps {
  onExternalFileDetected: () => void;
  onInitialResolutionComplete: () => void;
  takePaths?: () => Promise<string[]>;
  listen?: (handler: () => void) => Promise<() => void>;
}

export function AssociatedFileOpenController({
  onExternalFileDetected,
  onInitialResolutionComplete,
  takePaths = takeAssociatedFileOpenPaths,
  listen = listenForAssociatedFileOpenRequested,
}: AssociatedFileOpenControllerProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const layout = useLayoutState();
  const routeStateRef = useRef({
    pathname: location.pathname,
    lastWorkbenchWorkspaceId: layout.state.lastWorkbenchWorkspaceId,
  });
  const initialTakeStartedRef = useRef(false);
  const [associatedFileListenerReady, setAssociatedFileListenerReady] = useState(false);

  routeStateRef.current = {
    pathname: location.pathname,
    lastWorkbenchWorkspaceId: layout.state.lastWorkbenchWorkspaceId,
  };

  const openAssociatedFiles = useCallback(async (settleInitialResolution: boolean) => {
    try {
      const path = selectAssociatedFilePath(await takePaths());
      if (!path) {
        if (settleInitialResolution) {
          onInitialResolutionComplete();
        }
        return;
      }
      const { pathname, lastWorkbenchWorkspaceId } = routeStateRef.current;
      const activeWorkspaceId =
        parseWorkbenchPath(pathname)?.workspaceId ?? lastWorkbenchWorkspaceId ?? undefined;
      void navigate(workbenchFilePreviewPath(path, activeWorkspaceId));
      onExternalFileDetected();
    } catch {
      if (settleInitialResolution) {
        onInitialResolutionComplete();
      }
    }
  }, [navigate, onExternalFileDetected, onInitialResolutionComplete, takePaths]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen(() => {
      if (!disposed) {
        void openAssociatedFiles(false);
      }
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
      setAssociatedFileListenerReady(true);
    }).catch(() => {
      if (!disposed) {
        // Do not keep normal startup blocked if the desktop event bridge is unavailable.
        setAssociatedFileListenerReady(true);
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [listen, openAssociatedFiles]);

  useEffect(() => {
    if (!associatedFileListenerReady || initialTakeStartedRef.current) {
      return;
    }
    initialTakeStartedRef.current = true;
    void openAssociatedFiles(true);
  }, [associatedFileListenerReady, openAssociatedFiles]);

  return null;
}

function EventReplayRoute() {
  return (
    <RoutedLayout title="事件回放">
      <EventReplayHarness />
    </RoutedLayout>
  );
}

function RoutedLayout({
  runtime,
  title,
  contentMode = "reading",
  projects,
  conversations,
  showChatBucket,
  newConversationPath,
  archiveActiveFallbackPath,
  workspaceArchiveFallbackPath,
  getSessionPath,
  getWorkspaceNewConversationPath,
  workbenchWorkspaceSelector,
  primarySurface = "content",
  resetRightSidebarOnEnter = false,
  children,
}: PropsWithChildren<{
  runtime?: RuntimeBridge;
  title: string;
  contentMode?: "reading" | "full";
  projects?: SiderEntry[];
  conversations?: SiderEntry[];
  showChatBucket?: boolean;
  newConversationPath?: string;
  archiveActiveFallbackPath?: string;
  workspaceArchiveFallbackPath?: string;
  getSessionPath?: (sessionId: string) => string;
  getWorkspaceNewConversationPath?: (workspaceId?: string) => string;
  workbenchWorkspaceSelector?: WorkbenchWorkspaceSelectorProps;
  primarySurface?: "content" | "git";
  resetRightSidebarOnEnter?: boolean;
}>) {
  const navigate = useNavigate();
  const location = useLocation();
  const layout = useLayoutState();
  const appMode = appModeFromPath(location.pathname);
  const modeSwitchTargets = useMemo(
    () =>
      modeSwitchTargetsForPath(
        location.pathname,
        layout.state.lastWorkbenchWorkspaceId,
        layout.state.lastModePaths,
      ),
    [layout.state.lastModePaths, layout.state.lastWorkbenchWorkspaceId, location.pathname],
  );

  useEffect(() => {
    const rememberedPath = rememberableModePath(appMode, location.pathname, location.search);
    if (rememberedPath) {
      layout.actions.setLastModePath(appMode, rememberedPath);
    }
  }, [appMode, layout.actions, location.pathname, location.search]);

  const handleNavigate = (path: string) => {
    if (path.startsWith("/settings")) {
      void navigate(path, { state: { from: location.pathname } });
      return;
    }
    void navigate(path);
  };

  return (
    <Layout
      runtime={runtime}
      title={title}
      appMode={appMode}
      activePath={location.pathname}
      contentMode={contentMode}
      projects={projects}
      conversations={conversations}
      showChatBucket={showChatBucket}
      newConversationPath={newConversationPath}
      archiveActiveFallbackPath={archiveActiveFallbackPath}
      workspaceArchiveFallbackPath={workspaceArchiveFallbackPath}
      getSessionPath={getSessionPath}
      getWorkspaceNewConversationPath={getWorkspaceNewConversationPath}
      workbenchWorkspaceSelector={workbenchWorkspaceSelector}
      routePrimarySurface={primarySurface}
      routeGitNavigation
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

function AgentShellRoute({ runtime }: { runtime: RuntimeBridge }) {
  const location = useLocation();
  const homeActive = location.pathname === HOME_PATH;
  const gitActive = location.pathname.startsWith("/git/");
  return (
    <RoutedLayout
      runtime={runtime}
      title={homeActive ? "新对话" : ""}
      contentMode="full"
      primarySurface={gitActive ? "git" : "content"}
      resetRightSidebarOnEnter={homeActive}
    >
      <Outlet />
    </RoutedLayout>
  );
}

function GitRoute({ runtime }: { runtime: RuntimeBridge }) {
  const { workspaceId } = useParams();
  const decodedWorkspaceId = safeDecodeParam(workspaceId);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(Boolean(decodedWorkspaceId));

  useEffect(() => {
    if (!decodedWorkspaceId) {
      setWorkspace(null);
      setWorkspaceLoading(false);
      return;
    }
    let active = true;
    setWorkspace(null);
    setWorkspaceLoading(true);
    void runtime.workspaces
      .get(decodedWorkspaceId)
      .then((nextWorkspace) => {
        if (active) {
          setWorkspace(nextWorkspace);
        }
      })
      .catch(() => {
        if (active) {
          setWorkspace(null);
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

  const activeProjectDiscovery = useMemo(
    () => activeProjectDiscoveryFromWorkspace(workspace, workspaceLoading),
    [workspace, workspaceLoading],
  );
  usePublishActiveProjectDiscovery("git-route", activeProjectDiscovery);

  return null;
}

function WorkbenchRoute({ runtime }: { runtime: RuntimeBridge }) {
  const { workspaceId, sessionId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const layout = useLayoutState();
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const backendError = runtimeConnection?.status === "error";
  const backendErrorMessage = runtimeConnection?.error?.message ?? "本地服务连接失败";
  const decodedWorkspaceId = safeDecodeParam(workspaceId);
  const decodedSessionId = safeDecodeParam(sessionId);
  const gitRouteActive = parseWorkbenchPath(location.pathname)?.surface === "git";
  const externalPreviewIntentPath = searchParams.get("file")?.trim() || undefined;
  const [externalPreviewPath, setExternalPreviewPath] = useState<string | null>(
    () => externalPreviewIntentPath ?? null,
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceSessions, setWorkspaceSessions] = useState<AgentSession[]>([]);
  const invalidWorkspaceIdsRef = useRef(new Set<string>());
  const invalidSessionIdsRef = useRef(new Set<string>());
  const lifecycleEventGateRef = useRef(createLifecycleEventGate());
  const workspaceCatalogLoadedRef = useRef(false);
  const workspaceCatalogRuntimeRef = useRef(runtime);
  if (workspaceCatalogRuntimeRef.current !== runtime) {
    workspaceCatalogRuntimeRef.current = runtime;
    workspaceCatalogLoadedRef.current = false;
  }

  useLayoutEffect(() => {
    if (workbenchSidebarInitializedByRuntime.has(runtime)) {
      return;
    }
    workbenchSidebarInitializedByRuntime.add(runtime);
    layout.actions.setSidebarCollapsed(true);
  }, [layout.actions, runtime]);

  useEffect(() => {
    if (externalPreviewIntentPath) {
      setExternalPreviewPath(externalPreviewIntentPath);
      layout.actions.setSidebarCollapsed(true);
    }
  }, [externalPreviewIntentPath, layout.actions]);

  useEffect(() => {
    if (!backendReady) {
      workspaceCatalogLoadedRef.current = false;
      setWorkspaceLoading(!backendError);
      setWorkspaceError(backendError ? backendErrorMessage : null);
      if (backendError) {
        setWorkspaces([]);
      }
      return;
    }

    if (workspaceCatalogLoadedRef.current) {
      setWorkspaceLoading(false);
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
        let nextWorkspaces = response.list.filter((workspace) => !invalidWorkspaceIdsRef.current.has(workspace.id));
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
          workspaceCatalogLoadedRef.current = true;
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
          setWorkspaceSessions(response.list.filter((session) => !invalidSessionIdsRef.current.has(session.id)));
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

  useEffect(() => subscribeLifecycleEvents((event) => {
    if (!lifecycleEventGateRef.current(event)) return;
    if ((event.type === "workspace_archived" || event.type === "workspace_purged") && event.workspace_id) {
      invalidWorkspaceIdsRef.current.add(event.workspace_id);
      setWorkspaces((current) => current.filter((workspace) => workspace.id !== event.workspace_id));
      setWorkspaceSessions((current) => current.filter((session) => session.workspace_id !== event.workspace_id));
      if (event.workspace_id === decodedWorkspaceId) {
        void navigate(WORKBENCH_PATH, { replace: true });
      }
      return;
    }

    if (event.type === "workspace_restored" && event.workspace_id) {
      invalidWorkspaceIdsRef.current.delete(event.workspace_id);
      void runtime.workspaces.get(event.workspace_id).then((workspace) => {
        if (!invalidWorkspaceIdsRef.current.has(workspace.id) && workspace.archived_at === null) {
          setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
        }
      }).catch(() => undefined);
      return;
    }
    if ((event.type === "session_archived" || event.type === "session_purged") && event.session_id) {
      invalidSessionIdsRef.current.add(event.session_id);
      setWorkspaceSessions((current) => current.filter((session) => session.id !== event.session_id));
      if (event.session_id === decodedSessionId && decodedWorkspaceId) {
        void navigate(workbenchPath(decodedWorkspaceId), { replace: true });
      }
      return;
    }
    if (event.type === "session_restored" && event.session_id) {
      invalidSessionIdsRef.current.delete(event.session_id);
      void runtime.conversation.getSession(event.session_id).then((session) => {
        if (!invalidSessionIdsRef.current.has(session.id) && session.workspace_id === decodedWorkspaceId) {
          setWorkspaceSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
        }
      }).catch(() => undefined);
    }
  }), [decodedSessionId, decodedWorkspaceId, navigate, runtime]);

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
  const activeProjectDiscovery = useMemo(
    () => activeProjectDiscoveryFromWorkspace(selectedWorkspace, workspaceLoading),
    [selectedWorkspace, workspaceLoading],
  );
  usePublishActiveProjectDiscovery("workbench-route", activeProjectDiscovery);
  useEffect(() => {
    if (!externalPreviewPath || decodedWorkspaceId || workspaceLoading || workspaces.length === 0) {
      return;
    }
    const fallbackWorkspaceId = layout.state.lastWorkbenchWorkspaceId
      ? workspaces.find((workspace) => workspace.id === layout.state.lastWorkbenchWorkspaceId)?.id
      : undefined;
    const nextWorkspaceId = fallbackWorkspaceId ?? workspaces[0]?.id;
    if (nextWorkspaceId) {
      void navigate(workbenchPath(nextWorkspaceId), { replace: true });
    }
  }, [
    decodedWorkspaceId,
    externalPreviewPath,
    layout.state.lastWorkbenchWorkspaceId,
    navigate,
    workspaceLoading,
    workspaces,
  ]);
  const workspaceProjectEntries = useMemo<SiderEntry[]>(
    () =>
      selectedWorkspace
        ? [
            {
              id: selectedWorkspace.id,
              title: selectedWorkspace.name || selectedWorkspace.root_path || selectedWorkspace.id,
              updatedAt: selectedWorkspace.updated_at,
              rootPath: selectedWorkspace.root_path,
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
      void navigate(gitRouteActive ? workbenchGitPath(workspace.id) : workbenchPath(workspace.id));
    },
    [gitRouteActive, layout.actions, navigate],
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
  const clearExternalPreviewIntent = useCallback(() => {
    const nextSearchParams = new URLSearchParams(location.search);
    if (!nextSearchParams.has("file")) {
      return;
    }
    nextSearchParams.delete("file");
    const nextSearch = nextSearchParams.toString();
    void navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ""}`, { replace: true });
  }, [location.pathname, location.search, navigate]);
  const handleExternalPreviewIntentConsumed = useCallback(() => {
    clearExternalPreviewIntent();
  }, [clearExternalPreviewIntent]);
  const handleExternalPreviewClosed = useCallback(() => {
    setExternalPreviewPath(null);
    clearExternalPreviewIntent();
  }, [clearExternalPreviewIntent]);

  return (
    <RoutedLayout
      title=""
      contentMode="full"
      projects={workspaceProjectEntries}
      conversations={decodedWorkspaceId ? workspaceConversationEntries : []}
      showChatBucket={false}
      newConversationPath={decodedWorkspaceId ? workbenchPath(decodedWorkspaceId) : WORKBENCH_PATH}
      archiveActiveFallbackPath={decodedWorkspaceId ? workbenchPath(decodedWorkspaceId) : WORKBENCH_PATH}
      workspaceArchiveFallbackPath={WORKBENCH_PATH}
      getSessionPath={getWorkbenchSessionPath}
      getWorkspaceNewConversationPath={getWorkbenchNewPath}
      primarySurface={gitRouteActive ? "git" : "content"}
      workbenchWorkspaceSelector={
        decodedWorkspaceId || externalPreviewPath
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
      {gitRouteActive ? null : (
        <Suspense fallback={<WorkbenchRouteLoadingFallback />}>
          <WorkbenchModePage
            runtime={runtime}
            workspaceId={decodedWorkspaceId}
            selectedSessionId={decodedSessionId}
            externalPreviewPath={externalPreviewPath ?? undefined}
            externalPreviewIntentPath={externalPreviewIntentPath}
            externalPreviewIntentKey={externalPreviewIntentPath ? location.key : undefined}
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
            onExternalPreviewIntentConsumed={handleExternalPreviewIntentConsumed}
            onExternalPreviewClosed={handleExternalPreviewClosed}
            onOpenMcpSettings={() => void navigate("/settings/mcp", { state: { from: location.pathname } })}
          />
        </Suspense>
      )}
    </RoutedLayout>
  );
}

function WorkbenchRouteLoadingFallback() {
  return (
    <main
      className={styles.centerPage}
      data-testid="workbench-route-loading"
      aria-label="正在进入工作台"
    >
      <span className={styles.mark}>Workbench</span>
      <h1 className={styles.title}>正在进入工作台</h1>
      <LoadingSkeleton label="正在准备工作空间" lineCount={4} width="compact" />
    </main>
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
      <ConversationPage
        threadId={threadId ?? ""}
        runtime={runtime}
        initialModel={initialModel}
        quickSendId={quickSendId}
        focusTurnIndex={focusTurnIndex}
        focusTurnRequestId={focusTurnRequestId}
        onQuickSendConsumed={clearQuickSend}
        onOpenMcpSettings={() => void navigate("/settings/mcp", { state: { from: location.pathname } })}
        onOpenModelSettings={() => void navigate("/settings/model-defaults", { state: { from: location.pathname } })}
        onNavigateToConversation={(nextThreadId) => void navigate(conversationPath(nextThreadId))}
        onArchived={() => void navigate(HOME_PATH)}
      />
  );
}

function GeneralSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="general">
      <SettingsRuntimeGate>
        <GeneralSettingsPage runtime={runtime} />
      </SettingsRuntimeGate>
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
      <SettingsRuntimeGate>
        <ModelSettingsPage runtime={runtime} />
      </SettingsRuntimeGate>
    </SettingsShell>
  );
}

function ModelDefaultSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <SettingsShell activeSection="modelDefaults">
      <SettingsRuntimeGate>
        <ModelDefaultSettingsPage
          runtime={runtime}
          onOpenProviderSettings={() => void navigate("/settings/providers", { state: { from: location.pathname } })}
        />
      </SettingsRuntimeGate>
    </SettingsShell>
  );
}

function ExtensionSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <SettingsShell activeSection="extensions">
      <SettingsRuntimeGate>
        <ExtensionSettingsPage
          runtime={runtime}
          onOpenModelConfig={() => void navigate("/settings/model-defaults", { state: { from: location.pathname } })}
        />
      </SettingsRuntimeGate>
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
      <SettingsRuntimeGate>
        <UsageStatsPage runtime={runtime} onNavigateToConversationTurn={navigateToConversationTurn} />
      </SettingsRuntimeGate>
    </SettingsShell>
  );
}

function McpSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="mcp">
      <SettingsRuntimeGate>
        <McpConsolePage runtime={runtime} />
      </SettingsRuntimeGate>
    </SettingsShell>
  );
}

function ConfigSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="config">
      <SettingsRuntimeGate>
        <ConfigSettingsPage runtime={runtime} />
      </SettingsRuntimeGate>
    </SettingsShell>
  );
}

function ProjectSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="projects">
      <SettingsRuntimeGate>
        <ProjectManagementPage runtime={runtime} />
      </SettingsRuntimeGate>
    </SettingsShell>
  );
}

function ArchiveSettingsRoute({ runtime }: { runtime: RuntimeBridge }) {
  return (
    <SettingsShell activeSection="archive">
      <SettingsRuntimeGate>
        <ArchiveManagementPage runtime={runtime} />
      </SettingsRuntimeGate>
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
