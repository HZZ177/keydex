import { HashRouter } from "react-router-dom";
import { useEffect, type PropsWithChildren } from "react";

import { PreviewProvider } from "./PreviewProvider";
import { ThemeProvider } from "./ThemeProvider";
import { FontProvider } from "./FontProvider";
import { AgentSessionProvider } from "./AgentSessionProvider";
import { FileChangeProvider } from "./FileChangeProvider";
import { AppContextMenuProvider } from "./AppContextMenuProvider";
import { AppUpdateController } from "./AppUpdateController";
import { NotificationProvider } from "./NotificationProvider";
import { RuntimeConnectionProvider, type RuntimeConnectionProviderProps } from "./RuntimeConnectionProvider";
import { WindowClosePreferenceController } from "./WindowClosePreferenceController";
import { APP_FIND_SHORTCUT_EVENT, isFindShortcutEvent } from "@/renderer/events/findShortcut";
import { AppTooltipLayer } from "@/renderer/components/tooltip";
import { ComposerDraftProvider } from "@/renderer/features/composer";
import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { PierreWorkerPoolHost } from "@/renderer/components/diff/engine/PierreWorkerPoolHost";
import { TerminalSessionScopeProvider } from "./TerminalSessionScopeProvider";
import { TerminalProvider } from "@/renderer/features/terminal";
import { BrowserOcclusionProvider } from "@/renderer/features/browser/runtime";
import { MandatoryCheckpointMigrationGate } from "./MandatoryCheckpointMigrationGate";

export interface AppProvidersProps extends PropsWithChildren {
  runtime?: RuntimeBridge;
  runtimeConnection?: Omit<RuntimeConnectionProviderProps, "children" | "runtime">;
}

export function AppProviders({
  children,
  runtime = runtimeBridge,
  runtimeConnection,
}: AppProvidersProps) {
  useDisableBrowserFindShortcut();

  return (
    <ThemeProvider>
      <BrowserOcclusionProvider>
        <PierreWorkerPoolHost>
        <NotificationProvider>
          <AppUpdateController>
            <AppContextMenuProvider>
              <RuntimeConnectionProvider runtime={runtime} {...runtimeConnection}>
                <WindowClosePreferenceController runtime={runtime} />
                <AppTooltipLayer scopeSelector="body" targetMode="native-interactive-title" />
                <MandatoryCheckpointMigrationGate runtime={runtime}>
                  <TerminalSessionScopeProvider>
                    <TerminalProvider>
                      <FontProvider>
                        <ComposerDraftProvider>
                          <AgentSessionProvider runtime={runtime}>
                            <FileChangeProvider>
                              <PreviewProvider>
                                <HashRouter>{children}</HashRouter>
                              </PreviewProvider>
                            </FileChangeProvider>
                          </AgentSessionProvider>
                        </ComposerDraftProvider>
                      </FontProvider>
                    </TerminalProvider>
                  </TerminalSessionScopeProvider>
                </MandatoryCheckpointMigrationGate>
              </RuntimeConnectionProvider>
            </AppContextMenuProvider>
          </AppUpdateController>
        </NotificationProvider>
        </PierreWorkerPoolHost>
      </BrowserOcclusionProvider>
    </ThemeProvider>
  );
}

function useDisableBrowserFindShortcut() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isFindShortcutEvent(event)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      document.dispatchEvent(
        new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
          detail: { sourceTarget: event.target },
        }),
      );
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
