import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AssociatedFileOpenController } from "@/renderer/components/layout/Router";
import {
  externalFilePathFromSearch,
  initialLaunchIntent,
  launchIntentReducer,
  selectAssociatedFilePath,
} from "@/renderer/components/startup/launchIntent";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";

describe("launch intent", () => {
  it("starts resolving unless an external file query is already present", () => {
    expect(initialLaunchIntent("")).toBe("resolving");
    expect(initialLaunchIntent("?file=D%3A%2Fdocs%2Fread+me.md")).toBe("external-file");
    expect(externalFilePathFromSearch("?file=%20%20")).toBeNull();
  });

  it("keeps external-file sticky after the query has been consumed", () => {
    expect(launchIntentReducer("external-file", { type: "initial-resolution-complete" })).toBe("external-file");
    expect(launchIntentReducer("normal", { type: "external-file-detected" })).toBe("external-file");
  });

  it("settles a pathless initial resolution as normal and selects the last valid path", () => {
    expect(launchIntentReducer("resolving", { type: "initial-resolution-complete" })).toBe("normal");
    expect(selectAssociatedFilePath(["", " D:/first.md ", "  ", "D:/latest.md"])).toBe("D:/latest.md");
    expect(selectAssociatedFilePath(["", "  "])).toBeNull();
  });

  it("takes initial Tauri paths once in StrictMode and navigates to the latest valid file", async () => {
    const takePaths = vi.fn().mockResolvedValue(["", " D:/docs/first.md ", "D:/docs/latest.md"]);
    const listen = vi.fn(async () => () => undefined);
    const onExternalFileDetected = vi.fn();
    const onInitialResolutionComplete = vi.fn();

    render(
      <StrictMode>
        <ControllerHarness
          takePaths={takePaths}
          listen={listen}
          onExternalFileDetected={onExternalFileDetected}
          onInitialResolutionComplete={onInitialResolutionComplete}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId("current-location").textContent).toContain("latest.md"));
    expect(takePaths).toHaveBeenCalledTimes(1);
    expect(onExternalFileDetected).toHaveBeenCalledTimes(1);
    expect(onInitialResolutionComplete).not.toHaveBeenCalled();
  });

  it("settles normal once, then switches an active splash to the newest event path", async () => {
    const handlers: Array<() => void> = [];
    const takePaths = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["D:/docs/from-second-instance.md"]);
    const listen = vi.fn(async (handler: () => void) => {
      handlers.push(handler);
      return () => undefined;
    });
    const onExternalFileDetected = vi.fn();
    const onInitialResolutionComplete = vi.fn();

    render(
      <ControllerHarness
        takePaths={takePaths}
        listen={listen}
        onExternalFileDetected={onExternalFileDetected}
        onInitialResolutionComplete={onInitialResolutionComplete}
      />,
    );

    await waitFor(() => expect(onInitialResolutionComplete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handlers).toHaveLength(1));
    act(() => handlers[0]?.());
    await waitFor(() => expect(screen.getByTestId("current-location").textContent).toContain("from-second-instance.md"));

    expect(takePaths).toHaveBeenCalledTimes(2);
    expect(onExternalFileDetected).toHaveBeenCalledTimes(1);
  });
});

function ControllerHarness({
  takePaths,
  listen,
  onExternalFileDetected,
  onInitialResolutionComplete,
}: {
  takePaths: () => Promise<string[]>;
  listen: (handler: () => void) => Promise<() => void>;
  onExternalFileDetected: () => void;
  onInitialResolutionComplete: () => void;
}) {
  return (
    <LayoutStateProvider>
      <MemoryRouter initialEntries={["/guid"]}>
        <AssociatedFileOpenController
          takePaths={takePaths}
          listen={listen}
          onExternalFileDetected={onExternalFileDetected}
          onInitialResolutionComplete={onInitialResolutionComplete}
        />
        <LocationProbe />
      </MemoryRouter>
    </LayoutStateProvider>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="current-location">{`${location.pathname}${location.search}`}</span>;
}
