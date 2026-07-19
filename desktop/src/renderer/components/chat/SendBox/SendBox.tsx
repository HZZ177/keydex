import { ArrowUp, LoaderCircle, Paperclip, Plus, SendHorizontal, Square, X } from "lucide-react";
import {
  type ClipboardEvent,
  type ChangeEvent,
  type CompositionEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
  type ReactNode,
  type SetStateAction,
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
import { createPortal } from "react-dom";

import {
  runtimeBridge,
  type KeydexDiagnostic,
  type RuntimeBridge,
  type SkillSummary,
  type WorkspaceSearchResult,
} from "@/runtime";
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
import { WORKSPACE_FILE_SEARCH_DEBOUNCE_MS } from "@/renderer/utils/workspaceFileSearchBudget";
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
import { useCompositionInput, type SendBoxSubmitOptions } from "./useCompositionInput";
import {
  PASTED_TEXT_FRAGMENT_SELECTOR,
  PASTED_TEXT_CARET_HOST_SELECTOR,
  PASTED_TEXT_RAW_SELECTOR,
  closestPastedTextFragment,
  createPastedTextCaretHostElement,
  createPastedTextFragmentElement,
  createPastedTextFragmentId,
  isPastedTextToggle,
  normalizePastedText,
  normalizePastedTextFragments,
  pastedTextCaretHostValue,
  readPastedTextAwareDocument,
  readPastedTextSelection,
  rebasePastedTextFragments,
  samePastedTextFragments,
  setPastedTextElementCollapsed,
  shouldCollapsePastedText,
  pastedTextBoundaryPosition,
  type PastedTextDocument,
  type PastedTextFragment,
} from "./collapsiblePaste";

const LazyAtFileMenu = lazy(() =>
  import("@/renderer/components/chat/AtFileMenu/AtFileMenu").then((module) => ({
    default: module.AtFileMenu,
  })),
);

const MISSING_SOURCE_FILE_PATH_MESSAGE =
  "无法获取源文件路径，已拒绝作为临时副本添加。请在桌面端选择文件，或将文件放入工作区后用 @ 引用。";
const FILE_ACCESS_DISABLED_MESSAGE = "当前文件访问权限为「无文件访问权限」，不能引入文件或目录上下文。";
const WORKSPACE_FILE_ONLY_MESSAGE = "当前文件访问权限仅允许引入工作区内文件或目录，请将内容放入工作区后用 @ 引用。";

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
  externalContextRequest?: SendBoxExternalContextRequest | null;
  selectedFiles?: SelectedFile[];
  selectedQuotes?: SelectedQuote[];
  selectedImageAttachments?: SelectedImageAttachment[];
  pastedTextFragments?: PastedTextFragment[];
  leftHint?: ReactNode;
  allowBypassConversationSlashCommand?: boolean;
  allowGoalSlashCommand?: boolean;
  allowContextCompressionSlashCommand?: boolean;
  contextWindowProgress?: number | null;
  skills?: SkillSummary[];
  skillDiagnostics?: KeydexDiagnostic[];
  selectedSkill?: SkillSummary | null;
  onSelectedFilesChange?: (files: SelectedFile[]) => void;
  onSelectedQuotesChange?: (quotes: SelectedQuote[]) => void;
  onSelectedImageAttachmentsChange?: (attachments: SelectedImageAttachment[]) => void;
  onPastedTextFragmentsChange?: (fragments: PastedTextFragment[], value: string) => void;
  onSkillChange?: (skill: SkillSummary | null) => void;
  onChange: (value: string) => void;
  onSend: (
    files: SelectedFile[],
    quotes: SelectedQuote[],
    attachments: SelectedImageAttachment[],
    options?: SendBoxSubmitOptions,
  ) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  runtime?: RuntimeBridge;
  sessionId?: string | null;
  onEscape?: () => void;
  onOpenFileReference?: (file: SelectedFile) => void;
  onOpenSkill?: (skill: SkillSummary) => void | Promise<void>;
  onSlashCommand?: (command: SlashCommand) => void;
  onRefreshSkills?: () => void | Promise<void>;
  onExternalFileRequestHandled?: (requestId: number) => void;
  onExternalQuoteRequestHandled?: (requestId: number) => void;
  onExternalContextRequestHandled?: (requestId: number) => void;
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

export interface SendBoxExternalContextRequest {
  requestId: number;
  files?: SelectedFile[];
  quotes?: SelectedQuote[];
  attachments?: SelectedImageAttachment[];
}

type SlashMenuItem =
  | { type: "command"; command: SlashCommand }
  | { type: "skill"; skill: SkillSummary };

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
  externalContextRequest = null,
  selectedFiles: controlledSelectedFiles,
  selectedQuotes: controlledSelectedQuotes,
  selectedImageAttachments: controlledImageAttachments,
  pastedTextFragments: controlledPastedTextFragments = [],
  leftHint = null,
  allowBypassConversationSlashCommand = true,
  allowGoalSlashCommand = true,
  allowContextCompressionSlashCommand = true,
  contextWindowProgress = null,
  skills = [],
  skillDiagnostics = [],
  selectedSkill: controlledSelectedSkill,
  onSelectedFilesChange,
  onSelectedQuotesChange,
  onSelectedImageAttachmentsChange,
  onPastedTextFragmentsChange,
  onSkillChange,
  onChange,
  onSend,
  onStop,
  runtime = runtimeBridge,
  sessionId = null,
  onEscape,
  onOpenFileReference,
  onOpenSkill,
  onSlashCommand,
  onRefreshSkills,
  onExternalFileRequestHandled,
  onExternalQuoteRequestHandled,
  onExternalContextRequestHandled,
  onListWorkspaceDirectory,
  onSearchWorkspace,
}: SendBoxProps) {
  const inputRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentButtonRef = useRef<HTMLButtonElement | null>(null);
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);
  const imagePreviewObjectUrlsRef = useRef<Set<string>>(new Set());
  const imageAttachmentPreviewLoadKeysRef = useRef<Set<string>>(new Set());
  const handledExternalFileRequestIdRef = useRef<number | null>(null);
  const handledExternalQuoteRequestIdRef = useRef<number | null>(null);
  const handledExternalContextRequestIdRef = useRef<number | null>(null);
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
  const [uncontrolledImageAttachments, setUncontrolledImageAttachments] = useState<SelectedImageAttachment[]>([]);
  const controlledImageAttachmentsRef = useRef(controlledImageAttachments);
  controlledImageAttachmentsRef.current = controlledImageAttachments;
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [activeImagePreview, setActiveImagePreview] = useState<SelectedImageAttachment | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [uncontrolledSelectedSkill, setUncontrolledSelectedSkill] = useState<SkillSummary | null>(null);
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
  const pastedTextFragments = useMemo(
    () => normalizePastedTextFragments(editorValue, controlledPastedTextFragments),
    [controlledPastedTextFragments, editorValue],
  );
  const busy = isBusy(runtimeState);
  const inputDisabled = disabled || (busy && !canTypeWhileBusy(runtimeState));
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
  const imageAttachments = controlledImageAttachments ?? uncontrolledImageAttachments;
  const emitEditorChange = useCallback(
    (nextValue: string, nextFragments: PastedTextFragment[]) => {
      onPastedTextFragmentsChange?.(nextFragments, nextValue);
      onChange(nextValue);
    },
    [onChange, onPastedTextFragmentsChange],
  );
  const commitProgrammaticEditorValue = useCallback(
    (nextValue: string) => {
      emitEditorChange(nextValue, rebasePastedTextFragments(editorValue, nextValue, pastedTextFragments));
    },
    [editorValue, emitEditorChange, pastedTextFragments],
  );
  const setImageAttachments = useCallback(
    (update: SetStateAction<SelectedImageAttachment[]>) => {
      const current = controlledImageAttachmentsRef.current;
      if (current === undefined) {
        setUncontrolledImageAttachments(update);
        return;
      }
      const next = typeof update === "function" ? update(current) : update;
      controlledImageAttachmentsRef.current = next;
      onSelectedImageAttachmentsChange?.(next);
    },
    [onSelectedImageAttachmentsChange],
  );
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
    (skill: SkillSummary | null) => {
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
    [rememberPreviewUrl, setImageAttachments],
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
    [activeImagePreview?.attachment_id, revokePreviewUrl, setImageAttachments],
  );
  const clearImageAttachments = useCallback(() => {
    setImageAttachments((current) => {
      current.forEach((item) => revokePreviewUrl(item.previewUrl));
      return [];
    });
    setActiveImagePreview(null);
  }, [revokePreviewUrl, setImageAttachments]);
  const replaceImageAttachments = useCallback(
    (attachments: SelectedImageAttachment[]) => {
      setImageAttachments((current) => {
        current.forEach((item) => revokePreviewUrl(item.previewUrl));
        attachments.forEach((item) => rememberPreviewUrl(item.previewUrl));
        return attachments;
      });
      setActiveImagePreview(null);
    },
    [rememberPreviewUrl, revokePreviewUrl, setImageAttachments],
  );
  const updateImageAttachmentPreview = useCallback(
    (attachmentId: string, previewUrl: string) => {
      if (!attachmentId || !previewUrl) {
        return;
      }
      rememberPreviewUrl(previewUrl);
      setImageAttachments((current) =>
        current.map((item) =>
          item.attachment_id === attachmentId && !item.previewUrl ? { ...item, previewUrl } : item,
        ),
      );
      setActiveImagePreview((current) =>
        current?.attachment_id === attachmentId && !current.previewUrl ? { ...current, previewUrl } : current,
      );
    },
    [rememberPreviewUrl, setImageAttachments],
  );
  const canSubmit =
    runtimeState !== "cancelling" &&
    !attachmentLoading &&
    (canSend || fileSelection.files.length > 0 || quoteSelection.quotes.length > 0 || imageAttachments.length > 0);
  const showSendLoading = sendLoading && !busy;
  const requestSend = useCallback((options: SendBoxSubmitOptions = {}) => {
    const result = onSend(fileSelection.files, quoteSelection.quotes, imageAttachments, options);
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
      buildSlashCommands(skills, {
        includeBypassConversation: allowBypassConversationSlashCommand,
        includeGoal: allowGoalSlashCommand,
        includeContextCompression: allowContextCompressionSlashCommand,
      }),
    [
      allowBypassConversationSlashCommand,
      allowContextCompressionSlashCommand,
      allowGoalSlashCommand,
      skills,
    ],
  );
  const slashCommands = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(availableSlashCommands, slashQuery)),
    [availableSlashCommands, slashQuery],
  );
  const slashSkills = useMemo(
    () => (slashQuery === null ? [] : filterSlashSkills(skills, slashQuery)),
    [slashQuery, skills],
  );
  const slashRootItems = useMemo<SlashMenuItem[]>(
    () => [
      ...slashCommands.map((command) => ({ type: "command" as const, command })),
      ...slashSkills.map((skill) => ({ type: "skill" as const, skill })),
    ],
    [slashCommands, slashSkills],
  );
  const slashOpen = slashQuery !== null && dismissedSlashValue !== editorValue && !inputDisabled;
  const slashItemCount = slashMode === "skills" ? slashSkills.length : slashRootItems.length;
  const visibleSlashActiveIndex = Math.min(slashActiveIndex, Math.max(slashItemCount - 1, 0));
  const atQuery = getAtQuery(editorValue);
  const atBrowsePath = atBrowseState && atBrowseState.value === editorValue ? atBrowseState.path : null;
  const atOpen =
    allowFileSelection &&
    Boolean(onSearchWorkspace || onListWorkspaceDirectory) &&
    atQuery !== null &&
    dismissedAtValue !== editorValue &&
    !inputDisabled &&
    !slashOpen;
  const atDirectoryPath =
    atOpen && canUseFileContext && onListWorkspaceDirectory && (atBrowsePath !== null || !atQuery)
      ? atBrowsePath ?? ""
      : null;
  const atSearchQuery = atDirectoryPath === null ? atQuery ?? "" : "";
  const atSearchState = useWorkspaceFileSearch({
    debounceMs: WORKSPACE_FILE_SEARCH_DEBOUNCE_MS,
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
    if (refreshedSlashSessionRef.current || !onRefreshSkills) {
      return;
    }
    refreshedSlashSessionRef.current = true;
    void onRefreshSkills();
  }, [onRefreshSkills, slashOpen]);

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
    imageAttachments.forEach((attachment) => {
      const attachmentId = attachment.attachment_id || attachment.id;
      if (attachment.previewUrl || !attachmentId || imageAttachmentPreviewLoadKeysRef.current.has(attachmentId)) {
        return;
      }
      imageAttachmentPreviewLoadKeysRef.current.add(attachmentId);
      void runtime.attachments
        .readMedia(attachmentId)
        .then((media) => {
          updateImageAttachmentPreview(attachmentId, media.data_url);
        })
        .catch(() => {
          imageAttachmentPreviewLoadKeysRef.current.delete(attachmentId);
        });
    });
  }, [imageAttachments, runtime, updateImageAttachmentPreview]);

  useEffect(() => {
    if (!externalContextRequest) {
      return;
    }
    if (handledExternalContextRequestIdRef.current === externalContextRequest.requestId) {
      return;
    }
    handledExternalContextRequestIdRef.current = externalContextRequest.requestId;
    const files = canUseFileContext ? externalContextRequest.files ?? [] : [];
    const quotes = externalContextRequest.quotes ?? [];
    if (controlledSelectedFiles === undefined) {
      dispatchFileSelection({ type: "clear" });
      if (files.length) {
        dispatchFileSelection(files.length === 1 ? { type: "add", file: files[0] } : { type: "addMany", files });
      }
    } else {
      onSelectedFilesChange?.(files);
    }
    if (controlledSelectedQuotes === undefined) {
      dispatchQuoteSelection({ type: "clear" });
      if (quotes.length) {
        dispatchQuoteSelection(quotes.length === 1 ? { type: "add", quote: quotes[0] } : { type: "addMany", quotes });
      }
    } else {
      onSelectedQuotesChange?.(quotes);
    }
    replaceImageAttachments(externalContextRequest.attachments ?? []);
    onExternalContextRequestHandled?.(externalContextRequest.requestId);
    inputRef.current?.focus();
  }, [
    canUseFileContext,
    controlledSelectedFiles,
    controlledSelectedQuotes,
    dispatchFileSelection,
    dispatchQuoteSelection,
    externalContextRequest,
    onExternalContextRequestHandled,
    onSelectedFilesChange,
    onSelectedQuotesChange,
    replaceImageAttachments,
  ]);

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
        commitProgrammaticEditorValue(replaceSlashQuery(editorValue, "/"));
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
      commitProgrammaticEditorValue(nextValue);
      return;
    }
    commitProgrammaticEditorValue(replaceSlashQuery(editorValue, `${command.label} `));
  };

  const selectSlashSkill = (skill: SkillSummary) => {
    const command = skillToSlashCommand(skill);
    onSlashCommand?.(command);
    setSelectedSkill(skill);
    setSlashMode("root");
    const nextValue = removeSlashQuery(editorValue);
    setDismissedSlashValue(editorValue);
    commitProgrammaticEditorValue(nextValue);
  };

  const navigateSlashRoot = () => {
    setSlashMode("root");
    setSlashActiveIndex(0);
    if (slashQuery) {
      commitProgrammaticEditorValue(replaceSlashQuery(editorValue, "/"));
    }
  };

  const addAtReference = (result: WorkspaceSearchResult) => {
    dispatchFileSelection({ type: "add", file: selectedFileFromWorkspace(result) });
    const nextValue = removeAtQuery(editorValue);
    setAtBrowseState(null);
    setDismissedAtValue(nextValue);
    commitProgrammaticEditorValue(nextValue);
  };

  const navigateAtDirectory = (path: string) => {
    setAtBrowseState({ path, value: editorValue });
  };

  const activateAtResult = (result: WorkspaceSearchResult, referenceDirectory = false) => {
    if (result.type === "directory" && onListWorkspaceDirectory && !referenceDirectory) {
      navigateAtDirectory(result.path);
      return;
    }
    addAtReference(result);
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

  const commitEditableDocument = useCallback(
    (editor: HTMLDivElement) => {
      removeEmptyPastedTextFragments(editor);
      const document = readEditorDocument(editor);
      editor.dataset.empty = document.value ? "false" : "true";
      emitEditorChange(document.value, document.fragments);
      return document;
    },
    [emitEditorChange],
  );

  const togglePastedTextFragment = useCallback(
    (editor: HTMLDivElement, fragment: HTMLElement, target?: EventTarget | null) => {
      const wasCollapsed = fragment.dataset.collapsed !== "false";
      const targetElement = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      const collapseBeforeFragment = Boolean(
        targetElement?.closest('[data-paste-toggle-position="leading"]'),
      );
      setPastedTextElementCollapsed(fragment, !wasCollapsed);
      commitEditableDocument(editor);
      if (wasCollapsed) {
        placeCaretInsidePastedTextRaw(editor, fragment);
      } else {
        editor.focus({ preventScroll: true });
        placeCaretAtNodeBoundary(editor, fragment, !collapseBeforeFragment);
      }
      resizeEditableInput(editor);
      window.requestAnimationFrame(() => resizeEditableInput(editor));
    },
    [commitEditableDocument],
  );

  const handleEditorClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const fragment = closestPastedTextFragment(event.target);
      if (!fragment || !event.currentTarget.contains(fragment)) {
        return;
      }
      const boundaryPosition = pastedTextBoundaryPosition(event.target);
      if (boundaryPosition) {
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        placeCaretAtNodeBoundary(event.currentTarget, fragment, boundaryPosition === "trailing");
        return;
      }
      const selection = window.getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        selectionBelongsToEditor(event.currentTarget, selection)
      ) {
        return;
      }
      if (fragment.dataset.collapsed !== "false" || isPastedTextToggle(event.target)) {
        event.preventDefault();
        togglePastedTextFragment(event.currentTarget, fragment, event.target);
      }
    },
    [togglePastedTextFragment],
  );

  const handleEditorMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const fragment = closestPastedTextFragment(event.target);
    if (!fragment || !event.currentTarget.contains(fragment)) {
      return;
    }
    if (pastedTextBoundaryPosition(event.target)) {
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      return;
    }
    if (fragment.dataset.collapsed !== "false") {
      // Preserve the browser's native drag-to-select behavior for the
      // collapsed preview. A non-collapsed selection suppresses expansion in
      // handleEditorClick.
      return;
    }
    if (!isPastedTextToggle(event.target)) {
      return;
    }
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
  }, []);

  const deleteAdjacentPastedTextFragment = useCallback(
    (editor: HTMLDivElement, direction: "backward" | "forward") => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed) {
        return false;
      }
      const fragment = adjacentPastedTextFragment(editor, selection.getRangeAt(0), direction);
      if (!fragment) {
        return false;
      }
      const previousSibling = fragment.previousSibling;
      const caretHost = previousSibling instanceof HTMLElement &&
        previousSibling.matches(PASTED_TEXT_CARET_HOST_SELECTOR)
        ? previousSibling
        : createPastedTextCaretHostElement("leading");
      if (!caretHost.isConnected) {
        fragment.before(caretHost);
      }
      const deletionRange = document.createRange();
      deletionRange.selectNode(fragment);
      selection.removeAllRanges();
      selection.addRange(deletionRange);
      const deletedWithUndo =
        typeof document.execCommand === "function" && document.execCommand("delete", false);
      if (!deletedWithUndo || fragment.isConnected) {
        fragment.remove();
      }
      placeCaretAtNodeBoundary(editor, caretHost.firstChild ?? caretHost, true);
      commitEditableDocument(editor);
      resizeEditableInput(editor);
      return true;
    },
    [commitEditableDocument],
  );

  const handleEditorBeforeInput = useCallback(
    (event: FormEvent<HTMLDivElement>) => {
      const inputType = (event.nativeEvent as InputEvent).inputType;
      if (inputType !== "deleteContentBackward" && inputType !== "deleteContentForward") {
        return;
      }
      const deleted = deleteAdjacentPastedTextFragment(
        event.currentTarget,
        inputType === "deleteContentBackward" ? "backward" : "forward",
      );
      if (!deleted) {
        return;
      }
      event.preventDefault();
    },
    [deleteAdjacentPastedTextFragment],
  );

  const handleEditorCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selectionBelongsToEditor(event.currentTarget, selection)) {
      return;
    }
    const logicalText = readPastedTextSelection(selection.getRangeAt(0));
    if (logicalText === null) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", logicalText);
  }, []);

  const handleEditorCut = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed || !selectionBelongsToEditor(event.currentTarget, selection)) {
        return;
      }
      const range = selection.getRangeAt(0);
      const logicalText = readPastedTextSelection(range);
      if (logicalText === null) {
        return;
      }
      event.preventDefault();
      event.clipboardData.setData("text/plain", logicalText);
      range.deleteContents();
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      commitEditableDocument(event.currentTarget);
      resizeEditableInput(event.currentTarget);
    },
    [commitEditableDocument],
  );

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
    const text = normalizePastedText(event.clipboardData.getData("text/plain"));
    if (text && shouldCollapsePastedText(text)) {
      event.preventDefault();
      insertPastedTextFragment(event.currentTarget, text);
      commitEditableDocument(event.currentTarget);
      resizeEditableInput(event.currentTarget);
      return;
    }
    pastePlainText(event);
    commitEditableDocument(event.currentTarget);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const pastedTextFragment = closestPastedTextFragment(event.target);
    if (
      pastedTextFragment &&
      event.currentTarget.contains(pastedTextFragment) &&
      isPastedTextToggle(event.target) &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      event.stopPropagation();
      togglePastedTextFragment(event.currentTarget as HTMLDivElement, pastedTextFragment, event.target);
      return;
    }
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      deleteAdjacentPastedTextFragment(
        event.currentTarget as HTMLDivElement,
        event.key === "Backspace" ? "backward" : "forward",
      )
    ) {
      event.preventDefault();
      return;
    }
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
      if (event.key === "ArrowRight") {
        const result = atResults[atActiveIndex];
        if (result?.type === "directory" && onListWorkspaceDirectory) {
          event.preventDefault();
          navigateAtDirectory(result.path);
          return;
        }
      }
      if (event.key === "ArrowLeft" && atDirectoryPath) {
        event.preventDefault();
        navigateAtDirectory(parentDirectoryPath(atDirectoryPath));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = atResults[atActiveIndex];
        if (result) {
          activateAtResult(result, event.ctrlKey || event.metaKey);
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
      commitEditableDocument(event.currentTarget as HTMLDivElement);
      resizeEditableInput(event.currentTarget);
      scrollEditableToBottom(event.currentTarget);
      return;
    }
    composition.handleKeyDown(event);
  };

  const handleEditorInput = useCallback(
    (event: FormEvent<HTMLDivElement>) => {
      commitEditableDocument(event.currentTarget);
      resizeEditableInput(event.currentTarget);
    },
    [commitEditableDocument],
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
        if (canSubmit) {
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
              onOpenSkill={onOpenSkill}
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
        pastedTextFragments={pastedTextFragments}
        inputLabel={inputLabel}
        placeholder={placeholder}
        disabled={inputDisabled}
        className={styles.input}
        onBlur={() => setFocused(false)}
        onBeforeInput={handleEditorBeforeInput}
        onClick={handleEditorClick}
        onChange={handleEditorInput}
        onCompositionEnd={composition.handleCompositionEnd}
        onCompositionStart={composition.handleCompositionStart}
        onFocus={() => setFocused(true)}
        onCopy={handleEditorCopy}
        onCut={handleEditorCut}
        onKeyDown={handleKeyDown}
        onMouseDown={handleEditorMouseDown}
        onPaste={handlePaste}
      />

      {slashOpen ? (
        <SlashCommandMenu
          mode={slashMode}
          query={slashQuery ?? ""}
          commands={slashCommands}
          skills={slashSkills}
          diagnostics={skillDiagnostics}
          contextWindowProgress={contextWindowProgress}
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
            onNavigateDirectory={onListWorkspaceDirectory ? navigateAtDirectory : undefined}
            onSelect={addAtReference}
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
  return state === "starting"
    || state === "running"
    || state === "waiting_approval"
    || state === "waiting_input"
    || state === "cancelling";
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
  onOpenSkill,
  onRemove,
}: {
  skill: SkillSummary;
  onOpen?: (file: SelectedFile) => void;
  onOpenSkill?: (skill: SkillSummary) => void | Promise<void>;
  onRemove: () => void;
}) {
  const label = skill.label || `/${skill.name}`;
  const displayName = skillDisplayName(skill);
  const skillFile = selectedFileFromSkill(skill);
  const canOpen = Boolean(onOpenSkill || (skillFile && onOpen));
  return (
    <ComposerContextHover
      className={styles.skillChipWrapper}
      hoverAnchor="skill"
      title={displayName}
      description={skill.description}
    >
      <span
        className={styles.skillChip}
        data-context-type="skill"
        data-openable={canOpen ? "true" : "false"}
        data-skill-source={skill.source}
      >
        <button
          className={styles.contextChipMain}
          type="button"
          aria-label={`打开 Skill ${displayName}`}
          data-clickable={canOpen ? "true" : "false"}
          disabled={!canOpen}
          onClick={() => {
            if (onOpenSkill) {
              void onOpenSkill(skill);
            } else if (skillFile) {
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

function skillDisplayName(skill: SkillSummary): string {
  const raw = skill.name || skill.label;
  const normalized = raw.replace(/^\//, "").trim();
  return normalized || "Skill";
}

function selectedFileFromSkill(skill: SkillSummary): SelectedFile | null {
  if (skill.source !== "workspace") {
    return null;
  }
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
  const contextKind = quote.comment?.trim() ? "comment" : "quote";
  const quoteFile = selectedFileFromQuote(quote);
  const canOpen = Boolean(quoteFile && onOpen);

  return (
    <ComposerContextHover
      className={styles.quoteChipWrapper}
      hoverAnchor={contextKind}
      title={chipLabel}
      description={quoteHoverDescription(quote)}
    >
      <span
        className={styles.quoteInputChip}
        data-context-type={contextKind}
        data-openable={canOpen ? "true" : "false"}
        data-quote-index={index}
        data-source-quote={quote.file ? "true" : "false"}
      >
        <button
          className={styles.contextChipMain}
          type="button"
          aria-label={canOpen && quoteFile
            ? `${contextKind === "comment" ? "打开评论来源" : "打开引用来源"} ${quoteFile.path}`
            : `${chipLabel}：${quote.preview}`}
          data-clickable={canOpen ? "true" : "false"}
          disabled={!canOpen}
          onClick={() => {
            if (quoteFile) {
              onOpen?.(quoteFile);
            }
          }}
        >
          <span className={styles.contextChipIcon} data-context-chip-icon={contextKind} aria-hidden="true">
            <ContextChipIcon kind={contextKind} />
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
  return {
    path: quote.file.path,
    name: quote.file.name || fileName(quote.file.path),
    type: "file",
    source: "workspace",
    selectedText: quote.text,
    lineStart: quote.file.lineStart ?? null,
    lineEnd: quote.file.lineEnd ?? null,
    sourceStart: quote.file.sourceStart ?? null,
    sourceEnd: quote.file.sourceEnd ?? null,
  };
}

function quoteChipLabel(quote: SelectedQuote): string {
  if (quote.comment?.trim()) {
    return "评论";
  }
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

function parentDirectoryPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
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
  const referenceKindLabel = file.type === "directory" ? "目录" : "文件";
  const canActivate = Boolean(onOpen);

  return (
    <ComposerContextHover
      className={styles.fileChipWrapper}
      hoverAnchor="file"
      title={chipLabel}
      description={fileHoverDescription(file)}
      meta={fileKindLabel}
    >
      <span className={styles.fileChip} data-context-type={file.type} data-openable={canActivate ? "true" : "false"}>
        <button
          className={styles.contextChipMain}
          type="button"
          aria-label={
            canActivate
              ? file.type === "directory"
                ? `在文件列表中定位目录 ${file.path}`
                : `打开${referenceKindLabel}引用 ${file.path}`
              : `${referenceKindLabel}引用 ${file.path}`
          }
          data-clickable={canActivate ? "true" : "false"}
          disabled={!canActivate}
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
          aria-label={`移除${referenceKindLabel}引用 ${file.path}`}
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
  const comment = quote.comment?.trim() || "";
  const quoteText = quote.text || quote.preview;
  return [location, `引用片段：${quoteText}`, comment ? `评论：${comment}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

function fileHoverDescription(file: SelectedFile): string {
  if (!file.annotationReference) {
    return file.path;
  }
  const summary = file.annotationReference.body?.trim().replace(/\s+/g, " ") ?? "";
  if (!summary) {
    return "批注摘要暂不可用";
  }
  const maxLength = 160;
  return summary.length > maxLength
    ? `${summary.slice(0, maxLength - 1).trimEnd()}…`
    : summary;
}

function selectedFileKindLabel(file: SelectedFile): string {
  if (file.annotationReference) {
    if (file.annotationReference.kind === "document") {
      return "全文批注";
    }
    if (file.annotationReference.kind === "text") {
      return "选区批注";
    }
    return "批注";
  }
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

function ComposerContextHover({
  className,
  hoverAnchor,
  title,
  description,
  meta,
  children,
}: {
  className: string;
  hoverAnchor: "skill" | "quote" | "comment" | "file";
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
      {open && hoverPlacement.portalRoot
        ? createPortal(
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
            </span>,
            hoverPlacement.portalRoot,
          )
        : null}
    </span>
  );
}

interface HoverCardPlacement {
  wrapperRef: (node: HTMLSpanElement | null) => void;
  cardRef: (node: HTMLSpanElement | null) => void;
  portalRoot: HTMLElement | null;
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
    const root = wrapper.closest<HTMLElement>("[data-sendbox-root='true']");
    const rootRect = root?.getBoundingClientRect();
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
      left: `${leftInViewport - (rootRect?.left ?? 0)}px`,
      top: `${wrapperRect.top - (rootRect?.top ?? 0) - 8}px`,
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

  return {
    wrapperRef: setWrapperRef,
    cardRef: setCardRef,
    portalRoot: wrapperRef.current?.closest<HTMLElement>("[data-sendbox-root='true']") ?? null,
    style,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

interface ContentEditableInputProps {
  value: string;
  pastedTextFragments: PastedTextFragment[];
  inputLabel: string;
  placeholder: string;
  disabled: boolean;
  className: string;
  refSetter: (node: HTMLDivElement | null) => void;
  onBlur: () => void;
  onBeforeInput: (event: FormEvent<HTMLDivElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onChange: (event: FormEvent<HTMLDivElement>) => void;
  onCompositionEnd: (event: CompositionEvent<HTMLElement>) => void;
  onCompositionStart: (event: CompositionEvent<HTMLElement>) => void;
  onFocus: () => void;
  onCopy: (event: ClipboardEvent<HTMLDivElement>) => void;
  onCut: (event: ClipboardEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
}

function ContentEditableInput({
  value,
  pastedTextFragments,
  inputLabel,
  placeholder,
  disabled,
  className,
  refSetter,
  onBlur,
  onBeforeInput,
  onClick,
  onChange,
  onCompositionEnd,
  onCompositionStart,
  onFocus,
  onCopy,
  onCut,
  onKeyDown,
  onMouseDown,
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
    const currentDocument = readEditorDocument(editor);
    const normalizedFragments = normalizePastedTextFragments(value, pastedTextFragments);
    if (
      currentDocument.value !== value ||
      !samePastedTextFragments(currentDocument.fragments, normalizedFragments)
    ) {
      renderEditorValue(editor, value, normalizedFragments);
    }
    editor.dataset.empty = value ? "false" : "true";
  }, [pastedTextFragments, value]);

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
      onBeforeInput={onBeforeInput}
      onClick={onClick}
      onCompositionEnd={onCompositionEnd}
      onCompositionStart={onCompositionStart}
      onFocus={onFocus}
      onCopy={onCopy}
      onCut={onCut}
      onInput={onChange}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onPaste={onPaste}
    />
  );
}

const QUOTE_CARD_SHOW_DELAY_MS = 200;
const CONTEXT_HOVER_CARD_MAX_WIDTH = 420;
const HOVER_CARD_EDGE_GAP = 12;
const HOVER_CARD_ARROW_PADDING = 16;

function renderEditorValue(
  editor: HTMLDivElement,
  value: string,
  pastedTextFragments: readonly PastedTextFragment[],
) {
  const fragments = normalizePastedTextFragments(value, pastedTextFragments);
  const nodes: Node[] = [];
  let cursor = 0;
  for (const fragment of fragments) {
    if (fragment.start > cursor) {
      nodes.push(document.createTextNode(value.slice(cursor, fragment.start)));
    } else if (fragment.start === 0 && nodes.length === 0) {
      nodes.push(createPastedTextCaretHostElement("leading"));
    }
    nodes.push(createPastedTextFragmentElement(value.slice(fragment.start, fragment.end), fragment));
    if (fragment.end === value.length) {
      nodes.push(createPastedTextCaretHostElement("trailing"));
    }
    cursor = fragment.end;
  }
  if (cursor < value.length) {
    nodes.push(document.createTextNode(value.slice(cursor)));
  }
  editor.replaceChildren(...nodes);
}

function removeEmptyPastedTextFragments(editor: HTMLElement) {
  editor.querySelectorAll<HTMLElement>(PASTED_TEXT_FRAGMENT_SELECTOR).forEach((fragment) => {
    const raw = fragment.querySelector(PASTED_TEXT_RAW_SELECTOR);
    if ((raw?.textContent ?? "") === "") {
      fragment.remove();
    }
  });
}

function readEditorDocument(root: Node): PastedTextDocument {
  return readPastedTextAwareDocument(root) ?? { value: readEditorValue(root), fragments: [] };
}

function readEditorValue(root: Node): string {
  const pastedTextDocument = readPastedTextAwareDocument(root);
  if (pastedTextDocument) {
    return normalizeEditorText(pastedTextDocument.value);
  }
  if (!hasMeaningfulEditorContent(root)) {
    return "";
  }
  // Chromium may represent Shift+Enter as root text followed by a DIV. Its
  // textContent is flattened, while innerText retains the visible line break.
  if (root instanceof HTMLElement && typeof root.innerText === "string") {
    return normalizeEditorText(root.innerText);
  }
  return normalizeEditorText(readEditorChildValues(root));
}

function readEditorChildValues(root: Node): string {
  let value = "";
  let previousWasBlock = false;
  root.childNodes.forEach((node, index) => {
    const currentIsBlock = node instanceof HTMLElement && isBlockEditorNode(node);
    if (index > 0 && (previousWasBlock || currentIsBlock)) {
      value += "\n";
    }
    value += readEditorNodeValue(node);
    previousWasBlock = currentIsBlock;
  });
  return value;
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
  return readEditorChildValues(node);
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

function insertPastedTextFragment(editor: HTMLDivElement, rawText: string) {
  const fragmentId = createPastedTextFragmentId();
  const element = createPastedTextFragmentElement(rawText, { id: fragmentId, collapsed: true });
  const selection = window.getSelection();
  moveCollapsedPasteInsertionOutsideCaretHost(editor, selection);
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const hasEditorRange = Boolean(range && rangeBelongsToEditor(editor, range));

  if (
    hasEditorRange &&
    typeof document.execCommand === "function" &&
    document.execCommand("insertHTML", false, element.outerHTML)
  ) {
    const inserted = Array.from(editor.querySelectorAll<HTMLElement>(PASTED_TEXT_FRAGMENT_SELECTOR))
      .find((candidate) => candidate.dataset.fragmentId === fragmentId);
    if (inserted) {
      placeCaretAtNodeBoundary(editor, inserted, true);
    }
    return;
  }

  if (range && hasEditorRange) {
    range.deleteContents();
    range.insertNode(element);
    range.setStartAfter(element);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return;
  }

  editor.append(element);
  placeCaretAtNodeBoundary(editor, element, true);
}

function moveCollapsedPasteInsertionOutsideCaretHost(
  editor: HTMLDivElement,
  selection: Selection | null,
) {
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !rangeBelongsToEditor(editor, range)) return;
  const caretHost = pastedTextCaretHostContaining(range.startContainer);
  if (!caretHost || !editor.contains(caretHost)) return;
  const position = caretHost.dataset.pasteCaretHost;
  const insertionRange = document.createRange();
  if (position === "leading") {
    insertionRange.setStartBefore(caretHost);
  } else {
    insertionRange.setStartAfter(caretHost);
  }
  insertionRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(insertionRange);
}

function pastedTextCaretHostContaining(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(PASTED_TEXT_CARET_HOST_SELECTOR) ?? null;
}

function selectionBelongsToEditor(editor: HTMLElement, selection: Selection): boolean {
  return containsEditorNode(editor, selection.anchorNode) && containsEditorNode(editor, selection.focusNode);
}

function rangeBelongsToEditor(editor: HTMLElement, range: Range): boolean {
  return containsEditorNode(editor, range.startContainer) && containsEditorNode(editor, range.endContainer);
}

function containsEditorNode(editor: HTMLElement, node: Node | null): boolean {
  return Boolean(node && (node === editor || editor.contains(node)));
}

function adjacentPastedTextFragment(
  editor: HTMLDivElement,
  range: Range,
  direction: "backward" | "forward",
): HTMLElement | null {
  if (!range.collapsed || !rangeBelongsToEditor(editor, range)) {
    return null;
  }
  const containingElement = range.startContainer instanceof Element
    ? range.startContainer
    : range.startContainer.parentElement;
  const containingFragment = containingElement?.closest<HTMLElement>(PASTED_TEXT_FRAGMENT_SELECTOR) ?? null;
  if (
    containingFragment &&
    editor.contains(containingFragment) &&
    containingFragment.dataset.collapsed !== "false"
  ) {
    return containingFragment;
  }
  let directChild: Node = range.startContainer;
  if (directChild === editor) {
    const offset = range.startOffset;
    let candidate: ChildNode | null = direction === "backward"
      ? editor.childNodes[offset - 1] ?? null
      : editor.childNodes[offset] ?? null;
    if (
      candidate instanceof HTMLElement &&
      candidate.matches(PASTED_TEXT_CARET_HOST_SELECTOR) &&
      !pastedTextCaretHostValue(candidate)
    ) {
      candidate = direction === "backward" ? candidate.previousSibling : candidate.nextSibling;
    }
    return candidate instanceof HTMLElement && candidate.matches(PASTED_TEXT_FRAGMENT_SELECTOR) ? candidate : null;
  }
  while (directChild.parentNode && directChild.parentNode !== editor) {
    directChild = directChild.parentNode;
  }
  if (directChild.parentNode !== editor) {
    return null;
  }
  if (
    directChild instanceof HTMLElement &&
    directChild.matches(PASTED_TEXT_CARET_HOST_SELECTOR)
  ) {
    if (pastedTextCaretHostValue(directChild)) {
      return null;
    }
    const candidate = direction === "backward"
      ? directChild.previousSibling
      : directChild.nextSibling;
    return candidate instanceof HTMLElement && candidate.matches(PASTED_TEXT_FRAGMENT_SELECTOR)
      ? candidate
      : null;
  }
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const length = range.startContainer.textContent?.length ?? 0;
    if (
      (direction === "backward" && range.startOffset > 0) ||
      (direction === "forward" && range.startOffset < length)
    ) {
      return null;
    }
  }
  const index = Array.prototype.indexOf.call(editor.childNodes, directChild) as number;
  const candidate = direction === "backward"
    ? editor.childNodes[index - 1] ?? null
    : editor.childNodes[index + 1] ?? null;
  return candidate instanceof HTMLElement && candidate.matches(PASTED_TEXT_FRAGMENT_SELECTOR) ? candidate : null;
}

function ensurePastedTextCaretHost(
  editor: HTMLElement,
  fragment: HTMLElement,
  after: boolean,
): HTMLElement | null {
  const sibling = after ? fragment.nextSibling : fragment.previousSibling;
  if (sibling instanceof HTMLElement && sibling.matches(PASTED_TEXT_CARET_HOST_SELECTOR)) {
    return sibling;
  }
  if (sibling || !editor.contains(fragment)) {
    return null;
  }
  const host = createPastedTextCaretHostElement(after ? "trailing" : "leading");
  if (after) {
    fragment.after(host);
  } else {
    fragment.before(host);
  }
  return host;
}

function placeCaretAtNodeBoundary(editor: HTMLElement, node: Node, after: boolean) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  if (node instanceof HTMLElement && node.matches(PASTED_TEXT_FRAGMENT_SELECTOR)) {
    const caretHost = ensurePastedTextCaretHost(editor, node, after);
    if (caretHost) {
      range.selectNodeContents(caretHost);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
  }
  if (node === editor) {
    range.selectNodeContents(editor);
    range.collapse(after);
  } else if (editor.contains(node)) {
    if (node.nodeType === Node.TEXT_NODE) {
      range.setStart(node, after ? node.textContent?.length ?? 0 : 0);
    } else if (after) {
      range.setStartAfter(node);
    } else {
      range.setStartBefore(node);
    }
    range.collapse(true);
  } else {
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretInsidePastedTextRaw(editor: HTMLElement, fragment: HTMLElement) {
  const raw = fragment.querySelector<HTMLElement>(PASTED_TEXT_RAW_SELECTOR);
  const selection = window.getSelection();
  if (!raw || !selection) {
    placeCaretAtNodeBoundary(editor, fragment, true);
    return;
  }
  editor.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(raw);
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

function canTypeWhileBusy(state: ConversationRuntimeState): boolean {
  return state === "running" || state === "waiting_approval";
}
