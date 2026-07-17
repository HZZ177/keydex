import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Columns2,
  Copy,
  ExternalLink,
  Rows3,
  TextWrap,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { AppTooltipLayer } from "@/renderer/components/tooltip/AppTooltipLayer";
import type { KeydexDiffFile } from "./model";
import {
  resolveKeydexDiffProfile,
  type KeydexDiffActions,
  type KeydexDiffLayout,
  type KeydexDiffProfileName,
  type KeydexGitDiffActionStatus,
} from "./profiles";
import {
  KeydexDiffToolbar,
  KeydexDiffToolbarAction,
  type KeydexDiffActionState,
} from "./DiffToolbar";
import styles from "./KeydexDiffProductToolbar.module.css";
import { keydexDiffOpenPath } from "./DiffContextMenu";
import type { KeydexDiffSelectionRange } from "./selectionBridge";

export type KeydexDiffToolbarActionId =
  | "previous_file"
  | "next_file"
  | "copy_selection"
  | "copy_patch"
  | "open_file"
  | "toggle_wrap"
  | "toggle_layout"
  | "apply_git_patch";

export interface KeydexDiffProductToolbarProps {
  readonly profile: KeydexDiffProfileName;
  readonly files: readonly KeydexDiffFile[];
  readonly activeFile: KeydexDiffFile;
  readonly actions?: KeydexDiffActions;
  readonly layout: KeydexDiffLayout;
  readonly wrap: boolean;
  readonly selectionText?: string;
  readonly selection?: KeydexDiffSelectionRange | null;
  readonly loadingAction?: KeydexDiffToolbarActionId | null;
  readonly onLoadingActionChange?: (action: KeydexDiffToolbarActionId | null) => void;
  readonly onPreviousFile?: () => void;
  readonly onNextFile?: () => void;
  readonly onLayoutChange?: (layout: KeydexDiffLayout) => void;
  readonly onWrapChange?: (wrap: boolean) => void;
  readonly hiddenActions?: readonly KeydexDiffToolbarActionId[];
  readonly leading?: ReactNode;
}

