import type { ReactNode } from "react";

import styles from "./RightSidebarInitialPage.module.css";

export interface RightSidebarInitialPageProps {
  actions: readonly RightSidebarInitialPageAction[];
  emptyText?: string;
}

export interface RightSidebarInitialPageAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  onSelect(): void;
}

export function RightSidebarInitialPage({
  actions,
  emptyText = "暂无侧边内容",
}: RightSidebarInitialPageProps) {
  if (actions.length === 0) {
    return (
      <div className={styles.root} data-testid="right-sidebar-initial-page">
        <span>{emptyText}</span>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="right-sidebar-initial-page">
      {actions.map((action) => (
        <button className={styles.action} type="button" key={action.id} onClick={action.onSelect}>
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}
