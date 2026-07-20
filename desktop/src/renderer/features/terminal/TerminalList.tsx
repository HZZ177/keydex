import { CircleStop, X } from "lucide-react";
import type { TerminalSnapshot } from "@/runtime";
import styles from "./TerminalDock.module.css";

export function TerminalList({
  terminals,
  activeTerminalId,
  closingAll,
  onSelect,
  onClose,
  onCloseAll,
}: {
  terminals: TerminalSnapshot[];
  activeTerminalId: string | null;
  closingAll: boolean;
  onSelect: (terminalId: string) => void;
  onClose: (snapshot: TerminalSnapshot) => void;
  onCloseAll: () => void;
}) {
  return (
    <aside className={styles.terminalList} aria-label="当前会话终端列表">
      <div className={styles.terminalListEntries}>
        {terminals.map((terminal) => {
          const active = terminal.terminalId === activeTerminalId;
          return (
            <div className={styles.terminalListItem} data-active={active ? "true" : "false"} key={terminal.terminalId}>
              <button className={styles.terminalListSelect} type="button" aria-current={active ? "page" : undefined}
                title={terminal.title} onClick={() => onSelect(terminal.terminalId)}>
                <span className={styles.statusDot} data-status={terminal.status} aria-hidden="true" />
                <span className={styles.terminalListText}>
                  <span className={styles.terminalTitle}>{terminal.title}</span>
                  <span className={styles.terminalMeta}>{profileLabel(terminal.profileId)} · {statusLabel(terminal)}</span>
                </span>
              </button>
              <button className={styles.listCloseButton} type="button" aria-label={`关闭终端 ${terminal.title}`}
                title={`关闭 ${terminal.title}`} onClick={() => onClose(terminal)}>
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        className={styles.closeAllButton}
        type="button"
        aria-label="全部终止并关闭当前会话终端"
        disabled={terminals.length === 0 || closingAll}
        onClick={onCloseAll}
      >
        <CircleStop size={13} aria-hidden="true" />
        <span>{closingAll ? "正在关闭…" : "全部终止并关闭"}</span>
      </button>
    </aside>
  );
}

export function statusLabel(terminal: TerminalSnapshot): string {
  switch (terminal.status) {
    case "starting": return "启动中";
    case "running": return "运行中";
    case "closing": return "关闭中";
    case "failed": return "失败";
    case "exited": return terminal.exitCode == null ? "已退出" : `已退出 (${terminal.exitCode})`;
  }
}

function profileLabel(profileId: string): string {
  if (profileId === "git-bash") return "Git Bash";
  if (profileId === "powershell") return "PowerShell";
  if (profileId === "cmd") return "CMD";
  return profileId;
}
