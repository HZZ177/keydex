import * as pierre from "@pierre/diffs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildKeydexAlignedDiffModel } from "@/renderer/components/diff/aligned/alignmentSegments";
import {
  DiffHunkActionLayer,
  connectorGeometryMidpoint,
  handleAlignedDiffNavigationKeyDown,
  resolveAdjacentDiffChangeId,
  resolveDiffChangeScrollTarget,
} from "@/renderer/components/diff/aligned/DiffHunkActionLayer";
import { buildScrollMappingMetrics } from "@/renderer/components/diff/aligned/hunkScrollMapping";
import { DiffRowHeightIndex } from "@/renderer/components/diff/aligned/rowHeightIndex";
import {
  preparePierreAlignedFile,
  type PierreAlignedPublicApi,
} from "@/renderer/components/diff/engine/pierreAlignedAdapter";
import { alignedDiffFixture, materializeAlignedDiffFile } from "./fixtures/alignedDiffCatalog";

describe("aligned diff change focus and navigation", () => {
  it("resolves missing, boundary and looping navigation deterministically", () => {
    const ids = ["a", "b", "c"];
    expect(resolveAdjacentDiffChangeId(ids, null, "next")).toBe("a");
    expect(resolveAdjacentDiffChangeId(ids, null, "previous")).toBe("c");
    expect(resolveAdjacentDiffChangeId(ids, "b", "next")).toBe("c");
    expect(resolveAdjacentDiffChangeId(ids, "c", "next")).toBe("c");
    expect(resolveAdjacentDiffChangeId(ids, "c", "next", true)).toBe("a");
    expect(resolveAdjacentDiffChangeId(ids, "a", "previous", true)).toBe("c");
    expect(resolveAdjacentDiffChangeId([], null, "next")).toBeNull();
  });

  it("renders HTML hit targets independently from the assistive-hidden SVG", () => {
    const onActiveChange = vi.fn();
    const onNavigate = vi.fn();
    const changes = [
      change("a", "modified"),
      change("b", "added"),
    ];
    const geometry = [geometryFor("a", 20), geometryFor("b", 60)];
    const { container } = render(
      <DiffHunkActionLayer
        changes={changes}
        geometry={geometry}
        activeChangeId="a"
        onActiveChange={onActiveChange}
        onNavigate={onNavigate}
      />,
    );
    const target = screen.getByRole("button", { name: "差异 2/2，新增内容" });
    fireEvent.mouseDown(target);
    fireEvent.click(target);
    expect(onActiveChange).toHaveBeenCalledWith("b");
    expect(onNavigate).toHaveBeenCalledWith("b");
    expect(container.querySelector('[data-change-id="a"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(connectorGeometryMidpoint(geometry[0]!)).toBe(25);
  });

  it("handles Alt+Up/Down only inside a non-editable Diff focus scope", () => {
    const navigate = vi.fn();
    render(
      <div
        data-testid="scope"
        tabIndex={0}
        onKeyDown={(event) => handleAlignedDiffNavigationKeyDown(event, navigate)}
      >
        <input aria-label="编辑器" />
      </div>,
    );
    fireEvent.keyDown(screen.getByTestId("scope"), { key: "ArrowDown", altKey: true });
    expect(navigate).toHaveBeenCalledWith("next");
    fireEvent.keyDown(screen.getByTestId("scope"), { key: "ArrowUp", altKey: true });
    expect(navigate).toHaveBeenCalledWith("previous");
    fireEvent.keyDown(screen.getByTestId("scope"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "编辑器" }), { key: "ArrowDown", altKey: true });
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("computes a virtual-safe scroll target from semantic metrics for either pane", async () => {
    const fixture = alignedDiffFixture("aligned-multi-change-one-hunk");
    const prepared = await preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
      theme: "light",
      sourceVersion: "navigation",
      api: publicApi(),
    });
    const model = buildKeydexAlignedDiffModel(prepared);
    const left = new DiffRowHeightIndex(model.leftRows.length, 20);
    const right = new DiffRowHeightIndex(model.rightRows.length, 24);
    const metrics = buildScrollMappingMetrics(model, left, right);
    const target = model.changes[1]!;
    expect(resolveDiffChangeScrollTarget(model, metrics, target.id, "old", 40, 0)).toBeGreaterThan(0);
    expect(resolveDiffChangeScrollTarget(model, metrics, target.id, "new", 40, 0)).toBeGreaterThan(0);
    expect(resolveDiffChangeScrollTarget(model, metrics, "missing", "old", 40)).toBeNull();
  });
});

function change(id: string, kind: "added" | "removed" | "modified") {
  return Object.freeze({
    id,
    segmentId: `segment:${id}`,
    kind,
    left: { startRow: 0, endRow: 1, startLine: 1, endLine: 1 },
    right: { startRow: 0, endRow: 1, startLine: 1, endLine: 1 },
  });
}

function geometryFor(changeId: string, start: number) {
  return Object.freeze({
    changeId,
    kind: "modified" as const,
    leftStart: start,
    leftEnd: start + 10,
    rightStart: start,
    rightEnd: start + 10,
    clippedTop: false,
    clippedBottom: false,
  });
}

function publicApi(): PierreAlignedPublicApi {
  return {
    parsePatchFiles: pierre.parsePatchFiles,
    getFiletypeFromFileName: pierre.getFiletypeFromFileName,
    getSharedHighlighter: vi.fn(async () => ({}) as never),
    renderDiffWithHighlighter: vi.fn((metadata) => ({
      code: {
        deletionLines: metadata.deletionLines.map((value: string) => ({ type: "text", value })),
        additionLines: metadata.additionLines.map((value: string) => ({ type: "text", value })),
      },
      themeStyles: "",
      baseThemeType: "light",
    })) as never,
  };
}
