import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "@/App";
import { AppProviders } from "@/renderer/providers/AppProviders";

describe("React root", () => {
  it("renders the app shell through the provider tree before runtime startup completes", async () => {
    const starter = vi.fn(() => new Promise<never>(() => undefined));

    render(
      <AppProviders runtimeConnection={{ starter }}>
        <App />
      </AppProviders>,
    );

    expect(await screen.findByTestId("home-page")).not.toBeNull();
    expect(screen.getByLabelText("输入需求")).not.toBeNull();
    expect(screen.queryByTestId("connection-status")).toBeNull();
    expect(starter).toHaveBeenCalledTimes(1);
  });
});
