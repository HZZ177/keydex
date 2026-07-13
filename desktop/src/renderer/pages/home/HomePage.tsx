import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  runtimeBridge,
  type RuntimeBridge,
  type WorkspaceEntry,
  type WorkspaceSearchResult,
  type WorkspaceSkillSummary,
} from "@/runtime";
import {
  SendBox,
  agentAttachmentFromSelected,
  selectedQuoteFromText,
  type SelectedFile,
  type SelectedImageAttachment,
  type SelectedQuote,
} from "@/renderer/components/chat/SendBox";
import { GoalModeAccessory } from "@/renderer/components/chat/GoalModeAccessory";
import type { SlashCommand } from "@/renderer/components/chat/SlashCommandMenu";
import { RuntimeModelSelector, useRuntimeModelSelection, type RuntimeSelectedModel } from "@/renderer/components/model";
import { WorkspaceSelector, type WorkspaceSelection } from "@/renderer/components/workspace/WorkspaceSelector";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
import { useWorkspaceSkills } from "@/renderer/hooks/useWorkspaceSkills";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useWorkspaceFileWatchScope } from "@/renderer/providers/FileChangeProvider";
import {
  useOptionalPreview,
  type PreviewFileRevealTarget,
  type PreviewQuoteSelectionRequest,
} from "@/renderer/providers/PreviewProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import { prepareComposerMessage, type RuntimeParamsWithInjection } from "@/renderer/utils/messageInjection";
import type { AgentContextItem, AgentFileAttachment, FileAccessMode, ThreadTask, Workspace } from "@/types/protocol";
import {
  goalContextItem,
  goalSeedContextMetadata,
  runtimeParamsWithGoalContextItem,
  runtimeParamsWithInitialGoalTask,
} from "@/renderer/pages/conversation/goalSeedContext";
import styles from "./HomePage.module.css";

export interface HomePageProps {
  runtime?: RuntimeBridge;
  initialWorkspaceId?: string;
  initialSessionType?: "chat";
  autoFocusInputKey?: string;
  onNavigateToConversation: (
    sessionId: string,
    initialModel: RuntimeSelectedModel,
    initialMessage: string,
    options?: {
      runtimeParams?: RuntimeParamsWithInjection;
      contextItems?: AgentContextItem[];
      attachments?: AgentFileAttachment[];
    },
  ) => void;
  onOpenModelSettings: () => void;
}

interface PendingWorkspaceRegistration {
  rootPath: string;
  promise: Promise<Workspace>;
}

