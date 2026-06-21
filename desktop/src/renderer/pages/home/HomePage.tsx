import { useEffect, useRef, useState } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { SendBox } from "@/renderer/components/chat/SendBox";
import { RuntimeModelSelector, useRuntimeModelSelection } from "@/renderer/components/model";
import { WorkspaceSelector, type WorkspaceSelection } from "@/renderer/components/workspace";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
import type { Workspace } from "@/types/protocol";
import styles from "./HomePage.module.css";

export interface HomePageProps {
  runtime?: RuntimeBridge;
  onNavigateToConversation: (sessionId: string, initialModel: string, initialMessage: string) => void;
  onOpenModelSettings: () => void;
}

export function HomePage({
  runtime = runtimeBridge,
  onNavigateToConversation,
  onOpenModelSettings,
}: HomePageProps) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceSelection, setWorkspaceSelection] = useState<WorkspaceSelection>({ type: "chat" });
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const selectionTouchedRef = useRef(false);
  const modelSelection = useRuntimeModelSelection(runtime);

  useEffect(() => {
    let active = true;
    setWorkspaceLoading(true);
    void runtime.workspaces
      .list()
      .then((response) => {
        if (!active) {
          return;
        }
        setWorkspaces(response.list);
        if (!selectionTouchedRef.current && response.list.length) {
          setWorkspaceSelection({ type: "workspace", workspace: response.list[0] });
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
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
  }, [runtime]);

  const canSubmit =
    draft.trim().length > 0 && !submitting && !workspaceLoading && modelSelection.modelLoadState !== "loading";
  const title =
    workspaceSelection.type === "workspace"
      ? `我们应该在 ${workspaceSelection.workspace.name} 中构建什么？`
      : "我们应该聊些什么？";
  const searchWorkspace =
    workspaceSelection.type === "workspace"
      ? (query: string) => runtime.workspace.search({ workspaceId: workspaceSelection.workspace.id }, query)
      : undefined;
  const pickWorkspacePath = async () => {
    const selectedPath = await runtime.desktopPicker.pickDirectory();
    if (selectedPath) {
      return selectedPath;
    }
    if (!runtime.desktopPicker.isDirectoryPickerAvailable()) {
      throw new Error("当前环境无法打开文件夹选择器，请手动输入项目路径");
    }
    return null;
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const model = modelSelection.selectedModel.trim();
      if (!model) {
        setError("请先在设置中选择模型");
        onOpenModelSettings();
        return;
      }

      const sessionPayload =
        workspaceSelection.type === "workspace"
          ? {
              title: text.slice(0, 32),
              session_tag: "chat",
              sessionType: "workspace" as const,
              workspaceId: workspaceSelection.workspace.id,
            }
          : {
              title: text.slice(0, 32),
              session_tag: "chat",
              sessionType: "chat" as const,
            };

      const session = await runtime.conversation.createSession(sessionPayload);
      emitSessionCreated(session);
      setDraft("");
      onNavigateToConversation(session.id, model, text);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className={styles.home} data-testid="home-page">
      <section className={styles.canvas} aria-label="新对话">
        <h1 className={styles.title}>{title}</h1>
        <SendBox
          value={draft}
          runtimeState={submitting ? "starting" : "idle"}
          canSend={canSubmit}
          canStop={false}
          ariaLabel="新对话输入"
          inputLabel="输入需求"
          placeholder="随心输入"
          statusText={submitting ? "正在创建对话" : ""}
          disabled={submitting}
          variant="codex"
          allowFileSelection={workspaceSelection.type === "workspace"}
          onSearchWorkspace={searchWorkspace}
          contextBar={
            <WorkspaceSelector
              value={workspaceSelection}
              workspaces={workspaces}
              loading={workspaceLoading}
              disabled={submitting}
              onSelectChat={() => {
                selectionTouchedRef.current = true;
                setWorkspaceSelection({ type: "chat" });
              }}
              onSelectWorkspace={(workspace) => {
                selectionTouchedRef.current = true;
                setWorkspaceSelection({ type: "workspace", workspace });
              }}
              onAddWorkspace={async (rootPath) => {
                const workspace = await runtime.workspaces.create({ rootPath });
                selectionTouchedRef.current = true;
                setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
                setWorkspaceSelection({ type: "workspace", workspace });
              }}
              onPickWorkspacePath={pickWorkspacePath}
            />
          }
          rightControls={
            <RuntimeModelSelector
              model={modelSelection.selectedModel}
              modelOptions={modelSelection.modelOptions}
              modelLoadState={modelSelection.modelLoadState}
              modelError={modelSelection.modelError}
              disabled={submitting}
              onModelChange={modelSelection.setSelectedModel}
              onOpenModelSettings={onOpenModelSettings}
            />
          }
          onChange={setDraft}
          onSend={() => void submit()}
          onStop={() => undefined}
        />

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "发送失败";
}
