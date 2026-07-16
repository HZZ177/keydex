import { FileDiff, FolderOpen, GitBranch, MessageSquare } from "lucide-react";

import styles from "./RightSidebarInitialPage.module.css";
import { rightSidebarPanelRegistry } from "./rightSidebarRegistry";

export interface RightSidebarInitialPageProps {
  canOpenFiles?: boolean;
  canOpenBtwConversation?: boolean;
  canOpenReview?: boolean;
  canOpenGit?: boolean;
  onOpenFiles?: () => void;
  onOpenBtwConversation?: () => void;
  onOpenReview?: () => void;
  onOpenGit?: () => void;
}

export function RightSidebarInitialPage({
  canOpenFiles = false,
  canOpenBtwConversation = false,
  canOpenReview = false,
  canOpenGit = false,
  onOpenFiles,
  onOpenBtwConversation,
  onOpenReview,
  onOpenGit,
}: RightSidebarInitialPageProps) {
  if (!canOpenFiles && !canOpenBtwConversation && !canOpenReview && !canOpenGit) {
    return (
      <div className={styles.root} data-testid="right-sidebar-initial-page">
        <span>暂无侧边内容</span>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="right-sidebar-initial-page">
      {canOpenBtwConversation ? (
        <button className={styles.action} type="button" onClick={onOpenBtwConversation}>
          <MessageSquare size={14} strokeWidth={1.9} />
          <span>旁路对话</span>
        </button>
      ) : null}
      {canOpenFiles ? (
        <button className={styles.action} type="button" onClick={onOpenFiles}>
          <FolderOpen size={14} strokeWidth={1.9} />
          <span>文件</span>
        </button>
      ) : null}
      {canOpenReview ? (
        <button className={styles.action} type="button" onClick={onOpenReview}>
          <FileDiff size={14} strokeWidth={1.9} />
          <span>审阅</span>
        </button>
      ) : null}
      {canOpenGit ? (
        <button className={styles.action} type="button" onClick={onOpenGit}>
          <GitBranch size={14} strokeWidth={1.9} />
          <span>{rightSidebarPanelRegistry.get("git").label}</span>
        </button>
      ) : null}
    </div>
  );
}
