import { CalendarDays, LocateFixed, Link2, MessageSquarePlus, Pencil, ScanSearch, Trash2 } from "lucide-react";
import { useState } from "react";

import type {
  WebAnnotationItem,
  WebAnnotationMutationResult,
} from "../api";
import {
  summarizeWebAnnotationChanges,
  visibleWebAnnotationStatus,
  type WebAnnotationChangeKind,
  type WebAnnotationChangeSummary,
  type WebAnnotationVisibleStatus,
} from "../domain";
import type { WebAnnotationCoordinatorResolution } from "../runtime";
import { WebAnnotationEditor, type WebAnnotationEditorValue } from "./WebAnnotationEditor";

import styles from "./WebAnnotationDrawer.module.css";

export function WebAnnotationCard({
  item,
  pending,
  status = "pending",
  resolution,
  onDelete,
  onNavigate,
  onPatch,
  onRetarget,
  onAddToComposer,
}: {
  readonly item: WebAnnotationItem;
  readonly pending: boolean;
  readonly status?: WebAnnotationVisibleStatus;
  readonly resolution?: WebAnnotationCoordinatorResolution;
  onDelete(item: WebAnnotationItem): void;
  onNavigate?(item: WebAnnotationItem): void;
  onPatch(item: WebAnnotationItem, value: WebAnnotationEditorValue): Promise<WebAnnotationMutationResult>;
  onRetarget?(item: WebAnnotationItem): void;
  onAddToComposer?(item: WebAnnotationItem): void;
}) {
  const [editing, setEditing] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const record = item.annotation;
  const target = targetPresentation(record.target);
  const settledResolution = resolution?.settled ?? resolution?.lastKnown ?? null;
  const visibleStatus = visibleWebAnnotationStatus(status);
  const changeSummary = summarizeWebAnnotationChanges(settledResolution?.evidence?.changedSignals);
  const candidateSummaries = (
    resolution?.settled?.evidence?.candidateSummaries
    ?? resolution?.lastKnown?.evidence?.candidateSummaries
    ?? []
  ).slice(0, 5);

  return (
    <article
      className={styles.card}
      data-editing={editing ? "true" : "false"}
      data-status={visibleStatus}
      data-target={record.target.type}
    >
      <header className={styles.cardHeader}>
        <span className={styles.targetBadge}>{target.label}</span>
        <span className={styles.statusBadge} data-status={visibleStatus}>{statusLabel(visibleStatus)}</span>
        {changeSummary.material ? (
          <span
            className={styles.changeBadge}
            data-change-kind={changeBadgeKind(changeSummary)}
            title={changeDescription(changeSummary)}
          >
            {changeLabel(changeSummary)}
          </span>
        ) : null}
        <span className={styles.compactTargetSummary}>{target.summary}</span>
        <time dateTime={record.createdAt}>{formatTime(record.createdAt)}</time>
      </header>
      <blockquote className={styles.targetSummary}>{target.summary}</blockquote>
      {status === "ambiguous" && candidateSummaries.length ? (
        <div className={styles.candidateList} aria-label="可能的目标">
          <span>找到 {resolution?.settled?.evidence?.candidateCount ?? candidateSummaries.length} 个可能目标，请重新选择确认：</span>
          {candidateSummaries.map((candidate) => (
            <button key={candidate.candidateId} disabled={pending} onClick={() => onRetarget?.(item)} type="button">
              <strong>{candidate.label}</strong>
              <small>{candidate.tag}{candidate.role ? ` · ${candidate.role}` : ""}</small>
            </button>
          ))}
        </div>
      ) : null}
      {editing ? (
        <WebAnnotationEditor
          initialValue={{
            bodyMarkdown: record.bodyMarkdown,
          }}
          pending={pending}
          submitLabel="保存修改"
          onCancel={() => {
            setInlineError(null);
            setEditing(false);
          }}
          onSubmit={(value) => {
            setInlineError(null);
            void onPatch(item, value).then((result) => {
              if (result.status === "saved") setEditing(false);
              else setInlineError("批注已在其他位置更新，已载入最新版本，请确认后重试。");
            }).catch((error: unknown) => {
              setInlineError(error instanceof Error ? error.message : "保存失败");
            });
          }}
        />
      ) : (
        <p className={styles.body}>{record.bodyMarkdown}</p>
      )}
      {inlineError ? <div className={styles.validationError} role="alert">{inlineError}</div> : null}
      {!editing ? (
        <footer className={styles.cardFooter}>
          <span title={item.resource.urlNormalized}><Link2 size={12} />{item.resource.origin}</span>
          <div>
            {onAddToComposer ? (
              <button
                aria-label="添加网页批注到输入框"
                data-tooltip-label="添加到输入框"
                disabled={pending}
                onClick={() => onAddToComposer(item)}
                type="button"
              >
                <MessageSquarePlus size={14} />
              </button>
            ) : null}
            {onNavigate ? (
              <button
                aria-label="定位网页批注"
                data-tooltip-label="在页面中定位"
                disabled={pending}
                onClick={() => onNavigate(item)}
                type="button"
              >
                <LocateFixed size={14} />
              </button>
            ) : null}
            {onRetarget && (visibleStatus === "ambiguous" || visibleStatus === "orphaned") ? (
              <button
                aria-label={visibleStatus === "ambiguous" ? "选择正确目标" : "重新选择目标"}
                data-tooltip-label={visibleStatus === "ambiguous" ? "选择正确目标" : "重新选择目标"}
                disabled={pending}
                onClick={() => onRetarget(item)}
                type="button"
              >
                <ScanSearch size={14} />
              </button>
            ) : null}
            <button
              aria-label="编辑网页批注"
              data-tooltip-label="编辑批注"
              disabled={pending}
              onClick={() => setEditing(true)}
              type="button"
            >
              <Pencil size={14} />
            </button>
            <button
              aria-label="删除网页批注"
              data-tooltip-label="删除批注"
              disabled={pending}
              onClick={() => onDelete(item)}
              type="button"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </footer>
      ) : null}
      <span className={styles.revision}><CalendarDays size={11} />修订 {record.revision}</span>
    </article>
  );
}

