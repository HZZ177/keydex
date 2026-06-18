import { File, Folder } from "lucide-react";

import type { WorkspaceSearchResult } from "@/runtime";

import styles from "./AtFileMenu.module.css";

export interface AtFileMenuProps {
  results: WorkspaceSearchResult[];
  activeIndex: number;
  loading?: boolean;
  error?: string | null;
  query: string;
  onSelect: (result: WorkspaceSearchResult) => void;
}

export function AtFileMenu({ results, activeIndex, loading = false, error = null, query, onSelect }: AtFileMenuProps) {
  return (
    <div className={styles.menu} role="listbox" aria-label="文件引用菜单" data-testid="at-file-menu">
      {loading ? <div className={styles.empty}>正在搜索工作区</div> : null}
      {!loading && error ? <div className={styles.error}>{error}</div> : null}
      {!loading && !error && !query ? <div className={styles.empty}>继续输入文件名</div> : null}
      {!loading && !error && query && !results.length ? <div className={styles.empty}>没有匹配的文件</div> : null}
      {!loading && !error
        ? results.map((result, index) => (
            <button
              className={styles.item}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              data-active={activeIndex === index ? "true" : "false"}
              key={result.path}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(result);
              }}
            >
              <span className={styles.icon} aria-hidden="true">
                {result.type === "directory" ? <Folder size={14} /> : <File size={14} />}
              </span>
              <span className={styles.text}>
                <strong>{result.name}</strong>
                <span>{result.path}</span>
              </span>
            </button>
          ))
        : null}
    </div>
  );
}
