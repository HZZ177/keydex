import { createStore, type StoreApi } from "zustand/vanilla";

import type { GitHistoryFilters } from "@/runtime/git";

import type {
  GitCapabilitySet,
  GitCommandResult,
  GitDiffSnapshot,
  GitDiscoverySnapshot,
  GitHistoryPage,
  GitRef,
  GitRepositoryDescriptor,
  GitRepositoryId,
  GitStatusSnapshot,
} from "@/runtime/gitTypes";

export type GitToolWindowTab = "changes" | "history" | "blame" | "reflog" | "branches" | "stash" | "operations";

export type GitToolWindowNavigationIntent =
  | { kind: "compare_refs"; currentRef: string; targetRef: string }
  | { kind: "compare_worktree"; targetRef: string };

export type GitToolWindowNavigationRequest = GitToolWindowNavigationIntent & {
  requestId: number;
};

export interface GitProjectStoreState {
  workspaceId: string;
  projectRoot: string;
  loading: boolean;
  capability: GitCapabilitySet | null;
  repositoryIds: readonly GitRepositoryId[];
  selectedRepositoryId: GitRepositoryId | null;
  ancestorCandidateId: GitRepositoryId | null;
  error: { code: string; message: string } | null;
}

export interface GitProjectUiState {
  toolWindowOpen: boolean;
  toolWindowMaximized: boolean;
  activeTab: GitToolWindowTab;
  selectedRef: string | null;
  selectedPath: string | null;
  commitDraft: string;
  historyFilters: GitHistoryFilters;
  selectedHistoryObjectId: string | null;
  navigationPanePercent: number;
  detailPanePercent: number;
  updateStrategyByRepository: Record<string, "ff_only" | "merge" | "rebase">;
}

export interface GitUiStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface GitStoreOptions {
  storage?: GitUiStorage | null;
}

export interface GitStoreState {
  activeWorkspaceId: string | null;
  projects: Record<string, GitProjectStoreState>;
  repositories: Record<string, GitRepositoryDescriptor>;
  statusByRepository: Record<string, GitStatusSnapshot | undefined>;
  refsByRepository: Record<string, readonly GitRef[] | undefined>;
  historyByRepository: Record<string, GitHistoryPage | undefined>;
  diffByRepository: Record<string, GitDiffSnapshot | undefined>;
  operations: Record<string, GitCommandResult>;
  operationIds: readonly string[];
  uiByProject: Record<string, GitProjectUiState>;
  repositoryEpochs: Record<string, number | undefined>;
  invalidatedDomainsByRepository: Record<string, readonly string[] | undefined>;
  navigationRequestsByProject: Record<string, GitToolWindowNavigationRequest | undefined>;

  activateProject(workspaceId: string, projectRoot: string): void;
  clearActiveProject(): void;
  discoveryStarted(workspaceId: string, projectRoot: string): void;
  discoverySucceeded(workspaceId: string, projectRoot: string, discovery: GitDiscoverySnapshot): void;
  discoveryFailed(workspaceId: string, projectRoot: string, error: { code: string; message: string }): void;
  selectRepository(workspaceId: string, repositoryId: GitRepositoryId): void;
  setStatus(status: GitStatusSnapshot): void;
  setRefs(snapshot: { repositoryId: GitRepositoryId; refs: readonly GitRef[] }): void;
  setHistory(history: GitHistoryPage): void;
  setDiff(diff: GitDiffSnapshot): void;
  recordOperation(operation: GitCommandResult): void;
  invalidateRepository(repositoryId: GitRepositoryId, domains: readonly string[]): number;
  clearInvalidatedDomains(repositoryId: GitRepositoryId, domains: readonly string[]): void;
  updateProjectUi(workspaceId: string, update: Partial<GitProjectUiState>): void;
  requestToolWindowNavigation(workspaceId: string, intent: GitToolWindowNavigationIntent): void;
  consumeToolWindowNavigation(workspaceId: string, requestId: number): void;
}

export type GitStore = StoreApi<GitStoreState>;

