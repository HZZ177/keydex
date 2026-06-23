import { HashRouter } from "react-router-dom";
import type { PropsWithChildren } from "react";

import { PreviewProvider } from "./PreviewProvider";
import { ThemeProvider } from "./ThemeProvider";
import { AgentSessionProvider } from "./AgentSessionProvider";
import { NotificationProvider } from "./NotificationProvider";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <ThemeProvider>
      <NotificationProvider>
        <LayoutStateProvider>
          <AgentSessionProvider>
            <PreviewProvider>
              <HashRouter>{children}</HashRouter>
            </PreviewProvider>
          </AgentSessionProvider>
        </LayoutStateProvider>
      </NotificationProvider>
    </ThemeProvider>
  );
}
