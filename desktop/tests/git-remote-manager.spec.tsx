import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitRemoteManager } from "@/renderer/features/git/components/GitRemoteManager";

afterEach(cleanup);

describe("GitRemoteManager", () => {
  it("adds remotes with separate fetch/push URLs", () => {
    const onAdd = vi.fn();
    renderManager({ onAdd });
    fireEvent.change(screen.getByRole("textbox", { name: /^Remote name$/ }), { target: { value: "upstream" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^Fetch URL$/ }), { target: { value: "D:/fetch.git" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^Push URL$/ }), { target: { value: "D:/push.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).toHaveBeenCalledWith("upstream", "D:/fetch.git", "D:/push.git");
  });

  it("previews tracking impact and exposes rename/url/remove actions", () => {
    const onRename = vi.fn();
    const onSetUrl = vi.fn();
    const onRemove = vi.fn();
    renderManager({ onRename, onSetUrl, onRemove });
    expect(screen.getByText(/affects upstream for: main, release/)).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Rename remote"), { target: { value: "upstream" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledWith("origin", "upstream");
    fireEvent.change(screen.getByLabelText("Edit push URL"), { target: { value: "D:/new-push.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Save push URL" }));
    expect(onSetUrl).toHaveBeenCalledWith("origin", "D:/new-push.git", true);
    fireEvent.click(screen.getByRole("button", { name: "Remove remote…" }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ name: "origin" }));
  });
});

function renderManager(overrides: Record<string, ReturnType<typeof vi.fn>>) {
  return render(
    <GitRemoteManager
      remotes={[{
        name: "origin",
        fetchUrl: "D:/fetch.git",
        pushUrl: "D:/push.git",
        trackingBranches: ["main", "release"],
      }]}
      onAdd={overrides.onAdd ?? vi.fn()}
      onRename={overrides.onRename ?? vi.fn()}
      onSetUrl={overrides.onSetUrl ?? vi.fn()}
      onRemove={overrides.onRemove ?? vi.fn()}
    />,
  );
}