export function selectLatestActiveGitCheckoutOperation(state: GitStoreState): GitCommandResult | null {
  const workspaceId = state.activeWorkspaceId;
  const repositoryId = workspaceId ? state.projects[workspaceId]?.selectedRepositoryId : null;
  if (!repositoryId) return null;

  for (const operationId of state.operationIds) {
    const operation = state.operations[operationId];
    if (operation?.repositoryId === repositoryId && operation.command === "checkout") {
      return operation;
    }
  }
  return null;
}

const DEFAULT_UI: GitProjectUiState = {
  toolWindowOpen: false,
  toolWindowMaximized: true,
  activeTab: "changes",
  selectedRef: null,
  selectedPath: null,
  commitDraft: "",
  historyFilters: {
    search: "",
    revision: "",
    author: "",
    since: "",
  },
  selectedHistoryObjectId: null,
  navigationPanePercent: 19,
  detailPanePercent: 28,
  updateStrategyByRepository: {},
};

const GIT_UI_STORAGE_KEY = "keydex.git.project-ui.v1";
const GIT_UI_SCHEMA_VERSION = 1;

export function createGitStore(options: GitStoreOptions = {}): GitStore {
  const storage = options.storage ?? null;
  const persisted = readPersistedGitUi(storage);
  const persist = (state: GitStoreState) => writePersistedGitUi(storage, state);
  let navigationRequestSequence = 0;
  return createStore<GitStoreState>((set, get) => ({
    activeWorkspaceId: null,
    projects: {},
    repositories: {},
    statusByRepository: {},
    refsByRepository: {},
    historyByRepository: {},
    diffByRepository: {},
    operations: {},
    operationIds: [],
    uiByProject: {},
    repositoryEpochs: {},
    invalidatedDomainsByRepository: {},
    navigationRequestsByProject: {},

    activateProject(workspaceId, projectRoot) {
      set((state) => ({
        activeWorkspaceId: workspaceId,
        projects: state.projects[workspaceId]
          ? state.projects
          : {
              ...state.projects,
              [workspaceId]: emptyProject(workspaceId, projectRoot),
            },
        uiByProject: state.uiByProject[workspaceId]
          ? state.uiByProject
          : {
              ...state.uiByProject,
              [workspaceId]: persisted.projects[workspaceId]?.projectRoot === projectRoot
                ? persisted.projects[workspaceId].ui
                : cloneDefaultUi(),
            },
      }));
    },
    clearActiveProject() {
      set({ activeWorkspaceId: null });
    },
    discoveryStarted(workspaceId, projectRoot) {
      set((state) => ({
        projects: {
          ...state.projects,
          [workspaceId]: {
            ...(state.projects[workspaceId] ?? emptyProject(workspaceId, projectRoot)),
            projectRoot,
            loading: true,
            error: null,
          },
        },
      }));
    },
    discoverySucceeded(workspaceId, projectRoot, discovery) {
      set((state) => {
        const repositories = { ...state.repositories };
        discovery.repositories.forEach((repository) => {
          repositories[repository.id] = repository;
        });
        if (discovery.ancestorCandidate) {
          repositories[discovery.ancestorCandidate.id] = discovery.ancestorCandidate;
        }
        const previous = state.projects[workspaceId];
        const grantedAncestor = discovery.ancestorCandidate?.ancestorAuthorization === "granted"
          ? discovery.ancestorCandidate
          : null;
        const repositoryIds = [
          ...discovery.repositories.map((repository) => repository.id),
          ...(grantedAncestor ? [grantedAncestor.id] : []),
        ];
        const selectedRepositoryId =
          previous?.selectedRepositoryId && repositoryIds.includes(previous.selectedRepositoryId)
            ? previous.selectedRepositoryId
            : persisted.projects[workspaceId]?.projectRoot === projectRoot
              && persisted.projects[workspaceId].selectedRepositoryId
              && repositoryIds.includes(persisted.projects[workspaceId].selectedRepositoryId as GitRepositoryId)
              ? persisted.projects[workspaceId].selectedRepositoryId as GitRepositoryId
            : repositoryIds[0] ?? null;
        return {
          repositories,
          projects: {
            ...state.projects,
            [workspaceId]: {
              workspaceId,
              projectRoot,
              loading: false,
              capability: discovery.capability,
              repositoryIds,
              selectedRepositoryId,
              ancestorCandidateId: discovery.ancestorCandidate?.ancestorAuthorization === "pending"
                ? discovery.ancestorCandidate.id
                : null,
              error: null,
            },
          },
          uiByProject: state.uiByProject[workspaceId]
            ? state.uiByProject
            : { ...state.uiByProject, [workspaceId]: { ...DEFAULT_UI } },
        };
      });
    },
    discoveryFailed(workspaceId, projectRoot, error) {
      set((state) => ({
        projects: {
          ...state.projects,
          [workspaceId]: {
            ...(state.projects[workspaceId] ?? emptyProject(workspaceId, projectRoot)),
            projectRoot,
            loading: false,
            error,
          },
        },
      }));
    },
    selectRepository(workspaceId, repositoryId) {
      let changed = false;
      set((state) => {
        const project = state.projects[workspaceId];
        if (!project?.repositoryIds.includes(repositoryId)) return state;
        changed = project.selectedRepositoryId !== repositoryId;
        return {
          projects: {
            ...state.projects,
            [workspaceId]: { ...project, selectedRepositoryId: repositoryId },
          },
        };
      });
      if (changed) persist(get());
    },
    setStatus(status) {
      let selectionChanged = false;
      set((state) => {
        const workspaceId = workspaceSelectingRepository(state, status.repositoryId);
        const ui = workspaceId ? state.uiByProject[workspaceId] : null;
        const selectedPath = ui?.selectedPath ?? null;
        const keepSelectedPath =
          selectedPath === null ||
          status.files.some(
            (file) => file.path === selectedPath || file.originalPath === selectedPath,
          );
        selectionChanged = Boolean(ui && selectedPath && !keepSelectedPath);
        return {
          statusByRepository: { ...state.statusByRepository, [status.repositoryId]: status },
          uiByProject: selectionChanged && workspaceId && ui
            ? { ...state.uiByProject, [workspaceId]: { ...ui, selectedPath: null } }
            : state.uiByProject,
        };
      });
      if (selectionChanged) persist(get());
    },
    setRefs(snapshot) {
      let selectionChanged = false;
      set((state) => {
        const workspaceId = workspaceSelectingRepository(state, snapshot.repositoryId);
        const ui = workspaceId ? state.uiByProject[workspaceId] : null;
        const selectedRef = ui?.selectedRef ?? null;
        const selectedStillExists =
          selectedRef === null ||
          snapshot.refs.some(
            (ref) => ref.fullName === selectedRef || ref.shortName === selectedRef,
          );
        const fallbackRef = snapshot.refs.find((ref) => ref.current)?.fullName ?? null;
        selectionChanged = Boolean(ui && selectedRef && !selectedStillExists);
        return {
          refsByRepository: { ...state.refsByRepository, [snapshot.repositoryId]: snapshot.refs },
          uiByProject: selectionChanged && workspaceId && ui
            ? { ...state.uiByProject, [workspaceId]: { ...ui, selectedRef: fallbackRef } }
            : state.uiByProject,
        };
      });
      if (selectionChanged) persist(get());
    },
    setHistory(history) {
      set((state) => ({
        historyByRepository: { ...state.historyByRepository, [history.repositoryId]: history },
      }));
    },
    setDiff(diff) {
      set((state) => ({
        diffByRepository: { ...state.diffByRepository, [diff.repositoryId]: diff },
      }));
    },
    recordOperation(operation) {
      set((state) => ({
        operations: { ...state.operations, [operation.operationId]: operation },
        operationIds: state.operationIds.includes(operation.operationId)
          ? state.operationIds
          : [operation.operationId, ...state.operationIds],
      }));
    },
    invalidateRepository(repositoryId, domains) {
      const nextEpoch = (getStateEpoch(get(), repositoryId) + 1);
      set((state) => ({
        repositoryEpochs: { ...state.repositoryEpochs, [repositoryId]: nextEpoch },
        invalidatedDomainsByRepository: {
          ...state.invalidatedDomainsByRepository,
          [repositoryId]: Array.from(new Set([
            ...(state.invalidatedDomainsByRepository[repositoryId] ?? []),
            ...domains,
          ])),
        },
      }));
      return nextEpoch;
    },
    clearInvalidatedDomains(repositoryId, domains) {
      set((state) => ({
        invalidatedDomainsByRepository: {
          ...state.invalidatedDomainsByRepository,
          [repositoryId]: (state.invalidatedDomainsByRepository[repositoryId] ?? []).filter(
            (domain) => !domains.includes(domain),
          ),
        },
      }));
    },
    updateProjectUi(workspaceId, update) {
      set((state) => ({
        uiByProject: {
          ...state.uiByProject,
          [workspaceId]: { ...(state.uiByProject[workspaceId] ?? DEFAULT_UI), ...update },
        },
      }));
      persist(get());
    },
    requestToolWindowNavigation(workspaceId, intent) {
      navigationRequestSequence += 1;
      set((state) => ({
        navigationRequestsByProject: {
          ...state.navigationRequestsByProject,
          [workspaceId]: { ...intent, requestId: navigationRequestSequence },
        },
      }));
    },
    consumeToolWindowNavigation(workspaceId, requestId) {
      set((state) => {
        if (state.navigationRequestsByProject[workspaceId]?.requestId !== requestId) return state;
        const navigationRequestsByProject = { ...state.navigationRequestsByProject };
        delete navigationRequestsByProject[workspaceId];
        return { navigationRequestsByProject };
      });
    },
  }));
}

