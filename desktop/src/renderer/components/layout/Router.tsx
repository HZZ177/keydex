import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { lazy, Suspense, useCallback, type PropsWithChildren } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { queueQuickChatSend } from "@/renderer/pages/conversation/quickSend";

import { Layout } from "./Layout";

const EventReplayHarness = lazy(() =>
  import("@/renderer/devtools/EventReplayHarness").then((module) => ({ default: module.EventReplayHarness })),
);
const ConversationPage = lazy(() =>
  import("@/renderer/pages/conversation/ConversationPage").then((module) => ({ default: module.ConversationPage })),
);
const HomePage = lazy(() =>
  import("@/renderer/pages/home/HomePage").then((module) => ({ default: module.HomePage })),
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
        <Route path="/" element={<Navigate to="/guid" replace />} />
        <Route path="/guid" element={<HomeRoute runtime={runtime} />} />
        <Route path="/conversation/:threadId" element={<ConversationRoute runtime={runtime} />} />
        <Route path="/__dev/event-replay" element={<EventReplayRoute />} />
        <Route path="/settings/model" element={<ModelSettingsRoute runtime={runtime} />} />
        <Route path="/settings/config" element={<ConfigSettingsRoute runtime={runtime} />} />
        <Route path="/settings/usage" element={<UsageSettingsRoute runtime={runtime} />} />
        <Route path="/settings/general" element={<GeneralSettingsRoute />} />
        <Route path="*" element={<Navigate to="/guid" replace />} />
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
  resetRightSidebarOnEnter = false,
  children,
}: PropsWithChildren<{ title: string; contentMode?: "reading" | "full"; resetRightSidebarOnEnter?: boolean }>) {
  const navigate = useNavigate();
  const location = useLocation();

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
      activePath={location.pathname}
      contentMode={contentMode}
      resetRightSidebarKey={resetRightSidebarOnEnter ? location.key : undefined}
      onNavigate={handleNavigate}
    >
      {children}
    </Layout>
  );
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
          void navigate(`/conversation/${encodeURIComponent(threadId)}`, {
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
