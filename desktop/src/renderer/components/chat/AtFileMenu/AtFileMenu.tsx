import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef } from "react";

import type { WorkspaceSearchResult } from "@/runtime";
import { useMaterialEntryIcon } from "@/renderer/components/workspace/materialIconTheme";
import { WORKSPACE_FILE_SEARCH_BUDGET_HINT } from "@/renderer/utils/workspaceFileSearchBudget";

import popupStyles from "../ComposerPopupMenu/ComposerPopupMenu.module.css";
import styles from "./AtFileMenu.module.css";

export interface AtFileMenuProps {
  results: WorkspaceSearchResult[];
  activeIndex: number;
  loading?: boolean;
  error?: string | null;
  hint?: string | null;
  directoryPath?: string | null;
  query: string;
  onNavigateDirectory?: (path: string) => void;
  onSelect: (result: WorkspaceSearchResult) => void;
}

export function AtFileMenu({
  results,
  activeIndex,
  loading = false,
  error = null,
  hint = null,
  directoryPath = null,
  query,
  onNavigateDirectory,
  onSelect,
}: AtFileMenuProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const browsing = directoryPath !== null;
  const loadingText = browsing
    ? directoryPath
      ? "正在读取目录"
      : "正在读取工作区内容"
    : query
      ? "正在搜索工作区"
      : "正在读取工作区内容";
  const emptyText = browsing ? "目录为空" : query ? "没有匹配的文件或目录" : "工作区没有可引用内容";
  const directoryLabel = directoryPath ? `工作区 / ${directoryPath}` : "工作区";
  const headerLabel = browsing ? directoryLabel : query ? `搜索 ${query}` : "工作区文件和目录";

  useEffect(() => {
    const activeOption = bodyRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    activeOption?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, directoryPath, error, loading, results]);

  return (
    <div className={popupStyles.menu} role="listbox" aria-label="上下文引用菜单" data-testid="at-file-menu">
      <div className={popupStyles.header} aria-label="当前引用目录">
        {browsing && directoryPath ? (
          <button
            className={popupStyles.backButton}
            type="button"
            aria-label="返回上一级目录"
            onMouseDown={(event) => {
              event.preventDefault();
              onNavigateDirectory?.(parentPath(directoryPath));
            }}
          >
            <ChevronLeft size={14} />
          </button>
        ) : (
          <span className={popupStyles.backSpacer} />
        )}
        <span className={popupStyles.headerTitle}>{headerLabel}</span>
        <span className={popupStyles.headerMeta}>文件和目录</span>
      </div>

      <div className={styles.budgetHint}>
        <span>{WORKSPACE_FILE_SEARCH_BUDGET_HINT}</span>
        <span className={styles.operationHint}>目录：回车浏览 · Ctrl+Enter 引用</span>
      </div>

      <div ref={bodyRef} className={popupStyles.body}>
        {loading ? <div className={popupStyles.empty}>{loadingText}</div> : null}
        {!loading && error ? <div className={popupStyles.error}>{error}</div> : null}
        {!loading && !error && hint ? <div className={popupStyles.empty}>{hint}</div> : null}
        {!loading && !error && !hint && !results.length ? <div className={popupStyles.empty}>{emptyText}</div> : null}
        {!loading && !error && !hint
          ? results.map((result, index) => {
              const active = activeIndex === index;
              if (result.type === "directory" && onNavigateDirectory) {
                return (
                  <div
                    className={`${popupStyles.item} ${styles.directoryItem}`}
                    data-active={active ? "true" : "false"}
                    data-kind={result.type}
                    key={result.path}
                  >
                    <button
                      className={styles.directoryBrowseButton}
                      type="button"
                      role="option"
                      aria-label={`打开目录 ${result.path}`}
                      aria-selected={active}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        onNavigateDirectory(result.path);
                      }}
                    >
                      <span className={popupStyles.icon} aria-hidden="true">
                        <MaterialEntryIcon path={result.path || result.name} type={result.type} />
                      </span>
                      <span className={popupStyles.text}>
                        <strong>{result.name}</strong>
                        <span>{result.path}</span>
                      </span>
                      <ChevronRight className={popupStyles.enterIcon} size={13} />
                    </button>
                    <button
                      className={styles.directoryReferenceButton}
                      type="button"
                      aria-label={`引用目录 ${result.path}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect(result);
                      }}
                    >
                      引用
                    </button>
                  </div>
                );
              }
              return (
                <button
                  className={popupStyles.item}
                  type="button"
                  role="option"
                  aria-label={
                    result.type === "directory" ? `引用目录 ${result.path}` : `选择文件 ${result.path}`
                  }
                  aria-selected={active}
                  data-active={active ? "true" : "false"}
                  data-kind={result.type}
                  key={result.path}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(result);
                  }}
                >
                  <span className={popupStyles.icon} aria-hidden="true">
                    <MaterialEntryIcon path={result.path || result.name} type={result.type} />
                  </span>
                  <span className={popupStyles.text}>
                    <strong>{result.name}</strong>
                    <span>{result.path}</span>
                  </span>
                </button>
              );
            })
          : null}
      </div>
    </div>
  );
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function MaterialEntryIcon({
  path,
  type,
}: {
  path: string;
  type: WorkspaceSearchResult["type"];
}) {
  const icon = useMaterialEntryIcon(path, type === "directory" ? "directory" : "file");
  return (
    <img
      alt=""
      aria-hidden="true"
      className={styles.materialIcon}
      data-icon-id={icon.id}
      draggable={false}
      src={icon.src}
    />
  );
}
