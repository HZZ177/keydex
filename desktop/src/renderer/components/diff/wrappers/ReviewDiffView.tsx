import { ChevronRight } from "lucide-react";
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

import type { KeydexDiffDocument, KeydexDiffFile } from "../model";
import type { KeydexDiffActions } from "../profiles";
import { keydexDiffFileHeaderPresentation } from "../DiffChrome";
import { KeydexDiffView } from "../KeydexDiffView";
import { useKeydexDiffViewController } from "../diffViewController";
import styles from "./ReviewDiffView.module.css";

export type ReviewDiffActions = Omit<KeydexDiffActions, "git"> & { readonly git?: never };

export interface ReviewDiffViewProps {
  readonly document: KeydexDiffDocument;
  readonly actions?: ReviewDiffActions;
  readonly focusedPath?: string | null;
  readonly onFocusPath?: (path: string) => void;
  readonly scrollScopeKey?: string;
  readonly wrap?: boolean;
  readonly onWrapChange?: (wrap: boolean) => void;
  readonly embedded?: boolean;
}

export function ReviewDiffView({
  document,
  actions = {},
  focusedPath,
  onFocusPath,
  scrollScopeKey = "review",
  wrap,
  onWrapChange,
  embedded = true,
}: ReviewDiffViewProps) {
  const focusedFile = resolveReviewFocusedFile(document, focusedPath);
  const controller = useKeydexDiffViewController(document, "review", {
    activeFileId: focusedFile?.id ?? null,
    expandedFileIds: document.files.map((file) => file.id),
    ...(wrap === undefined ? {} : { wrap }),
  });
  const appliedExternalFocusRef = useRef<string | null>(null);
  const activeFile = document.files.find(
    (file) => file.id === controller.state.activeFileId,
  ) ?? focusedFile;
  const activeFileExpanded = activeFile
    ? controller.state.expandedFileIds.includes(activeFile.id)
    : false;

  useEffect(() => {
    if (!focusedFile) return;
    if (appliedExternalFocusRef.current === focusedFile.id) return;
    appliedExternalFocusRef.current = focusedFile.id;
    if (focusedFile.id !== controller.state.activeFileId) {
      controller.setActiveFile(focusedFile.id);
    }
    if (!controller.state.expandedFileIds.includes(focusedFile.id)) {
      controller.setExpandedFiles([...controller.state.expandedFileIds, focusedFile.id]);
    }
  }, [controller, focusedFile]);
  useEffect(() => {
    if (wrap !== undefined && wrap !== controller.state.wrap) {
      controller.setWrap(wrap);
    }
  }, [controller, wrap]);

  const focusFile = (fileId: string) => {
    controller.setActiveFile(fileId);
    if (!controller.state.expandedFileIds.includes(fileId)) {
      controller.setExpandedFiles([...controller.state.expandedFileIds, fileId]);
    }
    const file = document.files.find((candidate) => candidate.id === fileId);
    if (file) onFocusPath?.(file.displayPath);
  };
  const toggleFromToolbarRow = (event: ReactMouseEvent<HTMLElement>) => {
    if (!activeFile || !isReviewToolbarRowClick(event.target)) return;
    controller.toggleFile(activeFile.id);
  };

  return (
    <section
      className={styles.wrapper}
      data-keydex-diff-wrapper="review"
      aria-label="文件审阅"
      onClick={toggleFromToolbarRow}
    >
      <KeydexDiffView
        document={document}
        profile="review"
        embedded={embedded}
        actions={actions}
        state={{
          layout: controller.state.layout,
          wrap: controller.state.wrap,
          activeFileId: controller.state.activeFileId,
          expandedFileIds: controller.state.expandedFileIds,
          selection: controller.state.selection,
        }}
        scrollScopeKey={`${scrollScopeKey}:${document.id}`}
        loadingAction={controller.state.loadingAction as never}
        onLoadingActionChange={controller.setLoadingAction}
        onSelectionChange={controller.setSelection}
        onActiveFileChange={focusFile}
        onExpandedFilesChange={controller.setExpandedFiles}
        showFileHeader={false}
        hiddenToolbarActions={["open_file"]}
        singleFileExpanded={activeFileExpanded}
        toolbarLeading={activeFile ? (
          <ReviewDiffToolbarFile
            file={activeFile}
            expanded={activeFileExpanded}
            onToggle={() => controller.toggleFile(activeFile.id)}
          />
        ) : null}
        onWrapChange={(nextWrap) => {
          controller.setWrap(nextWrap);
          onWrapChange?.(nextWrap);
        }}
      />
    </section>
  );
}

export function isReviewToolbarRowClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const toolbar = target.closest('[data-keydex-diff-toolbar][data-profile="review"]');
  if (!toolbar) return false;
  return !target.closest("button, a, input, select, textarea, [role='button']");
}

function ReviewDiffToolbarFile({
  file,
  expanded,
  onToggle,
}: {
  readonly file: KeydexDiffFile;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const presentation = keydexDiffFileHeaderPresentation(file);
  return (
    <button
      className={styles.toolbarFile}
      type="button"
      title={presentation.fullPath}
      aria-label={`${expanded ? "收起" : "展开"} ${presentation.fullPath}`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <ChevronRight className={styles.toolbarFileChevron} size={14} aria-hidden="true" />
      <span className={styles.toolbarFileName}>{presentation.fileName}</span>
      <span
        className={styles.toolbarLineStats}
        aria-label={`新增 ${presentation.additions ?? 0} 行，删除 ${presentation.deletions ?? 0} 行`}
      >
        <span data-kind="added" aria-hidden="true">+{presentation.additions ?? 0}</span>
        <span data-kind="removed" aria-hidden="true">-{presentation.deletions ?? 0}</span>
      </span>
    </button>
  );
}

export function resolveReviewFocusedFile(
  document: KeydexDiffDocument,
  focusedPath?: string | null,
): KeydexDiffFile | null {
  if (!focusedPath) return document.files[0] ?? null;
  const normalized = focusedPath.replaceAll("\\", "/");
  return document.files.find((file) => [
    file.displayPath,
    file.oldPath,
    file.newPath,
    file.oldOperationPath,
    file.newOperationPath,
  ].some((path) => path?.replaceAll("\\", "/") === normalized)) ?? document.files[0] ?? null;
}
