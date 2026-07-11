import type { WorkspaceSearchResult } from "@/runtime";

export type SelectedFileSource = "workspace" | "dropped" | "pasted" | "picker";

export interface SelectedFile {
  id?: string | null;
  path: string;
  name: string;
  type: "file" | "directory";
  source: SelectedFileSource;
  annotationReference?: {
    annotationId: string;
    path: string;
    workspaceId: string;
  } | null;
  selectedText?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface FileSelectionState {
  files: SelectedFile[];
  dragging: boolean;
  error: string | null;
}

export type FileSelectionAction =
  | { type: "add"; file: SelectedFile }
  | { type: "addMany"; files: SelectedFile[] }
  | { type: "remove"; id: string }
  | { type: "dragging"; dragging: boolean }
  | { type: "error"; error: string | null }
  | { type: "clear" };

export const initialFileSelectionState: FileSelectionState = {
  files: [],
  dragging: false,
  error: null,
};

export function fileSelectionReducer(
  state: FileSelectionState,
  action: FileSelectionAction,
): FileSelectionState {
  switch (action.type) {
    case "add":
      return addFileToSelection(state, action.file);
    case "addMany":
      return action.files.reduce(addFileToSelection, state);
    case "remove":
      return {
        ...state,
        files: state.files.filter((file) => selectedFileKey(file) !== action.id),
        error: null,
      };
    case "dragging":
      return { ...state, dragging: action.dragging };
    case "error":
      return { ...state, error: action.error };
    case "clear":
      return initialFileSelectionState;
  }
}

function addFileToSelection(state: FileSelectionState, file: SelectedFile): FileSelectionState {
  if (!file.path.trim()) {
    return { ...state, error: "无法添加没有路径的文件" };
  }
  const key = selectedFileKey(file);
  if (state.files.some((item) => selectedFileKey(item) === key)) {
    return { ...state, error: null };
  }
  return { ...state, files: [...state.files, file], error: null };
}

export function selectedFileKey(file: SelectedFile): string {
  const path = file.path.trim();
  const id = normalizedOptionalText(file.id);
  if (id) {
    return id;
  }
  const reference = file.annotationReference;
  if (reference?.annotationId) {
    return `annotation:${reference.workspaceId}:${reference.annotationId}`;
  }
  return `path:${path}`;
}

export function selectedFileFromWorkspace(result: WorkspaceSearchResult): SelectedFile {
  return {
    path: result.path,
    name: result.name,
    type: result.type,
    source: "workspace",
  };
}

export function selectedFileFromPath(
  path: string,
  source: SelectedFileSource,
  name?: string | null,
  type: "file" | "directory" = "file",
): SelectedFile | null {
  const cleanedPath = path.trim();
  if (!cleanedPath) {
    return null;
  }
  return {
    path: cleanedPath,
    name: name?.trim() || fileName(cleanedPath),
    type,
    source,
  };
}

export function selectedFileFromFile(file: File, source: Exclude<SelectedFileSource, "workspace">): SelectedFile | null {
  const withPath = file as File & { path?: string };
  const path = withPath.path || "";
  if (!path) {
    return null;
  }
  return selectedFileFromPath(path, source, file.name, "file");
}

export function composeMessageWithSelectedFiles(message: string, files: SelectedFile[]): string {
  return message.trim();
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function normalizedOptionalText(value: string | null | undefined): string {
  return (value ?? "").trim();
}
