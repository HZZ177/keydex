import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "@/App";
import { AppProviders } from "@/renderer/providers/AppProviders";

describe("React root", () => {
  it("renders the app through the provider tree", () => {
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    );

    expect(screen.getByTestId("home-page")).not.toBeNull();
    expect(screen.getByLabelText("输入需求")).not.toBeNull();
  });
});
