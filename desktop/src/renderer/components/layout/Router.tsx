import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useCallback, type PropsWithChildren } from "react";

import { EventReplayHarness } from "@/renderer/devtools/EventReplayHarness";
import { ConversationPage } from "@/renderer/pages/conversation";
import { queueQuickChatSend } from "@/renderer/pages/conversation/quickSend";
import { HomePage } from "@/renderer/pages/home";
import { SettingsShell } from "@/renderer/pages/settings/SettingsShell";
import { ModelSettingsPage } from "@/renderer/pages/settings/model";
import { UsageStatsPage } from "@/renderer/pages/settings/usage";

import { Layout } from "./Layout";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/guid" replace />} />
      <Route path="/guid" element={<HomeRoute />} />
      <Route path="/conversation/:threadId" element={<ConversationRoute />} />
      <Route path="/__dev/event-replay" element={<EventReplayRoute />} />
      <Route path="/settings/model" element={<ModelSettingsRoute />} />
      <Route path="/settings/usage" element={<UsageSettingsRoute />} />
      <Route path="/settings/general" element={<Navigate to="/settings/model" replace />} />
      <Route path="*" element={<Navigate to="/guid" replace />} />
    </Routes>
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
  children,
}: PropsWithChildren<{ title: string; contentMode?: "reading" | "full" }>) {
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
    <Layout title={title} activePath={location.pathname} contentMode={contentMode} onNavigate={handleNavigate}>
      {children}
    </Layout>
  );
}

function HomeRoute() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <RoutedLayout title="新对话" contentMode="full">
      <HomePage
        onNavigateToConversation={(threadId, initialModel, initialMessage) => {
          const quickSend = queueQuickChatSend({
            sessionId: threadId,
            model: initialModel,
            message: initialMessage,
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

function ConversationRoute() {
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
        initialModel={initialModel}
        quickSendId={quickSendId}
        onQuickSendConsumed={clearQuickSend}
        onOpenModelSettings={() => void navigate("/settings/model", { state: { from: location.pathname } })}
      />
    </RoutedLayout>
  );
}

function ModelSettingsRoute() {
  return (
    <SettingsShell activeSection="model">
      <ModelSettingsPage />
    </SettingsShell>
  );
}

function UsageSettingsRoute() {
  return (
    <SettingsShell activeSection="usage">
      <UsageStatsPage />
    </SettingsShell>
  );
}
