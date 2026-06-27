import { describe, expect, it } from "vitest";

import {
  createWorkbenchAssistantState,
  workbenchAssistantReducer,
} from "../src/renderer/pages/workbench/workbenchAssistantState";

describe("workbenchAssistantReducer", () => {
  it("moves from capsule to composer on draft or explicit open without losing focus sequencing", () => {
    expect(workbenchAssistantReducer(createWorkbenchAssistantState(), { type: "draft-changed", hasDraft: true })).toEqual({
      mode: "composer",
      focusSeq: 0,
    });
    expect(workbenchAssistantReducer(createWorkbenchAssistantState(), { type: "open-composer" })).toEqual({
      mode: "composer",
      focusSeq: 1,
    });
  });

  it("keeps injected context focused unless the drawer is already active", () => {
    expect(workbenchAssistantReducer(createWorkbenchAssistantState(), { type: "context-injected" })).toEqual({
      mode: "composer",
      focusSeq: 1,
    });
    expect(workbenchAssistantReducer({ mode: "drawer", focusSeq: 3 }, { type: "context-injected" })).toEqual({
      mode: "drawer",
      focusSeq: 3,
    });
  });

  it("handles drawer, expanded and reset transitions from one source of truth", () => {
    expect(workbenchAssistantReducer({ mode: "composer", focusSeq: 2 }, { type: "dock-to-drawer" })).toEqual({
      mode: "drawer",
      focusSeq: 3,
    });
    expect(workbenchAssistantReducer({ mode: "drawer", focusSeq: 3 }, { type: "close-drawer", hasDraft: false })).toEqual({
      mode: "capsule",
      focusSeq: 3,
    });
    expect(workbenchAssistantReducer({ mode: "expanded", focusSeq: 4 }, { type: "toggle-expanded", hasDraft: false })).toEqual({
      mode: "capsule",
      focusSeq: 4,
    });
    expect(workbenchAssistantReducer({ mode: "expanded", focusSeq: 4 }, { type: "toggle-expanded", hasDraft: true })).toEqual({
      mode: "composer",
      focusSeq: 5,
    });
    expect(workbenchAssistantReducer({ mode: "drawer", focusSeq: 5 }, { type: "workspace-reset" })).toEqual({
      mode: "capsule",
      focusSeq: 0,
    });
  });

  it("opens the drawer when approval arrives regardless of current non-drawer mode", () => {
    expect(workbenchAssistantReducer({ mode: "expanded", focusSeq: 1 }, { type: "approval-pending" })).toEqual({
      mode: "drawer",
      focusSeq: 2,
    });
  });

  it("keeps rapid drawer and expanded transitions deterministic", () => {
    let state = createWorkbenchAssistantState();
    state = workbenchAssistantReducer(state, { type: "open-composer" });
    state = workbenchAssistantReducer(state, { type: "dock-to-drawer" });
    state = workbenchAssistantReducer(state, { type: "close-drawer", hasDraft: true });
    state = workbenchAssistantReducer(state, { type: "toggle-expanded", hasDraft: true });
    state = workbenchAssistantReducer(state, { type: "toggle-expanded", hasDraft: false });

    expect(state).toEqual({
      mode: "capsule",
      focusSeq: 4,
    });
  });

  it("does not create a second shell state when reset interrupts active modes", () => {
    expect(workbenchAssistantReducer({ mode: "drawer", focusSeq: 9 }, { type: "workspace-reset" })).toEqual(
      createWorkbenchAssistantState(),
    );
    expect(workbenchAssistantReducer({ mode: "expanded", focusSeq: 4 }, { type: "workspace-reset" })).toEqual(
      createWorkbenchAssistantState(),
    );
  });
});
