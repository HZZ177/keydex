import { useEffect } from "react";

import type { KeydexDiffDocument } from "../model";
import type { KeydexDiffActions, KeydexDiffLayout } from "../profiles";
import { KeydexDiffView } from "../KeydexDiffView";
import { useKeydexDiffViewController } from "../diffViewController";
import { useKeydexDiffDisplayPreference } from "../diffPreferences";
import styles from "./PreviewDiffView.module.css";

export type PreviewDiffActions = Omit<KeydexDiffActions, "git"> & { readonly git?: never };

export interface PreviewDiffViewProps {
  readonly document: KeydexDiffDocument;
  readonly actions?: PreviewDiffActions;
  readonly activeFileId?: string | null;
  readonly preferredLayout?: KeydexDiffLayout;
  readonly wrap?: boolean;
  readonly scrollScopeKey: string;
  readonly onActiveFileChange?: (fileId: string) => void;
  readonly onDisplayPreferenceChange?: (preference: {
    layout: KeydexDiffLayout;
    wrap: boolean;
    syncScroll: boolean;
  }) => void;
}

export function PreviewDiffView({
  document,
  actions = {},
  activeFileId,
  preferredLayout,
  wrap,
  scrollScopeKey,
  onActiveFileChange,
  onDisplayPreferenceChange,
}: PreviewDiffViewProps) {
  const displayPreference = useKeydexDiffDisplayPreference("preview", scrollScopeKey);
  const controller = useKeydexDiffViewController(document, "preview", {
    activeFileId,
    layout: preferredLayout ?? displayPreference.preference.layout,
    wrap: wrap ?? displayPreference.preference.wrap,
    syncScroll: displayPreference.preference.syncScroll,
  });

  useEffect(() => {
    if (activeFileId && activeFileId !== controller.state.activeFileId) {
      controller.setActiveFile(activeFileId);
    }
  }, [activeFileId, controller]);

  const setActiveFile = (fileId: string) => {
    controller.setActiveFile(fileId);
    onActiveFileChange?.(fileId);
  };
  const setLayout = (layout: KeydexDiffLayout) => {
    controller.setLayout(layout);
    displayPreference.update({ layout });
    onDisplayPreferenceChange?.({
      layout,
      wrap: controller.state.wrap,
      syncScroll: controller.state.syncScroll,
    });
  };
  const setWrap = (nextWrap: boolean) => {
    controller.setWrap(nextWrap);
    displayPreference.update({ wrap: nextWrap });
    onDisplayPreferenceChange?.({
      layout: controller.state.layout,
      wrap: nextWrap,
      syncScroll: controller.state.syncScroll,
    });
  };
  const setSyncScroll = (syncScroll: boolean) => {
    controller.setSyncScroll(syncScroll);
    displayPreference.update({ syncScroll });
    onDisplayPreferenceChange?.({
      layout: controller.state.layout,
      wrap: controller.state.wrap,
      syncScroll,
    });
  };

  return (
    <section
      className={styles.wrapper}
      data-keydex-diff-wrapper="preview"
      data-file-count={document.files.length}
      aria-label="差异文件预览"
    >
      <KeydexDiffView
        document={document}
        profile="preview"
        actions={actions}
        state={{
          layout: controller.state.layout,
          wrap: controller.state.wrap,
          syncScroll: controller.state.syncScroll,
          activeChangeId: controller.state.activeChangeId,
          activeFileId: controller.state.activeFileId,
          expandedFileIds: controller.state.expandedFileIds,
          selection: controller.state.selection,
        }}
        scrollScopeKey={`preview:${scrollScopeKey}:${document.id}`}
        loadingAction={controller.state.loadingAction as never}
        onLoadingActionChange={controller.setLoadingAction}
        onSelectionChange={controller.setSelection}
        onActiveFileChange={setActiveFile}
        onExpandedFilesChange={controller.setExpandedFiles}
        onLayoutChange={setLayout}
        onWrapChange={setWrap}
        onSyncScrollChange={setSyncScroll}
        onActiveChangeChange={controller.setActiveChange}
      />
    </section>
  );
}
