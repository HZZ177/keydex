import { useEffect, useRef, useState } from "react";

import { runtimeBridge, type RuntimeBridge, type WorkspaceEntry, type WorkspaceSearchResult } from "@/runtime";
import { SendBox, type SelectedFile } from "@/renderer/components/chat/SendBox";
import { RuntimeModelSelector, useRuntimeModelSelection } from "@/renderer/components/model";
import { WorkspaceSelector, type WorkspaceSelection } from "@/renderer/components/workspace";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useOptionalPreview } from "@/renderer/providers/PreviewProvider";
import { prepareComposerMessage, type RuntimeParamsWithInjection } from "@/renderer/utils/messageInjection";
import type { AgentContextItem, Workspace } from "@/types/protocol";
import styles from "./HomePage.module.css";

export interface HomePageProps {
  runtime?: RuntimeBridge;
  initialWorkspaceId?: string;
  onNavigateToConversation: (
    sessionId: string,
    initialModel: string,
    initialMessage: string,
    options?: { runtimeParams?: RuntimeParamsWithInjection; contextItems?: AgentContextItem[] },
  ) => void;
  onOpenModelSettings: () => void;
}

export function HomePage({
  runtime = runtimeBridge,
  initialWorkspaceId,
  onNavigateToConversation,
  onOpenModelSettings,
}: HomePageProps) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceSelection, setWorkspaceSelection] = useState<WorkspaceSelection>({ type: "chat" });
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const selectionTouchedRef = useRef(false);
  const modelSelection = useRuntimeModelSelection(runtime);
  const notifications = useNotifications();
  const previewContext = useOptionalPreview();

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
          const initialWorkspace = initialWorkspaceId
            ? response.list.find((workspace) => workspace.id === initialWorkspaceId)
            : null;
          setWorkspaceSelection({ type: "workspace", workspace: initialWorkspace ?? response.list[0] });
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          notifications.error(errorMessage(reason));
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
  }, [initialWorkspaceId, notifications, runtime]);

  const canSubmit =
    draft.trim().length > 0 && !submitting && !workspaceLoading && modelSelection.modelLoadState !== "loading";
  const title =
    workspaceSelection.type === "workspace"
      ? `我们应该在 ${workspaceSelection.workspace.name} 中构建什么？`
      : "我们应该聊些什么？";
  const searchWorkspace =
    workspaceSelection.type === "workspace"
      ? (query: string, options?: { signal?: AbortSignal }) =>
          runtime.workspace.search({ workspaceId: workspaceSelection.workspace.id }, query, options)
      : undefined;
  const listWorkspaceDirectory =
    workspaceSelection.type === "workspace"
      ? (path: string) =>
          runtime.workspace
            .listDirectory({ workspaceId: workspaceSelection.workspace.id }, path)
            .then((response) => workspaceEntriesToSearchResults(response.entries))
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
  const openFileReference =
    workspaceSelection.type === "workspace" && previewContext
      ? (file: SelectedFile) => {
          if (!file.path) {
            return;
          }
          previewContext.openFilePanel(file.path, {
            workspaceId: workspaceSelection.workspace.id,
            workspaceAvailable: true,
            workspaceLabel: workspaceSelection.workspace.root_path ?? workspaceSelection.workspace.name,
            runtime,
          });
        }
      : undefined;

  const submit = async (files: SelectedFile[] = []) => {
    const prepared = prepareComposerMessage(draft, files);
    const text = prepared.message;
    if ((!text && !prepared.contextItems.length) || submitting) {
      return false;
    }

    setSubmitting(true);
    try {
      const model = modelSelection.selectedModel.trim();
      if (!model) {
        notifications.error("请先在设置中选择模型");
        onOpenModelSettings();
        return false;
      }

      const sessionPayload =
        workspaceSelection.type === "workspace"
          ? {
              title: sessionTitleFromPreparedMessage(text, prepared.contextItems),
              session_tag: "chat",
              sessionType: "workspace" as const,
              workspaceId: workspaceSelection.workspace.id,
            }
          : {
              title: sessionTitleFromPreparedMessage(text, prepared.contextItems),
              session_tag: "chat",
              sessionType: "chat" as const,
            };

      const session = await runtime.conversation.createSession(sessionPayload);
      emitSessionCreated(session);
      setDraft("");
      const injectionOptions = prepared.runtimeParams || prepared.contextItems.length
        ? {
            runtimeParams: prepared.runtimeParams,
            contextItems: prepared.contextItems,
          }
        : undefined;
      if (injectionOptions) {
        onNavigateToConversation(session.id, model, text, injectionOptions);
      } else {
        onNavigateToConversation(session.id, model, text);
      }
      return true;
    } catch (reason) {
      notifications.error(errorMessage(reason));
      return false;
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
          onListWorkspaceDirectory={listWorkspaceDirectory}
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
          onSend={submit}
          onStop={() => undefined}
          onOpenFileReference={openFileReference}
        />
      </section>
    </main>
  );
}

function workspaceEntriesToSearchResults(entries: WorkspaceEntry[]): WorkspaceSearchResult[] {
  return entries.map((entry) => ({
    path: entry.path,
    name: entry.name,
    type: entry.type,
  }));
}

function sessionTitleFromPreparedMessage(text: string, contextItems: AgentContextItem[]): string {
  const title = text.trim() || contextItems[0]?.label || "新对话";
  return title.slice(0, 32);
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
