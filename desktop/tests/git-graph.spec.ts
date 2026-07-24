import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GIT_GRAPH_COLOR_COUNT,
  computeGitGraph,
  type GitGraphCommitInput,
} from "@/renderer/features/git/graph/gitGraph";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("computeGitGraph", () => {
  it("builds a stable linear lane snapshot", () => {
    expect(computeGitGraph([
      commit("c", "b"),
      commit("b", "a"),
      commit("a"),
    ])).toEqual({
      columnCount: 1,
      unresolvedLanes: [],
      rows: [
        row("c", ["b"], 0, 0, [], [lane("b", 0)]),
        row("b", ["a"], 0, 0, [lane("b", 0)], [lane("a", 0)]),
        row("a", [], 0, 0, [lane("a", 0)], []),
      ],
    });
  });

  it("keeps branch and merge edges in separate lanes until their shared base", () => {
    const model = computeGitGraph([
      commit("merge", "left", "right"),
      commit("left", "base"),
      commit("right", "base"),
      commit("base"),
    ]);

    expect(model.columnCount).toBe(2);
    expect(model.rows.map((item) => ({
      id: item.objectId,
      column: item.commitColumn,
      color: item.commitColorIndex,
      input: item.inputLanes,
      output: item.outputLanes,
    }))).toMatchInlineSnapshot(`
      [
        {
          "color": 0,
          "column": 0,
          "id": "merge",
          "input": [],
          "output": [
            {
              "colorIndex": 0,
              "laneId": 0,
              "objectId": "left",
            },
            {
              "colorIndex": 1,
              "laneId": 1,
              "objectId": "right",
            },
          ],
        },
        {
          "color": 0,
          "column": 0,
          "id": "left",
          "input": [
            {
              "colorIndex": 0,
              "laneId": 0,
              "objectId": "left",
            },
            {
              "colorIndex": 1,
              "laneId": 1,
              "objectId": "right",
            },
          ],
          "output": [
            {
              "colorIndex": 0,
              "laneId": 0,
              "objectId": "base",
            },
            {
              "colorIndex": 1,
              "laneId": 1,
              "objectId": "right",
            },
          ],
        },
        {
          "color": 1,
          "column": 1,
          "id": "right",
          "input": [
            {
              "colorIndex": 0,
              "laneId": 0,
              "objectId": "base",
            },
            {
              "colorIndex": 1,
              "laneId": 1,
              "objectId": "right",
            },
          ],
          "output": [
            {
              "colorIndex": 0,
              "laneId": 0,
              "objectId": "base",
            },
            {
              "colorIndex": 1,
              "laneId": 1,
              "objectId": "base",
            },
          ],
        },
        {
          "color": 0,
          "column": 0,
          "id": "base",
          "input": [
            {
              "colorIndex": 0,
              "laneId": 0,
              "objectId": "base",
            },
            {
              "colorIndex": 1,
              "laneId": 1,
              "objectId": "base",
            },
          ],
          "output": [],
        },
      ]
    `);
  });

  it("keeps duplicate target lanes stable across intervening rows before converging", () => {
    const model = computeGitGraph([
      commit("merge", "left", "right"),
      commit("left", "base"),
      commit("right", "base"),
      commit("other", "other-root"),
      commit("base", "root"),
    ]);

    const intervening = model.rows[3];
    expect(intervening.inputLanes.slice(0, 2)).toEqual([
      lane("base", 0, 0),
      lane("base", 1, 1),
    ]);
    expect(intervening.outputLanes.slice(0, 2)).toEqual(intervening.inputLanes.slice(0, 2));

    const sharedBase = model.rows[4];
    expect(sharedBase.inputLanes.filter((item) => item.objectId === "base").map((item) => item.laneId)).toEqual([0, 1]);
    expect(sharedBase.commitColumn).toBe(0);
    expect(sharedBase.parentLaneIds).toEqual([0]);
    expect(sharedBase.outputLanes).toContainEqual(lane("root", 0, 0));
  });

  it("keeps unrelated active lanes when a disconnected root commit is visited", () => {
    const model = computeGitGraph([
      commit("tip", "base"),
      commit("unrelated-root"),
      commit("base"),
    ]);

    expect(model.rows[1].outputLanes).toEqual([lane("base", 0, 0)]);
    expect(model.rows[2].inputLanes).toEqual([lane("base", 0, 0)]);
  });

  it("normalizes octopus parents and allocates deterministic colors", () => {
    const input = [commit("octopus", "a", "b", "b", "", "c", "d")];
    const first = computeGitGraph(input);
    const second = computeGitGraph(input);

    expect(first).toEqual(second);
    expect(first.columnCount).toBe(4);
    expect(first.rows[0].parentIds).toEqual(["a", "b", "c", "d"]);
    expect(first.rows[0].outputLanes).toEqual([
      lane("a", 0),
      lane("b", 1),
      lane("c", 2),
      lane("d", 3),
    ]);
    expect(first.rows[0].isMerge).toBe(true);
  });

  it("keeps cursor-truncated parents as unresolved continuation lanes", () => {
    const model = computeGitGraph([commit("tip", "older"), commit("other", "outside")]);

    expect(model.columnCount).toBe(2);
    expect(model.unresolvedLanes).toEqual([lane("older", 0), lane("outside", 1)]);
  });

  it("satisfies lane bounds, continuity, normalization, and determinism for generated DAGs", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const commits = generatedDag(seed, 60);
      const first = computeGitGraph(commits);
      expect(computeGitGraph(commits)).toEqual(first);
      expect(first.rows).toHaveLength(commits.length);

      for (let index = 0; index < first.rows.length; index += 1) {
        const graphRow = first.rows[index];
        expect(graphRow.commitColumn).toBeGreaterThanOrEqual(0);
        expect(graphRow.commitColumn).toBeLessThan(first.columnCount);
        expect(graphRow.commitColorIndex).toBeGreaterThanOrEqual(0);
        expect(graphRow.commitColorIndex).toBeLessThan(GIT_GRAPH_COLOR_COUNT);
        expect(graphRow.parentIds).toEqual([...new Set(graphRow.parentIds)]);
        expect(graphRow.parentIds.every(Boolean)).toBe(true);
        expect(graphRow.inputLanes.every(validLane)).toBe(true);
        expect(graphRow.outputLanes.every(validLane)).toBe(true);
        if (index > 0) expect(graphRow.inputLanes).toEqual(first.rows[index - 1].outputLanes);
      }
    }
  });

  it("maps a real local branch/merge DAG into the renderer-neutral graph model", () => {
    const repository = makeRepository();
    git(repository, "checkout", "-b", "topic");
    writeFileSync(join(repository, "topic.txt"), "topic\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "topic");
    git(repository, "checkout", "main");
    writeFileSync(join(repository, "main.txt"), "main\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "main");
    git(repository, "merge", "--no-ff", "topic", "-m", "merge topic");

    const commits = git(repository, "log", "--topo-order", "--format=%H%x00%P")
      .trim()
      .split("\n")
      .map((line) => {
        const [objectId, parents = ""] = line.split("\0");
        return { objectId, parentIds: parents ? parents.split(" ") : [] };
      });
    const model = computeGitGraph(commits);

    expect(model.rows).toHaveLength(4);
    expect(model.rows[0].isMerge).toBe(true);
    expect(model.rows[0].parentIds).toHaveLength(2);
    expect(model.columnCount).toBeGreaterThanOrEqual(2);
    expect(model.unresolvedLanes).toEqual([]);
  });
});

