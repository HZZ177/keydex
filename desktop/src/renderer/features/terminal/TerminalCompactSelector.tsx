import { X } from "lucide-react";
import type { TerminalSnapshot } from "@/runtime";
import { statusLabel } from "./TerminalList";
import { TerminalSelect } from "./TerminalSelect";
import styles from "./TerminalDock.module.css";

export function TerminalCompactSelector({ terminals, activeTerminalId, onSelect, onClose }: {
  terminals: TerminalSnapshot[];
  activeTerminalId: string | null;
  onSelect: (terminalId: string) => void;
  onClose: (snapshot: TerminalSnapshot) => void;
}) {
  const active = terminals.find((terminal) => terminal.terminalId === activeTerminalId) ?? terminals[0] ?? null;
  return (
    <div className={styles.compactSelector}>
      <span className={styles.statusDot} data-status={active?.status ?? "exited"} aria-hidden="true" />
      <TerminalSelect
        ariaLabel="选择当前终端"
        disabled={terminals.length === 0}
        options={terminals.map((terminal) => ({
          label: `${terminal.title} · ${statusLabel(terminal)}`,
          value: terminal.terminalId,
        }))}
        placeholder="没有终端"
        value={active?.terminalId ?? null}
        variant="terminal"
        onChange={onSelect}
      />
      <button type="button" aria-label={active ? `关闭终端 ${active.title}` : "关闭终端"}
        title="关闭当前终端" disabled={!active} onClick={() => active && onClose(active)}>
        <X size={14} />
      </button>
    </div>
  );
}
