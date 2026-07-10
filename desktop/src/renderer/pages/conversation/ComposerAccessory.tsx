import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Circle,
  CircleCheck,
  CircleX,
  CornerDownLeft,
  GripVertical,
  ListEnd,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Target,
  Trash2,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { RuntimeBridge } from "@/runtime";
import { useRuntimeTypingMetrics } from "@/renderer/hooks/useRuntimeTypingSpeed";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { FileReviewChange } from "@/renderer/utils/fileReview";
import type { AgentPendingInput, PendingInputMode, ThreadTask, ThreadTaskRun } from "@/types/protocol";

import { McpRuntimePill } from "./McpRuntimePanel";
import { type FileChangePreview } from "./messages";
import { LineChangeTicker } from "./messages/LineChangeTicker";
import styles from "./ComposerAccessory.module.css";
import {
  buildActiveTurnFileChangeSummary,
  type TurnFileChangeItem,
  type TurnFileChangeSummary,
} from "./turnFileChangeSummary";
import { buildActiveTurnPlanSummary, type TurnPlanEntry, type TurnPlanSummary } from "./turnPlanSummary";

type ThreadTaskUpdatePayload = {
  objective?: string | null;
  status?: "active" | "paused" | "cancelled" | null;
};

interface ComposerAccessoryStatusItem {
  active: boolean;
  description: string;
  id: string;
  label: string;
  manualOnly?: boolean;
  node: ReactNode;
  priority: number;
}

