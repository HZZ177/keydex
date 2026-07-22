import {
  Component,
  type ErrorInfo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { RotateCcw, X } from "lucide-react";

import { RightSidebarInitialPage } from "../RightSidebarInitialPage";
import layoutStyles from "../Layout.module.css";
import { rightSidebarDefinitionRegistry } from "../rightSidebarRegistry";
import { RightSidebarPanelIconGlyph } from "./icons";
import type { RightSidebarPanelState } from "./types";
import type {
  ConversationPanelHostContext,
  FilesPanelHostContext,
  ReviewPanelHostContext,
} from "./types";

export function RightSidebarRegisteredTab({
  active,
  menuOpen,
  panel,
  onActivate,
  onClose,
  onContextMenu,
}: {
  active: boolean;
  menuOpen: boolean;
  panel: RightSidebarPanelState;
  onActivate(): void;
  onClose(): void;
  onContextMenu(event: ReactMouseEvent<HTMLElement>): void;
}) {
  const presentation = rightSidebarDefinitionRegistry.getPresentation(panel);
  const capabilities = rightSidebarDefinitionRegistry.getCapabilities(panel);
  return (
    <div
      className={layoutStyles.rightSidebarTab}
      data-active={active ? "true" : "false"}
      data-app-context-menu="local"
      data-menu-open={menuOpen ? "true" : undefined}
      data-panel-badge={presentation.badge}
      data-panel-kind={panel.kind}
      onContextMenu={onContextMenu}
    >
      <button
        className={layoutStyles.rightSidebarTabMain}
        type="button"
        role="tab"
        aria-selected={active}
        data-tooltip-label={presentation.title}
        onClick={onActivate}
      >
        {presentation.icon ? <RightSidebarPanelIconGlyph icon={presentation.icon} /> : null}
        <span>{presentation.title}</span>
      </button>
      {capabilities.closable ? (
        <button
          className={layoutStyles.rightSidebarTabClose}
          type="button"
          aria-label={`关闭侧边栏窗口 ${presentation.title}`}
          data-tooltip-label={`关闭 ${presentation.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}

export function RightSidebarRegisteredPanelHost({
  activePanelId,
  conversationHostContext,
  browserHostContext,
  filesHostContext,
  panelOrder,
  panels,
  reviewHostContext,
  scopeKey,
  onUpdatePanel,
}: {
  readonly activePanelId: string | null;
  readonly conversationHostContext: ConversationPanelHostContext;
  readonly browserHostContext: import("./types").BrowserPanelHostContext;
  readonly filesHostContext: FilesPanelHostContext | null;
  readonly panelOrder: readonly string[];
  readonly panels: Record<string, RightSidebarPanelState>;
  readonly reviewHostContext: ReviewPanelHostContext;
  readonly scopeKey: string;
  onUpdatePanel(panel: RightSidebarPanelState): void;
}) {
  const orderedPanels = panelOrder.flatMap((panelId) => {
    const panel = panels[panelId];
    return panel ? [panel] : [];
  });
  const conversationPanels = orderedPanels.filter((panel) => panel.kind === "conversation");
  const browserPanels = orderedPanels.filter((panel) => panel.kind === "browser");
  const activePanel = activePanelId ? panels[activePanelId] ?? null : null;
  return (
    <>
      {conversationPanels.map((panel) => (
        <RightSidebarPanelErrorBoundary
          active={activePanelId === panel.id}
          key={panel.id}
          panelId={panel.id}
        >
          {rightSidebarDefinitionRegistry.get("conversation").render({
            active: activePanelId === panel.id,
            scopeKey,
            state: panel,
            hostContext: conversationHostContext,
            updateState: onUpdatePanel,
          })}
        </RightSidebarPanelErrorBoundary>
      ))}
      {activePanel?.kind === "files" && filesHostContext ? (
        <RightSidebarPanelErrorBoundary panelId={activePanel.id}>
          {rightSidebarDefinitionRegistry.get("files").render({
            active: true,
            scopeKey,
            state: activePanel,
            hostContext: filesHostContext,
            updateState: onUpdatePanel,
          })}
        </RightSidebarPanelErrorBoundary>
      ) : null}
      {activePanel?.kind === "review" ? (
        <RightSidebarPanelErrorBoundary panelId={activePanel.id}>
          {rightSidebarDefinitionRegistry.get("review").render({
            active: true,
            scopeKey,
            state: activePanel,
            hostContext: reviewHostContext,
            updateState: onUpdatePanel,
          })}
        </RightSidebarPanelErrorBoundary>
      ) : null}
      {browserPanels.map((panel) => (
        <RightSidebarPanelErrorBoundary
          active={activePanelId === panel.id}
          key={panel.id}
          panelId={panel.id}
        >
          {rightSidebarDefinitionRegistry.get("browser").render({
            active: activePanelId === panel.id,
            scopeKey,
            state: panel,
            hostContext: browserHostContext,
            updateState: onUpdatePanel,
          })}
        </RightSidebarPanelErrorBoundary>
      ))}
    </>
  );
}

interface RightSidebarPanelErrorBoundaryProps {
  readonly active?: boolean;
  readonly panelId: string;
  readonly children: ReactNode;
}

interface RightSidebarPanelErrorBoundaryState {
  readonly error: Error | null;
}

export class RightSidebarPanelErrorBoundary extends Component<
  RightSidebarPanelErrorBoundaryProps,
  RightSidebarPanelErrorBoundaryState
> {
  state: RightSidebarPanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RightSidebarPanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Right sidebar panel render failed", {
      panelId: this.props.panelId,
      error,
      componentStack: info.componentStack,
    });
  }

  componentDidUpdate(previousProps: RightSidebarPanelErrorBoundaryProps) {
    if (previousProps.panelId !== this.props.panelId && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className={layoutStyles.rightSidebarBody}
        data-content="error"
        hidden={this.props.active === false}
        role="alert"
      >
        <RightSidebarInitialPage
          emptyText="面板加载失败"
          actions={[{
            id: "retry",
            label: "重试",
            icon: <RotateCcw size={14} strokeWidth={1.9} />,
            onSelect: () => this.setState({ error: null }),
          }]}
        />
      </div>
    );
  }
}
