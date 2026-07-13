import type { FileChangeEventItem } from "@/types/protocol";

export interface WorkspaceDirectoryInvalidation {
  directoriesToRefresh: string[];
  deletedDirectoryPaths: string[];
}

/**
 * Turns one watcher batch into the smallest deterministic directory refresh plan.
 * Paths are workspace-relative POSIX paths; an empty string represents the root.
 */
export function planWorkspaceDirectoryInvalidation(
  changes: readonly FileChangeEventItem[],
  loadedDirectoryPaths: Iterable<string>,
): WorkspaceDirectoryInvalidation {
  const loaded = new Set(Array.from(loadedDirectoryPaths, normalizeWorkspacePath));
  const directoriesToRefresh = new Set<string>();
  const deletedDirectoryPaths = new Set<string>();

  for (const change of changes) {
    const path = normalizeWorkspacePath(change.path);
    const parent = workspaceParentDirectory(path);
    if (loaded.has(parent)) {
      directoriesToRefresh.add(parent);
    }
    if (change.kind === "deleted" && loaded.has(path)) {
      deletedDirectoryPaths.add(path);
    }
  }

  return {
    directoriesToRefresh: sortWorkspacePaths(directoriesToRefresh),
    deletedDirectoryPaths: sortWorkspacePaths(deletedDirectoryPaths),
  };
}

export function purgeDeletedDirectoryPaths<T>(
  valuesByDirectory: Readonly<Record<string, T>>,
  deletedDirectoryPaths: readonly string[],
): Record<string, T> {
  if (!deletedDirectoryPaths.length) {
    return valuesByDirectory as Record<string, T>;
  }
  return Object.fromEntries(
    Object.entries(valuesByDirectory).filter(
      ([path]) => !deletedDirectoryPaths.some((deletedPath) => isPathAtOrBelow(path, deletedPath)),
    ),
  );
}

export function purgeDeletedPathSet(
  paths: ReadonlySet<string>,
  deletedDirectoryPaths: readonly string[],
): Set<string> {
  if (!deletedDirectoryPaths.length) {
    return paths as Set<string>;
  }
  return new Set(
    Array.from(paths).filter(
      (path) => !deletedDirectoryPaths.some((deletedPath) => isPathAtOrBelow(path, deletedPath)),
    ),
  );
}

export function workspaceParentDirectory(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

export function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isPathAtOrBelow(path: string, directoryPath: string): boolean {
  const normalizedPath = normalizeWorkspacePath(path);
  const normalizedDirectory = normalizeWorkspacePath(directoryPath);
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

function sortWorkspacePaths(paths: Iterable<string>): string[] {
  return Array.from(paths).sort((left, right) => {
    if (!left) {
      return -1;
    }
    if (!right) {
      return 1;
    }
    return left.localeCompare(right);
  });
}