function targetPresentation(target: WebAnnotationItem["annotation"]["target"]): {
  readonly label: string;
  readonly summary: string;
} {
  switch (target.type) {
    case "text":
      return { label: "文本", summary: target.quote.exact };
    case "element":
      return {
        label: "元素",
        summary: target.accessibleName || target.textSummary || `<${target.tag}>`,
      };
    case "region":
      return {
        label: "区域",
        summary: `页面区域 ${Math.round(target.rect.width)} × ${Math.round(target.rect.height)}`,
      };
  }
}

function statusLabel(status: WebAnnotationVisibleStatus): string {
  return {
    pending: "待解析",
    resolving: "正在解析",
    resolved: "已定位",
    changed: "内容变化",
    ambiguous: "存在歧义",
    orphaned: "已失联",
    temporarily_unavailable: "暂不可用",
  }[status];
}

function changeBadgeKind(summary: WebAnnotationChangeSummary): WebAnnotationChangeKind | "mixed" {
  return summary.materialKinds.length === 1 ? summary.materialKinds[0] : "mixed";
}

function changeLabel(summary: WebAnnotationChangeSummary): string {
  if (summary.materialKinds.length !== 1) return "目标有变化";
  return {
    content: "文本变化",
    structure: "结构变化",
    attributes: "属性变化",
    visual: "视觉变化",
    layout: "布局变化",
    context: "上下文变化",
    unknown: "目标变化",
  }[summary.materialKinds[0]];
}

function changeDescription(summary: WebAnnotationChangeSummary): string {
  const labels = summary.materialKinds.map((kind) => ({
    content: "文本内容",
    structure: "元素结构",
    attributes: "关键属性",
    visual: "局部视觉",
    layout: "页面布局",
    context: "周边上下文",
    unknown: "其他目标信息",
  })[kind]);
  return `目标仍已定位；检测到${labels.join("、")}发生变化`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
