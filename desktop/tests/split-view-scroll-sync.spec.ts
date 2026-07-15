import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  codeMirrorViewportSourceAnchor,
  syncCodeMirrorViewportToSourceAnchor,
} from "@/renderer/components/workspace/splitViewScrollSync";

describe("split view source-line scroll sync", () => {
  afterEach(() => document.body.replaceChildren());

  it("keeps a wrapped logical line as one line anchor instead of converting height to characters", () => {
    const state = EditorState.create({ doc: "one\ntwo\nthree\nwrapped target content\nfive" });
    const targetLine = state.doc.line(4);
    const dom = document.createElement("div");
    const scrollElement = document.createElement("div");
    dom.append(document.createElement("div"));
    document.body.append(scrollElement, dom);
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: { configurable: true, value: 700, writable: true },
    });
    scrollElement.getBoundingClientRect = () => domRect(150, 400);
    const lineBlock = { from: targetLine.from, to: targetLine.to, top: 900, height: 400 };
    const view = {
      dom,
      state,
      scaleY: 1,
      documentTop: -850,
      lineBlockAtHeight: vi.fn().mockReturnValue(lineBlock),
      lineBlockAt: vi.fn().mockReturnValue(lineBlock),
    } as unknown as EditorView;

    expect(codeMirrorViewportSourceAnchor(view, scrollElement)).toEqual({
      line: 4,
      lineProgress: 0.25,
    });
    expect(view.lineBlockAtHeight).toHaveBeenCalledWith(1_000);

    const scrollTo = vi.fn();
    Object.defineProperty(scrollElement, "scrollTo", { configurable: true, value: scrollTo });
    expect(syncCodeMirrorViewportToSourceAnchor(
      view,
      scrollElement,
      { line: 4, lineProgress: 0.25 },
    )).toBe(true);
    expect(view.lineBlockAt).toHaveBeenCalledWith(targetLine.from);
    expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: "auto" });
  });
});

function domRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}
