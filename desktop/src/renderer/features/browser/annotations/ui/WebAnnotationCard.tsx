import { CalendarDays, LocateFixed, Link2, MessageSquarePlus, Pencil, ScanSearch, Trash2 } from "lucide-react";
import { useState } from "react";

import type {
  WebAnnotationItem,
  WebAnnotationMutationResult,
} from "../api";
import type { WebAnnotationVisibleStatus } from "../domain";
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
  const candidateSummaries = (
    resolution?.settled?.evidence?.candidateSummaries
    ?? resolution?.lastKnown?.evidence?.candidateSummaries
    ?? []
  ).slice(0, 5);

  return (
    <article className={styles.card} data-status={status} data-target={record.target.type}>
      <header className={styles.cardHeader}>
        <span className={styles.targetBadge}>{target.label}</span>
        <span className={styles.statusBadge} data-status={status}>{statusLabel(status)}</span>
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
            tags: record.tags,
            properties: record.properties,
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
        <>
          <p className={styles.body}>{record.bodyMarkdown}</p>
          {record.tags.length ? (
            <div className={styles.tags} aria-label="批注标签">
              {record.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            </div>
          ) : null}
          {record.properties.length ? (
            <dl className={styles.propertyList}>
              {record.properties.map((property) => (
                <div key={`${property.key}:${property.type}`}>
                  <dt>{property.key}</dt>
                  <dd>{propertyValue(property.value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      )}
      {inlineError ? <div className={styles.validationError} role="alert">{inlineError}</div> : null}
      {!editing ? (
        <footer className={styles.cardFooter}>
          <span title={item.resource.urlNormalized}><Link2 size={12} />{item.resource.origin}</span>
          <div>
            {onAddToComposer ? (
              <button aria-label="添加网页批注到输入框" disabled={pending} onClick={() => onAddToComposer(item)} type="button">
                <MessageSquarePlus size={14} />
              </button>
            ) : null}
            {onNavigate ? (
              <button aria-label="定位网页批注" disabled={pending} onClick={() => onNavigate(item)} type="button">
                <LocateFixed size={14} />
              </button>
            ) : null}
            {onRetarget && (status === "ambiguous" || status === "orphaned") ? (
              <button
                aria-label={status === "ambiguous" ? "选择正确目标" : "重新选择目标"}
                disabled={pending}
                onClick={() => onRetarget(item)}
                type="button"
              >
                <ScanSearch size={14} />
              </button>
            ) : null}
            <button aria-label="编辑网页批注" disabled={pending} onClick={() => setEditing(true)} type="button">
              <Pencil size={14} />
            </button>
            <button aria-label="删除网页批注" disabled={pending} onClick={() => onDelete(item)} type="button">
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

function propertyValue(value: string | number | boolean): string {
  return typeof value === "boolean" ? (value ? "是" : "否") : String(value);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
