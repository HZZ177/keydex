import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef } from "react";

import styles from "./BrowserPanel.module.css";

export function BrowserFindBar({
  matchCase,
  query,
  onClose,
  onMatchCaseChange,
  onQueryChange,
  onSearch,
}: {
  readonly matchCase: boolean;
  readonly query: string;
  onClose(): void;
  onMatchCaseChange(value: boolean): void;
  onQueryChange(value: string): void;
  onSearch(backwards: boolean): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className={styles.findBar} role="search" aria-label="页内查找">
      <input
        ref={inputRef}
        aria-label="查找内容"
        autoComplete="off"
        className={styles.findInput}
        maxLength={16_384}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSearch(event.shiftKey);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="在页面中查找"
        spellCheck={false}
        value={query}
      />
      <button
        aria-label="区分大小写"
        aria-pressed={matchCase}
        className={styles.findCaseButton}
        data-active={matchCase ? "true" : undefined}
        onClick={() => onMatchCaseChange(!matchCase)}
        type="button"
      >
        <CaseSensitive size={15} />
      </button>
      <button aria-label="上一个匹配项" className={styles.toolbarButton} disabled={!query} onClick={() => onSearch(true)} type="button">
        <ChevronUp size={15} />
      </button>
      <button aria-label="下一个匹配项" className={styles.toolbarButton} disabled={!query} onClick={() => onSearch(false)} type="button">
        <ChevronDown size={15} />
      </button>
      <button aria-label="关闭页内查找" className={styles.toolbarButton} onClick={onClose} type="button">
        <X size={15} />
      </button>
    </div>
  );
}