export function ConversationComposerAccessory({
  messages,
  activeTask = null,
  pendingInputs = [],
  runningTaskRun = null,
  mcpRuntime = null,
  onUpdateTask,
  onDeleteTask,
  onPendingInputModeChange,
  onPendingInputReorder,
  onPendingInputCancel,
  onPendingInputResume,
  onPendingInputEdit,
  onOpenMcpSettings,
  showScrollToBottom,
  showScrollButton = true,
  onFilePreview,
  onScrollToBottom,
}: {
  messages: ConversationMessage[];
  pendingInputs?: AgentPendingInput[];
  activeTask?: ThreadTask | null;
  runningTaskRun?: ThreadTaskRun | null;
  mcpRuntime?: {
    runtime: RuntimeBridge;
    sessionId: string;
    runtimeState: string;
  } | null;
  onUpdateTask?: (taskId: string, payload: ThreadTaskUpdatePayload) => Promise<unknown> | unknown;
  onDeleteTask?: (taskId: string) => Promise<unknown> | unknown;
  onPendingInputModeChange?: (pendingInputId: string, mode: PendingInputMode) => Promise<unknown> | unknown;
  onPendingInputReorder?: (pendingInputIds: string[]) => Promise<unknown> | unknown;
  onPendingInputCancel?: (pendingInputId: string) => Promise<unknown> | unknown;
  onPendingInputResume?: (target: { pendingInputId?: string; mode?: PendingInputMode }) => Promise<unknown> | unknown;
  onPendingInputEdit?: (pendingInput: AgentPendingInput) => Promise<unknown> | unknown;
  onOpenMcpSettings?: () => void;
  showScrollToBottom: boolean;
  showScrollButton?: boolean;
  onFilePreview: (file: FileChangePreview) => void;
  onScrollToBottom: () => void;
}) {
  const runtimeTypingMetrics = useRuntimeTypingMetrics();
  const fileChangeSummary = useMemo(() => buildActiveTurnFileChangeSummary(messages), [messages]);
  const planSummary = useMemo(() => buildActiveTurnPlanSummary(messages), [messages]);
  const activeTurnHasMcpTool = useMemo(() => activeTurnContainsMcpTool(messages), [messages]);
  const activeTaskRunning = Boolean(
    activeTask && runningTaskRun && runningTaskRun.task_id === activeTask.id && runningTaskRun.status === "running",
  );
  const accessoryItems = useMemo<ComposerAccessoryStatusItem[]>(
    () => [
      {
        id: "pending-inputs",
        active: pendingInputs.length > 0,
        description: pendingInputs.length > 0 ? `${pendingInputs.length} 条待处理输入` : "暂无待处理输入",
        label: "待发送",
        priority: 220,
        node: pendingInputs.length ? (
          <PendingInputsPill
            inputs={pendingInputs}
            onModeChange={onPendingInputModeChange}
            onReorder={onPendingInputReorder}
            onCancel={onPendingInputCancel}
            onResume={onPendingInputResume}
            onEdit={onPendingInputEdit}
          />
        ) : null,
      },
      {
        id: "thread-task",
        active: Boolean(activeTask),
        description: activeTask ? threadTaskMenuDescription(activeTask, activeTaskRunning) : "暂无长程任务",
        label: activeTask ? threadTaskTypeLabel(activeTask) : "目标",
        priority: 140,
        node: activeTask ? (
          <ThreadTaskPill
            task={activeTask}
            running={activeTaskRunning}
            onUpdateTask={onUpdateTask}
            onDeleteTask={onDeleteTask}
          />
        ) : null,
      },
      {
        id: "mcp-runtime",
        active: Boolean(mcpRuntime),
        description: activeTurnHasMcpTool ? "本轮已调用 MCP 工具" : "当前会话 MCP runtime",
        label: "MCP",
        manualOnly: !activeTurnHasMcpTool,
        priority: 160,
        node: mcpRuntime ? (
          <McpRuntimePill
            runtime={mcpRuntime.runtime}
            sessionId={mcpRuntime.sessionId}
            runtimeState={mcpRuntime.runtimeState}
            onOpenSettings={onOpenMcpSettings}
          />
        ) : null,
      },
      {
        id: "turn-file-change-summary",
        active: fileChangeSummary.files.length > 0,
        description: fileChangeSummary.files.length > 0 ? "本轮文件变更统计" : "暂无文件变更",
        label: "文件变更",
        priority: 100,
        node: <TurnFileChangePill summary={fileChangeSummary} onFilePreview={onFilePreview} />,
      },
      {
        id: "turn-plan-summary",
        active: Boolean(planSummary),
        description: planSummary ? planMenuDescription(planSummary) : "暂无计划",
        label: "计划",
        priority: 80,
        node: planSummary ? <TurnPlanPill summary={planSummary} /> : null,
      },
      {
        id: "runtime-typing-speed",
        active: true,
        description: "打字速度和待输出字符",
        label: "打字机",
        priority: 0,
        node: <TypingSpeedPill speed={runtimeTypingMetrics.speed} backlog={runtimeTypingMetrics.backlog} />,
      },
    ],
    [
      activeTask,
      activeTaskRunning,
      activeTurnHasMcpTool,
      fileChangeSummary,
      mcpRuntime,
      onDeleteTask,
      onFilePreview,
      onOpenMcpSettings,
      onPendingInputCancel,
      onPendingInputResume,
      onPendingInputEdit,
      onPendingInputModeChange,
      onPendingInputReorder,
      onUpdateTask,
      pendingInputs,
      planSummary,
      runtimeTypingMetrics.backlog,
      runtimeTypingMetrics.speed,
    ],
  );
  const autoActiveItems = useMemo(
    () =>
      accessoryItems
        .filter((item) => item.active && !item.manualOnly)
        .sort((left, right) => right.priority - left.priority),
    [accessoryItems],
  );
  const autoSelectedId = autoActiveItems[0]?.id ?? "runtime-typing-speed";
  const [manualSelectedId, setManualSelectedId] = useState<string | null>(null);
  const previousAutoSelectedId = useRef(autoSelectedId);

  useEffect(() => {
    if (previousAutoSelectedId.current === autoSelectedId) {
      return;
    }
    previousAutoSelectedId.current = autoSelectedId;
    setManualSelectedId(null);
  }, [autoSelectedId]);

  useEffect(() => {
    if (!manualSelectedId) {
      return;
    }
    if (!accessoryItems.some((item) => item.id === manualSelectedId && item.active)) {
      setManualSelectedId(null);
    }
  }, [accessoryItems, manualSelectedId]);

  const manualSelectedItem = manualSelectedId
    ? accessoryItems.find((item) => item.id === manualSelectedId && item.active)
    : null;
  const selectedItem =
    manualSelectedItem ??
    autoActiveItems[0] ??
    accessoryItems.find((item) => item.id === "runtime-typing-speed") ??
    accessoryItems[0];

  return (
    <div className={styles.composerAccessoryBar} aria-label="输入框状态">
      <span className={styles.composerAccessoryItem} data-selected-item={selectedItem.id}>
        <span className={styles.accessoryShell} data-selected-item={selectedItem.id}>
          <ComposerAccessorySwitcher
            items={accessoryItems}
            selectedItemId={selectedItem.id}
            onSelect={setManualSelectedId}
          />
          <span className={styles.accessoryContent}>{selectedItem.node}</span>
        </span>
      </span>
      {showScrollButton ? (
        <button
          className={styles.scrollBottomButton}
          type="button"
          aria-label="滚动到底"
          data-tooltip-label="滚动到底"
          title="滚动到底"
          disabled={!showScrollToBottom}
          onClick={onScrollToBottom}
        >
          <ArrowDown size={15} />
        </button>
      ) : null}
    </div>
  );
}

