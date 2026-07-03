import { Target, X } from "lucide-react";

import styles from "./GoalModeAccessory.module.css";

export interface GoalModeAccessoryProps {
  creating?: boolean;
  error?: string | null;
  onClose: () => void;
}

export function GoalModeAccessory({ creating = false, error = null, onClose }: GoalModeAccessoryProps) {
  return (
    <div className={styles.goalModeAccessory} data-testid="goal-mode-accessory">
      <span className={styles.goalModeDivider} aria-hidden="true" />
      <span className={styles.goalModePill} aria-label="目标模式已开启">
        <Target size={14} aria-hidden="true" />
        <span>目标</span>
        <button
          className={styles.goalModeClose}
          type="button"
          aria-label="关闭目标模式"
          disabled={creating}
          onClick={onClose}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </span>
      {creating ? <span className={styles.goalModeHint}>创建中</span> : null}
      {error ? (
        <span className={styles.goalModeError} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
