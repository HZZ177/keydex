import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  ExternalLink,
  Globe2,
  LoaderCircle,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type {
  WebActivityError,
  WebActivityPayload,
  WebActivitySource,
  WebFetchActivityItem,
} from "@/types/protocol";
import { normalizeWebActivityPayload } from "../webActivity";

import { serializeErrorDiagnostic } from "./errorDiagnostics";
import { copyText } from "./markdown";
import { useDeferredUnmount } from "./useDeferredUnmount";
import { useExpansionScrollAnchor } from "./useExpansionScrollAnchor";
import styles from "./WebActivityBlock.module.css";

export function WebActivityBlock({ message }: { message: ConversationMessage }) {
  const activity = webActivityFromMessage(message);
  const running = activity?.status === "running";
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const userExpansionIntentRef = useRef(false);
  const previousRunningRef = useRef(running);
  const copyTimerRef = useRef<number | null>(null);
  const captureExpansionAnchor = useExpansionScrollAnchor();
  const childrenMotion = useDeferredUnmount<HTMLDivElement>(expanded);
  const sources = useMemo(() => (activity ? activitySources(activity) : []), [activity]);
  const hasDetails = Boolean(activity && (sources.length || activity.items.length || activity.error));

  useEffect(() => {
    if (previousRunningRef.current && !running && !userExpansionIntentRef.current) {
      setExpanded(false);
    }
    previousRunningRef.current = running;
  }, [running]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  if (!activity) {
    return null;
  }

  const summary = activitySummary(activity);
  const truncatedCount = sources.filter((source) => source.truncated).length;
  const copySources = async () => {
    const links = sources.map((source) => source.url).join("\n");
    if (!links) {
      return;
    }
    await copyText(links);
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
  };
  const toggleDetails = (target: HTMLElement) => {
    captureExpansionAnchor(target);
    userExpansionIntentRef.current = true;
    setExpanded((value) => !value);
  };
  const summaryContent = (
    <>
      <span className={styles.leadingIcon} aria-hidden="true">
        <span className={styles.icon}>
          {running ? (
            <LoaderCircle size={16} />
          ) : activity.activity_type === "search" ? (
            <Search size={16} />
          ) : (
            <Globe2 size={16} />
          )}
        </span>
      </span>
      <span className={styles.titleGroup}>
        <span className={styles.summary} title={summary.title}>
          {summary.label}
        </span>
        {truncatedCount ? <span className={styles.badge}>{truncatedCount} 个已截断</span> : null}
      </span>
      {hasDetails ? (
        <span className={styles.trailingIcon} aria-hidden="true">
          <ChevronDown className={styles.chevron} size={14} />
        </span>
      ) : null}
    </>
  );

  return (
    <article
      className={styles.block}
      data-activity-type={activity.activity_type}
      data-state={activity.status}
      data-testid="web-activity"
    >
      {hasDetails ? (
        <button
          aria-expanded={expanded}
          aria-label={expanded ? "收起网络活动详情" : "展开网络活动详情"}
          aria-live={running ? "polite" : "off"}
          className={styles.summaryRow}
          onClick={(event) => toggleDetails(event.currentTarget)}
          type="button"
        >
          {summaryContent}
        </button>
      ) : (
        <div className={styles.summaryRow} role="status" aria-live={running ? "polite" : "off"}>
          {summaryContent}
        </div>
      )}

      {childrenMotion.shouldRender ? (
        <div
          aria-hidden={!expanded}
          className={styles.detailsMotion}
          data-motion={childrenMotion.phase}
          ref={childrenMotion.ref}
          style={childrenMotion.style}
        >
          <div className={styles.details}>
            {activity.error ? <WebErrorDetail error={activity.error} /> : null}
            {activity.activity_type === "search" ? (
              <WebSourceList sources={activity.sources} />
            ) : (
              <WebFetchItemList items={activity.items} />
            )}
            {sources.length ? (
              <button
                aria-label={copied ? "来源链接已复制" : "复制全部来源链接"}
                className={styles.copyButton}
                onClick={() => void copySources()}
                type="button"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                <span>{copied ? "已复制" : "复制链接"}</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function webActivityFromMessage(message: ConversationMessage): WebActivityPayload | null {
  return normalizeWebActivityPayload(
    message.payload.web_activity ??
      asRecord(message.payload.result)?.ui_payload ??
      message.payload.ui_payload,
  );
}

function WebSourceList({ sources }: { sources: WebActivitySource[] }) {
  if (!sources.length) {
    return null;
  }
  return (
    <ol className={styles.sourceList} aria-label="网络来源">
      {sources.map((source) => (
        <li key={source.source_id}>
          <WebSourceRow source={source} />
        </li>
      ))}
    </ol>
  );
}

function WebFetchItemList({ items }: { items: WebFetchActivityItem[] }) {
  if (!items.length) {
    return null;
  }
  return (
    <ol className={styles.sourceList} aria-label="网页读取结果">
      {items.map((item, index) => (
        <li key={`${item.requested_url}:${index}`}>
          {item.status === "success" && item.source ? (
            <WebSourceRow source={item.source} />
          ) : (
            <div className={styles.failedItem}>
              <CircleAlert aria-hidden="true" size={14} />
              <span>{safeDomain(item.requested_url)}</span>
              <small>{item.error?.message || "网页内容读取失败"}</small>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function WebSourceRow({ source }: { source: WebActivitySource }) {
  const safeUrl = safeExternalUrl(source.url);
  return (
    <div className={styles.sourceRow}>
      <span className={styles.favicon} aria-hidden="true">
        <Globe2 size={14} />
        {safeExternalUrl(source.favicon ?? "") ? (
          <img
            alt=""
            loading="lazy"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
            referrerPolicy="no-referrer"
            src={source.favicon ?? undefined}
          />
        ) : null}
      </span>
      <span className={styles.sourceCopy}>
        {safeUrl ? (
          <a
            aria-label={`打开来源：${source.title || source.domain}`}
            href={safeUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            <strong>{source.title || source.domain}</strong>
            <ExternalLink aria-hidden="true" size={12} />
          </a>
        ) : (
          <strong>{source.title || source.domain}</strong>
        )}
        <span className={styles.sourceMeta}>
          <span>{source.domain}</span>
          {source.published_at ? <time>{source.published_at}</time> : null}
          {source.truncated ? <em>内容已截断</em> : null}
        </span>
        {source.snippet ? <small>{source.snippet}</small> : null}
      </span>
    </div>
  );
}

function WebErrorDetail({ error }: { error: WebActivityError }) {
  const [copied, setCopied] = useState(false);
  const retryAfter = numberValue(error.details.retry_after_seconds);
  const detailsText = JSON.stringify(error.details, null, 2);
  const hasDetails = Object.keys(error.details).length > 0;
  const copyError = async () => {
    await copyText(serializeErrorDiagnostic({ error, context: {} }));
    setCopied(true);
  };
  return (
    <div className={styles.errorDetail} role="note">
      <CircleAlert aria-hidden="true" size={14} />
      <span>{error.message}</span>
      {retryAfter !== undefined ? (
        <small>{retryAfter} 秒后可重试</small>
      ) : error.retryable ? (
        <small>可以稍后重试</small>
      ) : null}
      <code>{error.code}</code>
      {error.status ? <code>HTTP {error.status}</code> : null}
      <button
        aria-label={copied ? "网络错误已复制" : "复制网络错误"}
        className={styles.copyButton}
        onClick={() => void copyError()}
        type="button"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? "已复制" : "复制错误"}</span>
      </button>
      {hasDetails ? <pre className={styles.errorDetails}>{detailsText}</pre> : null}
    </div>
  );
}

function activitySummary(activity: WebActivityPayload): { label: string; title?: string } {
  if (activity.activity_type === "search") {
    const query = activity.query?.trim() || "网络信息";
    const clipped = clipText(query, 72);
    if (activity.status === "running") return { label: `正在搜索“${clipped}”`, title: query };
    if (activity.status === "cancelled") return { label: `已停止搜索“${clipped}”`, title: query };
    if (activity.status === "empty") return { label: `未找到“${clipped}”的相关来源`, title: query };
    if (activity.status === "failed") return { label: `搜索“${clipped}”失败`, title: query };
    return {
      label: `已搜索“${clipped}” · ${activity.sources.length} 个来源`,
      title: query,
    };
  }

  const successCount = activity.items.filter((item) => item.status === "success").length;
  const failedCount = activity.items.length - successCount;
  const target = fetchTargetLabel(activity);
  if (activity.status === "running") return { label: `正在读取${target}` };
  if (activity.status === "cancelled") return { label: `已停止读取${target}` };
  if (activity.status === "partial_failure") {
    return { label: `已读取 ${successCount} 个网页，${failedCount} 个失败` };
  }
  if (activity.status === "failed") return { label: `读取${target}失败` };
  if (activity.status === "empty") return { label: `未读取到${target}的内容` };
  return { label: `已读取${target}` };
}

function fetchTargetLabel(activity: WebActivityPayload): string {
  const urls = activity.requested_urls.length
    ? activity.requested_urls
    : activity.items.map((item) => item.requested_url);
  if (urls.length === 1) {
    return ` ${safeDomain(urls[0])}`;
  }
  return ` ${urls.length} 个网页`;
}

function activitySources(activity: WebActivityPayload): WebActivitySource[] {
  return activity.activity_type === "search"
    ? activity.sources
    : activity.items.flatMap((item) => (item.source ? [item.source] : []));
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeDomain(value: string): string {
  try {
    return new URL(value).hostname || "网页";
  } catch {
    return "网页";
  }
}

function clipText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
