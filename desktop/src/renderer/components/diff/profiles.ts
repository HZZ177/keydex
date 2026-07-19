import type { KeydexDiffSelectionRange } from "./selectionBridge";

export type KeydexDiffProfileName = "compact" | "review" | "git" | "preview";

export type KeydexDiffLayout = "stacked" | "split";

export type KeydexDiffSelectionMode = "none" | "text" | "git_patch";

export type KeydexDiffNavigationMode = "none" | "files";

export type KeydexDiffDensity = "compact" | "comfortable";

export type KeydexDiffScrollChainingMode = "contain" | "parent_at_edge";

export type KeydexDiffHunkCapability =
  | "navigate"
  | "copy"
  | "accept_left"
  | "accept_right"
  | "stage"
  | "unstage"
  | "discard";

export const KEYDEX_DIFF_HUNK_WRITE_CAPABILITIES = Object.freeze([
  "accept_left",
  "accept_right",
  "stage",
  "unstage",
  "discard",
] satisfies readonly KeydexDiffHunkCapability[]);

export type KeydexDiffActionName =
  | "copy_patch"
  | "copy_selection"
  | "open_file"
  | "toggle_wrap"
  | "toggle_layout"
  | "toggle_sync_scroll"
  | "navigate_changes"
  | "navigate_files"
  | "apply_git_patch";

export interface KeydexDiffProfileContract {
  readonly name: KeydexDiffProfileName;
  readonly density: KeydexDiffDensity;
  readonly defaultLayout: KeydexDiffLayout;
  readonly allowedLayouts: readonly KeydexDiffLayout[];
  readonly defaultWrap: boolean;
  readonly wrapToggle: boolean;
  readonly navigation: KeydexDiffNavigationMode;
  readonly selection: KeydexDiffSelectionMode;
  readonly persistDisplayPreferences: boolean;
  readonly defaultSyncScroll: boolean;
  readonly alignedSplit: boolean;
  readonly connector: boolean;
  readonly syncScroll: boolean;
  readonly hunkNavigation: boolean;
  readonly scrollChaining: KeydexDiffScrollChainingMode;
  readonly hunkActions: readonly KeydexDiffHunkCapability[];
  readonly allowedActions: readonly KeydexDiffActionName[];
}

export interface KeydexGitDiffAction {
  readonly mode: "stage" | "unstage";
  readonly busy?: boolean;
  readonly status?: KeydexGitDiffActionStatus;
  readonly disabledReason?: string;
  readonly applyPatches: (patches: readonly string[]) => void | Promise<void>;
  readonly applyHunk?: (target: KeydexGitHunkActionTarget) => void | Promise<void>;
  readonly applySelection?: (selection: KeydexDiffSelectionRange) => void | Promise<void>;
}

export type KeydexGitDiffActionStatus = "idle" | "queued" | "running" | "success" | "error";

export interface KeydexGitHunkActionTarget {
  readonly fileId: string;
  readonly fileCacheKey: string;
  readonly hunkId: string;
}

export interface KeydexDiffActions {
  readonly copyPatch?: (patch: string) => void | Promise<void>;
  readonly copySelection?: (selection: string) => void | Promise<void>;
  readonly copyPath?: (path: string) => void | Promise<void>;
  readonly openFile?: (path: string) => void | Promise<void>;
  readonly git?: KeydexGitDiffAction;
}

export interface ResolvedKeydexDiffProfile {
  readonly profile: KeydexDiffProfileContract;
  readonly actions: KeydexDiffActions;
  readonly enabledActions: readonly KeydexDiffActionName[];
  readonly readOnly: boolean;
}

export class KeydexDiffProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeydexDiffProfileError";
  }
}

