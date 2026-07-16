export type GitRepositoryRootKind = "workspace" | "nested" | "ancestor" | "worktree" | "submodule";

export interface GitRepositoryRoot {
  id: string;
  rootPath: string;
  displayPath: string;
  kind: GitRepositoryRootKind;
  parentRepoId?: string;
}

export interface ActiveProjectIdentity {
  workspaceId: string;
  projectPath: string;
  name: string;
}

interface ProjectBoundState extends ActiveProjectIdentity {
  selectedRepoId: string | null;
}

export type ActiveProjectState =
  | { status: "none"; selectedRepoId: null }
  | (ProjectBoundState & { status: "loading" })
  | (ProjectBoundState & {
      status: "ready";
      repoRoots: readonly [GitRepositoryRoot];
      selectedRepoId: string;
    })
  | (ProjectBoundState & {
      status: "multi_repo";
      repoRoots: readonly [GitRepositoryRoot, GitRepositoryRoot, ...GitRepositoryRoot[]];
      selectedRepoId: string;
    })
  | (ProjectBoundState & { status: "non_repo"; selectedRepoId: null })
  | (ProjectBoundState & {
      status: "ancestor_pending";
      selectedRepoId: null;
      ancestorCandidate: GitRepositoryRoot;
    })
  | (ProjectBoundState & {
      status: "denied";
      selectedRepoId: null;
      deniedRepoId: string;
      reason: "ancestor_not_authorized" | "outside_workspace" | "invalid_repository";
    })
  | (ProjectBoundState & { status: "error"; errorCode: string; message: string });

export interface ActiveProjectDiscovery {
  project: ActiveProjectIdentity | null;
  loading?: boolean;
  repoRoots?: readonly GitRepositoryRoot[];
  selectedRepoId?: string | null;
  ancestorCandidate?: GitRepositoryRoot | null;
  denied?: { repoId: string; reason: Extract<ActiveProjectState, { status: "denied" }>['reason'] };
  error?: { code: string; message: string };
}

export type ActiveProjectEvent =
  | { type: "select_repo"; repoId: string }
  | { type: "ancestor_granted"; repo: GitRepositoryRoot }
  | { type: "ancestor_denied" }
  | { type: "discovery_started" }
  | { type: "project_cleared" };

function normalizedRoots(roots: readonly GitRepositoryRoot[]): GitRepositoryRoot[] {
  const ids = new Set<string>();
  return roots.map((root) => {
    if (!root.id.trim() || !root.rootPath.trim()) throw new Error("Git repository roots require id and path");
    if (ids.has(root.id)) throw new Error(`Duplicate Git repository id: ${root.id}`);
    ids.add(root.id);
    return { ...root };
  });
}

export function deriveActiveProjectState(input: ActiveProjectDiscovery): ActiveProjectState {
  if (!input.project) return { status: "none", selectedRepoId: null };
  const base = { ...input.project };
  if (input.loading) return { ...base, status: "loading", selectedRepoId: null };
  if (input.error) {
    return {
      ...base,
      status: "error",
      selectedRepoId: null,
      errorCode: input.error.code,
      message: input.error.message,
    };
  }
  if (input.denied) {
    return {
      ...base,
      status: "denied",
      selectedRepoId: null,
      deniedRepoId: input.denied.repoId,
      reason: input.denied.reason,
    };
  }

  const roots = normalizedRoots(input.repoRoots ?? []);
  if (roots.length === 0 && input.ancestorCandidate) {
    return {
      ...base,
      status: "ancestor_pending",
      selectedRepoId: null,
      ancestorCandidate: input.ancestorCandidate,
    };
  }
  if (roots.length === 0) return { ...base, status: "non_repo", selectedRepoId: null };

  const selectedRepoId = input.selectedRepoId ?? roots[0].id;
  if (!roots.some((root) => root.id === selectedRepoId)) {
    throw new Error(`Selected Git repository is not part of the active project: ${selectedRepoId}`);
  }
  if (roots.length === 1) {
    return { ...base, status: "ready", repoRoots: [roots[0]], selectedRepoId };
  }
  return {
    ...base,
    status: "multi_repo",
    repoRoots: roots as [GitRepositoryRoot, GitRepositoryRoot, ...GitRepositoryRoot[]],
    selectedRepoId,
  };
}

export function reduceActiveProjectState(
  state: ActiveProjectState,
  event: ActiveProjectEvent,
): ActiveProjectState {
  if (event.type === "project_cleared") return { status: "none", selectedRepoId: null };
  if (state.status === "none") return state;
  if (event.type === "discovery_started") {
    return {
      status: "loading",
      workspaceId: state.workspaceId,
      projectPath: state.projectPath,
      name: state.name,
      selectedRepoId: null,
    };
  }
  if (event.type === "select_repo") {
    if (state.status !== "ready" && state.status !== "multi_repo") return state;
    if (!state.repoRoots.some((root) => root.id === event.repoId)) return state;
    return { ...state, selectedRepoId: event.repoId };
  }
  if (event.type === "ancestor_denied" && state.status === "ancestor_pending") {
    return {
      status: "denied",
      workspaceId: state.workspaceId,
      projectPath: state.projectPath,
      name: state.name,
      selectedRepoId: null,
      deniedRepoId: state.ancestorCandidate.id,
      reason: "ancestor_not_authorized",
    };
  }
  if (event.type === "ancestor_granted" && state.status === "ancestor_pending") {
    if (event.repo.id !== state.ancestorCandidate.id) return state;
    return {
      status: "ready",
      workspaceId: state.workspaceId,
      projectPath: state.projectPath,
      name: state.name,
      repoRoots: [{ ...event.repo, kind: "ancestor" }],
      selectedRepoId: event.repo.id,
    };
  }
  return state;
}

export function selectedGitRepository(state: ActiveProjectState): GitRepositoryRoot | null {
  if (state.status !== "ready" && state.status !== "multi_repo") return null;
  return state.repoRoots.find((root) => root.id === state.selectedRepoId) ?? null;
}
