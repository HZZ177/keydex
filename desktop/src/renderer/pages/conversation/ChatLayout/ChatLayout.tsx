import { Check, Copy, Files, MoreHorizontal, PanelRightOpen, SendHorizontal, X } from "lucide-react";
import { type PropsWithChildren, type ReactNode, useEffect, useRef, useState } from "react";

import styles from "./ChatLayout.module.css";

export interface ChatLayoutProps extends PropsWithChildren {
  title: string;
  subtitle?: string;
  composer?: ReactNode;
  composerAccessory?: ReactNode;
  workspacePanel?: ReactNode;
  previewPanel?: ReactNode;
}

export function ChatLayout({
  title,
  subtitle,
  children,
  composer,
  composerAccessory,
  workspacePanel,
  previewPanel,
}: ChatLayoutProps) {
  const layoutRef = useRef<HTMLElement>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [titleCopied, setTitleCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasWorkspacePanel = hasRenderableNode(workspacePanel);
  const hasPreviewPanel = hasRenderableNode(previewPanel);

  useEffect(() => {
    if (hasPreviewPanel) {
      setPreviewOpen(true);
    } else {
      setPreviewOpen(false);
    }
  }, [hasPreviewPanel]);

  useEffect(() => {
    if (!hasWorkspacePanel) {
      setWorkspaceOpen(false);
    }
  }, [hasWorkspacePanel]);

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

  const workspaceVisible = hasWorkspacePanel && workspaceOpen;
  const previewVisible = hasPreviewPanel && previewOpen;
  const sideOpen = workspaceVisible || previewVisible;
  const splitPanels = workspaceVisible && previewVisible;

  const copyTitle = async () => {
    try {
      await navigator.clipboard?.writeText(title);
      setTitleCopied(true);
      window.setTimeout(() => setTitleCopied(false), 1200);
    } catch {
      setTitleCopied(false);
    }
  };

  return (
    <main ref={layoutRef} className={styles.chatLayout} data-side={sideOpen ? "open" : "closed"} data-testid="chat-layout">
      <div className={styles.topBar}>
        <div className={styles.topBarInner}>
          <div className={styles.titleMenuAnchor} ref={menuRef}>
            <h1 className={styles.title}>{title}</h1>
            <button
              className={styles.moreButton}
              type="button"
              aria-label="更多对话操作"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={16} />
            </button>

            {menuOpen ? (
              <div className={styles.menu} role="menu" aria-label="对话操作菜单">
                {subtitle ? <div className={styles.menuStatus}>{subtitle}</div> : null}
                {subtitle ? <div className={styles.menuDivider} /> : null}
                {hasWorkspacePanel ? (
                  <button
                    className={styles.menuItem}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setWorkspaceOpen((open) => !open);
                      setMenuOpen(false);
                    }}
                  >
                    <Files size={15} />
                    <span>{workspaceOpen ? "关闭工作区" : "打开工作区"}</span>
                  </button>
                ) : null}
                {hasPreviewPanel ? (
                  <button
                    className={styles.menuItem}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPreviewOpen((open) => !open);
                      setMenuOpen(false);
                    }}
                  >
                    <PanelRightOpen size={15} />
                    <span>{previewOpen ? "关闭预览" : "打开预览"}</span>
                  </button>
                ) : null}
                <button className={styles.menuItem} type="button" role="menuitem" onClick={() => void copyTitle()}>
                  {titleCopied ? <Check size={15} /> : <Copy size={15} />}
                  <span>{titleCopied ? "已复制标题" : "复制标题"}</span>
                </button>
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

      {sideOpen ? (
        <aside className={styles.sideRail} aria-label="右侧面板">
          {workspaceVisible ? (
            <section className={styles.sidePanel} data-density={splitPanels ? "split" : "full"} role="complementary" aria-label="工作区">
              <div className={styles.drawerHeader}>
                <h2>工作区</h2>
                <button
                  className={styles.iconButton}
                  type="button"
                  aria-label="关闭工作区"
                  onClick={() => setWorkspaceOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <div className={styles.sidePanelBody}>
                {workspacePanel}
              </div>
            </section>
          ) : null}

          {previewVisible ? (
            <section className={styles.sidePanel} data-density={splitPanels ? "split" : "full"} role="complementary" aria-label="预览">
              <div className={styles.drawerHeader}>
                <h2>预览</h2>
                <button
                  className={styles.iconButton}
                  type="button"
                  aria-label="关闭预览"
                  onClick={() => setPreviewOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <div className={styles.sidePanelBody}>
                {previewPanel}
              </div>
            </section>
          ) : null}
        </aside>
      ) : null}

      <div className={styles.composerDock} data-testid="conversation-composer">
        {composerAccessory ? <div className={styles.composerAccessory}>{composerAccessory}</div> : null}
        {composer ?? <ReadOnlyComposer />}
      </div>
    </main>
  );
}

function hasRenderableNode(node: ReactNode): boolean {
  return node !== null && node !== undefined && node !== false;
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
