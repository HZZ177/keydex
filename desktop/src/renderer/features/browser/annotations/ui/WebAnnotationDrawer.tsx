import { BoxSelect, MousePointer2, Quote, RefreshCw, StickyNote, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ConfirmDialog } from "@/renderer/components/dialog";
import { useNotifications } from "@/renderer/providers/NotificationProvider";

import type { WebSelectionMode } from "../../runtime";
import type { WebAnnotationItem } from "../api";
import type { WebAnnotationVisibleStatus } from "../domain";
import type { WebAnnotationCoordinatorResolution, WebAnnotationNavigationResult } from "../runtime";
import type { WebAnnotationStore } from "../state/webAnnotationStore";
import type { AddWebAnnotationToComposerResult } from "@/renderer/events/webAnnotationContext";
import {
  type WebAnnotationSession,
  useWebAnnotationSession,
} from "../state/WebAnnotationSession";
import { WebAnnotationCard } from "./WebAnnotationCard";
import { WebAnnotationEditor, type WebAnnotationEditorValue } from "./WebAnnotationEditor";
import { RetargetFlow } from "./RetargetFlow";

import styles from "./WebAnnotationDrawer.module.css";

export function WebAnnotationDrawer({
  open,
  session,
  store,
  resolutions = {},
  resolutionDetails = {},
  profileMode = "persistent",
  showCreationActions = true,
  variant = "sidebar",
  onDelete,
  onNavigate,
  onAddToComposer,
  onCreateTemporaryReference,
  onDiscardTemporaryReference,
  onClose,
}: {
  readonly open: boolean;
  readonly session: WebAnnotationSession;
  readonly store: WebAnnotationStore;
  readonly resolutions?: Readonly<Record<string, WebAnnotationVisibleStatus | undefined>>;
  readonly resolutionDetails?: Readonly<Record<string, WebAnnotationCoordinatorResolution | undefined>>;
  readonly profileMode?: "persistent" | "incognito";
  readonly showCreationActions?: boolean;
  readonly variant?: "sidebar" | "shelf";
  onDelete(item: WebAnnotationItem): Promise<void>;
  onNavigate?(item: WebAnnotationItem): Promise<WebAnnotationNavigationResult>;
  onAddToComposer?(item: WebAnnotationItem): AddWebAnnotationToComposerResult;
  onCreateTemporaryReference?(
    draft: import("../state/WebAnnotationSession").WebAnnotationDraft,
    value: WebAnnotationEditorValue,
  ): Promise<AddWebAnnotationToComposerResult>;
  onDiscardTemporaryReference?(draftId: string): void;
  onClose(): void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const sessionState = useWebAnnotationSession(session);
  const notifications = useNotifications();
  const [deleteTarget, setDeleteTarget] = useState<WebAnnotationItem | null>(null);
  const [retargetItem, setRetargetItem] = useState<WebAnnotationItem | null>(null);
  const [retargetConflict, setRetargetConflict] = useState<string | null>(null);
  const [temporaryConfirmation, setTemporaryConfirmation] = useState<{
    readonly draft: import("../state/WebAnnotationSession").WebAnnotationDraft;
    readonly value: WebAnnotationEditorValue;
  } | null>(null);
  const [temporaryPending, setTemporaryPending] = useState(false);
  const notifiedErrorRef = useRef<string | null>(null);
  const entry = state.activePage ? state.pages[state.activePage.pageKey] : null;
  const incognito = profileMode === "incognito";
  const pending = state.mutation !== null || temporaryPending;
  const annotationGroups = groupAnnotationsByResolution(entry?.items ?? [], resolutions);

  useEffect(() => {
    const message = entry?.error ?? state.mutationError;
    if (!message || notifiedErrorRef.current === message) return;
    notifiedErrorRef.current = message;
    notifications.error(message, { title: "网页批注操作失败" });
  }, [entry?.error, notifications, state.mutationError]);

  useEffect(() => {
    if (
      retargetItem
      && sessionState.status === "idle"
      && sessionState.lastExitReason !== null
      && sessionState.lastExitReason !== "saved"
    ) {
      setRetargetItem(null);
      setRetargetConflict(null);
    }
  }, [retargetItem, sessionState]);

  useEffect(() => {
    if (sessionState.status !== "draft") setTemporaryConfirmation(null);
  }, [sessionState.status]);

  if (!open) return null;
  const beginSelection = (mode: WebSelectionMode) => {
    onClose();
    void session.startSelection(mode).catch((error: unknown) => {
      notifications.error(error instanceof Error ? error.message : "无法开始网页选择");
    });
  };
  const draft = sessionState.status === "draft" ? sessionState.draft : null;
  const retargetDraft = retargetItem && draft ? draft : null;
  const beginRetarget = (item: WebAnnotationItem) => {
    setRetargetItem(item);
    setRetargetConflict(null);
    onClose();
    void session.startSelection(item.annotation.target.type).catch((error: unknown) => {
      setRetargetItem(null);
      notifications.error(error instanceof Error ? error.message : "无法开始重新选择目标");
    });
  };

  return (
    <>
      <aside aria-label="网页批注" className={styles.sidebar} data-variant={variant}>
        {variant === "sidebar" ? <header className={styles.sidebarHeader}>
          <div className={styles.sidebarHeading}>
            <span className={styles.drawerTitle}><StickyNote size={15} />网页批注</span>
            <span className={styles.sidebarCount}>{entry?.items.length ?? 0}</span>
          </div>
          <button aria-label="隐藏网页批注侧栏" className={styles.sidebarClose} onClick={onClose} type="button">
            <X size={14} />
          </button>
          <span className={styles.sidebarDescription} title={state.activePage?.url ?? "当前网页"}>
            {state.activePage?.url ?? "当前网页"}
          </span>
        </header> : null}
        <div className={styles.drawerBody} data-custom-scrollbar="true">
        {showCreationActions ? (
          <div className={styles.selectionActions} aria-label="创建网页批注">
            <SelectionButton icon={<Quote size={14} />} label="选择文本" onClick={() => beginSelection("text")} />
            <SelectionButton icon={<MousePointer2 size={14} />} label="选择元素" onClick={() => beginSelection("element")} />
            <SelectionButton icon={<BoxSelect size={14} />} label="选择区域" onClick={() => beginSelection("region")} />
          </div>
        ) : null}
        {incognito ? (
          <div className={styles.incognitoNotice} role="note">
            <strong>无痕页面仅支持一次性引用</strong>
            <span>所选内容不会创建网页批注记录；确认发送后会成为当前任务历史的一部分。</span>
          </div>
        ) : null}
        {retargetItem && retargetDraft ? (
          <RetargetFlow
            conflictMessage={retargetConflict}
            draft={retargetDraft}
            item={retargetItem}
            pending={pending}
            onCancel={() => {
              session.cancelDraft();
              setRetargetItem(null);
              setRetargetConflict(null);
            }}
            onConfirm={() => {
              const capture = retargetDraft.evidence?.status === "ready" ? retargetDraft.evidence.asset : null;
              const asset = capture?.kind === "staged"
                ? { ...capture, kind: "staged" as const }
                : null;
              void store.getState().retargetAnnotation(retargetItem.annotation.id, {
                expectedRevision: retargetItem.annotation.revision,
                target: retargetDraft.target,
                ...(asset ? { stagedAsset: asset } : {}),
              }).then((result) => {
                if (result.status === "conflict") {
                  setRetargetItem(result.current);
                  setRetargetConflict(`批注已在其他位置更新，已载入服务端修订 ${result.current.annotation.revision}。请重新对比后确认。`);
                  notifications.warning("批注已更新，已载入服务端最新版本");
                  return;
                }
                session.completeDraftSave();
                setRetargetItem(null);
                setRetargetConflict(null);
                notifications.success("网页批注目标已更新");
              }).catch((error: unknown) => {
                notifications.error(error instanceof Error ? error.message : "重新绑定网页批注失败");
              });
            }}
          />
        ) : draft ? (
          <section className={styles.draft} aria-label="新建网页批注">
            <div className={styles.sectionHeading}>
              <strong>{incognito ? "临时引用" : "新批注"}</strong>
              <span>{targetLabel(draft.target.type)}</span>
            </div>
            <blockquote>{targetSummary(draft.target)}</blockquote>
            {draft.evidence?.status === "capturing" ? <p role="status">正在保存区域证据…</p> : null}
            {draft.evidence?.status === "failed" ? (
              <div className={styles.validationError} role="alert">区域证据保存失败：{draft.evidence.errorCategory}</div>
            ) : null}
            <WebAnnotationEditor
              pending={pending || (draft.target.type === "region" && draft.evidence?.status !== "ready")}
              submitLabel={incognito ? "添加到输入框" : "创建批注"}
              onCancel={() => session.cancelDraft()}
              onSubmit={(value) => {
                if (incognito) {
                  setTemporaryConfirmation({ draft, value });
                  return;
                }
                const capture = draft.evidence?.status === "ready" ? draft.evidence.asset : null;
                const asset = capture?.kind === "staged"
                  ? { ...capture, kind: "staged" as const }
                  : null;
                void store.getState().createAnnotation({
                  ...value,
                  target: draft.target,
                  ...(asset ? { stagedAsset: asset } : {}),
                }).then(() => {
                  session.completeDraftSave();
                  notifications.success("网页批注已创建");
                }).catch((error: unknown) => {
                  notifications.error(error instanceof Error ? error.message : "创建网页批注失败");
                });
              }}
            />
          </section>
        ) : null}
        {!incognito ? <section className={styles.listSection} aria-live="polite">
          <div className={styles.sectionHeading}>
            <strong>当前页面</strong>
            <span>{entry?.items.length ?? 0} 条</span>
          </div>
          {entry?.status === "loading" ? <DrawerState kind="loading" /> : null}
          {entry?.status === "error" ? (
            <DrawerState kind="error" message={entry.error ?? "加载失败"} onRetry={() => void store.getState().reload()} />
          ) : null}
          {entry?.status === "ready" && entry.items.length === 0 && !draft ? (
            <DrawerState
              kind="empty"
              message={showCreationActions
                ? "从上方选择文本、元素或区域开始。"
                : "点击顶部批注按钮，然后在页面中选择元素。"}
            />
          ) : null}
          {annotationGroups.map((group) => (
            <section
              aria-label={`${group.label}批注`}
              className={styles.statusGroup}
              data-resolution-group={group.kind}
              key={group.kind}
            >
              <header className={styles.statusGroupHeading}>
                <strong>{group.label}</strong>
                <span>{group.items.length}</span>
              </header>
              {group.items.map((item) => (
                <WebAnnotationCard
                  item={item}
                  key={item.annotation.id}
                  pending={pending}
                  resolution={resolutionDetails[item.annotation.id]}
                  status={resolutions[item.annotation.id]}
                  onDelete={setDeleteTarget}
                  onAddToComposer={onAddToComposer ? (current) => {
                    const result = onAddToComposer(current);
                    if (result === "added") notifications.success("网页批注已添加到输入框");
                    else if (result === "duplicate") notifications.info("该网页批注已在输入框中");
                    else if (result === "limit") notifications.warning("一次最多添加 20 条网页批注");
                    else notifications.error("当前没有可接收网页批注的输入框");
                  } : undefined}
                  onRetarget={beginRetarget}
                  onNavigate={onNavigate ? (current) => {
                    void onNavigate(current).then((result) => {
                      if (result.status === "revealed") {
                        notifications.success("已定位到网页批注");
                      } else if (result.status === "evidence_only") {
                        notifications.warning(result.resolution === "ambiguous"
                          ? "当前目标存在歧义，已打开来源页面但未自动定位"
                          : "当前目标已失联，已打开来源页面但未自动定位");
                      } else if (result.status === "unavailable") {
                        notifications.error(result.reason, { title: "无法定位网页批注" });
                      }
                    });
                  } : undefined}
                  onPatch={async (current, value) => {
                    const result = await store.getState().patchAnnotation(current.annotation.id, {
                      expectedRevision: current.annotation.revision,
                      ...value,
                    });
                    if (result.status === "conflict") {
                      notifications.warning("批注已更新，已载入服务端最新版本");
                    } else {
                      notifications.success("网页批注已保存");
                    }
                    return result;
                  }}
                />
              ))}
            </section>
          ))}
        </section> : null}
        </div>
      </aside>
      {deleteTarget ? (
        <ConfirmDialog
          cancelDisabled={pending}
          confirmDisabled={pending}
          confirmLabel="永久删除"
          confirmTone="danger"
          description="此操作会删除批注及其区域证据，并从尚未发送的输入框中移除对应胶囊；已经发送到对话的历史内容不受影响。"
          preview={<span>{deleteTarget.annotation.bodyMarkdown}</span>}
          title="删除网页批注？"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            void onDelete(deleteTarget).then(() => {
              setDeleteTarget(null);
              notifications.success("网页批注已删除");
            }).catch((error: unknown) => {
              notifications.error(error instanceof Error ? error.message : "删除网页批注失败");
            });
          }}
        />
      ) : null}
      {temporaryConfirmation ? (
        <ConfirmDialog
          cancelDisabled={temporaryPending}
          confirmDisabled={temporaryPending}
          confirmLabel={temporaryPending ? "正在添加…" : "确认并添加"}
          description="该页面处于无痕模式；发送后所选文字或截图将成为当前任务历史的一部分。Keydex 不会创建可恢复的网页批注记录。"
          preview={(
            <div>
              <strong>{targetSummary(temporaryConfirmation.draft.target)}</strong>
              <p>{temporaryConfirmation.value.bodyMarkdown}</p>
            </div>
          )}
          title="添加无痕网页引用？"
          onCancel={() => {
            onDiscardTemporaryReference?.(temporaryConfirmation.draft.draftId);
            session.cancelDraft();
            setTemporaryConfirmation(null);
          }}
          onConfirm={() => {
            if (!onCreateTemporaryReference || temporaryPending) return;
            setTemporaryPending(true);
            void onCreateTemporaryReference(
              temporaryConfirmation.draft,
              temporaryConfirmation.value,
            ).then((result) => {
              if (result === "added") {
                session.completeDraftSave();
                setTemporaryConfirmation(null);
                notifications.success("无痕网页引用已添加到输入框");
              } else if (result === "duplicate") {
                notifications.info("该无痕网页引用已在输入框中");
              } else if (result === "limit") {
                notifications.warning("一次最多添加 20 条网页引用");
              } else {
                notifications.error("当前没有可接收网页引用的输入框");
              }
            }).catch((error: unknown) => {
              notifications.error(error instanceof Error ? error.message : "添加无痕网页引用失败");
            }).finally(() => setTemporaryPending(false));
          }}
        />
      ) : null}
    </>
  );
}

function SelectionButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick(): void }) {
  return <button onClick={onClick} type="button">{icon}<span>{label}</span></button>;
}

function DrawerState({
  kind,
  message,
  onRetry,
}: {
  readonly kind: "empty" | "loading" | "error";
  readonly message?: string;
  onRetry?(): void;
}) {
  return (
    <div className={styles.drawerState} data-kind={kind} role={kind === "error" ? "alert" : "status"}>
      <StickyNote size={18} />
      <strong>{kind === "empty" ? "当前页面还没有批注" : kind === "loading" ? "正在加载批注…" : "批注加载失败"}</strong>
      <span>{message ?? ""}</span>
      {onRetry ? <button onClick={onRetry} type="button"><RefreshCw size={13} />重试</button> : null}
    </div>
  );
}

function targetLabel(type: "text" | "element" | "region"): string {
  return { text: "文本目标", element: "元素目标", region: "区域目标" }[type];
}

function targetSummary(target: WebAnnotationItem["annotation"]["target"]): string {
  if (target.type === "text") return target.quote.exact;
  if (target.type === "element") return target.accessibleName || target.textSummary || `<${target.tag}>`;
  return `页面区域 ${Math.round(target.rect.width)} × ${Math.round(target.rect.height)}`;
}

function groupAnnotationsByResolution(
  items: readonly WebAnnotationItem[],
  resolutions: Readonly<Record<string, WebAnnotationVisibleStatus | undefined>>,
): readonly {
  readonly kind: "attention" | "resolving" | "located";
  readonly label: string;
  readonly items: readonly WebAnnotationItem[];
}[] {
  const groups = [
    { kind: "attention" as const, label: "需要处理", items: [] as WebAnnotationItem[] },
    { kind: "resolving" as const, label: "正在解析", items: [] as WebAnnotationItem[] },
    { kind: "located" as const, label: "已定位", items: [] as WebAnnotationItem[] },
  ];
  for (const item of items) {
    const status = resolutions[item.annotation.id] ?? "pending";
    const group = status === "ambiguous" || status === "orphaned"
      ? groups[0]
      : status === "resolved" || status === "changed"
        ? groups[2]
        : groups[1];
    group.items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}
