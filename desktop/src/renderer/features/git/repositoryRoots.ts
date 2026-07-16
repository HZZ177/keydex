import type { GitRepositoryRoot } from "./activeProject";

function portablePath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function containsPath(rootPath: string, candidatePath: string): boolean {
  const root = portablePath(rootPath);
  const candidate = portablePath(candidatePath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

function pathDepth(path: string): number {
  return portablePath(path).split("/").filter(Boolean).length;
}

export function createGitRepositoryIdentity(rootPath: string, gitDirPath = `${rootPath}/.git`): string {
  const source = `${portablePath(rootPath)}\u0000${portablePath(gitDirPath)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `git-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function organizeGitRepositoryRoots(
  projectPath: string,
  roots: readonly GitRepositoryRoot[],
): GitRepositoryRoot[] {
  const unique = new Map<string, GitRepositoryRoot>();
  for (const root of roots) {
    const pathKey = portablePath(root.rootPath);
    if (unique.has(pathKey)) throw new Error(`Duplicate Git repository root: ${root.rootPath}`);
    unique.set(pathKey, { ...root, parentRepoId: undefined });
  }

  const organized = [...unique.values()]
    .map((root, _index, all) => {
      const parent = all
        .filter(
          (candidate) =>
            candidate.id !== root.id &&
            containsPath(candidate.rootPath, root.rootPath) &&
            portablePath(candidate.rootPath) !== portablePath(root.rootPath),
        )
        .sort((left, right) => pathDepth(right.rootPath) - pathDepth(left.rootPath))[0];
      const atProjectRoot = portablePath(root.rootPath) === portablePath(projectPath);
      return {
        ...root,
        kind: root.kind === "ancestor" || root.kind === "worktree" || root.kind === "submodule"
          ? root.kind
          : atProjectRoot
            ? "workspace"
            : "nested",
        parentRepoId: parent?.id,
      } satisfies GitRepositoryRoot;
    })
    .sort((left, right) => {
      const leftRank = left.kind === "workspace" ? 0 : left.kind === "ancestor" ? 2 : 1;
      const rightRank = right.kind === "workspace" ? 0 : right.kind === "ancestor" ? 2 : 1;
      return leftRank - rightRank || portablePath(left.rootPath).localeCompare(portablePath(right.rootPath));
    });

  return organized;
}

export function repositoryOwningPath(
  roots: readonly GitRepositoryRoot[],
  filePath: string,
): GitRepositoryRoot | null {
  return (
    roots
      .filter((root) => containsPath(root.rootPath, filePath))
      .sort((left, right) => pathDepth(right.rootPath) - pathDepth(left.rootPath))[0] ?? null
  );
}
