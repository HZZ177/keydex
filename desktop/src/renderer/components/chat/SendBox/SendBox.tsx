import { ArrowUp, SendHorizontal, Square } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type { WorkspaceSearchResult } from "@/runtime";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import { AtFileMenu, getAtQuery, replaceAtQuery } from "@/renderer/components/chat/AtFileMenu";
import {
  defaultSlashCommands,
  filterSlashCommands,
  getSlashQuery,
  replaceSlashQuery,
  SlashCommandMenu,
  type SlashCommand,
} from "@/renderer/components/chat/SlashCommandMenu";

import styles from "./SendBox.module.css";
import {
  fileSelectionReducer,
  initialFileSelectionState,
  selectedFileFromFile,
  selectedFileFromWorkspace,
} from "./fileSelection";
import { useCompositionInput } from "./useCompositionInput";

export interface SendBoxProps {
  value: string;
  runtimeState: ConversationRuntimeState;
  canSend: boolean;
  canStop: boolean;
  placeholder?: string;
  ariaLabel?: string;
  inputLabel?: string;
  statusText?: string;
  controls?: ReactNode;
  rightControls?: ReactNode;
  contextBar?: ReactNode;
  disabled?: boolean;
  variant?: "conversation" | "codex";
  allowFileSelection?: boolean;
  leftHint?: ReactNode;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onSlashCommand?: (command: SlashCommand) => void;
  onSearchWorkspace?: (query: string) => Promise<WorkspaceSearchResult[]>;
}

