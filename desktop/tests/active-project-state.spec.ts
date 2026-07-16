import { describe, expect, it } from "vitest";

import {
  deriveActiveProjectState,
  reduceActiveProjectState,
  selectedGitRepository,
  type ActiveProjectIdentity,
  type GitRepositoryRoot,
} from "@/renderer/features/git/activeProject";

const project: ActiveProjectIdentity = {
  workspaceId: "workspace-a",
  projectPath: "D:/work/project",
  name: "Project",
};
const root = (id: string, kind: GitRepositoryRoot["kind"] = "workspace"): GitRepositoryRoot => ({
  id,
  rootPath: `D:/work/project/${id}`,
  displayPath: id,
  kind,
});

describe("ActiveProject Git state", () => {
  it("derives none, loading, non-repo, single and multi-repo states", () => {
    expect(deriveActiveProjectState({ project: null })).toEqual({ status: "none", selectedRepoId: null });
    expect(deriveActiveProjectState({ project, loading: true }).status).toBe("loading");
    expect(deriveActiveProjectState({ project }).status).toBe("non_repo");
    expect(deriveActiveProjectState({ project, repoRoots: [root("a")] }).status).toBe("ready");
    const multi = deriveActiveProjectState({
      project,
      repoRoots: [root("a"), root("nested", "nested")],
      selectedRepoId: "nested",
    });
    expect(multi.status).toBe("multi_repo");
    expect(selectedGitRepository(multi)?.id).toBe("nested");
  });

  it("requires explicit authorization before promoting an ancestor repository", () => {
    const candidate = root("ancestor", "ancestor");
    const pending = deriveActiveProjectState({ project, ancestorCandidate: candidate });
    expect(pending.status).toBe("ancestor_pending");
    expect(selectedGitRepository(pending)).toBeNull();

    const denied = reduceActiveProjectState(pending, { type: "ancestor_denied" });
    expect(denied).toMatchObject({ status: "denied", reason: "ancestor_not_authorized" });

    const granted = reduceActiveProjectState(pending, { type: "ancestor_granted", repo: candidate });
    expect(granted.status).toBe("ready");
    expect(selectedGitRepository(granted)?.kind).toBe("ancestor");
  });

  it("rejects invalid root combinations without inventing a repository", () => {
    expect(() => deriveActiveProjectState({ project, repoRoots: [root("a"), root("a")] })).toThrow(
      "Duplicate Git repository id",
    );
    expect(() =>
      deriveActiveProjectState({ project, repoRoots: [root("a")], selectedRepoId: "missing" }),
    ).toThrow("not part of the active project");
  });

  it("ignores repo selection outside ready states and resets on project clear", () => {
    const nonRepo = deriveActiveProjectState({ project });
    expect(reduceActiveProjectState(nonRepo, { type: "select_repo", repoId: "a" })).toBe(nonRepo);

    const ready = deriveActiveProjectState({ project, repoRoots: [root("a")] });
    expect(reduceActiveProjectState(ready, { type: "project_cleared" })).toEqual({
      status: "none",
      selectedRepoId: null,
    });
  });
});
