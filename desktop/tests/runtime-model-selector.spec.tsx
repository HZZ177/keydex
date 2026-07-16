import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RuntimeModelSelector } from "@/renderer/components/model";
import type { RuntimeModelOption } from "@/renderer/components/model";

describe("RuntimeModelSelector", () => {
  it("focuses the search field when the menu opens and reopens", async () => {
    render(
      <RuntimeModelSelector
        model={{ providerId: "provider-a", model: "qwen-coder" }}
        modelOptions={modelOptions()}
        modelLoadState="ready"
        modelError={null}
        onModelChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "选择模型" });
    fireEvent.click(trigger);
    const search = screen.getByLabelText("筛选模型");

    await waitFor(() => {
      expect(document.activeElement).toBe(search);
    });

    fireEvent.click(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);

    await waitFor(() => {
      expect(document.activeElement).toBe(search);
    });
  });

  it("moves focus back to the trigger before hiding the closing menu", async () => {
    render(
      <RuntimeModelSelector
        model={{ providerId: "provider-a", model: "qwen-coder" }}
        modelOptions={modelOptions()}
        modelLoadState="ready"
        modelError={null}
        onModelChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "选择模型" });
    fireEvent.click(trigger);
    const search = screen.getByLabelText("筛选模型");

    await waitFor(() => {
      expect(document.activeElement).toBe(search);
    });

    fireEvent.keyDown(search, { key: "Escape" });

    const closingMenu = document.querySelector<HTMLElement>('[data-floating-layer="true"]');
    expect(document.activeElement).toBe(trigger);
    expect(closingMenu?.getAttribute("aria-hidden")).toBe("true");
    expect(closingMenu?.hasAttribute("inert")).toBe(true);
  });

  it("selects models with arrow keys from the search field", async () => {
    const onModelChange = vi.fn();

    render(
      <RuntimeModelSelector
        model={{ providerId: "provider-a", model: "qwen-coder" }}
        modelOptions={modelOptions()}
        modelLoadState="ready"
        modelError={null}
        onModelChange={onModelChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    const search = screen.getByLabelText("筛选模型");

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "qwen-coder" }).getAttribute("data-active")).toBe("true");
    });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "deepseek-coder" }).getAttribute("data-active")).toBe("true");

    fireEvent.keyDown(search, { key: "Enter" });

    expect(onModelChange).toHaveBeenCalledWith({ providerId: "provider-a", model: "deepseek-coder" });
    expect(screen.queryByRole("listbox", { name: "模型" })).toBeNull();
  });

  it("wraps model keyboard navigation across provider headers", async () => {
    const onModelChange = vi.fn();

    render(
      <RuntimeModelSelector
        model={{ providerId: "provider-a", model: "qwen-coder" }}
        modelOptions={modelOptions()}
        modelLoadState="ready"
        modelError={null}
        onModelChange={onModelChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    const search = screen.getByLabelText("筛选模型");

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "qwen-coder" }).getAttribute("data-active")).toBe("true");
    });

    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: "kimi-k2" }).getAttribute("data-active")).toBe("true");

    fireEvent.keyDown(search, { key: "Enter" });

    expect(onModelChange).toHaveBeenCalledWith({ providerId: "provider-b", model: "kimi-k2" });
  });

  it("filters across providers and models in a flat grouped list", async () => {
    const onModelChange = vi.fn();

    render(
      <RuntimeModelSelector
        model={{ providerId: "provider-a", model: "qwen-coder" }}
        modelOptions={modelOptions()}
        modelLoadState="ready"
        modelError={null}
        onModelChange={onModelChange}
      />,
    );

    expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("qwen-coder");
    expect(screen.getByRole("button", { name: "选择模型" }).textContent).not.toContain("供应商 A");

    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    fireEvent.change(screen.getByLabelText("筛选模型"), { target: { value: "供应商 B" } });

    expect(screen.getByText("供应商 B")).not.toBeNull();
    expect(screen.getByRole("option", { name: "kimi-k2" })).not.toBeNull();
    expect(screen.queryByText("供应商 A")).toBeNull();
    expect(screen.queryByRole("option", { name: "qwen-coder" })).toBeNull();
  });
});

function modelOptions(): RuntimeModelOption[] {
  return [
    { providerId: "provider-a", providerName: "供应商 A", model: "qwen-coder" },
    { providerId: "provider-a", providerName: "供应商 A", model: "deepseek-coder" },
    { providerId: "provider-b", providerName: "供应商 B", model: "kimi-k2" },
  ];
}
