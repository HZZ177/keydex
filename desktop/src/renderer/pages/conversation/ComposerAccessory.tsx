import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Circle,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Target,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeTypingMetrics } from "@/renderer/hooks/useRuntimeTypingSpeed";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { FileReviewChange } from "@/renderer/utils/fileReview";
import type { ThreadTask, ThreadTaskRun } from "@/types/protocol";

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
  node: ReactNode;
  priority: number;
}

export function ConversationComposerAccessory({
  messages,
  activeTask = null,
  runningTaskRun = null,
  onUpdateTask,
  onDeleteTask,
  showScrollToBottom,
  showScrollButton = true,
  onFilePreview,
  onScrollToBottom,
}: {
  messages: ConversationMessage[];
  activeTask?: ThreadTask | null;
  runningTaskRun?: ThreadTaskRun | null;
  onUpdateTask?: (taskId: string, payload: ThreadTaskUpdatePayload) => Promise<unknown> | unknown;
  onDeleteTask?: (taskId: string) => Promise<unknown> | unknown;
  showScrollToBottom: boolean;
  showScrollButton?: boolean;
  onFilePreview: (file: FileChangePreview) => void;
  onScrollToBottom: () => void;
}) {
  const runtimeTypingMetrics = useRuntimeTypingMetrics();
  const fileChangeSummary = useMemo(() => buildActiveTurnFileChangeSummary(messages), [messages]);
  const planSummary = useMemo(() => buildActiveTurnPlanSummary(messages), [messages]);
  const activeTaskRunning = Boolean(
    activeTask && runningTaskRun && runningTaskRun.task_id === activeTask.id && runningTaskRun.status === "running",
  );
  const accessoryItems = useMemo<ComposerAccessoryStatusItem[]>(
    () => [
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
      fileChangeSummary,
      onDeleteTask,
      onFilePreview,
      onUpdateTask,
      planSummary,
      runtimeTypingMetrics.backlog,
      runtimeTypingMetrics.speed,
    ],
  );
  const activeItems = useMemo(
    () => accessoryItems.filter((item) => item.active).sort((left, right) => right.priority - left.priority),
    [accessoryItems],
  );
  const autoSelectedId = activeItems[0]?.id ?? "runtime-typing-speed";
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
  const selectedItem = manualSelectedItem ?? activeItems[0] ?? accessoryItems[0];

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
