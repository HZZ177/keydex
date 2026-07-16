import { GitBranch } from "lucide-react";

import type { GitRepositoryDescriptor, GitRepositoryId, GitStatusSnapshot } from "@/runtime/gitTypes";

import styles from "./GitRepositoryList.module.css";

export interface GitRepositoryListItem {
  repository: GitRepositoryDescriptor;
  status: GitStatusSnapshot | null;
}

export function GitRepositoryList({ items, selectedRepositoryId, onSelect }: {
  items: readonly GitRepositoryListItem[];
  selectedRepositoryId: GitRepositoryId | null;
  onSelect: (repositoryId: GitRepositoryId) => void;
}) {
  const totals = items.reduce((summary, item) => ({
    changes: summary.changes + (item.status?.files.length ?? 0),
    ahead: summary.ahead + (item.status?.branch.ahead ?? 0),
    behind: summary.behind + (item.status?.branch.behind ?? 0),
  }), { changes: 0, ahead: 0, behind: 0 });
  return (
    <div className={styles.root}>
      <div className={styles.summary} aria-label="全部 Git 仓库摘要">
        <strong>全部仓库</strong>
        <small>{items.length} 个根目录 · {totals.changes} 个改动 · ↑{totals.ahead} ↓{totals.behind}</small>
      </div>
      <div className={styles.list} role="listbox" aria-label="Git 仓库根目录">
        {items.map(({ repository, status }) => (
          <button
            key={repository.id}
            type="button"
            role="option"
            aria-selected={repository.id === selectedRepositoryId}
            data-active={repository.id === selectedRepositoryId ? "true" : "false"}
            style={{ paddingInlineStart: `${8 + repositoryDepth(repository, items) * 13}px` }}
            onClick={() => onSelect(repository.id)}
          >
            <GitBranch size={13} />
            <span>
              <strong>{repository.displayPath}</strong>
              <small>{repositoryKindLabel(repository.kind)} · {status?.branch.head ?? (status?.branch.detachedAt ? "分离指针" : "加载中")}</small>
            </span>
            <em>{status?.files.length ?? 0}</em>
          </button>
        ))}
      </div>
    </div>
  );
}

function repositoryKindLabel(kind: GitRepositoryDescriptor["kind"]): string {
  return ({ workspace: "工作区", nested: "嵌套仓库", worktree: "工作树", ancestor: "上级仓库", submodule: "子模块" })[kind];
}

function repositoryDepth(repository: GitRepositoryDescriptor, items: readonly GitRepositoryListItem[]): number {
  const byId = new Map(items.map((item) => [item.repository.id, item.repository]));
  const seen = new Set<GitRepositoryId>();
  let parentId = repository.parentRepoId;
  let depth = 0;
  while (parentId && !seen.has(parentId) && depth < 8) {
    seen.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentRepoId ?? null;
  }
  return depth;
}