export function selectActiveGitProject(state: GitStoreState): GitProjectStoreState | null {
  return state.activeWorkspaceId ? state.projects[state.activeWorkspaceId] ?? null : null;
}

export function selectActiveGitRepository(state: GitStoreState): GitRepositoryDescriptor | null {
  const project = selectActiveGitProject(state);
  return project?.selectedRepositoryId ? state.repositories[project.selectedRepositoryId] ?? null : null;
}

export function selectSelectedGitStatus(state: GitStoreState): GitStatusSnapshot | null {
  const repository = selectActiveGitRepository(state);
  return repository ? state.statusByRepository[repository.id] ?? null : null;
}

export function selectProjectUi(state: GitStoreState, workspaceId: string): GitProjectUiState {
  return state.uiByProject[workspaceId] ?? DEFAULT_UI;
}

function emptyProject(workspaceId: string, projectRoot: string): GitProjectStoreState {
  return {
    workspaceId,
    projectRoot,
    loading: false,
    capability: null,
    repositoryIds: [],
    selectedRepositoryId: null,
    ancestorCandidateId: null,
    error: null,
  };
}

function getStateEpoch(state: GitStoreState, repositoryId: GitRepositoryId): number {
  return state.repositoryEpochs[repositoryId] ?? 0;
}

