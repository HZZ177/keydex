export type AssistantSurfaceMode = "capsule" | "composer" | "expanded" | "drawer";

export interface WorkbenchAssistantState {
  focusSeq: number;
  mode: AssistantSurfaceMode;
}

export type WorkbenchAssistantAction =
  | { type: "workspace-reset" }
  | { type: "draft-changed"; hasDraft: boolean }
  | { type: "context-injected" }
  | { type: "open-composer" }
  | { type: "toggle-expanded"; hasDraft: boolean }
  | { type: "dock-to-drawer" }
  | { type: "close-drawer"; hasDraft: boolean }
  | { type: "approval-pending" };

export function createWorkbenchAssistantState(): WorkbenchAssistantState {
  return {
    focusSeq: 0,
    mode: "capsule",
  };
}

export function workbenchAssistantReducer(
  state: WorkbenchAssistantState,
  action: WorkbenchAssistantAction,
): WorkbenchAssistantState {
  switch (action.type) {
    case "workspace-reset":
      return createWorkbenchAssistantState();
    case "draft-changed":
      return state.mode === "capsule" && action.hasDraft ? { ...state, mode: "composer" } : state;
    case "context-injected":
      return state.mode === "drawer"
        ? state
        : {
            mode: state.mode === "capsule" ? "composer" : state.mode,
            focusSeq: state.focusSeq + 1,
          };
    case "open-composer":
      return {
        mode: "composer",
        focusSeq: state.focusSeq + 1,
      };
    case "toggle-expanded":
      if (state.mode === "expanded") {
        return {
          mode: action.hasDraft ? "composer" : "capsule",
          focusSeq: state.focusSeq + (action.hasDraft ? 1 : 0),
        };
      }
      return {
        mode: "expanded",
        focusSeq: state.focusSeq + 1,
      };
    case "dock-to-drawer":
    case "approval-pending":
      return {
        mode: "drawer",
        focusSeq: state.focusSeq + 1,
      };
    case "close-drawer":
      return {
        mode: action.hasDraft ? "composer" : "capsule",
        focusSeq: state.focusSeq + (action.hasDraft ? 1 : 0),
      };
  }
}