function PendingInputsPill({
  inputs,
  onModeChange,
  onReorder,
  onCancel,
  onResume,
  onEdit,
}: {
  inputs: AgentPendingInput[];
  onModeChange?: (pendingInputId: string, mode: PendingInputMode) => Promise<unknown> | unknown;
  onReorder?: (pendingInputIds: string[]) => Promise<unknown> | unknown;
  onCancel?: (pendingInputId: string) => Promise<unknown> | unknown;
  onResume?: (target: { pendingInputId?: string; mode?: PendingInputMode }) => Promise<unknown> | unknown;
  onEdit?: (pendingInput: AgentPendingInput) => Promise<unknown> | unknown;
}) {
  const [orderedInputs, setOrderedInputs] = useState(inputs);

  useEffect(() => {
    setOrderedInputs(inputs);
  }, [inputs]);

  const steerInputs = orderedInputs.filter((input) => input.mode === "steer");
  const queueInputs = orderedInputs.filter((input) => input.mode === "queue");
  const hasPausedInputs = orderedInputs.some(isPendingInputPaused);

  const commitSectionOrder = (mode: PendingInputMode, nextIds: string[]) => {
    if (!onReorder) {
      return Promise.resolve();
    }
    const currentIds = orderedInputs
      .filter((input) => input.mode === mode && isPendingInputReorderable(input))
      .map(pendingInputId);
    if (arraysEqual(currentIds, nextIds)) {
      return Promise.resolve();
    }
    const previousInputs = orderedInputs;
    setOrderedInputs(applyPendingInputSectionOrder(orderedInputs, mode, nextIds));
    return Promise.resolve(onReorder(nextIds)).catch((reason) => {
      setOrderedInputs(previousInputs);
      throw reason;
    });
  };

  return (
    <div className={styles.pendingInputsPill} aria-label="待发送消息" data-testid="pending-inputs-pill">
      {hasPausedInputs ? (
        <div className={styles.pendingInputsPausedNotice} role="status">
          <Pause size={13} aria-hidden="true" />
          <span>等待发送时的轮次已被您主动停止，请选择如何处理以下待发送消息。</span>
        </div>
      ) : null}
      {steerInputs.length ? (
        <PendingInputSection
          mode="steer"
          inputs={steerInputs}
          onModeChange={onModeChange}
          onReorder={(ids) => commitSectionOrder("steer", ids)}
          onCancel={onCancel}
          onResume={onResume}
          onEdit={onEdit}
        />
      ) : null}
      {queueInputs.length ? (
        <PendingInputSection
          mode="queue"
          inputs={queueInputs}
          onModeChange={onModeChange}
          onReorder={(ids) => commitSectionOrder("queue", ids)}
          onCancel={onCancel}
          onResume={onResume}
          onEdit={onEdit}
        />
      ) : null}
    </div>
  );
}

