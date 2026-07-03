import { ArrowUp, LoaderCircle, Paperclip, Plus, SendHorizontal, Square, X } from "lucide-react";
import {
  type ClipboardEvent,
  type ChangeEvent,
  type CompositionEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type CSSProperties,
  type ReactNode,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { runtimeBridge, type RuntimeBridge, type WorkspaceSearchResult, type WorkspaceSkillSummary } from "@/runtime";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import type { FileAccessMode } from "@/types/protocol";
import { getAtQuery, removeAtQuery } from "@/renderer/components/chat/AtFileMenu/atFiles";
import popupStyles from "@/renderer/components/chat/ComposerPopupMenu/ComposerPopupMenu.module.css";
import {
  buildSlashCommands,
  filterSlashCommands,
  filterSlashSkills,
  getSlashQuery,
  removeSlashQuery,
  replaceSlashQuery,
  SlashCommandMenu,
  type SlashCommand,
  skillToSlashCommand,
} from "@/renderer/components/chat/SlashCommandMenu";
import { ContextChipIcon } from "@/renderer/components/chat/ContextChipIcon";
import { useWorkspaceFileSearch, type WorkspaceFileSearchFn } from "@/renderer/hooks/useWorkspaceFileSearch";
import { ImagePreviewDialog } from "@/renderer/components/workspace/ImagePreviewSurface";

import styles from "./SendBox.module.css";
import {
  fileSelectionReducer,
  initialFileSelectionState,
  type FileSelectionAction,
  type SelectedFile,
  type SelectedFileSource,
  selectedFileKey,
  selectedFileFromFile,
  selectedFileFromPath,
  selectedFileFromWorkspace,
} from "./fileSelection";
import {
  isImageFile,
  isImagePath,
  selectedImageAttachmentFromRecord,
  type SelectedImageAttachment,
} from "./imageAttachments";
import {
  initialQuoteSelectionState,
  quoteSelectionReducer,
  type QuoteSelectionAction,
  type SelectedQuote,
} from "./quoteSelection";
import { useCompositionInput } from "./useCompositionInput";

const LazyAtFileMenu = lazy(() =>
  import("@/renderer/components/chat/AtFileMenu/AtFileMenu").then((module) => ({
    default: module.AtFileMenu,
  })),
);

const MISSING_SOURCE_FILE_PATH_MESSAGE =
  "无法获取源文件路径，已拒绝作为临时副本添加。请在桌面端选择文件，或将文件放入工作区后用 @ 引用。";
const FILE_ACCESS_DISABLED_MESSAGE = "当前文件访问权限为「无文件访问权限」，不能引入文件上下文。";
const WORKSPACE_FILE_ONLY_MESSAGE = "当前文件访问权限仅允许引入工作区内文件，请将文件放入工作区后用 @ 引用。";

export interface SendBoxProps {
  value: string;
  runtimeState: ConversationRuntimeState;
  canSend: boolean;
  canStop: boolean;
  placeholder?: string;
  ariaLabel?: string;
  inputLabel?: string;
  className?: string;
  statusText?: string;
  controls?: ReactNode;
  rightControls?: ReactNode;
  leftAccessory?: ReactNode;
  contextBar?: ReactNode;
  disabled?: boolean;
  sendLoading?: boolean;
  variant?: "conversation" | "keydex";
  autoFocusKey?: string;
  allowFileSelection?: boolean;
  fileAccessMode?: FileAccessMode;
  workspaceRoots?: string[];
  externalFileRequest?: SendBoxExternalFileRequest | null;
  externalQuoteRequest?: SendBoxExternalQuoteRequest | null;
  selectedFiles?: SelectedFile[];
  selectedQuotes?: SelectedQuote[];
  leftHint?: ReactNode;
  allowBypassConversationSlashCommand?: boolean;
  allowGoalSlashCommand?: boolean;
  workspaceSkills?: WorkspaceSkillSummary[];
  selectedSkill?: WorkspaceSkillSummary | null;
  onSelectedFilesChange?: (files: SelectedFile[]) => void;
  onSelectedQuotesChange?: (quotes: SelectedQuote[]) => void;
  onSkillChange?: (skill: WorkspaceSkillSummary | null) => void;
  onChange: (value: string) => void;
  onSend: (
    files: SelectedFile[],
    quotes: SelectedQuote[],
    attachments: SelectedImageAttachment[],
  ) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  runtime?: RuntimeBridge;
  sessionId?: string | null;
  onEscape?: () => void;
  onOpenFileReference?: (file: SelectedFile) => void;
  onSlashCommand?: (command: SlashCommand) => void;
  onRefreshWorkspaceSkills?: () => void | Promise<void>;
  onExternalFileRequestHandled?: (requestId: number) => void;
  onExternalQuoteRequestHandled?: (requestId: number) => void;
  onListWorkspaceDirectory?: (path: string) => Promise<WorkspaceSearchResult[]>;
  onSearchWorkspace?: WorkspaceFileSearchFn;
}

export interface SendBoxExternalFileRequest {
  requestId: number;
  file?: SelectedFile | null;
  files?: SelectedFile[];
}

export interface SendBoxExternalQuoteRequest {
  requestId: number;
  quote?: SelectedQuote | null;
  quotes?: SelectedQuote[];
}

type SlashMenuItem =
  | { type: "command"; command: SlashCommand }
  | { type: "skill"; skill: WorkspaceSkillSummary };

export function SendBox({
  value,
  runtimeState,
  canSend,
  canStop,
  placeholder = "要求后续变更",
  ariaLabel = "继续对话输入",
  inputLabel = "继续输入",
  className = "",
  statusText = "回车发送",
  controls,
  rightControls,
  leftAccessory,
  contextBar,
  disabled = false,
  sendLoading = false,
  variant = "conversation",
  autoFocusKey,
  allowFileSelection = true,
  fileAccessMode = "workspace_trusted",
  workspaceRoots = [],
  externalFileRequest = null,
  externalQuoteRequest = null,
  selectedFiles: controlledSelectedFiles,
  selectedQuotes: controlledSelectedQuotes,
  leftHint = null,
  allowBypassConversationSlashCommand = true,
  allowGoalSlashCommand = true,
  workspaceSkills = [],
  selectedSkill: controlledSelectedSkill,
  onSelectedFilesChange,
  onSelectedQuotesChange,
  onSkillChange,
  onChange,
  onSend,
  onStop,
  runtime = runtimeBridge,
  sessionId = null,
  onEscape,
  onOpenFileReference,
  onSlashCommand,
  onRefreshWorkspaceSkills,
  onExternalFileRequestHandled,
  onExternalQuoteRequestHandled,
  onListWorkspaceDirectory,
  onSearchWorkspace,
}: SendBoxProps) {
  const inputRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentButtonRef = useRef<HTMLButtonElement | null>(null);
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);
  const imagePreviewObjectUrlsRef = useRef<Set<string>>(new Set());
  const handledExternalFileRequestIdRef = useRef<number | null>(null);
  const handledExternalQuoteRequestIdRef = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [slashMode, setSlashMode] = useState<"root" | "skills">("root");
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [dismissedSlashValue, setDismissedSlashValue] = useState<string | null>(null);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [dismissedAtValue, setDismissedAtValue] = useState<string | null>(null);
  const [atBrowseState, setAtBrowseState] = useState<{ path: string; value: string } | null>(null);
  const hadAtDirectoryRequestRef = useRef(false);
  const refreshedSlashSessionRef = useRef(false);
  const [atDirectoryResults, setAtDirectoryResults] = useState<WorkspaceSearchResult[]>([]);
  const [atDirectoryLoading, setAtDirectoryLoading] = useState(false);
  const [atDirectoryError, setAtDirectoryError] = useState<string | null>(null);
  const [imageAttachments, setImageAttachments] = useState<SelectedImageAttachment[]>([]);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [activeImagePreview, setActiveImagePreview] = useState<SelectedImageAttachment | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [uncontrolledSelectedSkill, setUncontrolledSelectedSkill] = useState<WorkspaceSkillSummary | null>(null);
  const [uncontrolledFileSelection, dispatchUncontrolledFileSelection] = useReducer(
    fileSelectionReducer,
    initialFileSelectionState,
  );
  const [uncontrolledQuoteSelection, dispatchUncontrolledQuoteSelection] = useReducer(
    quoteSelectionReducer,
    initialQuoteSelectionState,
  );
  const notifications = useNotifications();
  const editorValue = value;
  const busy = isBusy(runtimeState);
  const inputDisabled = disabled || (busy && runtimeState !== "running");
  const canUseFileContext = allowFileSelection && fileAccessMode !== "no_file_access";
  const filePickerAllowsGlobalPaths = fileAccessMode === "full_access";
  const fileAccessHint = fileAccessMessage(fileAccessMode);
  const selectedSkill = controlledSelectedSkill !== undefined ? controlledSelectedSkill : uncontrolledSelectedSkill;
  const fileSelection =
    controlledSelectedFiles === undefined
      ? uncontrolledFileSelection
      : { ...uncontrolledFileSelection, files: controlledSelectedFiles };
  const quoteSelection =
    controlledSelectedQuotes === undefined
      ? uncontrolledQuoteSelection
      : { quotes: controlledSelectedQuotes };
  const dispatchFileSelection = useCallback(
    (action: FileSelectionAction) => {
      if (controlledSelectedFiles === undefined) {
        dispatchUncontrolledFileSelection(action);
        return;
      }
      const next = fileSelectionReducer(fileSelection, action);
      dispatchUncontrolledFileSelection({ type: "dragging", dragging: next.dragging });
      dispatchUncontrolledFileSelection({ type: "error", error: next.error });
      if (next.files !== fileSelection.files) {
        onSelectedFilesChange?.(next.files);
      }
    },
    [controlledSelectedFiles, fileSelection, onSelectedFilesChange],
  );
  const dispatchQuoteSelection = useCallback(
    (action: QuoteSelectionAction) => {
      if (controlledSelectedQuotes === undefined) {
        dispatchUncontrolledQuoteSelection(action);
        return;
      }
      const next = quoteSelectionReducer(quoteSelection, action);
      if (next.quotes !== quoteSelection.quotes) {
        onSelectedQuotesChange?.(next.quotes);
      }
    },
    [controlledSelectedQuotes, onSelectedQuotesChange, quoteSelection],
  );
  const setSelectedSkill = useCallback(
    (skill: WorkspaceSkillSummary | null) => {
      if (controlledSelectedSkill === undefined) {
        setUncontrolledSelectedSkill(skill);
      }
      onSkillChange?.(skill);
    },
    [controlledSelectedSkill, onSkillChange],
  );
  const rememberPreviewUrl = useCallback((url: string | null | undefined) => {
    if (url?.startsWith("blob:")) {
      imagePreviewObjectUrlsRef.current.add(url);
    }
  }, []);
  const revokePreviewUrl = useCallback((url: string | null | undefined) => {
    if (!url?.startsWith("blob:")) {
      return;
    }
    URL.revokeObjectURL(url);
    imagePreviewObjectUrlsRef.current.delete(url);
  }, []);
  const addImageAttachment = useCallback(
    (attachment: SelectedImageAttachment) => {
      rememberPreviewUrl(attachment.previewUrl);
      setImageAttachments((current) => {
        const next = current.filter((item) => item.attachment_id !== attachment.attachment_id);
        return [...next, attachment];
      });
    },
    [rememberPreviewUrl],
  );
  const removeImageAttachment = useCallback(
    (attachmentId: string) => {
      setImageAttachments((current) => {
        const removed = current.find((item) => item.attachment_id === attachmentId);
        revokePreviewUrl(removed?.previewUrl);
        if (activeImagePreview?.attachment_id === attachmentId) {
          setActiveImagePreview(null);
        }
        return current.filter((item) => item.attachment_id !== attachmentId);
      });
    },
    [activeImagePreview?.attachment_id, revokePreviewUrl],
  );
  const clearImageAttachments = useCallback(() => {
    setImageAttachments((current) => {
      current.forEach((item) => revokePreviewUrl(item.previewUrl));
      return [];
    });
    setActiveImagePreview(null);
  }, [revokePreviewUrl]);
  const canSubmit =
    !busy &&
    !attachmentLoading &&
    (canSend || fileSelection.files.length > 0 || quoteSelection.quotes.length > 0 || imageAttachments.length > 0);
  const showSendLoading = sendLoading && !busy;
  const requestSend = useCallback(() => {
    const result = onSend(fileSelection.files, quoteSelection.quotes, imageAttachments);
    void Promise.resolve(result).then((sent) => {
      if (sent !== false) {
        dispatchFileSelection({ type: "clear" });
        dispatchQuoteSelection({ type: "clear" });
        clearImageAttachments();
        setSelectedSkill(null);
      }
    });
  }, [
    clearImageAttachments,
    fileSelection.files,
    imageAttachments,
    onSend,
    quoteSelection.quotes,
    setSelectedSkill,
  ]);
  const SendIcon = variant === "keydex" ? ArrowUp : SendHorizontal;
  const slashQuery = getSlashQuery(editorValue);
  const availableSlashCommands = useMemo(
    () =>
      buildSlashCommands(workspaceSkills, {
        includeBypassConversation: allowBypassConversationSlashCommand,
        includeGoal: allowGoalSlashCommand,
      }),
    [allowBypassConversationSlashCommand, allowGoalSlashCommand, workspaceSkills],
  );
  const slashCommands = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(availableSlashCommands, slashQuery)),
    [availableSlashCommands, slashQuery],
  );
  const slashSkills = useMemo(
    () => (slashQuery === null ? [] : filterSlashSkills(workspaceSkills, slashQuery)),
    [slashQuery, workspaceSkills],
  );
  const slashRootItems = useMemo<SlashMenuItem[]>(
    () => [
      ...slashCommands.map((command) => ({ type: "command" as const, command })),
      ...slashSkills.map((skill) => ({ type: "skill" as const, skill })),
    ],
    [slashCommands, slashSkills],
  );
  const slashOpen = slashQuery !== null && dismissedSlashValue !== editorValue && !busy;
  const slashItemCount = slashMode === "skills" ? slashSkills.length : slashRootItems.length;
  const visibleSlashActiveIndex = Math.min(slashActiveIndex, Math.max(slashItemCount - 1, 0));
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
    atOpen && canUseFileContext && onListWorkspaceDirectory && (atBrowsePath !== null || !atQuery)
      ? atBrowsePath ?? ""
      : null;
  const atSearchQuery = atDirectoryPath === null ? atQuery ?? "" : "";
  const atSearchState = useWorkspaceFileSearch({
    enabled: atOpen && canUseFileContext && atDirectoryPath === null && Boolean(onSearchWorkspace),
    query: atSearchQuery,
    search: onSearchWorkspace,
  });
  const atResults = canUseFileContext ? (atDirectoryPath === null ? atSearchState.results : atDirectoryResults) : [];
  const atLoading = canUseFileContext && (atDirectoryPath === null ? atSearchState.loading : atDirectoryLoading);
  const atError = canUseFileContext ? (atDirectoryPath === null ? atSearchState.error : atDirectoryError) : null;
  const atHint = atOpen && !canUseFileContext ? fileAccessHint : null;
  const composition = useCompositionInput({
    disabled: inputDisabled || !canSubmit,
    onSubmit: requestSend,
  });

  useEffect(() => {
    const directSkillIndex = slashMode === "root" && slashQuery && slashSkills.length ? slashCommands.length : 0;
    setSlashActiveIndex(directSkillIndex);
  }, [slashCommands.length, slashMode, slashQuery, slashSkills.length]);

  useEffect(() => {
    return () => {
      imagePreviewObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      imagePreviewObjectUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!attachmentMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (attachmentButtonRef.current?.contains(target) || attachmentMenuRef.current?.contains(target)) {
        return;
      }
      setAttachmentMenuOpen(false);
    };
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setAttachmentMenuOpen(false);
      attachmentButtonRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleDocumentKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
    };
  }, [attachmentMenuOpen]);

  useEffect(() => {
    if (slashQuery === null && dismissedSlashValue !== null) {
      setDismissedSlashValue(null);
    }
    if (slashQuery === null && slashMode !== "root") {
      setSlashMode("root");
    }
  }, [dismissedSlashValue, slashMode, slashQuery]);

  useEffect(() => {
    if (!slashOpen) {
      refreshedSlashSessionRef.current = false;
      return;
    }
    if (refreshedSlashSessionRef.current || !onRefreshWorkspaceSkills) {
      return;
    }
    refreshedSlashSessionRef.current = true;
    void onRefreshWorkspaceSkills();
  }, [onRefreshWorkspaceSkills, slashOpen]);

  useEffect(() => {
    setAtActiveIndex(0);
  }, [atDirectoryPath, atQuery]);

  useEffect(() => {
    if (!atOpen) {
      setAtBrowseState(null);
    }
  }, [atOpen]);

  useEffect(() => {
    if (attachmentMenuOpen && (slashOpen || atOpen)) {
      setAttachmentMenuOpen(false);
    }
  }, [attachmentMenuOpen, atOpen, slashOpen]);

  useEffect(() => {
    if (atQuery === null && dismissedAtValue !== null) {
      setDismissedAtValue(null);
    }
  }, [atQuery, dismissedAtValue]);

  useEffect(() => {
    if (atBrowseState && atBrowseState.value !== editorValue && atQuery !== "") {
      setAtBrowseState(null);
    }
  }, [atBrowseState, atQuery, editorValue]);

  useEffect(() => {
    if (!externalFileRequest || !canUseFileContext) {
      return;
    }
    if (handledExternalFileRequestIdRef.current === externalFileRequest.requestId) {
      return;
    }
    handledExternalFileRequestIdRef.current = externalFileRequest.requestId;
    const files = externalFileRequestFiles(externalFileRequest);
    if (files.length === 0) {
      return;
    }
    dispatchFileSelection(
      files.length === 1 ? { type: "add", file: files[0] } : { type: "addMany", files },
    );
    onExternalFileRequestHandled?.(externalFileRequest.requestId);
    inputRef.current?.focus();
  }, [canUseFileContext, externalFileRequest, onExternalFileRequestHandled]);

  useEffect(() => {
    if (!externalQuoteRequest) {
      return;
    }
    if (handledExternalQuoteRequestIdRef.current === externalQuoteRequest.requestId) {
      return;
    }
    handledExternalQuoteRequestIdRef.current = externalQuoteRequest.requestId;
    const quotes = externalQuoteRequestQuotes(externalQuoteRequest);
    if (quotes.length === 0) {
      return;
    }
    dispatchQuoteSelection(
      quotes.length === 1 ? { type: "add", quote: quotes[0] } : { type: "addMany", quotes },
    );
    onExternalQuoteRequestHandled?.(externalQuoteRequest.requestId);
    inputRef.current?.focus();
  }, [externalQuoteRequest, onExternalQuoteRequestHandled]);

  useEffect(() => {
    let active = true;
    if (!atOpen || !canUseFileContext || atDirectoryPath === null || !onListWorkspaceDirectory) {
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
  }, [atDirectoryPath, atOpen, canUseFileContext, onListWorkspaceDirectory]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    resizeEditableInput(input);
  }, [editorValue]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!autoFocusKey || inputDisabled || !input) {
      return;
    }
    focusEditableInput(input);
  }, [autoFocusKey, inputDisabled]);

  const selectSlashCommand = (command: SlashCommand) => {
    if (command.kind === "skill_group") {
      setSlashMode("skills");
      setSlashActiveIndex(0);
      if (slashQuery && slashSkills.length === 0) {
        onChange(replaceSlashQuery(editorValue, "/"));
      }
      return;
    }
    if (command.kind === "skill" && command.skill) {
      selectSlashSkill(command.skill);
      return;
    }
    onSlashCommand?.(command);
    if (command.kind === "builtin" || command.kind === "goal") {
      setSlashMode("root");
      const nextValue = removeSlashQuery(editorValue);
      setDismissedSlashValue(nextValue);
      onChange(nextValue);
      return;
    }
    onChange(replaceSlashQuery(editorValue, `${command.label} `));
  };

  const selectSlashSkill = (skill: WorkspaceSkillSummary) => {
    const command = skillToSlashCommand(skill);
    onSlashCommand?.(command);
    setSelectedSkill(skill);
    setSlashMode("root");
    const nextValue = removeSlashQuery(editorValue);
    setDismissedSlashValue(editorValue);
    onChange(nextValue);
  };

  const navigateSlashRoot = () => {
    setSlashMode("root");
    setSlashActiveIndex(0);
    if (slashQuery) {
      onChange(replaceSlashQuery(editorValue, "/"));
    }
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
    onChange(nextValue);
  };

  const navigateAtDirectory = (path: string) => {
    setAtBrowseState({ path, value: editorValue });
  };

  const removeFile = (file: SelectedFile) => {
    dispatchFileSelection({ type: "remove", id: selectedFileKey(file) });
  };

  const addImagePath = useCallback(
    async (path: string, source: string, previewUrl?: string | null) => {
      const record = await runtime.attachments.registerImagePath(path, { source, sessionId });
      let resolvedPreviewUrl = previewUrl ?? null;
      if (!resolvedPreviewUrl) {
        try {
          const media = await runtime.attachments.readMedia(record.attachment_id || record.id);
          resolvedPreviewUrl = media.data_url;
        } catch {
          resolvedPreviewUrl = null;
        }
      }
      addImageAttachment(selectedImageAttachmentFromRecord(record, resolvedPreviewUrl));
    },
    [addImageAttachment, runtime, sessionId],
  );

  const addSelectedFilePath = useCallback(
    (path: string, source: SelectedFileSource, name?: string | null) => {
      if (!canUseFileContext) {
        return false;
      }
      if (!filePickerAllowsGlobalPaths && source !== "workspace" && !isWorkspaceAllowedPath(path, workspaceRoots)) {
        return false;
      }
      const selected = selectedFileFromPath(path, source, name, "file");
      if (!selected) {
        return false;
      }
      dispatchFileSelection({ type: "add", file: selected });
      return true;
    },
    [canUseFileContext, filePickerAllowsGlobalPaths, workspaceRoots],
  );

  const reportAttachmentSelectionResult = useCallback(
    (message: string | null, level: "warning" | "error" = "warning") => {
      if (!message) {
        dispatchFileSelection({ type: "error", error: null });
        return;
      }
      const notificationId =
        level === "error"
          ? notifications.error(message)
          : notifications.warning(message);
      dispatchFileSelection({ type: "error", error: notificationId ? null : message });
    },
    [notifications],
  );

  const addPickedPaths = useCallback(
    async (paths: string[], source: SelectedFileSource) => {
      const cleanedPaths = paths.map((path) => path.trim()).filter(Boolean);
      if (!cleanedPaths.length) {
        return;
      }
      setAttachmentLoading(true);
      try {
        let added = 0;
        let blockedByFileAccess = false;
        let blockedByWorkspaceScope = false;
        for (const path of cleanedPaths) {
          if (isImagePath(path)) {
            await addImagePath(path, source);
            added += 1;
            continue;
          }
          if (!canUseFileContext) {
            blockedByFileAccess = true;
            continue;
          }
          if (!filePickerAllowsGlobalPaths && source !== "workspace" && !isWorkspaceAllowedPath(path, workspaceRoots)) {
            blockedByWorkspaceScope = true;
            continue;
          }
          if (addSelectedFilePath(path, source)) {
            added += 1;
          }
        }
        reportAttachmentSelectionResult(
          blockedByFileAccess
            ? FILE_ACCESS_DISABLED_MESSAGE
            : blockedByWorkspaceScope
              ? fileAccessHint || WORKSPACE_FILE_ONLY_MESSAGE
              : added
                ? null
                : "不支持的文件，无法获取路径",
        );
      } catch (reason) {
        reportAttachmentSelectionResult(errorMessage(reason), "error");
      } finally {
        setAttachmentLoading(false);
      }
    },
    [
      addImagePath,
      addSelectedFilePath,
      canUseFileContext,
      fileAccessHint,
      filePickerAllowsGlobalPaths,
      reportAttachmentSelectionResult,
      workspaceRoots,
    ],
  );

  const addImageUrl = useCallback(
    async (url: string) => {
      setAttachmentLoading(true);
      try {
        const record = await runtime.attachments.importImageUrl(url, { source: "url", sessionId });
        const media = await runtime.attachments.readMedia(record.attachment_id || record.id);
        addImageAttachment(selectedImageAttachmentFromRecord(record, media.data_url));
        reportAttachmentSelectionResult(null);
      } catch (reason) {
        reportAttachmentSelectionResult(errorMessage(reason), "error");
      } finally {
        setAttachmentLoading(false);
      }
    },
    [addImageAttachment, reportAttachmentSelectionResult, runtime, sessionId],
  );

  const addFiles = useCallback(
    async (files: FileList | File[] | null, source: Exclude<SelectedFileSource, "workspace">) => {
      const items = filesArray(files);
      if (!items.length) {
        return;
      }
      setAttachmentLoading(true);
      try {
        let added = 0;
        let blockedByFileAccess = false;
        let blockedByWorkspaceScope = false;
        let missingSourcePath = false;
        for (const file of items) {
          if (isImageFile(file)) {
            const previewUrl = URL.createObjectURL(file);
            try {
              const path = fileSystemPathFromFile(file);
              if (path) {
                await addImagePath(path, source, previewUrl);
              } else {
                const record = await runtime.attachments.uploadImage(file, {
                  filename: file.name,
                  source,
                  sessionId,
                });
                addImageAttachment(selectedImageAttachmentFromRecord(record, previewUrl));
              }
              added += 1;
            } catch (reason) {
              URL.revokeObjectURL(previewUrl);
              throw reason;
            }
            continue;
          }
          if (!canUseFileContext) {
            blockedByFileAccess = true;
            continue;
          }
          const selected = selectedFileFromFile(file, source);
          if (selected) {
            if (!filePickerAllowsGlobalPaths && !isWorkspaceAllowedPath(selected.path, workspaceRoots)) {
              blockedByWorkspaceScope = true;
              continue;
            }
            if (addSelectedFilePath(selected.path, source, selected.name)) {
              added += 1;
            }
            continue;
          }
          missingSourcePath = true;
        }
        reportAttachmentSelectionResult(
          blockedByFileAccess
            ? FILE_ACCESS_DISABLED_MESSAGE
            : blockedByWorkspaceScope
              ? fileAccessHint || WORKSPACE_FILE_ONLY_MESSAGE
              : missingSourcePath
                ? MISSING_SOURCE_FILE_PATH_MESSAGE
                : added
                  ? null
                  : "不支持的文件，无法获取路径",
        );
      } catch (reason) {
        reportAttachmentSelectionResult(errorMessage(reason), "error");
      } finally {
        setAttachmentLoading(false);
      }
    },
    [
      addImageAttachment,
      addImagePath,
      addSelectedFilePath,
      canUseFileContext,
      fileAccessHint,
      filePickerAllowsGlobalPaths,
      reportAttachmentSelectionResult,
      runtime,
      sessionId,
      workspaceRoots,
    ],
  );

  const handleAttachmentPick = useCallback(() => {
    if (inputDisabled || attachmentLoading) {
      return;
    }
    if (runtime.desktopPicker.isFilePickerAvailable()) {
      void runtime.desktopPicker
        .pickFiles()
        .then((paths) => {
          if (paths.length) {
            return addPickedPaths(paths, "picker");
          }
          return undefined;
        })
        .catch((reason) => {
          dispatchFileSelection({ type: "error", error: errorMessage(reason) });
        });
      return;
    }
    fileInputRef.current?.click();
  }, [addPickedPaths, attachmentLoading, inputDisabled, runtime]);

  const handleAttachmentMenuToggle = useCallback(() => {
    if (inputDisabled || attachmentLoading) {
      return;
    }
    setAttachmentMenuOpen((open) => !open);
  }, [attachmentLoading, inputDisabled]);

  const handleAttachmentMenuPick = useCallback(() => {
    setAttachmentMenuOpen(false);
    handleAttachmentPick();
  }, [handleAttachmentPick]);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const files = filesArray(input.files);
      input.value = "";
      void addFiles(files, "picker");
    },
    [addFiles],
  );

  const handleDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dispatchFileSelection({ type: "dragging", dragging: true });
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dispatchFileSelection({ type: "dragging", dragging: false });
    void addFiles(event.dataTransfer.files, "dropped");
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (event.clipboardData.files.length) {
      event.preventDefault();
      void addFiles(event.clipboardData.files, "pasted");
      return;
    }
    const imageUrl = imageUrlFromClipboard(event.clipboardData);
    if (imageUrl) {
      event.preventDefault();
      void addImageUrl(imageUrl);
      return;
    }
    pastePlainText(event);
    syncEditableChange(event.currentTarget, (nextValue) => {
      onChange(nextValue);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((index) => nextMenuIndex(index, slashItemCount, 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((index) => nextMenuIndex(index, slashItemCount, -1));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashValue(editorValue);
        setSlashMode("root");
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (slashMode === "skills") {
          const skill = slashSkills[visibleSlashActiveIndex];
          if (skill) {
            selectSlashSkill(skill);
          }
        } else {
          const item = slashRootItems[visibleSlashActiveIndex];
          if (item?.type === "command") {
            selectSlashCommand(item.command);
          }
          if (item?.type === "skill") {
            selectSlashSkill(item.skill);
          }
        }
        return;
      }
    }
    if (atOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAtActiveIndex((index) => nextMenuIndex(index, atResults.length, 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setAtActiveIndex((index) => nextMenuIndex(index, atResults.length, -1));
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
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      insertPlainText("\n");
      syncEditableChange(event.currentTarget, (nextValue) => {
        onChange(nextValue);
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
        onChange(nextValue);
      });
      resizeEditableInput(event.currentTarget);
    },
    [onChange],
  );

  const handleQuoteRemove = useCallback(
    (quoteId: string) => {
      dispatchQuoteSelection({ type: "remove", id: quoteId });
    },
    [dispatchQuoteSelection],
  );

  return (
    <form
      className={[styles.root, className].filter(Boolean).join(" ")}
      data-sendbox-root="true"
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
      <input
        ref={fileInputRef}
        className={styles.hiddenFileInput}
        type="file"
        multiple
        tabIndex={-1}
        onChange={handleFileInputChange}
      />

      {imageAttachments.length ? (
        <div className={styles.imageAttachments} aria-label="已添加图片">
          {imageAttachments.map((attachment) => (
            <div className={styles.imageAttachmentItem} key={attachment.attachment_id}>
              <button
                className={styles.imageAttachmentButton}
                type="button"
                title={attachment.name}
                aria-label={`预览图片 ${attachment.name}`}
                onClick={() => setActiveImagePreview(attachment)}
              >
                {attachment.previewUrl ? (
                  <img className={styles.imageAttachmentThumb} src={attachment.previewUrl} alt="" />
                ) : (
                  <span className={styles.imageAttachmentFallback}>{attachment.name}</span>
                )}
              </button>
              <button
                className={styles.imageAttachmentRemove}
                type="button"
                aria-label={`删除图片 ${attachment.name}`}
                onClick={() => removeImageAttachment(attachment.attachment_id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {selectedSkill || quoteSelection.quotes.length || fileSelection.files.length ? (
        <div className={styles.fileChips} aria-label="已添加上下文" data-sendbox-context-chips="true">
          {selectedSkill ? (
            <SkillContextChip
              skill={selectedSkill}
              onOpen={onOpenFileReference}
              onRemove={() => setSelectedSkill(null)}
            />
          ) : null}
          {quoteSelection.quotes.map((quote, index) => (
            <QuoteContextChip
              key={quote.id}
              quote={quote}
              index={index}
              onOpen={onOpenFileReference}
              onRemove={() => handleQuoteRemove(quote.id)}
            />
          ))}
          {fileSelection.files.map((file) => (
            <FileContextChip
              key={selectedFileKey(file)}
              file={file}
              onOpen={onOpenFileReference}
              onRemove={() => removeFile(file)}
            />
          ))}
        </div>
      ) : null}

      <ContentEditableInput
        refSetter={(node) => {
          inputRef.current = node;
        }}
        value={value}
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
        <SlashCommandMenu
          mode={slashMode}
          query={slashQuery ?? ""}
          commands={slashCommands}
          skills={slashSkills}
          activeIndex={visibleSlashActiveIndex}
          onBack={navigateSlashRoot}
          onSelectCommand={selectSlashCommand}
          onSelectSkill={selectSlashSkill}
        />
      ) : null}
      {atOpen ? (
        <Suspense fallback={null}>
          <LazyAtFileMenu
            results={atResults}
            activeIndex={atActiveIndex}
            loading={atLoading}
            error={atError}
            hint={atHint}
            directoryPath={atDirectoryPath}
            query={atQuery ?? ""}
            onNavigateDirectory={navigateAtDirectory}
            onSelect={selectFile}
          />
        </Suspense>
      ) : null}
      {attachmentMenuOpen ? (
        <div
          ref={attachmentMenuRef}
          className={popupStyles.menu}
          role="listbox"
          aria-label="添加内容"
          data-testid="attachment-action-menu"
        >
          <div className={popupStyles.header}>
            <span className={popupStyles.backSpacer} />
            <span className={popupStyles.headerTitle}>添加内容</span>
            <span className={popupStyles.headerMeta}>附件</span>
          </div>
          <div className={popupStyles.body}>
            <button
              className={popupStyles.item}
              type="button"
              role="option"
              aria-label="附件"
              aria-selected="true"
              data-active="true"
              data-kind="attachment"
              onMouseDown={(event) => {
                event.preventDefault();
                handleAttachmentMenuPick();
              }}
            >
              <span className={popupStyles.icon} aria-hidden="true">
                <Paperclip size={14} />
              </span>
              <span className={popupStyles.text}>
                <strong>附件</strong>
                <span>添加图片或文件</span>
              </span>
            </button>
          </div>
        </div>
      ) : null}

      {fileSelection.error ? (
        <div className={styles.fileError} data-sendbox-file-error="true">
          {fileSelection.error}
        </div>
      ) : null}

      <div className={styles.toolbar} data-sendbox-toolbar="true">
        <div className={styles.leftActions}>
          <div className={styles.attachmentMenuRoot}>
            <button
              ref={attachmentButtonRef}
              className={styles.attachmentButton}
              type="button"
              title="添加"
              aria-label={attachmentLoading ? "正在添加附件" : "添加"}
              aria-haspopup="menu"
              aria-expanded={attachmentMenuOpen ? "true" : "false"}
              disabled={inputDisabled || attachmentLoading}
              onClick={handleAttachmentMenuToggle}
            >
              {attachmentLoading ? (
                <LoaderCircle className={styles.attachmentSpinner} size={15} />
              ) : (
                <Plus size={17} />
              )}
            </button>
          </div>
          {controls}
          {leftAccessory}
          {leftHint}
        </div>

        <div className={styles.rightActions}>
          {statusText ? <span className={styles.statusText}>{statusText}</span> : null}
          {rightControls}
          {busy ? (
            <button className={styles.stopButton} type="button" aria-label="停止" disabled={!canStop} onClick={onStop}>
              <Square size={variant === "keydex" ? 12 : 13} />
            </button>
          ) : (
            <button
              className={styles.sendButton}
              type="submit"
              aria-label={showSendLoading ? "正在准备发送" : "发送"}
              data-loading={showSendLoading ? "true" : "false"}
              disabled={showSendLoading || !canSubmit}
            >
              {showSendLoading ? <LoaderCircle className={styles.sendSpinner} size={17} /> : <SendIcon size={17} />}
            </button>
          )}
        </div>
      </div>

      {contextBar ? (
        <div className={styles.contextBar} data-sendbox-context-bar="true">
          {contextBar}
        </div>
      ) : null}

      {activeImagePreview ? (
        <ImagePreviewDialog
          src={activeImagePreview.previewUrl}
          title={activeImagePreview.name}
          alt={activeImagePreview.name}
          unavailableText={activeImagePreview.name}
          onClose={() => setActiveImagePreview(null)}
        />
      ) : null}
    </form>
  );
}

function isBusy(state: ConversationRuntimeState): boolean {
  return state === "starting" || state === "running" || state === "waiting_approval" || state === "cancelling";
}

function filesArray(files: FileList | File[] | null): File[] {
  if (!files) {
    return [];
  }
  return Array.isArray(files) ? files : Array.from(files);
}

function fileSystemPathFromFile(file: File): string | null {
  const withPath = file as File & { path?: string };
  const path = withPath.path || file.webkitRelativePath || "";
  return isLikelyFilesystemPath(path) ? path : null;
}

function isLikelyFilesystemPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function fileAccessMessage(mode: FileAccessMode): string {
  if (mode === "no_file_access") {
    return FILE_ACCESS_DISABLED_MESSAGE;
  }
  if (mode === "workspace_read_only") {
    return "当前文件访问权限为「工作区内只读」，只能引入工作区内文件。";
  }
  if (mode === "workspace_trusted") {
    return "当前文件访问权限为「工作区内信任」，只能引入工作区内文件。";
  }
  return "";
}

function isWorkspaceAllowedPath(path: string, workspaceRoots: string[]): boolean {
  const cleaned = path.trim();
  if (!cleaned) {
    return false;
  }
  if (!isLikelyFilesystemPath(cleaned)) {
    return true;
  }
  const target = comparablePath(cleaned);
  return workspaceRoots.some((root) => {
    const normalizedRoot = comparablePath(root);
    return Boolean(normalizedRoot) && (target === normalizedRoot || target.startsWith(`${normalizedRoot}/`));
  });
}

function comparablePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function imageUrlFromClipboard(data: DataTransfer): string | null {
  const htmlUrl = imageUrlFromClipboardHtml(data.getData("text/html"));
  if (htmlUrl) {
    return htmlUrl;
  }
  const text = data.getData("text/plain").trim();
  return isLikelyImageUrl(text) ? text : null;
}

function imageUrlFromClipboardHtml(html: string): string | null {
  if (!html.trim()) {
    return null;
  }
  const match = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  const src = match?.[1]?.trim();
  if (!src) {
    return null;
  }
  return isHttpUrl(src) ? src.replaceAll("&amp;", "&") : null;
}

function isLikelyImageUrl(value: string): boolean {
  if (!isHttpUrl(value)) {
    return false;
  }
  try {
    return /\.(png|jpe?g|webp|gif)$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function nextMenuIndex(index: number, length: number, delta: 1 | -1): number {
  if (length <= 0) {
    return 0;
  }
  return (index + delta + length) % length;
}

function SkillContextChip({
  skill,
  onOpen,
  onRemove,
}: {
  skill: WorkspaceSkillSummary;
  onOpen?: (file: SelectedFile) => void;
  onRemove: () => void;
}) {
  const label = skill.label || `/${skill.name}`;
  const displayName = skillDisplayName(skill);
  const skillFile = selectedFileFromSkill(skill);
  const canOpen = Boolean(skillFile && onOpen);
  return (
    <ComposerContextHover
      className={styles.skillChipWrapper}
      hoverAnchor="skill"
      title={displayName}
      description={skill.description}
      meta={skill.locator || null}
    >
      <span className={styles.skillChip} data-context-type="skill" data-openable={canOpen ? "true" : "false"}>
        <button
          className={styles.contextChipMain}
          type="button"
          aria-label={`打开 Skill ${displayName}`}
          data-clickable={canOpen ? "true" : "false"}
          disabled={!canOpen}
          onClick={() => {
            if (skillFile) {
              onOpen?.(skillFile);
            }
          }}
        >
          <span className={styles.contextChipIcon} data-context-chip-icon="skill" aria-hidden="true">
            <ContextChipIcon kind="skill" />
          </span>
          <span className={styles.contextChipLabel}>{displayName}</span>
        </button>
        <button
          className={styles.skillChipRemove}
          type="button"
          aria-label={`删除 Skill ${label}`}
          onClick={onRemove}
        >
          <X size={12} />
        </button>
      </span>
    </ComposerContextHover>
  );
}

function skillDisplayName(skill: WorkspaceSkillSummary): string {
  const raw = skill.name || skill.label;
  const normalized = raw.replace(/^\//, "").trim();
  return normalized || "Skill";
}

function selectedFileFromSkill(skill: WorkspaceSkillSummary): SelectedFile | null {
  const path = skill.locator?.trim();
  if (!path) {
    return null;
  }
  return {
    path,
    name: skill.name || fileName(path),
    type: "file",
    source: "workspace",
  };
}

function QuoteContextChip({
  quote,
  index,
  onOpen,
  onRemove,
}: {
  quote: SelectedQuote;
  index: number;
  onOpen?: (file: SelectedFile) => void;
  onRemove: () => void;
}) {
  const chipLabel = quoteChipLabel(quote);
  const quoteFile = selectedFileFromQuote(quote);
  const canOpen = Boolean(quoteFile && onOpen);

  return (
    <ComposerContextHover
      className={styles.quoteChipWrapper}
      hoverAnchor="quote"
      title={chipLabel}
      description={quoteHoverDescription(quote)}
    >
      <span
        className={styles.quoteInputChip}
        data-context-type="quote"
        data-openable={canOpen ? "true" : "false"}
        data-quote-index={index}
        data-source-quote={quote.file ? "true" : "false"}
      >
        <button
          className={styles.contextChipMain}
          type="button"
          aria-label={canOpen && quoteFile ? `打开引用来源 ${quoteFile.path}` : `${chipLabel}：${quote.preview}`}
          data-clickable={canOpen ? "true" : "false"}
          disabled={!canOpen}
          onClick={() => {
            if (quoteFile) {
              onOpen?.(quoteFile);
            }
          }}
        >
          <span className={styles.contextChipIcon} data-context-chip-icon="quote" aria-hidden="true">
            <ContextChipIcon kind="quote" />
          </span>
          <span className={styles.contextChipLabel}>{chipLabel}</span>
        </button>
        <button
          className={styles.quoteInputChipRemove}
          type="button"
          aria-label={`删除${chipLabel} ${quote.preview}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} strokeWidth={2} />
        </button>
      </span>
    </ComposerContextHover>
  );
}

function selectedFileFromQuote(quote: SelectedQuote): SelectedFile | null {
  if (!quote.file?.path) {
    return null;
  }
  const annotationComment = quote.annotationComment?.trim();
  const annotationId = quote.annotationId?.trim();
  return {
    path: quote.file.path,
    name: quote.file.name || fileName(quote.file.path),
    type: "file",
    source: "workspace",
    selectedText: quote.text,
    ...(annotationId ? { annotationId } : {}),
    ...(annotationComment ? { annotationComment } : {}),
    lineStart: quote.file.lineStart ?? null,
    lineEnd: quote.file.lineEnd ?? null,
    sourceStart: quote.file.sourceStart ?? null,
    sourceEnd: quote.file.sourceEnd ?? null,
  };
}

function quoteChipLabel(quote: SelectedQuote): string {
  if (!quote.file) {
    return "引用片段";
  }
  const name = quote.file.name || fileName(quote.file.path);
  const lineLabel = quoteLineLabel(quote.file.lineStart, quote.file.lineEnd);
  return lineLabel ? `${name} · ${lineLabel}` : `${name} · 引用`;
}

function quoteLineLabel(start?: number | null, end?: number | null): string | null {
  if (!start || !end) {
    return null;
  }
  return start === end ? `L${start}` : `L${start}-L${end}`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function externalFileRequestFiles(request: SendBoxExternalFileRequest): SelectedFile[] {
  if (request.files?.length) {
    return request.files;
  }
  return request.file ? [request.file] : [];
}

function externalQuoteRequestQuotes(request: SendBoxExternalQuoteRequest): SelectedQuote[] {
  if (request.quotes?.length) {
    return request.quotes;
  }
  return request.quote ? [request.quote] : [];
}

function FileContextChip({
  file,
  onOpen,
  onRemove,
}: {
  file: SelectedFile;
  onOpen?: (file: SelectedFile) => void;
  onRemove: () => void;
}) {
  const fileKindLabel = selectedFileKindLabel(file);
  const chipLabel = fileName(file.name || file.path);

  return (
    <ComposerContextHover
      className={styles.fileChipWrapper}
      hoverAnchor="file"
      title={chipLabel}
      description={fileHoverDescription(file)}
      meta={fileKindLabel}
    >
      <span className={styles.fileChip} data-context-type={file.type} data-openable={onOpen ? "true" : "false"}>
        <button
          className={styles.contextChipMain}
          type="button"
          aria-label={`打开文件引用 ${file.path}`}
          data-clickable={onOpen ? "true" : "false"}
          disabled={!onOpen}
          onClick={() => onOpen?.(file)}
        >
          <span className={styles.contextChipIcon} data-context-chip-icon={file.type} aria-hidden="true">
            <ContextChipIcon kind={file.type === "directory" ? "directory" : "file"} />
          </span>
          <span className={styles.contextChipLabel}>{chipLabel}</span>
        </button>
        <button
          className={styles.fileChipRemove}
          type="button"
          aria-label={`移除文件引用 ${file.path}`}
          onClick={onRemove}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </span>
    </ComposerContextHover>
  );
}

function quoteHoverDescription(quote: SelectedQuote): string {
  const lineLabel = quote.file ? quoteLineLabel(quote.file.lineStart, quote.file.lineEnd) : null;
  const location = quote.file?.path ? `${quote.file.path}${lineLabel ? ` · ${lineLabel}` : ""}` : "";
  return [location, quote.text || quote.preview, annotationCommentDescription(quote.annotationComment)]
    .filter(Boolean)
    .join("\n\n");
}

function fileHoverDescription(file: SelectedFile): string {
  return [file.path, annotationCommentDescription(file.annotationComment)].filter(Boolean).join("\n\n");
}

function selectedFileKindLabel(file: SelectedFile): string {
  if (file.source === "workspace") {
    return file.type === "directory" ? "工作区目录" : "工作区文件";
  }
  if (file.source === "pasted") {
    return "粘贴文件";
  }
  if (file.source === "dropped") {
    return "拖拽文件";
  }
  return file.type === "directory" ? "本地目录" : "本地文件";
}

function annotationCommentDescription(comment?: string | null): string {
  const value = comment?.trim();
  return value ? `批注：${value}` : "";
}

function ComposerContextHover({
  className,
  hoverAnchor,
  title,
  description,
  meta,
  children,
}: {
  className: string;
  hoverAnchor: "skill" | "quote" | "file";
  title: string;
  description: string;
  meta?: string | null;
  children: ReactNode;
}) {
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const hoverPlacement = useHoverCardPlacement(open, CONTEXT_HOVER_CARD_MAX_WIDTH);

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
    }, 120);
  }, [clearHideTimer, clearShowTimer]);

  useEffect(
    () => () => {
      clearShowTimer();
      clearHideTimer();
    },
    [clearHideTimer, clearShowTimer],
  );

  return (
    <span
      ref={hoverPlacement.wrapperRef}
      className={className}
      data-sendbox-hover-anchor={hoverAnchor}
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
      {children}
      {open ? (
        <span
          ref={hoverPlacement.cardRef}
          className={styles.contextHoverCard}
          data-sendbox-context-hover-card="true"
          data-context-type={hoverAnchor}
          style={hoverPlacement.style}
          onMouseEnter={clearHideTimer}
          onMouseLeave={scheduleClose}
        >
          <span className={styles.contextHoverTitle}>{title}</span>
          {description ? <span className={styles.contextHoverDescription}>{description}</span> : null}
          {meta ? <span className={styles.contextHoverMeta}>{meta}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

interface HoverCardPlacement {
  wrapperRef: (node: HTMLSpanElement | null) => void;
  cardRef: (node: HTMLSpanElement | null) => void;
  style: CSSProperties | undefined;
}

function useHoverCardPlacement(open: boolean, preferredMaxWidth: number): HoverCardPlacement {
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLSpanElement | null>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>();

  const setWrapperRef = useCallback((node: HTMLSpanElement | null) => {
    wrapperRef.current = node;
  }, []);

  const setCardRef = useCallback((node: HTMLSpanElement | null) => {
    cardRef.current = node;
  }, []);

  const updatePlacement = useCallback(() => {
    const wrapper = wrapperRef.current;
    const card = cardRef.current;
    if (!wrapper || !card) {
      return;
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    const rootRect = wrapper.closest<HTMLElement>("[data-sendbox-root='true']")?.getBoundingClientRect();
    const boundaryLeft = Math.max(HOVER_CARD_EDGE_GAP, (rootRect?.left ?? 0) + HOVER_CARD_EDGE_GAP);
    const boundaryRight = Math.min(
      window.innerWidth - HOVER_CARD_EDGE_GAP,
      (rootRect?.right ?? window.innerWidth) - HOVER_CARD_EDGE_GAP,
    );
    const boundaryWidth = Math.max(96, boundaryRight - boundaryLeft);
    const maxWidth = Math.min(preferredMaxWidth, boundaryWidth);
    const measuredWidth = Math.min(Math.max(96, card.getBoundingClientRect().width || maxWidth), maxWidth);
    const anchorCenter = wrapperRect.left + wrapperRect.width / 2;
    const leftInViewport = clamp(anchorCenter - measuredWidth / 2, boundaryLeft, boundaryRight - measuredWidth);
    const arrowLeft = clamp(
      anchorCenter - leftInViewport,
      Math.min(HOVER_CARD_ARROW_PADDING, measuredWidth / 2),
      Math.max(HOVER_CARD_ARROW_PADDING, measuredWidth - HOVER_CARD_ARROW_PADDING),
    );

    setStyle({
      left: `${leftInViewport - wrapperRect.left}px`,
      maxWidth: `${maxWidth}px`,
      "--sendbox-hover-card-arrow-left": `${arrowLeft}px`,
      "--sendbox-hover-card-translate-x": "0px",
    } as CSSProperties);
  }, [preferredMaxWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined);
      return;
    }
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [open, updatePlacement]);

  return { wrapperRef: setWrapperRef, cardRef: setCardRef, style };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
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
      data-sendbox-input="true"
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
const CONTEXT_HOVER_CARD_MAX_WIDTH = 420;
const HOVER_CARD_EDGE_GAP = 12;
const HOVER_CARD_ARROW_PADDING = 16;

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
  const computedStyle = window.getComputedStyle(input);
  const minHeight = parseCssPixelValue(computedStyle.minHeight, 44);
  const maxHeight = parseCssPixelValue(computedStyle.maxHeight, 188);
  input.style.height = "0px";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, minHeight), maxHeight)}px`;
}

function parseCssPixelValue(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scrollEditableToBottom(input: HTMLElement) {
  input.scrollTop = input.scrollHeight;
  window.requestAnimationFrame(() => {
    input.scrollTop = input.scrollHeight;
  });
}

function focusEditableInput(input: HTMLElement) {
  input.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
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

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "工作区搜索失败";
}
