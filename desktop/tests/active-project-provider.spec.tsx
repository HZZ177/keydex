import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { type ActiveProjectDiscovery } from "@/renderer/features/git/activeProject";
import {
  ActiveProjectProvider,
  createActiveProjectSelectionStorage,
  useActiveProjectSelector,
  useActiveProjectState,
  useSelectActiveGitRepository,
} from "@/renderer/providers/ActiveProjectProvider";

const discovery = (workspaceId: string, roots = ["a", "b"]): ActiveProjectDiscovery => ({
  project: { workspaceId, projectPath: `D:/work/${workspaceId}`, name: workspaceId },
  repoRoots: roots.map((id) => ({
    id,
    rootPath: `D:/work/${workspaceId}/${id}`,
    displayPath: id,
    kind: "nested" as const,
  })),
});

function Consumer() {
  const state = useActiveProjectState();
  const selectRepo = useSelectActiveGitRepository();
  return (
    <>
      <output data-testid="state">{`${state.status}:${state.selectedRepoId}`}</output>
      <button onClick={() => selectRepo("b")}>select b</button>
    </>
  );
}

function StatusRenderCounter() {
  const status = useActiveProjectSelector((state) => state.status);
  const renders = useRef(0);
  renders.current += 1;
  return <output data-testid="renders">{`${status}:${renders.current}`}</output>;
}

describe("ActiveProjectProvider", () => {
  it("shares selection and restores it by project without leaking to another project", () => {
    const storage = createActiveProjectSelectionStorage();
    const view = render(
      <ActiveProjectProvider discovery={discovery("workspace-a")} selectionStorage={storage}>
        <Consumer />
      </ActiveProjectProvider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("multi_repo:a");
    act(() => screen.getByText("select b").click());
    expect(screen.getByTestId("state").textContent).toBe("multi_repo:b");

    view.rerender(
      <ActiveProjectProvider discovery={discovery("workspace-b")} selectionStorage={storage}>
        <Consumer />
      </ActiveProjectProvider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("multi_repo:a");

    view.rerender(
      <ActiveProjectProvider discovery={discovery("workspace-a")} selectionStorage={storage}>
        <Consumer />
      </ActiveProjectProvider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("multi_repo:b");
  });

  it("keeps scalar selector consumers stable when only the selected repo changes", () => {
    render(
      <ActiveProjectProvider discovery={discovery("workspace-a")}>
        <StatusRenderCounter />
        <Consumer />
      </ActiveProjectProvider>,
    );
    const before = screen.getByTestId("renders").textContent;
    act(() => screen.getByText("select b").click());
    expect(screen.getByTestId("renders").textContent).toBe(before);
    expect(screen.getByTestId("state").textContent).toBe("multi_repo:b");
  });
});