function commit(objectId: string, ...parentIds: string[]): GitGraphCommitInput {
  return { objectId, parentIds };
}

function lane(objectId: string, colorIndex: number, laneId = colorIndex) {
  return { laneId, objectId, colorIndex };
}

function row(
  objectId: string,
  parentIds: string[],
  commitColumn: number,
  commitColorIndex: number,
  inputLanes: ReturnType<typeof lane>[],
  outputLanes: ReturnType<typeof lane>[],
) {
  return {
    objectId,
    parentIds,
    commitColumn,
    commitColorIndex,
    inputLanes,
    outputLanes,
    parentLaneIds: parentIds.map((parentId) => {
      const parentLane = outputLanes.find((item) => item.objectId === parentId);
      if (!parentLane) throw new Error(`Missing expected parent lane for ${parentId}`);
      return parentLane.laneId;
    }),
    isMerge: parentIds.length > 1,
  };
}

function validLane(item: { laneId: number; objectId: string; colorIndex: number }) {
  return Number.isInteger(item.laneId)
    && item.laneId >= 0
    && Boolean(item.objectId)
    && item.colorIndex >= 0
    && item.colorIndex < GIT_GRAPH_COLOR_COUNT;
}

function generatedDag(seed: number, size: number): GitGraphCommitInput[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return Array.from({ length: size }, (_, index) => {
    const availableParents = size - index - 1;
    const parentCount = availableParents === 0 ? 0 : Math.min(3, Math.floor(random() * 4));
    const parents = new Set<string>();
    while (parents.size < Math.min(parentCount, availableParents)) {
      parents.add(`c${index + 1 + Math.floor(random() * availableParents)}`);
    }
    return commit(`c${index}`, ...parents);
  });
}

function makeRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "keydex-git-graph-"));
  temporaryDirectories.push(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Keydex Tests");
  git(repository, "config", "user.email", "keydex@example.invalid");
  writeFileSync(join(repository, "base.txt"), "base\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  return repository;
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
}