function workspaceSelectingRepository(
  state: GitStoreState,
  repositoryId: GitRepositoryId,
): string | null {
  return Object.values(state.projects).find(
    (project) => project.selectedRepositoryId === repositoryId,
  )?.workspaceId ?? null;
}

interface PersistedGitProjectUi {
  projectRoot: string;
  selectedRepositoryId: string | null;
  ui: GitProjectUiState;
}

interface PersistedGitUi {
  version: 1;
  projects: Record<string, PersistedGitProjectUi>;
}

function cloneDefaultUi(): GitProjectUiState {
  return {
    ...DEFAULT_UI,
    historyFilters: { ...DEFAULT_UI.historyFilters },
    updateStrategyByRepository: {},
  };
}

export function readPersistedGitUi(storage: GitUiStorage | null): PersistedGitUi {
  if (!storage) return { version: GIT_UI_SCHEMA_VERSION, projects: {} };
  try {
    const raw = storage.getItem(GIT_UI_STORAGE_KEY);
    if (!raw) return { version: GIT_UI_SCHEMA_VERSION, projects: {} };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const projectsRaw = parsed.projects && typeof parsed.projects === "object" ? parsed.projects as Record<string, unknown> : {};
    const projects: Record<string, PersistedGitProjectUi> = {};
    for (const [workspaceId, value] of Object.entries(projectsRaw)) {
      if (!value || typeof value !== "object") continue;
      const project = value as Record<string, unknown>;
      if (typeof project.projectRoot !== "string" || !project.projectRoot) continue;
      projects[workspaceId] = {
        projectRoot: project.projectRoot,
        selectedRepositoryId: typeof project.selectedRepositoryId === "string" ? project.selectedRepositoryId : null,
        ui: normalizePersistedUi(project.ui),
      };
    }
    return { version: GIT_UI_SCHEMA_VERSION, projects };
  } catch {
    return { version: GIT_UI_SCHEMA_VERSION, projects: {} };
  }
}

