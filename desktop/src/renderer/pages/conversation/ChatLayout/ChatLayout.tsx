import { FolderOpen, GitBranch, MoreHorizontal, SendHorizontal } from "lucide-react";
import { type PropsWithChildren, type ReactNode, useEffect, useRef, useState } from "react";

import {
  SessionActionMenuItems,
  type SessionActionMenuItemsProps,
} from "@/renderer/components/session/SessionActionMenuItems";
import { AppTooltipLayer } from "@/renderer/components/tooltip";

import styles from "./ChatLayout.module.css";

export interface ChatLayoutProps extends PropsWithChildren {
  title: string;
  workspaceLabel?: string;
  workspaceTitle?: string;
  sourceSessionAction?: {
    title?: string;
    onClick: () => void;
  };
  sessionActions?: Omit<SessionActionMenuItemsProps, "itemClassName" | "iconSize">;
  composer?: ReactNode;
  composerAccessory?: ReactNode;
}

export function ChatLayout({
  title,
  workspaceLabel,
  workspaceTitle,
  sourceSessionAction,
  sessionActions,
  children,
  composer,
  composerAccessory,
}: ChatLayoutProps) {
  const layoutRef = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasMenuActions = Boolean(sourceSessionAction || sessionActions);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const openSourceSession = () => {
    setMenuOpen(false);
    sourceSessionAction?.onClick();
  };

  const runSessionAction = (action?: () => void) => {
    setMenuOpen(false);
    action?.();
  };

  return (
    <main ref={layoutRef} className={styles.chatLayout} data-conversation-tooltips="true" data-testid="chat-layout">
      <AppTooltipLayer scopeSelector="[data-conversation-tooltips='true']" defaultPlacement="top" />
      <div className={styles.topBar}>
        <div className={styles.topBarInner}>
          <div className={styles.titleMenuAnchor} ref={menuRef}>
            {workspaceLabel ? (
              <div
                className={styles.workspaceMeta}
                title={workspaceTitle || workspaceLabel}
                aria-label={`当前工作区：${workspaceLabel}`}
                data-testid="chat-workspace-meta"
              >
                <FolderOpen size={14} aria-hidden="true" />
                <span className={styles.workspaceMetaLabel}>工作区</span>
                <span className={styles.workspaceMetaName}>{workspaceLabel}</span>
              </div>
            ) : null}
            <h1 className={styles.title}>{title}</h1>
            {hasMenuActions ? (
              <button
                className={styles.moreButton}
                type="button"
                aria-label="更多对话操作"
                data-tooltip-label="更多操作"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((open) => !open)}
              >
                <MoreHorizontal size={16} />
              </button>
            ) : null}

            {menuOpen && hasMenuActions ? (
              <div className={styles.menu} role="menu" aria-label="对话操作菜单">
                {sourceSessionAction ? (
                  <button
                    className={styles.menuItem}
                    type="button"
                    role="menuitem"
                    title={sourceSessionAction.title}
                    onClick={openSourceSession}
                  >
                    <GitBranch size={15} />
                    <span>查看源会话</span>
                  </button>
                ) : null}
                {sessionActions ? (
                  <SessionActionMenuItems
                    {...sessionActions}
                    itemClassName={styles.menuItem}
                    iconSize={15}
                    onExport={() => runSessionAction(sessionActions.onExport)}
                    onFork={() => runSessionAction(sessionActions.onFork)}
                    onRename={() => runSessionAction(sessionActions.onRename)}
                    onDelete={() => runSessionAction(sessionActions.onDelete)}
                    onRefresh={() => runSessionAction(sessionActions.onRefresh)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <section className={styles.document} data-testid="chat-reading-column" aria-label="对话内容">
        <div className={styles.messageSurface} data-testid="message-surface">
          {children}
        </div>
      </section>

      <div className={styles.composerDock} data-testid="conversation-composer">
        {composerAccessory ? <div className={styles.composerAccessory}>{composerAccessory}</div> : null}
        {composer ?? <ReadOnlyComposer />}
      </div>
    </main>
  );
}

function ReadOnlyComposer() {
  return (
    <form className={styles.composer} aria-label="继续对话输入">
      <textarea
        className={styles.input}
        aria-label="继续输入"
        placeholder="要求后续变更"
        rows={1}
        disabled
      />
      <div className={styles.composerToolbar}>
        <span>发送能力将在后续 issue 接入</span>
        <button className={styles.sendButton} type="submit" aria-label="发送" disabled>
          <SendHorizontal size={17} />
        </button>
      </div>
    </form>
  );
}
