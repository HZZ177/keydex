import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import type { PropsWithChildren } from "react";

import { EventReplayHarness } from "@/renderer/devtools/EventReplayHarness";
import { ConversationPage } from "@/renderer/pages/conversation";
import { HomePage } from "@/renderer/pages/home";
import { ModelSettingsPage } from "@/renderer/pages/settings/model";

import { Layout } from "./Layout";
import styles from "./Router.module.css";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/guid" replace />} />
      <Route path="/guid" element={<HomeRoute />} />
      <Route path="/conversation/:threadId" element={<ConversationRoute />} />
      <Route path="/__dev/event-replay" element={<EventReplayRoute />} />
      <Route path="/settings/model" element={<ModelSettingsRoute />} />
      <Route path="/settings/general" element={<SettingsPage section="通用设置" />} />
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
        onNavigateToConversation={(threadId, initialModel, initialMessage) =>
          void navigate(`/conversation/${encodeURIComponent(threadId)}`, {
            state: { initialModel, initialMessage },
          })
        }
        onOpenModelSettings={() => void navigate("/settings/model", { state: { from: location.pathname } })}
      />
    </RoutedLayout>
  );
}

function ConversationRoute() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as { initialModel?: string; initialMessage?: string } | null;
  const initialModel = routeState?.initialModel ?? "";
  const initialMessage = routeState?.initialMessage ?? "";

  return (
    <RoutedLayout title="" contentMode="full">
      <ConversationPage
        threadId={threadId ?? ""}
        initialModel={initialModel}
        initialMessage={initialMessage}
        onOpenModelSettings={() => void navigate("/settings/model", { state: { from: location.pathname } })}
      />
    </RoutedLayout>
  );
}

function ModelSettingsRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;

  return (
    <RoutedLayout title="模型设置">
      <main className={styles.documentPage}>
        <button className={styles.backButton} type="button" onClick={() => void navigate(from ?? "/guid")}>
          返回
        </button>
        <ModelSettingsPage />
      </main>
    </RoutedLayout>
  );
}

function SettingsPage({ section }: { section: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;

  return (
    <RoutedLayout title={section}>
      <main className={styles.documentPage}>
        <button className={styles.backButton} type="button" onClick={() => void navigate(from ?? "/guid")}>
          返回
        </button>
        <h1 className={styles.sectionTitle}>{section}</h1>
        <p className={styles.muted}>设置内容将在后续 issue 接入。</p>
      </main>
    </RoutedLayout>
  );
}
