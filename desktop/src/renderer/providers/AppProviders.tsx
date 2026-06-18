import { HashRouter } from "react-router-dom";
import type { PropsWithChildren } from "react";

import { PreviewProvider } from "./PreviewProvider";
import { ThemeProvider } from "./ThemeProvider";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <ThemeProvider>
      <LayoutStateProvider>
        <PreviewProvider>
          <HashRouter>{children}</HashRouter>
        </PreviewProvider>
      </LayoutStateProvider>
    </ThemeProvider>
  );
}
