import { ArrowUp, SendHorizontal, Square, X } from "lucide-react";
import {
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type { WorkspaceSearchResult } from "@/runtime";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import { AtFileMenu, getAtQuery, removeAtQuery } from "@/renderer/components/chat/AtFileMenu";
import {
  defaultSlashCommands,
  filterSlashCommands,
  getSlashQuery,
  replaceSlashQuery,
  SlashCommandMenu,
  type SlashCommand,
} from "@/renderer/components/chat/SlashCommandMenu";
import {
  parseQuoteMarkers,
  quoteMarkerPreview,
  removeQuoteMarkerAtIndex,
  type QuoteMarkerQuoteSegment,
} from "@/renderer/utils/quoteMarkers";
import { useWorkspaceFileSearch, type WorkspaceFileSearchFn } from "@/renderer/hooks/useWorkspaceFileSearch";

import styles from "./SendBox.module.css";
import {
  fileSelectionReducer,
  initialFileSelectionState,
  type SelectedFile,
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
  onSend: (files: SelectedFile[]) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  onOpenFileReference?: (file: SelectedFile) => void;
  onSlashCommand?: (command: SlashCommand) => void;
  onListWorkspaceDirectory?: (path: string) => Promise<WorkspaceSearchResult[]>;
  onSearchWorkspace?: WorkspaceFileSearchFn;
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
  onOpenFileReference,
  onSlashCommand,
  onListWorkspaceDirectory,
  onSearchWorkspace,
}: SendBoxProps) {
  const inputRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [dismissedSlashValue, setDismissedSlashValue] = useState<string | null>(null);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [dismissedAtValue, setDismissedAtValue] = useState<string | null>(null);
  const [atBrowseState, setAtBrowseState] = useState<{ path: string; value: string } | null>(null);
  const hadAtDirectoryRequestRef = useRef(false);
  const [atDirectoryResults, setAtDirectoryResults] = useState<WorkspaceSearchResult[]>([]);
  const [atDirectoryLoading, setAtDirectoryLoading] = useState(false);
  const [atDirectoryError, setAtDirectoryError] = useState<string | null>(null);
  const [fileSelection, dispatchFileSelection] = useReducer(
    fileSelectionReducer,
    initialFileSelectionState,
  );
  const editorValue = useMemo(() => editorTextFromComposerValue(value), [value]);
  const quoteChips = useMemo(() => quoteChipsFromComposerValue(value), [value]);
  const busy = isBusy(runtimeState);
  const inputDisabled = disabled || busy;
  const canSubmit = canSend || fileSelection.files.length > 0;
  const requestSend = useCallback(() => {
    const result = onSend(fileSelection.files);
    void Promise.resolve(result).then((sent) => {
      if (sent !== false) {
        dispatchFileSelection({ type: "clear" });
      }
    });
  }, [fileSelection.files, onSend]);
  const SendIcon = variant === "codex" ? ArrowUp : SendHorizontal;
  const slashQuery = getSlashQuery(editorValue);
  const slashCommands = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(defaultSlashCommands, slashQuery)),
    [slashQuery],
  );
  const slashOpen = slashQuery !== null && dismissedSlashValue !== editorValue && !busy;
  const atQuery = getAtQuery(editorValue);
  const atBrowsePath = atBrowseState && atBrowseState.value === editorValue ? atBrowseState.path : null;
  const atOpen =
    allowFileSelection &&
    Boolean(onSearchWorkspace || onListWorkspaceDirectory) &&
    atQuery !== null &&
    dismissedAtValue !== editorValue &&
    !busy &&
    !slashOpen;
  const atDirectoryPath =
    atOpen && onListWorkspaceDirectory && (atBrowsePath !== null || !atQuery) ? atBrowsePath ?? "" : null;
  const atSearchQuery = atDirectoryPath === null ? atQuery ?? "" : "";
  const atSearchState = useWorkspaceFileSearch({
    enabled: atOpen && atDirectoryPath === null && Boolean(onSearchWorkspace),
    query: atSearchQuery,
    search: onSearchWorkspace,
  });
  const atResults = atDirectoryPath === null ? atSearchState.results : atDirectoryResults;
  const atLoading = atDirectoryPath === null ? atSearchState.loading : atDirectoryLoading;
  const atError = atDirectoryPath === null ? atSearchState.error : atDirectoryError;
  const composition = useCompositionInput({
    disabled: inputDisabled || !canSubmit,
    onSubmit: requestSend,
  });

  useEffect(() => {
    setSlashActiveIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    setAtActiveIndex(0);
  }, [atDirectoryPath, atQuery]);

  useEffect(() => {
    if (!atOpen) {
      setAtBrowseState(null);
    }
  }, [atOpen]);

  useEffect(() => {
    if (atBrowseState && atBrowseState.value !== editorValue && atQuery !== "") {
      setAtBrowseState(null);
    }
  }, [atBrowseState, atQuery, editorValue]);

  useEffect(() => {
    let active = true;
    if (!atOpen || atDirectoryPath === null || !onListWorkspaceDirectory) {
      if (hadAtDirectoryRequestRef.current) {
        hadAtDirectoryRequestRef.current = false;
        setAtDirectoryResults([]);
        setAtDirectoryLoading(false);
        setAtDirectoryError(null);
      }
      return;
    }
    hadAtDirectoryRequestRef.current = true;
    setAtDirectoryResults([]);
    setAtDirectoryLoading(true);
    setAtDirectoryError(null);
    void onListWorkspaceDirectory(atDirectoryPath)
      .then((results) => {
        if (active) {
          setAtDirectoryResults(results);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setAtDirectoryResults([]);
          setAtDirectoryError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (active) {
          setAtDirectoryLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [atDirectoryPath, atOpen, onListWorkspaceDirectory]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    resizeEditableInput(input);
  }, [editorValue]);

  const selectSlashCommand = (command: SlashCommand) => {
    onSlashCommand?.(command);
    if (command.id === "clear") {
      onChange("");
      return;
    }
    onChange(composerValueFromEditorText(replaceSlashQuery(editorValue, `${command.label} `), value));
  };

  const selectFile = (result: WorkspaceSearchResult) => {
    if (result.type === "directory" && onListWorkspaceDirectory) {
      setAtBrowseState({ path: result.path, value: editorValue });
      return;
    }
    dispatchFileSelection({ type: "add", file: selectedFileFromWorkspace(result) });
    const nextValue = removeAtQuery(editorValue);
    setAtBrowseState(null);
    setDismissedAtValue(nextValue);
    onChange(composerValueFromEditorText(nextValue, value));
  };

  const navigateAtDirectory = (path: string) => {
    setAtBrowseState({ path, value: editorValue });
  };

  const removeFile = (path: string) => {
    dispatchFileSelection({ type: "remove", path });
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

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (allowFileSelection && event.clipboardData.files.length) {
      event.preventDefault();
      addFiles(event.clipboardData.files, "pasted");
      return;
    }
    pastePlainText(event);
    syncEditableChange(event.currentTarget, (nextValue) => {
      onChange(composerValueFromEditorText(nextValue, value));
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
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
        setDismissedSlashValue(editorValue);
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
        setDismissedAtValue(editorValue);
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
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      insertPlainText("\n");
      syncEditableChange(event.currentTarget, (nextValue) => {
        onChange(composerValueFromEditorText(nextValue, value));
      });
      resizeEditableInput(event.currentTarget);
      scrollEditableToBottom(event.currentTarget);
      return;
    }
    composition.handleKeyDown(event);
  };

  const handleEditorInput = useCallback(
    (event: FormEvent<HTMLDivElement>) => {
      syncEditableChange(event.currentTarget, (nextValue) => {
        onChange(composerValueFromEditorText(nextValue, value));
      });
    },
    [onChange, value],
  );

  const handleQuoteRemove = useCallback(
    (quoteIndex: number) => {
      onChange(removeQuoteMarkerAtIndex(value, quoteIndex));
    },
    [onChange, value],
  );

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
        if (!busy && canSubmit) {
          requestSend();
        }
      }}
    >
      {quoteChips.length || fileSelection.files.length ? (
        <div className={styles.fileChips} aria-label="已添加上下文">
          {quoteChips.map((quote) => (
            <QuoteContextChip
              key={`${quote.index}:${quote.marker}`}
              quote={quote}
              onRemove={() => handleQuoteRemove(quote.index)}
            />
          ))}
          {fileSelection.files.map((file) => (
            <span className={styles.fileChip} key={file.path}>
              <button
                className={styles.fileChipMain}
                type="button"
                aria-label={`打开文件引用 ${file.path}`}
                disabled={!onOpenFileReference}
                onClick={() => onOpenFileReference?.(file)}
              >
                <span className={styles.fileChipText}>{file.path}</span>
              </button>
              <button
                className={styles.fileChipRemove}
                type="button"
                aria-label={`移除文件引用 ${file.path}`}
                onClick={() => removeFile(file.path)}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <ContentEditableInput
        refSetter={(node) => {
          inputRef.current = node;
        }}
        value={editorValue}
        inputLabel={inputLabel}
        placeholder={placeholder}
        disabled={inputDisabled}
        className={styles.input}
        onBlur={() => setFocused(false)}
        onChange={handleEditorInput}
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
          directoryPath={atDirectoryPath}
          query={atQuery ?? ""}
          onNavigateDirectory={navigateAtDirectory}
          onSelect={selectFile}
        />
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
            <button className={styles.sendButton} type="submit" aria-label="发送" disabled={!canSubmit}>
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

function editorTextFromComposerValue(value: string): string {
  return parseQuoteMarkers(value)
    .map((segment) => (segment.type === "text" ? segment.value : ""))
    .join("");
}

function composerValueFromEditorText(editorText: string, currentValue: string): string {
  const quoteMarkers = quoteSegmentsFromComposerValue(currentValue)
    .map((segment) => segment.marker)
    .join("");
  return `${editorText}${quoteMarkers}`;
}

function quoteChipsFromComposerValue(value: string): QuoteChipItem[] {
  return quoteSegmentsFromComposerValue(value).map((segment, index) => ({
    index,
    marker: segment.marker,
    preview: quoteMarkerPreview(segment.value),
    text: segment.value,
  }));
}

function quoteSegmentsFromComposerValue(value: string): QuoteMarkerQuoteSegment[] {
  return parseQuoteMarkers(value).filter((segment): segment is QuoteMarkerQuoteSegment => segment.type === "quote");
}

interface QuoteChipItem {
  index: number;
  marker: string;
  preview: string;
  text: string;
}

function QuoteContextChip({ quote, onRemove }: { quote: QuoteChipItem; onRemove: () => void }) {
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current === null) {
      return;
    }
    window.clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) {
      return;
    }
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const scheduleOpen = useCallback(() => {
    clearShowTimer();
    clearHideTimer();
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      setOpen(true);
    }, QUOTE_CARD_SHOW_DELAY_MS);
  }, [clearHideTimer, clearShowTimer]);

  const scheduleClose = useCallback(() => {
    clearShowTimer();
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setOpen(false);
      setCopied(false);
    }, 120);
  }, [clearHideTimer, clearShowTimer]);

  useEffect(
    () => () => {
      clearShowTimer();
      clearHideTimer();
    },
    [clearHideTimer, clearShowTimer],
  );

  const handleCopyQuote = async () => {
    await copyToClipboard(quote.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <span
      className={styles.quoteChipWrapper}
      onBlur={(event) => {
        const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
        if (!event.currentTarget.contains(relatedTarget)) {
          scheduleClose();
        }
      }}
      onFocus={scheduleOpen}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <span
        className={styles.quoteInputChip}
        tabIndex={0}
        aria-label={`引用片段：${quote.preview}`}
        data-quote-index={quote.index}
      >
        <span className={styles.quoteInputChipLabel}>引用片段</span>
        <button
          className={styles.quoteInputChipRemove}
          type="button"
          aria-label={`删除引用片段 ${quote.preview}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} strokeWidth={2} />
        </button>
      </span>
      {open ? (
        <span
          className={styles.quoteHoverCard}
          data-quote-hover-card="true"
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={clearHideTimer}
          onMouseLeave={scheduleClose}
        >
          <span className={styles.quoteHoverBody}>{quote.text}</span>
          <span className={styles.quoteHoverActions}>
            <button type="button" onClick={handleCopyQuote}>
              {copied ? "已复制" : "复制"}
            </button>
            <button type="button" data-danger="true" onClick={onRemove}>
              删除
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
}

interface ContentEditableInputProps {
  value: string;
  inputLabel: string;
  placeholder: string;
  disabled: boolean;
  className: string;
  refSetter: (node: HTMLDivElement | null) => void;
  onBlur: () => void;
  onChange: (event: FormEvent<HTMLDivElement>) => void;
  onCompositionEnd: (event: CompositionEvent<HTMLElement>) => void;
  onCompositionStart: (event: CompositionEvent<HTMLElement>) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
}

function ContentEditableInput({
  value,
  inputLabel,
  placeholder,
  disabled,
  className,
  refSetter,
  onBlur,
  onChange,
  onCompositionEnd,
  onCompositionStart,
  onFocus,
  onKeyDown,
  onPaste,
}: ContentEditableInputProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const setEditorRef = useCallback(
    (node: HTMLDivElement | null) => {
      editorRef.current = node;
      refSetter(node);
    },
    [refSetter],
  );

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    if (readEditorValue(editor) !== value) {
      renderEditorValue(editor, value);
    }
    editor.dataset.empty = value ? "false" : "true";
  }, [value]);

  return (
    <div
      ref={setEditorRef}
      className={`${className} ${styles.richInput}`}
      role="textbox"
      aria-label={inputLabel}
      aria-multiline="true"
      aria-disabled={disabled}
      aria-placeholder={placeholder}
      contentEditable={!disabled}
      data-empty={value ? "false" : "true"}
      data-placeholder={placeholder}
      suppressContentEditableWarning
      tabIndex={disabled ? -1 : 0}
      onBlur={onBlur}
      onCompositionEnd={onCompositionEnd}
      onCompositionStart={onCompositionStart}
      onFocus={onFocus}
      onInput={onChange}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  );
}

const QUOTE_CARD_SHOW_DELAY_MS = 200;

function renderEditorValue(editor: HTMLDivElement, value: string) {
  editor.replaceChildren(...(value ? [document.createTextNode(value)] : []));
}

function syncEditableChange(editor: HTMLElement, onChange: (value: string) => void) {
  const nextValue = readEditorValue(editor);
  editor.dataset.empty = nextValue ? "false" : "true";
  onChange(nextValue);
}

function readEditorValue(root: Node): string {
  if (!hasMeaningfulEditorContent(root)) {
    return "";
  }
  let value = "";
  root.childNodes.forEach((node) => {
    value += readEditorNodeValue(node);
  });
  return normalizeEditorText(value);
}

function readEditorNodeValue(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (!(node instanceof HTMLElement)) {
    return "";
  }
  if (node.tagName === "BR") {
    return "\n";
  }
  const childValue = readEditorValue(node);
  return isBlockEditorNode(node) && childValue ? `${childValue}\n` : childValue;
}

function isBlockEditorNode(node: HTMLElement): boolean {
  return node.tagName === "DIV" || node.tagName === "P";
}

function hasMeaningfulEditorContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeEditorText(node.textContent ?? "").length > 0;
  }
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  if (node.tagName === "BR") {
    return false;
  }
  return Array.from(node.childNodes).some((child) => hasMeaningfulEditorContent(child));
}

function normalizeEditorText(text: string): string {
  return text.replace(/\u00a0/g, " ");
}

function resizeEditableInput(input: HTMLElement) {
  input.style.height = "0px";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 44), 188)}px`;
}

function scrollEditableToBottom(input: HTMLElement) {
  input.scrollTop = input.scrollHeight;
  window.requestAnimationFrame(() => {
    input.scrollTop = input.scrollHeight;
  });
}

function pastePlainText(event: ClipboardEvent<HTMLElement>) {
  const text = event.clipboardData.getData("text/plain");
  event.preventDefault();
  insertPlainText(text);
}

function insertPlainText(text: string) {
  if (!text) {
    return;
  }
  if (typeof document.execCommand === "function" && document.execCommand("insertText", false, text)) {
    return;
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount) {
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  document.execCommand("copy", false, text);
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
