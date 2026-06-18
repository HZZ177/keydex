import type { WorkspaceSearchResult } from "@/runtime";

export interface SelectedFile {
  path: string;
  name: string;
  type: "file" | "directory";
  source: "workspace" | "dropped" | "pasted";
}

export interface FileSelectionState {
  files: SelectedFile[];
  dragging: boolean;
  error: string | null;
}

export type FileSelectionAction =
  | { type: "add"; file: SelectedFile }
  | { type: "remove"; path: string }
  | { type: "dragging"; dragging: boolean }
  | { type: "error"; error: string | null };

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
      if (!action.file.path.trim()) {
        return { ...state, error: "无法添加没有路径的文件" };
      }
      if (state.files.some((file) => file.path === action.file.path)) {
        return { ...state, error: null };
      }
      return { ...state, files: [...state.files, action.file], error: null };
    case "remove":
      return { ...state, files: state.files.filter((file) => file.path !== action.path), error: null };
    case "dragging":
      return { ...state, dragging: action.dragging };
    case "error":
      return { ...state, error: action.error };
  }
}

export function selectedFileFromWorkspace(result: WorkspaceSearchResult): SelectedFile {
  return {
    path: result.path,
    name: result.name,
    type: result.type,
    source: "workspace",
  };
}

export function selectedFileFromFile(file: File, source: "dropped" | "pasted"): SelectedFile | null {
  const withPath = file as File & { path?: string };
  const path = withPath.path || file.webkitRelativePath || file.name;
  if (!path) {
    return null;
  }
  return {
    path,
    name: file.name || path,
    type: "file",
    source,
  };
}
