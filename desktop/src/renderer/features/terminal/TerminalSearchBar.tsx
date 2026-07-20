import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";

import styles from "./TerminalSurface.module.css";

export function TerminalSearchBar({
  addon,
  open,
  onClose,
}: {
  addon: SearchAddon;
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else addon.clearDecorations();
  }, [addon, open]);
  if (!open) return null;
  const findNext = () => query && addon.findNext(query, { incremental: true, decorations: searchDecorations });
  const findPrevious = () => query && addon.findPrevious(query, { decorations: searchDecorations });
  return (
    <div className={styles.searchBar} role="search" aria-label="搜索终端输出">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          if (event.target.value) addon.findNext(event.target.value, { incremental: true, decorations: searchDecorations });
          else addon.clearDecorations();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) findPrevious();
            else findNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="搜索输出"
        aria-label="搜索终端输出"
      />
      <button type="button" onClick={findPrevious} aria-label="上一个匹配项"><ArrowUp size={14} /></button>
      <button type="button" onClick={findNext} aria-label="下一个匹配项"><ArrowDown size={14} /></button>
      <button type="button" onClick={onClose} aria-label="关闭搜索"><X size={14} /></button>
    </div>
  );
}

const searchDecorations = {
  matchBackground: "#f6c34466",
  matchBorder: "#c68b00",
  activeMatchBackground: "#f59e0b99",
  activeMatchBorder: "#92400e",
  matchOverviewRuler: "#f6c344",
  activeMatchColorOverviewRuler: "#f59e0b",
};