function writePersistedGitUi(storage: GitUiStorage | null, state: GitStoreState): void {
  if (!storage) return;
  const projects: PersistedGitUi["projects"] = {};
  for (const [workspaceId, project] of Object.entries(state.projects)) {
    projects[workspaceId] = {
      projectRoot: project.projectRoot,
      selectedRepositoryId: project.selectedRepositoryId,
      ui: normalizePersistedUi(state.uiByProject[workspaceId]),
    };
  }
  try {
    storage.setItem(GIT_UI_STORAGE_KEY, JSON.stringify({ version: GIT_UI_SCHEMA_VERSION, projects }));
  } catch {
    // Storage quota or policy must not make Git unusable.
  }
}

function normalizePersistedUi(value: unknown): GitProjectUiState {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const activeTab = typeof raw.activeTab === "string" && ["changes", "history", "blame", "reflog", "branches", "stash", "operations"].includes(raw.activeTab)
    ? raw.activeTab as GitToolWindowTab
    : DEFAULT_UI.activeTab;
  const filtersRaw = raw.historyFilters && typeof raw.historyFilters === "object" ? raw.historyFilters as Record<string, unknown> : {};
  const strategiesRaw = raw.updateStrategyByRepository && typeof raw.updateStrategyByRepository === "object"
    ? raw.updateStrategyByRepository as Record<string, unknown>
    : {};
  const updateStrategyByRepository = Object.fromEntries(
    Object.entries(strategiesRaw).filter((entry): entry is [string, "ff_only" | "merge" | "rebase"] =>
      entry[1] === "ff_only" || entry[1] === "merge" || entry[1] === "rebase"),
  );
  return {
    toolWindowOpen: raw.toolWindowOpen === true,
    toolWindowMaximized: raw.toolWindowMaximized !== false,
    activeTab,
    selectedRef: typeof raw.selectedRef === "string" ? raw.selectedRef.slice(0, 4096) : null,
    selectedPath: typeof raw.selectedPath === "string" ? raw.selectedPath.slice(0, 4096) : null,
    commitDraft: typeof raw.commitDraft === "string" ? raw.commitDraft.slice(0, 20_000) : "",
    historyFilters: {
      search: textFilter(filtersRaw.search),
      revision: textFilter(filtersRaw.revision),
      author: textFilter(filtersRaw.author),
      since: historyDateFilter(filtersRaw.since),
    },
    selectedHistoryObjectId: typeof raw.selectedHistoryObjectId === "string"
      ? raw.selectedHistoryObjectId.slice(0, 128)
      : null,
    navigationPanePercent: panePercent(raw.navigationPanePercent, DEFAULT_UI.navigationPanePercent, 12, 35),
    detailPanePercent: panePercent(raw.detailPanePercent, DEFAULT_UI.detailPanePercent, 18, 42),
    updateStrategyByRepository,
  };
}

function textFilter(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 4096) : "";
}

function historyDateFilter(value: unknown): string {
  return value === "24h" || value === "7d" ? value : "";
}

function panePercent(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}