export const KEYDEX_DIFF_PROFILES = Object.freeze({
  compact: profile({
    name: "compact",
    density: "compact",
    defaultLayout: "stacked",
    allowedLayouts: ["stacked"],
    defaultWrap: true,
    wrapToggle: false,
    navigation: "none",
    selection: "text",
    persistDisplayPreferences: false,
    defaultSyncScroll: false,
    alignedSplit: false,
    connector: false,
    syncScroll: false,
    hunkNavigation: false,
    scrollChaining: "parent_at_edge",
    hunkActions: [],
    allowedActions: ["copy_patch", "copy_selection", "open_file"],
  }),
  review: profile({
    name: "review",
    density: "comfortable",
    defaultLayout: "stacked",
    allowedLayouts: ["stacked", "split"],
    defaultWrap: true,
    wrapToggle: true,
    navigation: "files",
    selection: "text",
    persistDisplayPreferences: false,
    defaultSyncScroll: true,
    alignedSplit: true,
    connector: true,
    syncScroll: true,
    hunkNavigation: true,
    scrollChaining: "parent_at_edge",
    hunkActions: ["navigate", "copy"],
    allowedActions: [
      "copy_patch",
      "copy_selection",
      "open_file",
      "toggle_wrap",
      "toggle_layout",
      "toggle_sync_scroll",
      "navigate_changes",
      "navigate_files",
    ],
  }),
  git: profile({
    name: "git",
    density: "comfortable",
    defaultLayout: "split",
    allowedLayouts: ["stacked", "split"],
    defaultWrap: false,
    wrapToggle: true,
    navigation: "files",
    selection: "git_patch",
    persistDisplayPreferences: true,
    defaultSyncScroll: true,
    alignedSplit: true,
    connector: true,
    syncScroll: true,
    hunkNavigation: true,
    scrollChaining: "contain",
    hunkActions: ["navigate", "copy"],
    allowedActions: [
      "copy_patch",
      "copy_selection",
      "open_file",
      "toggle_wrap",
      "toggle_layout",
      "toggle_sync_scroll",
      "navigate_changes",
      "navigate_files",
      "apply_git_patch",
    ],
  }),
  preview: profile({
    name: "preview",
    density: "comfortable",
    defaultLayout: "stacked",
    allowedLayouts: ["stacked", "split"],
    defaultWrap: true,
    wrapToggle: true,
    navigation: "files",
    selection: "text",
    persistDisplayPreferences: true,
    defaultSyncScroll: true,
    alignedSplit: true,
    connector: true,
    syncScroll: true,
    hunkNavigation: true,
    scrollChaining: "contain",
    hunkActions: ["navigate", "copy"],
    allowedActions: [
      "copy_patch",
      "copy_selection",
      "open_file",
      "toggle_wrap",
      "toggle_layout",
      "toggle_sync_scroll",
      "navigate_changes",
      "navigate_files",
    ],
  }),
} satisfies Record<KeydexDiffProfileName, KeydexDiffProfileContract>);

export function resolveKeydexDiffProfile(
  name: KeydexDiffProfileName,
  actions: KeydexDiffActions = {},
): ResolvedKeydexDiffProfile {
  const contract = KEYDEX_DIFF_PROFILES[name];
  if (!contract) {
    throw new KeydexDiffProfileError(`Unknown Diff profile: ${String(name)}`);
  }
  if (actions.git && name !== "git") {
    throw new KeydexDiffProfileError(`Git write actions are not allowed in the ${name} profile`);
  }

  const enabled = new Set<KeydexDiffActionName>();
  if (actions.copyPatch) enabled.add("copy_patch");
  if (actions.copySelection) enabled.add("copy_selection");
  if (actions.openFile) enabled.add("open_file");
  if (contract.wrapToggle) enabled.add("toggle_wrap");
  if (contract.allowedLayouts.length > 1) enabled.add("toggle_layout");
  if (contract.syncScroll) enabled.add("toggle_sync_scroll");
  if (contract.hunkNavigation) enabled.add("navigate_changes");
  if (contract.navigation === "files") enabled.add("navigate_files");
  if (actions.git) enabled.add("apply_git_patch");

  const enabledActions = Object.freeze(
    contract.allowedActions.filter((action) => enabled.has(action)),
  );
  return Object.freeze({
    profile: contract,
    actions: Object.freeze({ ...actions, ...(actions.git ? { git: Object.freeze(actions.git) } : {}) }),
    enabledActions,
    readOnly: !actions.git,
  });
}

function profile(contract: KeydexDiffProfileContract): KeydexDiffProfileContract {
  if (!contract.allowedLayouts.includes(contract.defaultLayout)) {
    throw new KeydexDiffProfileError(
      `${contract.name}: default layout must be included in allowedLayouts`,
    );
  }
  if (contract.selection === "git_patch" && contract.name !== "git") {
    throw new KeydexDiffProfileError(`${contract.name}: git_patch selection is Git-only`);
  }
  if (contract.alignedSplit !== contract.allowedLayouts.includes("split")) {
    throw new KeydexDiffProfileError(
      `${contract.name}: alignedSplit must match split layout capability`,
    );
  }
  if ((contract.connector || contract.syncScroll || contract.hunkNavigation) && !contract.alignedSplit) {
    throw new KeydexDiffProfileError(
      `${contract.name}: connector, sync and change navigation require aligned split`,
    );
  }
  if (contract.defaultSyncScroll && !contract.syncScroll) {
    throw new KeydexDiffProfileError(
      `${contract.name}: default sync requires syncScroll capability`,
    );
  }
  if (
    contract.allowedActions.includes("apply_git_patch") !==
    (contract.selection === "git_patch")
  ) {
    throw new KeydexDiffProfileError(
      `${contract.name}: apply_git_patch must match git_patch selection capability`,
    );
  }
  return Object.freeze({
    ...contract,
    allowedLayouts: Object.freeze([...contract.allowedLayouts]),
    allowedActions: Object.freeze([...contract.allowedActions]),
    hunkActions: Object.freeze([...contract.hunkActions]),
  });
}