export function HomePage({
  runtime = runtimeBridge,
  initialWorkspaceId,
  initialSessionType,
  autoFocusInputKey,
  onNavigateToConversation,
  onOpenModelSettings,
}: HomePageProps) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [goalComposerOpen, setGoalComposerOpen] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [quoteChipRequest, setQuoteChipRequest] = useState<{ requestId: number; quote: SelectedQuote } | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceSelection, setWorkspaceSelection] = useState<WorkspaceSelection>({ type: "chat" });
  const [selectedSkill, setSelectedSkill] = useState<WorkspaceSkillSummary | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [fileAccessMode, setFileAccessMode] = useState<FileAccessMode>("workspace_trusted");
  const selectionTouchedRef = useRef(false);
  const pendingWorkspaceRegistrationRef = useRef<PendingWorkspaceRegistration | null>(null);
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const backendError = runtimeConnection?.status === "error";
  const modelSelection = useRuntimeModelSelection(runtime, null, { enabled: backendReady });
  const notifications = useNotifications();
  const previewContext = useOptionalPreview();
  const setPreviewHostContext = previewContext?.setPreviewHostContext;
  const selectedWorkspaceId = workspaceSelection.type === "workspace" ? workspaceSelection.workspace.id : "";
  useWorkspaceFileWatchScope(selectedWorkspaceId);
  const workspaceSkillScope = useMemo(
    () => (selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : null),
    [selectedWorkspaceId],
  );
  const { state: workspaceSkillsState, refresh: refreshWorkspaceSkills } = useWorkspaceSkills({
    runtime,
    scope: workspaceSkillScope,
    enabled: backendReady && Boolean(selectedWorkspaceId),
  });
  const workspaceSkills = selectedWorkspaceId ? workspaceSkillsState.skills : [];

  useEffect(() => {
    if (!backendReady) {
      return;
    }
    let active = true;
    void runtime.settings
      .getSettings()
      .then((settings) => {
        if (active) {
          setFileAccessMode(settings.command.file_access_mode);
        }
      })
      .catch(() => {
        if (active) {
          setFileAccessMode("workspace_trusted");
        }
      });
    return () => {
      active = false;
    };
  }, [backendReady, runtime]);

  const upsertWorkspace = useCallback((workspace: Workspace) => {
    setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
  }, []);

  const selectWorkspaceIfStillPending = useCallback((rootPath: string, workspace: Workspace) => {
    setWorkspaceSelection((current) =>
      current.type === "pending" && current.rootPath === rootPath ? { type: "workspace", workspace } : current,
    );
  }, []);

  const registerWorkspacePath = useCallback(
    async (rootPath: string) => {
      const activeRegistration = pendingWorkspaceRegistrationRef.current;
      if (activeRegistration?.rootPath === rootPath) {
        return activeRegistration.promise;
      }

      const promise = runtime.workspaces.create({ rootPath });
      pendingWorkspaceRegistrationRef.current = { rootPath, promise };
      try {
        return await promise;
      } finally {
        if (pendingWorkspaceRegistrationRef.current?.promise === promise) {
          pendingWorkspaceRegistrationRef.current = null;
        }
      }
    },
    [runtime],
  );

  const quoteSelection = useCallback((request: PreviewQuoteSelectionRequest) => {
    const quote = selectedQuoteFromText(request.selectedText, {
      source: "selection",
      file: {
        path: request.path,
        name: fileName(request.path),
        lineStart: request.lineStart ?? null,
        lineEnd: request.lineEnd ?? null,
        sourceStart: request.sourceStart ?? null,
        sourceEnd: request.sourceEnd ?? null,
      },
    });
    if (!quote) {
      return;
    }
    setQuoteChipRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      quote,
    }));
  }, []);

  useEffect(() => {
    if (!setPreviewHostContext) {
      return;
    }
    if (workspaceSelection.type !== "workspace") {
      setPreviewHostContext(null);
      return;
    }
    setPreviewHostContext({
      workspaceId: workspaceSelection.workspace.id,
      workspaceAvailable: true,
      workspaceLabel: workspaceSelection.workspace.root_path ?? workspaceSelection.workspace.name,
      runtime,
      onQuoteSelection: quoteSelection,
    });
  }, [quoteSelection, runtime, setPreviewHostContext, workspaceSelection]);

  useEffect(
    () => () => {
      setPreviewHostContext?.(null);
    },
    [setPreviewHostContext],
  );

  useEffect(() => {
    setSelectedSkill((current) => {
      if (!current || !selectedWorkspaceId) {
        return null;
      }
      return workspaceSkills.some((skill) => skill.name === current.name && skill.source === current.source)
        ? current
        : null;
    });
  }, [selectedWorkspaceId, workspaceSkills]);

  useEffect(() => {
    if (!backendReady) {
      setWorkspaceLoading(false);
      setWorkspaces([]);
      return;
    }
    let active = true;
    setWorkspaceLoading(true);
    void runtime.workspaces
      .list()
      .then((response) => {
        if (!active) {
          return;
        }
        setWorkspaces(response.list);
        if (!selectionTouchedRef.current && initialSessionType === "chat") {
          setWorkspaceSelection({ type: "chat" });
          return;
        }
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
  }, [backendReady, initialSessionType, initialWorkspaceId, notifications, runtime]);

  useEffect(() => {
    if (!backendReady || workspaceSelection.type !== "pending") {
      return;
    }

    let active = true;
    const { rootPath } = workspaceSelection;
    void registerWorkspacePath(rootPath)
      .then((workspace) => {
        if (!active) {
          return;
        }
        upsertWorkspace(workspace);
        selectWorkspaceIfStillPending(rootPath, workspace);
      })
      .catch((reason: unknown) => {
        if (active) {
          notifications.error(errorMessage(reason));
        }
      });

    return () => {
      active = false;
    };
  }, [
    backendReady,
    notifications,
    registerWorkspacePath,
    selectWorkspaceIfStillPending,
    upsertWorkspace,
    workspaceSelection,
  ]);

  const canSubmit =
    backendReady &&
    draft.trim().length > 0 &&
    !submitting &&
    modelSelection.modelLoadState !== "loading";
  const sendLoading =
    !backendError && (!backendReady || workspaceSelection.type === "pending" || modelSelection.modelLoadState === "loading");
  const title =
    workspaceSelection.type === "workspace"
      ? `我们应该在 ${workspaceSelection.workspace.name} 中构建什么？`
      : workspaceSelection.type === "pending"
        ? `我们应该在 ${workspaceSelection.name} 中构建什么？`
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
          const renderContext = {
            workspaceId: workspaceSelection.workspace.id,
            workspaceAvailable: true,
            workspaceLabel: workspaceSelection.workspace.root_path ?? workspaceSelection.workspace.name,
            runtime,
            onQuoteSelection: quoteSelection,
          };
          if (file.type === "directory") {
            previewContext.openDirectoryPanel(file.path, renderContext);
            return;
          }
          previewContext.openFilePanel(file.path, renderContext, selectedFileRevealTarget(file));
        }
      : undefined;

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    if (goalError) {
      setGoalError(null);
    }
  }, [goalError]);

  const handleSlashCommand = useCallback((command: SlashCommand) => {
    if (command.id !== "goal") {
      return;
    }
    setGoalComposerOpen(true);
    setGoalError(null);
  }, []);

  const closeGoalComposer = useCallback(() => {
    if (submitting) {
      return;
    }
    setGoalComposerOpen(false);
    setGoalError(null);
  }, [submitting]);

  const goalModeAccessory = useMemo(() => {
    if (!goalComposerOpen) {
      return null;
    }
    return <GoalModeAccessory creating={submitting} error={goalError} onClose={closeGoalComposer} />;
  }, [closeGoalComposer, goalComposerOpen, goalError, submitting]);

  const submit = async (
    files: SelectedFile[] = [],
    quotes: SelectedQuote[] = [],
    imageAttachments: SelectedImageAttachment[] = [],
  ) => {
    const prepared = prepareComposerMessage(draft, files, { quotes, selectedSkill });
    const attachments = imageAttachments.map(agentAttachmentFromSelected);
    const text = prepared.message;
    if ((!text && !prepared.contextItems.length && !attachments.length) || submitting) {
      return false;
    }

    setSubmitting(true);
    try {
      if (!backendReady) {
        notifications.warning("本地服务尚未就绪");
        return false;
      }
      const model = modelSelection.selectedModel;
      if (!model) {
        notifications.error("请先选择模型");
        onOpenModelSettings();
        return false;
      }

      let sessionWorkspace: Workspace | null = null;
      if (workspaceSelection.type === "workspace") {
        sessionWorkspace = workspaceSelection.workspace;
      } else if (workspaceSelection.type === "pending") {
        const { rootPath } = workspaceSelection;
        const workspace = await registerWorkspacePath(rootPath);
        upsertWorkspace(workspace);
        selectWorkspaceIfStillPending(rootPath, workspace);
        sessionWorkspace = workspace;
      }

      const sessionPayload =
        sessionWorkspace
          ? {
              title: sessionTitleFromPreparedMessage(text, prepared.contextItems),
              session_tag: "chat",
              sessionType: "workspace" as const,
              workspaceId: sessionWorkspace.id,
              currentModelProviderId: model.providerId,
              currentModel: model.model,
            }
          : {
              title: sessionTitleFromPreparedMessage(text, prepared.contextItems),
              session_tag: "chat",
              sessionType: "chat" as const,
              currentModelProviderId: model.providerId,
              currentModel: model.model,
            };

      const session = await runtime.conversation.createSession(sessionPayload);
      const goalItem = goalComposerOpen ? goalContextItem(text) : null;
      let goalTask: ThreadTask | null = null;
      if (goalComposerOpen) {
        try {
          goalTask = await runtime.conversation.createThreadTask(session.id, {
            type: "goal",
            objective: text,
            metadata: goalSeedContextMetadata({
              message: text,
              contextItems: prepared.contextItems,
              runtimeParams: prepared.runtimeParams,
              attachments,
            }),
          });
        } catch (reason) {
          setGoalError(errorMessage(reason));
          return false;
        }
      }
      const runtimeParams = goalItem && goalTask
        ? runtimeParamsWithInitialGoalTask(
            runtimeParamsWithGoalContextItem(prepared.runtimeParams, goalItem),
            goalTask,
          )
        : goalItem
          ? runtimeParamsWithGoalContextItem(prepared.runtimeParams, goalItem)
          : prepared.runtimeParams;
      const contextItems = goalItem ? [...prepared.contextItems, goalItem] : prepared.contextItems;
      emitSessionCreated(session);
      setDraft("");
      setSelectedSkill(null);
      setGoalComposerOpen(false);
      setGoalError(null);
      const injectionOptions = runtimeParams || contextItems.length || attachments.length
        ? {
            runtimeParams,
            contextItems,
            attachments,
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
          sendLoading={sendLoading}
          variant="keydex"
          autoFocusKey={autoFocusInputKey}
          className={styles.compactComposer}
          allowFileSelection={workspaceSelection.type === "workspace"}
          fileAccessMode={fileAccessMode}
          workspaceRoots={workspaceSelection.type === "workspace" ? [workspaceSelection.workspace.root_path] : []}
          workspaceSkills={workspaceSkills}
          selectedSkill={selectedSkill}
          allowBypassConversationSlashCommand={false}
          allowContextCompressionSlashCommand={false}
          onListWorkspaceDirectory={listWorkspaceDirectory}
          onSearchWorkspace={searchWorkspace}
          contextBar={
            <WorkspaceSelector
              value={workspaceSelection}
              workspaces={workspaces}
              loading={backendReady && workspaceLoading}
              disabled={submitting}
              onSelectChat={() => {
                selectionTouchedRef.current = true;
                setSelectedSkill(null);
                setWorkspaceSelection({ type: "chat" });
              }}
              onSelectWorkspace={(workspace) => {
                selectionTouchedRef.current = true;
                setSelectedSkill(null);
                setWorkspaceSelection({ type: "workspace", workspace });
              }}
              onAddWorkspace={async (rootPath) => {
                selectionTouchedRef.current = true;
                setSelectedSkill(null);
                if (!backendReady) {
                  setWorkspaceSelection({
                    type: "pending",
                    rootPath,
                    name: workspaceNameFromPath(rootPath),
                  });
                  return;
                }
                const workspace = await registerWorkspacePath(rootPath);
                upsertWorkspace(workspace);
                setWorkspaceSelection({ type: "workspace", workspace });
              }}
              onPickWorkspacePath={pickWorkspacePath}
            />
          }
          rightControls={
            <RuntimeModelSelector
              model={modelSelection.selectedModel}
              modelOptions={modelSelection.modelOptions}
              modelLoadState={!backendReady && !backendError ? "loading" : modelSelection.modelLoadState}
              modelError={modelSelection.modelError}
              disabled={submitting || !backendReady}
              onModelChange={modelSelection.setSelectedModel}
              onOpenModelSettings={onOpenModelSettings}
            />
          }
          leftAccessory={goalModeAccessory}
          onChange={handleDraftChange}
          onSkillChange={setSelectedSkill}
          onRefreshWorkspaceSkills={() => refreshWorkspaceSkills({ forceReload: true })}
          onSend={submit}
          onStop={() => undefined}
          onSlashCommand={handleSlashCommand}
          runtime={runtime}
          onOpenFileReference={openFileReference}
          externalQuoteRequest={quoteChipRequest}
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

function selectedFileRevealTarget(file: SelectedFile): PreviewFileRevealTarget | null {
  const annotationId = file.annotationReference?.annotationId.trim() || null;
  if (!annotationId && !file.lineStart && !file.lineEnd && file.sourceStart == null && file.sourceEnd == null) {
    return null;
  }
  return {
    annotationId,
    selectedText: file.selectedText ?? null,
    lineStart: file.lineStart ?? null,
    lineEnd: file.lineEnd ?? null,
    sourceStart: file.sourceStart ?? null,
    sourceEnd: file.sourceEnd ?? null,
  };
}

function sessionTitleFromPreparedMessage(text: string, contextItems: AgentContextItem[]): string {
  const title = text.trim() || contextItems[0]?.label || "新对话";
  return title.slice(0, 32);
}

function workspaceNameFromPath(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || "新项目";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
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