function PendingInputSection({
  mode,
  inputs,
  onModeChange,
  onReorder,
  onCancel,
  onResume,
  onEdit,
}: {
  mode: PendingInputMode;
  inputs: AgentPendingInput[];
  onModeChange?: (pendingInputId: string, mode: PendingInputMode) => Promise<unknown> | unknown;
  onReorder: (pendingInputIds: string[]) => Promise<unknown>;
  onCancel?: (pendingInputId: string) => Promise<unknown> | unknown;
  onResume?: (target: { pendingInputId?: string; mode?: PendingInputMode }) => Promise<unknown> | unknown;
  onEdit?: (pendingInput: AgentPendingInput) => Promise<unknown> | unknown;
}) {
  const [draggedInputId, setDraggedInputId] = useState<string | null>(null);
  const [dragPreviewIds, setDragPreviewIds] = useState<string[] | null>(null);
  const draggedInputIdRef = useRef<string | null>(null);
  const dragInitialIdsRef = useRef<string[] | null>(null);
  const dragPreviewIdsRef = useRef<string[] | null>(null);
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>());
  const rowPositionsBeforeUpdateRef = useRef<Map<string, number> | null>(null);
  const rowAnimationsRef = useRef(new Map<string, Animation>());
  const reorderableIds = inputs
    .filter((input) => isPendingInputReorderable(input))
    .map((input) => pendingInputId(input));
  const displayedInputs = useMemo(
    () => dragPreviewIds ? applyPendingInputSectionOrder(inputs, mode, dragPreviewIds) : inputs,
    [dragPreviewIds, inputs, mode],
  );
  const canReorder = reorderableIds.length > 1;
  const pausedInputs = inputs.filter(isPendingInputPaused);
  const sectionTitle = mode === "steer" ? "引导当前轮次" : "等待队列";
  const sectionDescription = mode === "steer"
    ? "以下消息将在下一次模型请求前一次性发送给 Agent。"
    : "以下消息会在当前轮次结束后按顺序逐条发送。";

  const captureRowPositions = () => {
    rowPositionsBeforeUpdateRef.current = new Map(
      [...rowElementsRef.current.entries()].map(([id, element]) => [id, element.getBoundingClientRect().top]),
    );
  };

  useLayoutEffect(() => {
    const previousPositions = rowPositionsBeforeUpdateRef.current;
    if (!previousPositions) {
      return;
    }
    rowPositionsBeforeUpdateRef.current = null;
    for (const animation of rowAnimationsRef.current.values()) {
      animation.cancel();
    }
    rowAnimationsRef.current.clear();
    const reduceMotion = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      return;
    }
    for (const [id, element] of rowElementsRef.current) {
      const previousTop = previousPositions.get(id);
      if (previousTop === undefined) {
        continue;
      }
      const deltaY = previousTop - element.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 1 || typeof element.animate !== "function") {
        continue;
      }
      const animation = element.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 170, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
      rowAnimationsRef.current.set(id, animation);
    }
  }, [displayedInputs]);

  useEffect(() => () => {
    for (const animation of rowAnimationsRef.current.values()) {
      animation.cancel();
    }
  }, []);

  const resetDragState = () => {
    if (dragPreviewIdsRef.current) {
      captureRowPositions();
    }
    draggedInputIdRef.current = null;
    dragInitialIdsRef.current = null;
    dragPreviewIdsRef.current = null;
    setDraggedInputId(null);
    setDragPreviewIds(null);
  };

  const commitOrder = (nextIds: string[]) => {
    const initialIds = dragInitialIdsRef.current ?? reorderableIds;
    if (arraysEqual(nextIds, initialIds)) {
      resetDragState();
      return;
    }
    resetDragState();
    void onReorder(nextIds).catch(() => undefined);
  };

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, inputId: string) => {
    captureRowPositions();
    draggedInputIdRef.current = inputId;
    dragInitialIdsRef.current = reorderableIds;
    dragPreviewIdsRef.current = reorderableIds;
    setDraggedInputId(inputId);
    setDragPreviewIds(reorderableIds);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", inputId);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    const sourceId = draggedInputIdRef.current;
    if (!sourceId || !canReorder) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    if (sourceId === targetId) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const position: PendingInputDropPosition = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const currentIds = dragPreviewIdsRef.current ?? dragInitialIdsRef.current ?? reorderableIds;
    const nextIds = reorderPendingInputIds(currentIds, sourceId, targetId, position);
    if (arraysEqual(currentIds, nextIds)) {
      return;
    }
    captureRowPositions();
    dragPreviewIdsRef.current = nextIds;
    setDragPreviewIds(nextIds);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sourceId = draggedInputIdRef.current || event.dataTransfer?.getData("text/plain") || "";
    if (!sourceId || !canReorder) {
      resetDragState();
      return;
    }
    commitOrder(dragPreviewIdsRef.current ?? dragInitialIdsRef.current ?? reorderableIds);
  };

  const handleReorderKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, inputId: string) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }
    event.preventDefault();
    const sourceIndex = reorderableIds.indexOf(inputId);
    const targetIndex = sourceIndex + (event.key === "ArrowUp" ? -1 : 1);
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= reorderableIds.length) {
      return;
    }
    const nextIds = [...reorderableIds];
    [nextIds[sourceIndex], nextIds[targetIndex]] = [nextIds[targetIndex], nextIds[sourceIndex]];
    commitOrder(nextIds);
  };

  return (
    <section className={styles.pendingInputSection} data-mode={mode} aria-label={sectionTitle}>
      <header className={styles.pendingInputSectionHeader}>
        <span className={styles.pendingInputSectionCopy}>
          <strong>{sectionTitle}</strong>
          <span>{sectionDescription}</span>
        </span>
        {pausedInputs.length ? (
          <button
            className={styles.pendingInputResumeAll}
            type="button"
            aria-label={`恢复全部${sectionTitle}消息`}
            data-tooltip-label={`恢复全部${sectionTitle}消息`}
            disabled={!onResume}
            onClick={() => void onResume?.({ mode })}
          >
            <Play size={13} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div className={styles.pendingInputSectionRows} data-drag-active={draggedInputId ? "true" : "false"}>
      {displayedInputs.map((input) => {
        const id = pendingInputId(input);
        const nextMode: PendingInputMode = input.mode === "steer" ? "queue" : "steer";
        const ModeIcon = nextMode === "steer" ? CornerDownLeft : ListEnd;
        const nextModeLabel = nextMode === "steer" ? "改为引导" : "改为队列";
        const reorderable = canReorder && isPendingInputReorderable(input);
        const paused = isPendingInputPaused(input);
        const contentMeta = pendingInputContentMeta(input);
        return (
          <div
            className={styles.pendingInputRow}
            key={id}
            data-mode={input.mode}
            data-status={input.status}
            data-pending-input-id={id}
            data-dragging={draggedInputId === id ? "true" : "false"}
            data-drag-placeholder={draggedInputId === id ? "true" : "false"}
            data-paused={paused ? "true" : "false"}
            ref={(element) => {
              if (element) {
                rowElementsRef.current.set(id, element);
              } else {
                rowElementsRef.current.delete(id);
              }
            }}
            onDragOver={(event) => handleDragOver(event, id)}
            onDrop={handleDrop}
          >
            <button
              className={styles.pendingInputDragHandle}
              type="button"
              aria-label={`拖动调整顺序：${input.message}`}
              aria-grabbed={draggedInputId === id}
              data-tooltip-label="拖动排序"
              draggable={reorderable}
              disabled={!reorderable}
              onDragStart={(event) => handleDragStart(event, id)}
              onDragEnd={resetDragState}
              onKeyDown={(event) => handleReorderKeyDown(event, id)}
            >
              <GripVertical size={13} />
            </button>
            <span className={styles.pendingInputMeta} aria-hidden="true">
              {paused ? <Pause size={11} /> : null}
              <span className={styles.pendingInputStatus}>{pendingInputStatusLabel(input)}</span>
            </span>
            <span className={styles.pendingInputContent}>
              <span className={styles.pendingInputText}>{input.message || "仅包含上下文"}</span>
              {contentMeta ? <span className={styles.pendingInputContentMeta}>{contentMeta}</span> : null}
            </span>
            <span className={styles.pendingInputActions}>
              {paused ? (
                <button
                  className={styles.pendingInputAction}
                  type="button"
                  aria-label={`恢复待发送消息：${input.message}`}
                  data-tooltip-label="恢复这条消息"
                  disabled={!onResume}
                  onClick={() => void onResume?.({ pendingInputId: id })}
                >
                  <Play size={13} />
                </button>
              ) : null}
              <button
                className={styles.pendingInputAction}
                type="button"
                aria-label={`${nextModeLabel}：${input.message}`}
                data-tooltip-label={nextModeLabel}
                disabled={!onModeChange || (input.status !== "pending_steer" && input.status !== "queued")}
                onClick={() => {
                  void onModeChange?.(id, nextMode);
                }}
              >
                <ModeIcon size={13} />
              </button>
              <button
                className={styles.pendingInputAction}
                type="button"
                aria-label={`编辑待发送消息：${input.message}`}
                data-tooltip-label="编辑"
                disabled={!onEdit}
                onClick={() => {
                  void onEdit?.(input);
                }}
              >
                <Pencil size={13} />
              </button>
              <button
                className={styles.pendingInputAction}
                type="button"
                aria-label={`删除待发送消息：${input.message}`}
                data-tooltip-label="删除"
                disabled={!onCancel}
                onClick={() => {
                  void onCancel?.(id);
                }}
              >
                <Trash2 size={13} />
              </button>
            </span>
          </div>
        );
      })}
      </div>
    </section>
  );
}

type PendingInputDropPosition = "before" | "after";

function pendingInputId(input: AgentPendingInput): string {
  return input.pending_input_id || input.id;
}

function isPendingInputReorderable(input: AgentPendingInput): boolean {
  return input.status === "pending_steer" || input.status === "queued";
}

function reorderPendingInputIds(
  ids: string[],
  sourceId: string,
  targetId: string,
  position: PendingInputDropPosition,
): string[] {
  const next = ids.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0 || !ids.includes(sourceId)) {
    return ids;
  }
  next.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceId);
  return next;
}

