import { ChevronDown, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import type { KeydexDiffDocument } from "../model";
import type { KeydexDiffActions } from "../profiles";
import { KeydexDiffFileHeader } from "../KeydexDiffFileHeader";
import { KeydexDiffView } from "../KeydexDiffView";
import { useKeydexDiffViewController } from "../diffViewController";
import { keydexDiffOpenPath } from "../DiffContextMenu";
import styles from "./CompactDiffView.module.css";

export type CompactDiffActions = Omit<KeydexDiffActions, "git"> & { readonly git?: never };

export interface CompactDiffViewProps {
  readonly document: KeydexDiffDocument;
  readonly actions?: CompactDiffActions;
  readonly expanded?: boolean;
  readonly defaultExpanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly activeFileId?: string | null;
  readonly onActiveFileChange?: (fileId: string) => void;
}

export function CompactDiffView({
  document,
  actions = {},
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  activeFileId,
  onActiveFileChange,
}: CompactDiffViewProps) {
  const controller = useKeydexDiffViewController(document, "compact", { activeFileId });
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const open = expanded ?? internalExpanded;
  const firstFile = document.files[0] ?? null;
  const setOpen = (next: boolean) => {
    if (expanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  };
  useEffect(() => {
    if (activeFileId && activeFileId !== controller.state.activeFileId) {
      controller.setActiveFile(activeFileId);
    }
  }, [activeFileId, controller]);
  const setActiveFile = (fileId: string) => {
    controller.setActiveFile(fileId);
    onActiveFileChange?.(fileId);
  };

  return (
    <section
      className={styles.wrapper}
      data-keydex-diff-wrapper="compact"
      data-expanded={open ? "true" : "false"}
      aria-label="文件变更"
    >
      {firstFile ? (
        <KeydexDiffFileHeader
          file={firstFile}
          density="compact"
          expanded={open}
          onToggle={() => setOpen(!open)}
          actions={(
            <>
              {document.files.length > 1 ? (
                <span className={styles.fileCount}>{document.files.length} 个文件</span>
              ) : null}
              {actions.copyPatch ? (
                <button
                  className={styles.headerAction}
                  type="button"
                  aria-label="复制原始补丁"
                  data-tooltip-label="复制原始补丁"
                  onClick={() => void Promise.resolve(actions.copyPatch!(firstFile.patch)).catch(() => undefined)}
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
              ) : null}
              {actions.openFile ? (
                <button
                  className={styles.headerAction}
                  type="button"
                  aria-label="在侧边栏审阅"
                  data-tooltip-label="在侧边栏审阅"
                  disabled={!keydexDiffOpenPath(firstFile)}
                  onClick={() => {
                    const path = keydexDiffOpenPath(firstFile);
                    if (path) void Promise.resolve(actions.openFile!(path)).catch(() => undefined);
                  }}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                </button>
              ) : null}
              <span className={styles.toggleGlyph} aria-hidden="true">
                <ChevronDown size={15} aria-hidden="true" />
              </span>
            </>
          )}
        />
      ) : <span className={styles.emptyLabel}>没有文件变更</span>}
      <div className={styles.collapseRegion} aria-hidden={!open}>
        <div className={styles.collapseContent}>
          <div className={styles.viewer} data-height-limited="true">
            <KeydexDiffView
              document={document}
              profile="compact"
              actions={actions}
              state={{
                layout: controller.state.layout,
                wrap: controller.state.wrap,
                activeFileId: controller.state.activeFileId,
                selection: controller.state.selection,
              }}
              scrollScopeKey={`compact:${document.id}`}
              onSelectionChange={controller.setSelection}
              onActiveFileChange={setActiveFile}
              showToolbar={false}
              showFileHeader={false}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