export function KeydexDiffProductToolbar({
  profile,
  files,
  activeFile,
  actions = {},
  layout,
  wrap,
  selectionText = "",
  selection = null,
  loadingAction,
  onLoadingActionChange,
  onPreviousFile,
  onNextFile,
  onLayoutChange,
  onWrapChange,
  hiddenActions = [],
  leading,
}: KeydexDiffProductToolbarProps) {
  const tooltipScopeId = useId();
  const resolved = useMemo(
    () => resolveKeydexDiffProfile(profile, actions),
    [actions, profile],
  );
  const feedback = useToolbarFeedback(
    loadingAction,
    onLoadingActionChange,
    `${activeFile.id}:${activeFile.cacheKey}:${String(activeFile.selectableForPatch)}`,
  );
  const enabled = new Set(resolved.enabledActions);
  const hidden = new Set(hiddenActions);
  const buttons = [];
  const canNavigate =
    enabled.has("navigate_files") &&
    files.length > 1 &&
    Boolean(onPreviousFile && onNextFile) &&
    !hidden.has("previous_file") &&
    !hidden.has("next_file");

  if (canNavigate) {
    buttons.push(
      <KeydexDiffToolbarAction
        key="previous_file"
        label="上一个文件"
        shortcut="Alt+↑"
        icon={<ArrowLeft size={16} />}
        state={feedback.stateFor("previous_file")}
        onClick={() => feedback.run("previous_file", onPreviousFile!)}
      />,
      <KeydexDiffToolbarAction
        key="next_file"
        label="下一个文件"
        shortcut="Alt+↓"
        icon={<ArrowRight size={16} />}
        state={feedback.stateFor("next_file")}
        onClick={() => feedback.run("next_file", onNextFile!)}
      />,
    );
  }
  if (!hidden.has("copy_selection") && enabled.has("copy_selection") && actions.copySelection) {
    buttons.push(
      <KeydexDiffToolbarAction
        key="copy_selection"
        label="复制选中代码"
        shortcut="Ctrl+C"
        icon={<Copy size={16} />}
        disabled={!selectionText}
        disabledReason="请先选择代码"
        state={feedback.stateFor("copy_selection")}
        onClick={() => feedback.run("copy_selection", () => actions.copySelection!(selectionText))}
      />,
    );
  }
  if (!hidden.has("copy_patch") && enabled.has("copy_patch") && actions.copyPatch) {
    buttons.push(
      <KeydexDiffToolbarAction
        key="copy_patch"
        label="复制原始补丁"
        icon={<Copy size={16} />}
        state={feedback.stateFor("copy_patch")}
        onClick={() => feedback.run("copy_patch", () => actions.copyPatch!(activeFile.patch))}
      />,
    );
  }
  if (!hidden.has("open_file") && enabled.has("open_file") && actions.openFile) {
    const path = keydexDiffOpenPath(activeFile);
    buttons.push(
      <KeydexDiffToolbarAction
        key="open_file"
        label="打开文件"
        shortcut="Ctrl+Enter"
        icon={<ExternalLink size={16} />}
        disabled={!path}
        disabledReason="此变更没有可打开的工作区路径"
        state={feedback.stateFor("open_file")}
        onClick={() => feedback.run("open_file", () => actions.openFile!(path!))}
      />,
    );
  }
  if (!hidden.has("toggle_layout") && enabled.has("toggle_layout") && onLayoutChange) {
    const nextLayout = layout === "stacked" ? "split" : "stacked";
    buttons.push(
      <KeydexDiffToolbarAction
        key="toggle_layout"
        label={nextLayout === "split" ? "切换为并排视图" : "切换为统一视图"}
        icon={nextLayout === "split" ? <Columns2 size={16} /> : <Rows3 size={16} />}
        pressed={layout === "split"}
        onClick={() => onLayoutChange(nextLayout)}
      />,
    );
  }
  if (!hidden.has("toggle_wrap") && enabled.has("toggle_wrap") && onWrapChange) {
    buttons.push(
      <KeydexDiffToolbarAction
        key="toggle_wrap"
        label={wrap ? "关闭自动换行" : "开启自动换行"}
        icon={<TextWrap size={16} />}
        pressed={wrap}
        onClick={() => onWrapChange(!wrap)}
      />,
    );
  }
  if (!hidden.has("apply_git_patch") && enabled.has("apply_git_patch") && actions.git) {
    const controlledGitState = gitActionState(actions.git.status);
    const gitBusy = Boolean(actions.git.busy) || controlledGitState === "loading";
    const hasSelectionAction = Boolean(actions.git.applySelection);
    const gitLabel = hasSelectionAction
      ? actions.git.mode === "stage" ? "暂存选择" : "取消暂存选择"
      : actions.git.mode === "stage" ? "暂存文件" : "取消暂存文件";
    const selectionMissing = hasSelectionAction && !selection;
    buttons.push(
      <KeydexDiffToolbarAction
        key="apply_git_patch"
        label={gitLabel}
        showLabel
        icon={<ArrowDownToLine size={16} />}
        disabled={!activeFile.selectableForPatch || gitBusy || selectionMissing}
        disabledReason={
          actions.git.disabledReason
            ?? (gitBusy
            ? actions.git.status === "queued" ? "Git 操作已进入队列" : "Git 操作正在进行"
            : selectionMissing
              ? "请先选择要操作的变更行"
              : "当前差异不支持精确补丁操作")
        }
        state={controlledGitState ?? (gitBusy ? "loading" : feedback.stateFor("apply_git_patch"))}
        onClick={() => {
          const apply = () => hasSelectionAction
            ? actions.git!.applySelection!(selection!)
            : actions.git!.applyPatches([activeFile.patch]);
          if (actions.git!.status !== undefined) {
            void apply();
            return;
          }
          void feedback.run("apply_git_patch", apply);
        }}
      />,
    );
  }

  if (buttons.length === 0) return null;

  return (
    <div
      className={styles.scope}
      data-keydex-diff-product-toolbar="true"
      data-keydex-diff-tooltip-scope={tooltipScopeId}
      data-app-tooltip-owner={tooltipScopeId}
    >
      <KeydexDiffToolbar profile={profile} leading={leading}>{buttons}</KeydexDiffToolbar>
      <AppTooltipLayer
        scopeSelector={`[data-keydex-diff-tooltip-scope="${tooltipScopeId}"]`}
        ownerId={tooltipScopeId}
      />
    </div>
  );
}

function gitActionState(
  status: KeydexGitDiffActionStatus | undefined,
): KeydexDiffActionState | null {
  if (status === "queued" || status === "running") return "loading";
  if (status === "success" || status === "error") return status;
  return status === "idle" ? "idle" : null;
}

interface ToolbarFeedback {
  readonly stateFor: (id: KeydexDiffToolbarActionId) => KeydexDiffActionState;
  readonly run: (id: KeydexDiffToolbarActionId, action: () => void | Promise<void>) => Promise<void>;
}

function useToolbarFeedback(
  controlledLoading: KeydexDiffToolbarActionId | null | undefined,
  onLoadingChange: ((action: KeydexDiffToolbarActionId | null) => void) | undefined,
  resetKey: string,
): ToolbarFeedback {
  const [state, setState] = useState<{
    id: KeydexDiffToolbarActionId | null;
    status: KeydexDiffActionState;
  }>({ id: null, status: "idle" });
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setState({ id: null, status: "idle" });
  }, [resetKey]);

  const run = useCallback(async (
    id: KeydexDiffToolbarActionId,
    action: () => void | Promise<void>,
  ) => {
    if (controlledLoading || state.status === "loading") return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setState({ id, status: "loading" });
    onLoadingChange?.(id);
    try {
      await action();
      setState({ id, status: "success" });
    } catch {
      setState({ id, status: "error" });
    } finally {
      onLoadingChange?.(null);
      timerRef.current = window.setTimeout(() => {
        setState({ id: null, status: "idle" });
        timerRef.current = null;
      }, 1_000);
    }
  }, [controlledLoading, onLoadingChange, state.status]);

  return {
    stateFor: (id) => controlledLoading === id
      ? "loading"
      : state.id === id
        ? state.status
        : "idle",
    run,
  };
}
