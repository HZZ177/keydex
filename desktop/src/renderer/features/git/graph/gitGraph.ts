/**
 * Pure Git history lane layout.
 *
 * Source: Stack-Cairn/LiveAgent, crates/agent-gui/src/lib/git/gitGraph.ts
 * Commit: 1616eb5e574274693dc29e18248650dc30911123
 * License: MIT, Copyright (c) 2026 Stack-Cairn
 *
 * Keydex modifications:
 * - use Keydex-owned commit/object-id vocabulary;
 * - remove LiveAgent ref-marker and UI-specific color semantics;
 * - expose unresolved lanes so cursor-truncated history pages can continue the
 *   graph without pretending their parent commits were loaded;
 * - keep the result as a renderer-neutral SVG/canvas model (no copied UI/CSS).
 */

import { GIT_GRAPH_COLOR_COUNT } from "./gitGraphColor";

export { GIT_GRAPH_COLOR_COUNT } from "./gitGraphColor";

export interface GitGraphCommitInput {
  objectId: string;
  parentIds: readonly string[];
}

export interface GitGraphLane {
  objectId: string;
  colorIndex: number;
}

export interface GitGraphRow {
  objectId: string;
  parentIds: readonly string[];
  commitColumn: number;
  commitColorIndex: number;
  inputLanes: readonly GitGraphLane[];
  outputLanes: readonly GitGraphLane[];
  isMerge: boolean;
}

export interface GitGraphModel {
  rows: readonly GitGraphRow[];
  columnCount: number;
  /** Lanes whose commits are outside the currently loaded cursor page. */
  unresolvedLanes: readonly GitGraphLane[];
}

function normalizeParents(parentIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawParentId of parentIds) {
    const parentId = rawParentId.trim();
    if (!parentId || seen.has(parentId)) continue;
    seen.add(parentId);
    normalized.push(parentId);
  }
  return normalized;
}

function cloneLane(lane: GitGraphLane): GitGraphLane {
  return { ...lane };
}

/**
 * Converts reverse-topological `git log` rows into stable lane coordinates.
 * The caller must preserve Git's log order; the function is deterministic and
 * does not mutate its input.
 */
export function computeGitGraph(commits: readonly GitGraphCommitInput[]): GitGraphModel {
  if (commits.length === 0) {
    return { rows: [], columnCount: 0, unresolvedLanes: [] };
  }

  const rows: GitGraphRow[] = [];
  const loadedObjectIds = new Set(commits.map((commit) => commit.objectId));
  let previousOutputLanes: GitGraphLane[] = [];
  let nextColorIndex = -1;
  let columnCount = 1;

  function allocateColor(): number {
    nextColorIndex = (nextColorIndex + 1) % GIT_GRAPH_COLOR_COUNT;
    return nextColorIndex;
  }

  for (const commit of commits) {
    const objectId = commit.objectId.trim();
    const parentIds = normalizeParents(commit.parentIds);
    const inputLanes = previousOutputLanes.map(cloneLane);
    const inputIndex = inputLanes.findIndex((lane) => lane.objectId === objectId);
    const commitColumn = inputIndex >= 0 ? inputIndex : inputLanes.length;
    const commitColorIndex = inputIndex >= 0 ? inputLanes[inputIndex].colorIndex : allocateColor();
    const outputLanes: GitGraphLane[] = [];

    if (parentIds.length > 0) {
      let firstParentAdded = false;
      for (const lane of inputLanes) {
        if (lane.objectId === objectId) {
          if (!firstParentAdded) {
            outputLanes.push({ objectId: parentIds[0], colorIndex: commitColorIndex });
            firstParentAdded = true;
          }
          continue;
        }
        outputLanes.push(cloneLane(lane));
      }

      if (!firstParentAdded) {
        outputLanes.push({ objectId: parentIds[0], colorIndex: commitColorIndex });
      }

      for (const parentId of parentIds.slice(1)) {
        outputLanes.push({ objectId: parentId, colorIndex: allocateColor() });
      }
    }

    columnCount = Math.max(
      columnCount,
      inputLanes.length,
      outputLanes.length,
      commitColumn + 1,
    );
    rows.push({
      objectId,
      parentIds,
      commitColumn,
      commitColorIndex,
      inputLanes,
      outputLanes,
      isMerge: parentIds.length > 1,
    });
    previousOutputLanes = outputLanes;
  }

  return {
    rows,
    columnCount,
    unresolvedLanes: previousOutputLanes
      .filter((lane) => !loadedObjectIds.has(lane.objectId))
      .map(cloneLane),
  };
}