function applyPendingInputSectionOrder(
  inputs: AgentPendingInput[],
  mode: PendingInputMode,
  ids: string[],
): AgentPendingInput[] {
  const byId = new Map(inputs.map((input) => [pendingInputId(input), input]));
  let nextIndex = 0;
  return inputs.map((input) => {
    if (input.mode !== mode || !isPendingInputReorderable(input)) {
      return input;
    }
    const next = byId.get(ids[nextIndex]);
    nextIndex += 1;
    return next ?? input;
  });
}

function isPendingInputPaused(input: AgentPendingInput): boolean {
  return Boolean(input.paused_at || input.paused);
}

function pendingInputContentMeta(input: AgentPendingInput): string {
  const attachmentCount = input.attachments?.length ?? 0;
  const runtimeParams = input.runtime_params ?? {};
  const rawContextItems = runtimeParams.message_context_items ?? runtimeParams.messageContextItems;
  const contextCount = Array.isArray(rawContextItems) ? rawContextItems.length : 0;
  return [
    attachmentCount ? `${attachmentCount} 个附件` : "",
    contextCount ? `${contextCount} 个上下文` : "",
  ].filter(Boolean).join(" · ");
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function pendingInputStatusLabel(input: AgentPendingInput): string {
  if (isPendingInputPaused(input)) {
    return "已暂停";
  }
  const { status } = input;
  if (status === "pending_steer") {
    return "等待注入";
  }
  if (status === "queued") {
    return "等待发送";
  }
  if (status === "starting" || status === "running") {
    return "发送中";
  }
  return "已处理";
}

function activeTurnContainsMcpTool(messages: ConversationMessage[]): boolean {
  const lastUserIndex = messages.findLastIndex((message) => message.kind === "user");
  return messages.slice(lastUserIndex + 1).some(isMcpToolMessage);
}

function isMcpToolMessage(message: ConversationMessage): boolean {
  if (message.kind !== "tool") {
    return false;
  }
  const payload = asRecord(message.payload);
  const call = asRecord(payload?.call);
  const result = asRecord(payload?.result);
  const metadata = asRecord(payload?.metadata);
  const callMetadata = asRecord(call?.metadata);
  const resultMetadata = asRecord(result?.metadata);
  const toolName =
    stringValue(call?.name) ||
    stringValue(payload?.tool) ||
    stringValue(payload?.tool_name) ||
    stringValue(payload?.toolName);
  const mcpRecords = [
    asRecord(metadata?.mcp),
    asRecord(callMetadata?.mcp),
    asRecord(resultMetadata?.mcp),
    asRecord(payload?.mcp),
    asRecord(call?.mcp),
    asRecord(result?.mcp),
  ];
  return (
    toolName.startsWith("mcp__") ||
    mcpRecords.some((record) =>
      Boolean(record?.kind === "mcp_tool" || record?.server_id || record?.server_name || record?.raw_tool_name),
    )
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ComposerAccessorySwitcher({
  items,
  selectedItemId,
  onSelect,
}: {
  items: ComposerAccessoryStatusItem[];
  selectedItemId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <span className={styles.accessorySwitch} ref={rootRef}>
      <button
        className={styles.accessorySwitchButton}
        type="button"
        aria-label="切换胶囊信息"
        data-tooltip-label="切换胶囊信息"
        aria-expanded={open}
        aria-haspopup="menu"
        data-open={open ? "true" : "false"}
        data-testid="composer-accessory-switcher"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronsUpDown size={13} />
      </button>
      <div
        className={styles.accessoryMenu}
        role="menu"
        aria-hidden={!open}
        data-open={open ? "true" : "false"}
        data-testid="composer-accessory-menu"
      >
        {items.map((item) => {
          const selected = item.id === selectedItemId;
          return (
            <button
              className={styles.accessoryMenuItem}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              disabled={!item.active}
              tabIndex={open ? 0 : -1}
              key={item.id}
              onClick={() => {
                if (!item.active) {
                  return;
                }
                onSelect(item.id);
                setOpen(false);
              }}
            >
              <span className={styles.accessoryMenuCheck} aria-hidden="true">
                {selected ? <Check size={13} /> : null}
              </span>
              <span className={styles.accessoryMenuText}>
                <span className={styles.accessoryMenuLabel}>{item.label}</span>
                <span className={styles.accessoryMenuDescription}>{item.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </span>
  );
}

function TypingSpeedPill({ speed, backlog }: { speed: number; backlog: number }) {
  return (
    <span className={styles.typingSpeedPill} data-testid="typing-speed-pill">
      打字机 {speed} 字符/s - 待输出 {backlog} 字
    </span>
  );
}

function ThreadTaskPill({
  task,
  running,
  onUpdateTask,
  onDeleteTask,
}: {
  task: ThreadTask;
  running: boolean;
  onUpdateTask?: (taskId: string, payload: ThreadTaskUpdatePayload) => Promise<unknown> | unknown;
  onDeleteTask?: (taskId: string) => Promise<unknown> | unknown;
}) {
  const status = running ? "running" : task.status;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.objective);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminal = task.is_terminal || task.status === "complete" || task.status === "system_stopped" || task.status === "cancelled";
  const canPause = task.status === "active";
  const canResume = task.status === "paused" || task.status === "blocked";
  const typeLabel = threadTaskTypeLabel(task);

  useEffect(() => {
    setDraft(task.objective);
    setEditing(false);
    setConfirmDelete(false);
    setError(null);
  }, [task.id, task.objective, task.status]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const runTaskAction = async (action: () => Promise<unknown> | unknown) => {
    setWorking(true);
    setError(null);
    try {
      await action();
      setEditing(false);
      setConfirmDelete(false);
    } catch (reason) {
      setError(errorMessage(reason));
      setOpen(true);
    } finally {
      setWorking(false);
    }
  };

  return (
    <span
      className={styles.threadTaskPillWrap}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <span className={`${styles.typingSpeedPill} ${styles.threadTaskPill}`} data-testid="thread-task-pill">
        <button
          className={styles.threadTaskPreviewButton}
          type="button"
          aria-expanded={open}
          aria-label="查看目标详情"
          onClick={() => setOpen(true)}
        >
          <Target className={styles.threadTaskIcon} size={13} aria-hidden="true" />
          <span className={styles.threadTaskType}>{typeLabel}</span>
          <span className={styles.threadTaskStatus} data-status={status}>
            {running ? "运行中" : threadTaskStatusLabel(task.status)}
          </span>
          <span className={styles.threadTaskElapsed}>{formatThreadTaskElapsed(task.elapsed_seconds)}</span>
          <span className={styles.threadTaskObjective}>{task.objective}</span>
        </button>
        <span className={styles.threadTaskInlineActions} aria-label="目标快捷操作">
          {!terminal ? (
            <>
              <button
                className={styles.threadTaskIconButton}
                type="button"
                aria-label="编辑目标"
                title="编辑"
                disabled={working || !onUpdateTask}
                onClick={() => {
                  setEditing(true);
                  setOpen(true);
                }}
              >
                <Pencil size={13} aria-hidden="true" />
              </button>
              {canPause ? (
                <button
                  className={styles.threadTaskIconButton}
                  type="button"
                  aria-label="暂停目标"
                  title="暂停"
                  disabled={working || !onUpdateTask}
                  onClick={() => runTaskAction(() => onUpdateTask?.(task.id, { status: "paused" }))}
                >
                  <Pause size={13} aria-hidden="true" />
                </button>
              ) : null}
              {canResume ? (
                <button
                  className={styles.threadTaskIconButton}
                  type="button"
                  aria-label="恢复目标"
                  title="恢复"
                  disabled={working || !onUpdateTask}
                  onClick={() => runTaskAction(() => onUpdateTask?.(task.id, { status: "active" }))}
                >
                  <Play size={13} aria-hidden="true" />
                </button>
              ) : null}
              <button
                className={styles.threadTaskIconButton}
                type="button"
                aria-label={confirmDelete ? "确认删除目标" : "删除目标"}
                title={confirmDelete ? "确认删除" : "删除"}
                disabled={working || !onDeleteTask}
                data-danger="true"
                data-confirming={confirmDelete ? "true" : "false"}
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  void runTaskAction(() => onDeleteTask?.(task.id));
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </>
          ) : null}
          <button
            className={`${styles.threadTaskIconButton} ${styles.threadTaskChevronButton}`}
            type="button"
            aria-expanded={open}
            aria-label={open ? "收起目标详情" : "展开目标详情"}
            title={open ? "收起" : "展开"}
            data-open={open ? "true" : "false"}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </span>
      </span>
      <div
        className={styles.threadTaskPanel}
        role="dialog"
        aria-label="目标任务详情"
        aria-hidden={!open}
        data-open={open ? "true" : "false"}
        data-testid="thread-task-panel"
      >
        <div className={styles.threadTaskPanelHeader}>
          <span className={styles.threadTaskPanelType}>{typeLabel}</span>
          <span className={styles.threadTaskPanelStatus} data-status={status}>
            {running ? "运行中" : threadTaskStatusLabel(task.status)}
          </span>
        </div>
        {editing ? (
          <textarea
            className={styles.threadTaskEditInput}
            value={draft}
            aria-label="编辑目标内容"
            disabled={working}
            rows={4}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        ) : (
          <p className={styles.threadTaskPanelObjective}>{task.objective}</p>
        )}
        <dl className={styles.threadTaskMetaGrid}>
          <div>
            <dt>耗时</dt>
            <dd>{formatThreadTaskElapsed(task.elapsed_seconds)}</dd>
          </div>
          <div>
            <dt>轮次</dt>
            <dd>{task.turn_count}</dd>
          </div>
          <div>
            <dt>更新</dt>
            <dd>{formatTaskDate(task.updated_at)}</dd>
          </div>
        </dl>
        {task.evidence.length ? (
          <div className={styles.threadTaskEvidence}>
            <span>最近证据</span>
            <p>{String(task.evidence.at(-1) ?? "")}</p>
          </div>
        ) : null}
        {terminal ? <p className={styles.threadTaskTerminalHint}>任务已结束，可创建新目标。</p> : null}
        {error ? (
          <div className={styles.threadTaskActionError} role="alert">
            {error}
          </div>
        ) : null}
        {!terminal && editing ? (
          <div className={styles.threadTaskActions}>
            <button
              className={styles.threadTaskActionButton}
              type="button"
              disabled={working}
              onClick={() => {
                setEditing(false);
                setDraft(task.objective);
              }}
            >
              取消
            </button>
            <button
              className={styles.threadTaskActionButton}
              type="button"
              disabled={working || !draft.trim() || !onUpdateTask}
              onClick={() => runTaskAction(() => onUpdateTask?.(task.id, { objective: draft.trim() }))}
            >
              保存
            </button>
          </div>
        ) : null}
      </div>
    </span>
  );
}

function TurnFileChangePill({
  summary,
  onFilePreview,
}: {
  summary: TurnFileChangeSummary;
  onFilePreview: (file: FileChangePreview) => void;
}) {
  return (
    <div className={styles.fileChangePillWrap}>
      <span className={`${styles.typingSpeedPill} ${styles.fileChangeSummaryPill}`} data-testid="file-change-summary-pill">
        <span className={styles.fileChangeSummaryText}>
          本轮共创建了 {summary.createdCount} 个文件，编辑了 {summary.editedCount} 个文件
        </span>
        <LineChangeTicker
          className={styles.composerLineTicker}
          label=""
          added={summary.additions}
          removed={summary.deletions}
          unit=""
        />
      </span>
      <div className={styles.fileChangeHoverCard} role="tooltip" data-testid="file-change-summary-card">
        <header className={styles.fileChangeCardHeader}>
          <span>本轮文件变更</span>
          <LineChangeTicker
            className={styles.cardLineTicker}
            label="共"
            added={summary.additions}
            removed={summary.deletions}
            unit=""
          />
        </header>
        <div className={styles.fileChangeCardStats}>
          <span>创建 {summary.createdCount}</span>
          <span>编辑 {summary.editedCount}</span>
        </div>
        <ul className={styles.fileChangeCardList}>
          {summary.files.map((file) => (
            <TurnFileChangeRow file={file} key={`${file.kind}:${file.path}`} onFilePreview={onFilePreview} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function TurnPlanPill({ summary }: { summary: TurnPlanSummary }) {
  const activeStepNumber = Math.min(summary.activeIndex + 1, summary.totalCount);
  const activeContent = summary.activeEntry?.content ?? "计划已同步";
  const activeStatus = summary.activeEntry?.status ?? "completed";

  return (
    <div className={styles.planPillWrap}>
      <span className={`${styles.typingSpeedPill} ${styles.planSummaryPill}`} data-testid="plan-summary-pill">
        <span className={styles.planSummaryIcon} data-status={activeStatus} aria-hidden="true">
          {activeStatus === "failed" ? (
            <CircleX size={13} />
          ) : activeStatus === "completed" ? (
            <CircleCheck size={13} />
          ) : activeStatus === "in_progress" ? (
            <LoaderCircle className={styles.planStatusLoading} size={13} />
          ) : (
            <Circle size={13} />
          )}
        </span>
        <span className={styles.planSummaryText}>
          第 {activeStepNumber} / {summary.totalCount} 步 · {activeContent}
          {activeStatus === "failed" ? " · 失败" : ""}
        </span>
      </span>
      <div className={styles.planHoverCard} role="tooltip" data-testid="plan-summary-card">
        <ol className={styles.planList} aria-label="当前计划">
          {summary.entries.map((entry, index) => (
            <TurnPlanRow entry={entry} key={`${entry.status}-${index}-${entry.content}`} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function TurnPlanRow({ entry }: { entry: TurnPlanEntry }) {
  return (
    <li className={styles.planRow} data-status={entry.status}>
      <span className={styles.planStatusIcon} aria-hidden="true">
        {entry.status === "completed" ? (
          <CircleCheck size={14} />
        ) : entry.status === "in_progress" ? (
          <LoaderCircle className={styles.planStatusLoading} size={14} />
        ) : entry.status === "failed" ? (
          <CircleX size={14} />
        ) : (
          <Circle size={14} />
        )}
      </span>
      <span className={styles.planRowText}>
        <span className={styles.planRowContent}>{entry.content}</span>
      </span>
    </li>
  );
}

function planMenuDescription(summary: TurnPlanSummary): string {
  const completed = `${summary.completedCount}/${summary.totalCount} 已完成`;
  return summary.failedCount > 0 ? `${completed}，${summary.failedCount} 失败` : completed;
}

function threadTaskMenuDescription(task: ThreadTask, running: boolean): string {
  const status = running ? "运行中" : threadTaskStatusLabel(task.status);
  return `${status} · ${task.objective}`;
}

function threadTaskTypeLabel(task: ThreadTask): string {
  return task.type_label || (task.type === "goal" ? "目标" : "任务");
}

function threadTaskStatusLabel(status: ThreadTask["status"]): string {
  switch (status) {
    case "active":
      return "进行中";
    case "paused":
      return "已暂停";
    case "blocked":
      return "已阻塞";
    case "complete":
      return "已完成";
    case "system_stopped":
      return "系统停止";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function formatThreadTaskElapsed(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (totalSeconds < 60) {
    return `${totalSeconds}秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}分`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes ? `${hours}小时${remainingMinutes}分` : `${hours}小时`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}天${remainingHours}小时` : `${days}天`;
}

function formatTaskDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
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

function TurnFileChangeRow({
  file,
  onFilePreview,
}: {
  file: TurnFileChangeItem;
  onFilePreview: (file: FileChangePreview) => void;
}) {
  return (
    <li className={styles.fileChangeCardRow}>
      <span className={styles.fileChangeKind} data-kind={file.kind}>
        {file.kind === "created" ? "创建" : "编辑"}
      </span>
      <button
        className={styles.fileChangePathButton}
        type="button"
        onClick={() =>
          onFilePreview({
            path: file.path,
            diff: file.diff,
            files: reviewFilesFromTurnSummaryFile(file),
            message: file.sourceMessage,
            messages: file.sourceMessages,
            title: "本轮文件变更",
          })
        }
      >
        {file.path}
      </button>
      <LineChangeTicker
        className={styles.cardFileLineTicker}
        label=""
        added={file.additions}
        removed={file.deletions}
        unit=""
      />
    </li>
  );
}

function reviewFilesFromTurnSummaryFile(file: TurnFileChangeItem): FileReviewChange[] {
  return [
    {
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      diff: file.diff,
      operation: file.kind === "created" ? "add" : "update",
      source: "streaming",
    },
  ];
}
