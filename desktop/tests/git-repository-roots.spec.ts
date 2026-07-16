import { describe, expect, it } from "vitest";

import type { GitRepositoryRoot } from "@/renderer/features/git/activeProject";
import {
  createGitRepositoryIdentity,
  organizeGitRepositoryRoots,
  repositoryOwningPath,
} from "@/renderer/features/git/repositoryRoots";

const repo = (id: string, rootPath: string): GitRepositoryRoot => ({
  id,
  rootPath,
  displayPath: rootPath.split(/[\\/]/).at(-1) ?? rootPath,
  kind: "nested",
});

describe("multi-root Git repository model", () => {
  it("keeps sibling and nested repositories distinct with nearest-parent relations", () => {
    const roots = organizeGitRepositoryRoots("D:/work/project", [
      repo("nested", "D:/work/project/packages/nested"),
      repo("root", "D:/work/project"),
      repo("sibling", "D:/work/project/tools"),
      repo("deep", "D:/work/project/packages/nested/deep"),
    ]);

    expect(roots.map(({ id, kind, parentRepoId }) => ({ id, kind, parentRepoId }))).toEqual([
      { id: "root", kind: "workspace", parentRepoId: undefined },
      { id: "nested", kind: "nested", parentRepoId: "root" },
      { id: "deep", kind: "nested", parentRepoId: "nested" },
      { id: "sibling", kind: "nested", parentRepoId: "root" },
    ]);
  });

  it("routes a file to the deepest matching repository", () => {
    const roots = [repo("root", "D:/work/project"), repo("nested", "D:/work/project/pkg")];
    expect(repositoryOwningPath(roots, "D:/work/project/pkg/src/a.ts")?.id).toBe("nested");
    expect(repositoryOwningPath(roots, "D:/work/project/README.md")?.id).toBe("root");
    expect(repositoryOwningPath(roots, "D:/outside/file.txt")).toBeNull();
  });

  it("uses stable Windows path identities and rejects duplicate canonical roots", () => {
    expect(createGitRepositoryIdentity("D:\\Work\\Repo")).toBe(
      createGitRepositoryIdentity("d:/work/repo/"),
    );
    expect(() =>
      organizeGitRepositoryRoots("D:/work/project", [
        repo("a", "D:/work/project"),
        repo("b", "d:\\work\\project\\"),
      ]),
    ).toThrow("Duplicate Git repository root");
  });
});
