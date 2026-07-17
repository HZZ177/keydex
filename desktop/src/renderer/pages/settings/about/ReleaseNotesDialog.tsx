import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileQuestion,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import { StaticMarkdown } from "@/renderer/components/markdown/StaticMarkdown";
import {
  loadAppReleaseHistory,
  type AppReleaseHistory,
  type AppReleaseNote,
} from "@/runtime";
import { openExternalUrl } from "@/runtime/externalLinks";

import styles from "./ReleaseNotesDialog.module.css";

export interface ReleaseNotesDialogProps {
  currentVersion: string;
  onClose: () => void;
  loadHistory?: typeof loadAppReleaseHistory;
}

type ReleaseNavigationDirection = "older" | "newer";

export function ReleaseNotesDialog({
  currentVersion,
  onClose,
  loadHistory = loadAppReleaseHistory,
}: ReleaseNotesDialogProps) {
  const [history, setHistory] = useState<AppReleaseHistory | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [navigationDirection, setNavigationDirection] = useState<ReleaseNavigationDirection | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reloadSequence, setReloadSequence] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void loadHistory({
      signal: controller.signal,
      forceRefresh: true,
    }).then((result) => {
      if (controller.signal.aborted) {
        return;
      }
      setHistory(result);
      setSelectedIndex(0);
      setNavigationDirection(null);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) {
        return;
      }
      setError(errorMessage(reason));
      setLoading(false);
    });
    return () => controller.abort();
  }, [loadHistory, reloadSequence]);

  const releases = history?.releases ?? [];
  const release = releases[selectedIndex] ?? null;
  const canViewOlder = selectedIndex < releases.length - 1;
  const canViewNewer = selectedIndex > 0;
  const releaseAnimationClass = navigationDirection === "older"
    ? styles.releaseEnterFromRight
    : navigationDirection === "newer"
      ? styles.releaseEnterFromLeft
      : "";
  const navigateToRelease = (direction: ReleaseNavigationDirection) => {
    setNavigationDirection(direction);
    setSelectedIndex((index) => direction === "older"
      ? Math.min(releases.length - 1, index + 1)
      : Math.max(0, index - 1));
  };
  const footerStatus = useMemo(() => {
    if (history?.stale) {
      return "网络不可用，当前显示上次缓存的更新日志";
    }
    if (release) {
      return `${selectedIndex + 1} / ${releases.length}`;
    }
    return "";
  }, [history?.stale, release, releases.length, selectedIndex]);

  return (
    <AppDialog
      title="更新日志"
      description="查看 Keydex 各版本的功能更新与问题修复"
      size="form"
      backdrop="plain"
      panelClassName={styles.dialog}
      bodyClassName={styles.dialogBody}
      footerClassName={styles.dialogFooter}
      onClose={onClose}
      footer={
        <div className={styles.footerContent}>
          <span className={history?.stale ? styles.cacheNotice : styles.pageCount}>{footerStatus}</span>
          <div className={styles.footerActions}>
            {history ? (
              <DialogButton
                type="button"
                disabled={loading}
                onClick={() => setReloadSequence((value) => value + 1)}
              >
                <RefreshCw size={14} />
                <span>刷新</span>
              </DialogButton>
            ) : null}
            {release?.htmlUrl ? (
              <DialogButton
                type="button"
                onClick={() => void openExternalUrl(release.htmlUrl).catch(() => undefined)}
              >
                <ExternalLink size={14} />
                <span>在 GitHub 查看</span>
              </DialogButton>
            ) : null}
            <DialogButton tone="primary" type="button" onClick={onClose}>
              完成
            </DialogButton>
          </div>
        </div>
      }
    >
      {loading ? (
        <DialogState icon={<LoaderCircle className={styles.spin} size={22} />} title="正在加载更新日志" detail="正在从 GitHub 获取已发布版本…" />
      ) : error ? (
        <DialogState
          icon={<CircleAlert size={22} />}
          title="更新日志加载失败"
          detail={error}
          action={<DialogButton tone="primary" type="button" onClick={() => setReloadSequence((value) => value + 1)}>重新加载</DialogButton>}
        />
      ) : !release ? (
        <DialogState icon={<FileQuestion size={22} />} title="暂无更新日志" detail="还没有可供展示的公开版本说明。" />
      ) : (
        <div className={styles.releaseNavigator}>
          <VersionNavigationButton
            direction="newer"
            disabled={!canViewNewer}
            onClick={() => navigateToRelease("newer")}
          />

          <div className={styles.releaseStage}>
            <article className={`${styles.release} ${releaseAnimationClass}`} key={release.id}>
              <ReleaseHeader currentVersion={currentVersion} release={release} />
              <div className={styles.markdownViewport} data-testid="release-notes-markdown-viewport">
                {release.body ? (
                  <StaticMarkdown
                    ariaLabel={`${release.version} 更新说明`}
                    className={styles.markdown}
                    source={release.body}
                  />
                ) : (
                  <p className={styles.emptyBody}>此版本没有提供详细更新说明。</p>
                )}
              </div>
            </article>
          </div>

          <VersionNavigationButton
            direction="older"
            disabled={!canViewOlder}
            onClick={() => navigateToRelease("older")}
          />
        </div>
      )}
    </AppDialog>
  );
}

function ReleaseHeader({ currentVersion, release }: { currentVersion: string; release: AppReleaseNote }) {
  const isCurrent = normalizedVersion(currentVersion) === normalizedVersion(release.version);
  return (
    <header className={styles.releaseHeader}>
      <div className={styles.releaseIdentity}>
        <div className={styles.releaseTitleLine}>
          <h3>{release.title}</h3>
          {isCurrent ? <span className={styles.currentBadge}>当前版本</span> : null}
          {release.prerelease ? <span className={styles.prereleaseBadge}>预发布</span> : null}
        </div>
        <div className={styles.releaseMeta}>
          <span>{release.tagName}</span>
          {release.publishedAt ? <time dateTime={release.publishedAt}>{formatReleaseDate(release.publishedAt)}</time> : null}
        </div>
      </div>
    </header>
  );
}

function VersionNavigationButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "older" | "newer";
  disabled: boolean;
  onClick: () => void;
}) {
  const newer = direction === "newer";
  const label = newer ? "查看较新版本" : "查看较早版本";
  return (
    <button
      aria-label={label}
      className={styles.navigationButton}
      data-tooltip-label={label}
      disabled={disabled}
      title={label}
      type="button"
      onClick={onClick}
    >
      {newer ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
    </button>
  );
}

function DialogState({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.dialogState}>
      <span className={styles.stateIcon} aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action ? <div className={styles.stateAction}>{action}</div> : null}
    </div>
  );
}

function normalizedVersion(version: string | null | undefined): string {
  return (version ?? "").trim().replace(/^v/iu, "");
}

function formatReleaseDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return typeof reason === "string" && reason ? reason : "无法获取更新日志";
}
