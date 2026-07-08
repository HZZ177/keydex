import styles from "./A2UIDebugPanel.module.css";

export interface A2UIDebugInfoButtonProps {
  expanded: boolean;
  onClick: () => void;
}

export function A2UIDebugInfoButton({ expanded, onClick }: A2UIDebugInfoButtonProps) {
  return (
    <button
      className={styles.debugButton}
      type="button"
      aria-expanded={expanded}
      aria-haspopup="dialog"
      aria-label={expanded ? "隐藏 A2UI 调试信息" : "查看 A2UI 调试信息"}
      title={expanded ? "隐藏 A2UI 调试信息" : "查看 A2UI 调试信息"}
      onClick={onClick}
    >
      <span className={styles.debugMark} aria-hidden="true">
        !
      </span>
    </button>
  );
}
