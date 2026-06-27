import type { WorkspaceSelectorProps } from "@/renderer/components/workspace";

export type WorkbenchWorkspaceSelectorProps = Pick<
  WorkspaceSelectorProps,
  | "value"
  | "workspaces"
  | "loading"
  | "allowProjectFreeChat"
  | "onSelectWorkspace"
  | "onAddWorkspace"
  | "onPickWorkspacePath"
>;