export function SendBox({
  value,
  runtimeState,
  canSend,
  canStop,
  placeholder = "要求后续变更",
  ariaLabel = "继续对话输入",
  inputLabel = "继续输入",
  statusText = "回车发送",
  controls,
  rightControls,
  contextBar,
  disabled = false,
  variant = "conversation",
  allowFileSelection = true,
  leftHint = null,
  onChange,
  onSend,
  onStop,
  onSlashCommand,
  onSearchWorkspace,
}: SendBoxProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [dismissedSlashValue, setDismissedSlashValue] = useState<string | null>(null);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [dismissedAtValue, setDismissedAtValue] = useState<string | null>(null);
  const [atResults, setAtResults] = useState<WorkspaceSearchResult[]>([]);
  const [atLoading, setAtLoading] = useState(false);
  const [atError, setAtError] = useState<string | null>(null);
  const [fileSelection, dispatchFileSelection] = useReducer(
    fileSelectionReducer,
    initialFileSelectionState,
  );
  const busy = isBusy(runtimeState);
  const inputDisabled = disabled || busy;
  const SendIcon = variant === "codex" ? ArrowUp : SendHorizontal;
  const slashQuery = getSlashQuery(value);
  const slashCommands = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(defaultSlashCommands, slashQuery)),
    [slashQuery],
  );
  const slashOpen = slashQuery !== null && dismissedSlashValue !== value && !busy;
  const atQuery = getAtQuery(value);
  const atOpen =
    allowFileSelection && Boolean(onSearchWorkspace) && atQuery !== null && dismissedAtValue !== value && !busy && !slashOpen;
  const composition = useCompositionInput({
    disabled: inputDisabled || !canSend,
    onSubmit: onSend,
  });

  useEffect(() => {
    setSlashActiveIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    setAtActiveIndex(0);
  }, [atQuery]);

  useEffect(() => {
    let active = true;
    if (!atOpen) {
      setAtResults([]);
      setAtLoading(false);
      setAtError(null);
      return;
    }
    if (!atQuery) {
      setAtResults([]);
      setAtLoading(false);
      setAtError(null);
      return;
    }
    if (!onSearchWorkspace) {
      setAtResults([]);
      setAtLoading(false);
      setAtError(null);
      return;
    }
    setAtLoading(true);
    setAtError(null);
    void onSearchWorkspace(atQuery)
      .then((results) => {
        if (!active) {
          return;
        }
        setAtResults(results);
      })
      .catch((reason: unknown) => {
        if (!active) {
          return;
        }
        setAtResults([]);
        setAtError(errorMessage(reason));
      })
      .finally(() => {
        if (active) {
          setAtLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [atOpen, atQuery, onSearchWorkspace]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.style.height = "0px";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 44), 188)}px`;
  }, [value]);

  const selectSlashCommand = (command: SlashCommand) => {
    onSlashCommand?.(command);
    if (command.id === "clear") {
      onChange("");
      return;
    }
    onChange(replaceSlashQuery(value, `${command.label} `));
  };

  const selectFile = (result: WorkspaceSearchResult) => {
    dispatchFileSelection({ type: "add", file: selectedFileFromWorkspace(result) });
    onChange(replaceAtQuery(value, result));
  };

  const removeFile = (path: string) => {
    dispatchFileSelection({ type: "remove", path });
    onChange(value.replace(`@${path} `, "").replace(`@${path}`, ""));
  };

  const addFiles = (files: FileList | null, source: "dropped" | "pasted") => {
    if (!allowFileSelection) {
      return;
    }
    if (!files?.length) {
      return;
    }
    let added = 0;
    Array.from(files).forEach((file) => {
      const selected = selectedFileFromFile(file, source);
      if (!selected) {
        return;
      }
      added += 1;
      dispatchFileSelection({ type: "add", file: selected });
    });
    if (!added) {
      dispatchFileSelection({ type: "error", error: "不支持的文件，无法获取路径" });
    }
  };

  const handleDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!allowFileSelection) {
      return;
    }
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dispatchFileSelection({ type: "dragging", dragging: true });
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!allowFileSelection) {
      return;
    }
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dispatchFileSelection({ type: "dragging", dragging: false });
    addFiles(event.dataTransfer.files, "dropped");
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!allowFileSelection) {
      return;
    }
    if (!event.clipboardData.files.length) {
      return;
    }
    event.preventDefault();
    addFiles(event.clipboardData.files, "pasted");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((index) => Math.min(index + 1, Math.max(slashCommands.length - 1, 0)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashValue(value);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const command = slashCommands[slashActiveIndex];
        if (command) {
          selectSlashCommand(command);
        }
        return;
      }
    }
    if (atOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAtActiveIndex((index) => Math.min(index + 1, Math.max(atResults.length - 1, 0)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setAtActiveIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAtValue(value);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = atResults[atActiveIndex];
        if (result) {
          selectFile(result);
        }
        return;
      }
    }
    composition.handleKeyDown(event);
  };

  return (
    <form
      className={styles.root}
      data-focused={focused ? "true" : "false"}
      data-dragging={fileSelection.dragging ? "true" : "false"}
      data-state={runtimeState}
      data-variant={variant}
      aria-label={ariaLabel}
      onDragLeave={() => dispatchFileSelection({ type: "dragging", dragging: false })}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) {
          onSend();
        }
      }}
    >
      <textarea
        ref={inputRef}
        className={styles.input}
        aria-label={inputLabel}
        placeholder={placeholder}
        rows={1}
        value={value}
        disabled={inputDisabled}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.target.value)}
        onCompositionEnd={composition.handleCompositionEnd}
        onCompositionStart={composition.handleCompositionStart}
        onFocus={() => setFocused(true)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />

      {slashOpen ? (
        <SlashCommandMenu commands={slashCommands} activeIndex={slashActiveIndex} onSelect={selectSlashCommand} />
      ) : null}
      {atOpen ? (
        <AtFileMenu
          results={atResults}
          activeIndex={atActiveIndex}
          loading={atLoading}
          error={atError}
          query={atQuery ?? ""}
          onSelect={selectFile}
        />
      ) : null}

      {fileSelection.files.length ? (
        <div className={styles.fileChips} aria-label="已选择文件">
          {fileSelection.files.map((file) => (
            <button
              className={styles.fileChip}
              type="button"
              aria-label={`移除文件 ${file.path}`}
              key={file.path}
              onClick={() => removeFile(file.path)}
            >
              <span>{file.path}</span>
            </button>
          ))}
        </div>
      ) : null}
      {fileSelection.error ? <div className={styles.fileError}>{fileSelection.error}</div> : null}

      <div className={styles.toolbar}>
        <div className={styles.leftActions}>
          {controls}
          {leftHint}
        </div>

        <div className={styles.rightActions}>
          {statusText ? <span className={styles.statusText}>{statusText}</span> : null}
          {rightControls}
          {busy ? (
            <button className={styles.stopButton} type="button" aria-label="停止" disabled={!canStop} onClick={onStop}>
              <Square size={13} />
            </button>
          ) : (
            <button className={styles.sendButton} type="submit" aria-label="发送" disabled={!canSend}>
              <SendIcon size={variant === "codex" ? 19 : 17} />
            </button>
          )}
        </div>
      </div>

      {contextBar ? <div className={styles.contextBar}>{contextBar}</div> : null}
    </form>
  );
}

function isBusy(state: ConversationRuntimeState): boolean {
  return state === "starting" || state === "running" || state === "waiting_approval" || state === "cancelling";
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "工作区搜索失败";
}
