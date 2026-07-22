import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { rightSidebarDefinitionRegistry } from "@/renderer/components/layout/rightSidebarRegistry";
import {
  conversationPanelCreateInput,
  conversationPanelDefinition,
  normalizeConversationPanelState,
  serializeConversationPanelState,
} from "@/renderer/components/layout/rightSidebar/panels/conversation";

const NOW = "2026-07-21T00:00:00.000Z";

describe("conversation right sidebar panel definition", () => {
  it("creates and roundtrips a ready BTW conversation with a quote request", () => {
    const state = conversationPanelDefinition.create({
      id: "right-sidebar:conversation:1",
      sequence: 1,
      now: NOW,
      input: conversationPanelCreateInput({
        sessionId: "session-btw",
        title: "旁路对话",
        sourceSessionId: "session-main",
        quoteRequest: {
          requestId: 1,
          quote: {
            id: "quote:1",
            text: "selected text",
            preview: "selected text",
            source: "selection",
            file: { path: "README.md", lineStart: 1, lineEnd: 1 },
          },
        },
      }),
    });

    expect(state).toMatchObject({
      conversationKind: "conversation",
      status: "ready",
      sessionId: "session-btw",
      sourceSessionId: "session-main",
      quoteRequest: { requestId: 1 },
    });
    expect(normalizeConversationPanelState(serializeConversationPanelState(state))).toEqual(state);
  });

  it("supports opening and subagent variants without changing the panel kind", () => {
    const opening = conversationPanelDefinition.create({
      id: "right-sidebar:conversation:1",
      sequence: 1,
      now: NOW,
      input: conversationPanelCreateInput({ status: "opening", title: "旁路对话" }),
    });
    const subagent = conversationPanelDefinition.create({
      id: "right-sidebar:conversation:2",
      sequence: 2,
      now: NOW,
      input: conversationPanelCreateInput({
        conversationKind: "subagent",
        title: "子智能体",
        parentSessionId: "session-main",
        subagentInvocation: {
          invocationId: "invocation-1",
          parentSessionId: "session-main",
          role: "worker",
          task: "inspect",
          state: "running",
          errorCode: null,
          errorMessage: null,
        },
      }),
    });

    expect(opening).toMatchObject({ kind: "conversation", status: "opening" });
    expect(subagent).toMatchObject({
      kind: "conversation",
      conversationKind: "subagent",
      parentSessionId: "session-main",
    });
  });

  it("rejects unknown schemas and runtime-only top-level fields", () => {
    const state = conversationPanelDefinition.create({
      id: "right-sidebar:conversation:1",
      sequence: 1,
      now: NOW,
      input: conversationPanelCreateInput({ sessionId: "session-btw" }),
    });
    const serialized = serializeConversationPanelState(state);

    expect(normalizeConversationPanelState({ ...serialized, schemaVersion: 2 })).toBeNull();
    expect(normalizeConversationPanelState({ ...serialized, runtime: true })).toBeNull();
  });

  it("uses registry presentation and definition-owned rendering", () => {
    const state = rightSidebarDefinitionRegistry.create("conversation", {
      id: "right-sidebar:conversation:1",
      sequence: 1,
      now: NOW,
      input: conversationPanelCreateInput({ sessionId: "session-btw", title: "上下文讨论" }),
    });
    const rendered = rightSidebarDefinitionRegistry.get("conversation").render({
      active: true,
      scopeKey: "session:main",
      state,
      hostContext: {
        runtime: {} as RuntimeBridge,
        a2uiRenderSuspended: false,
        onQuoteRequestHandled: vi.fn(),
        onOpenSubagentList: vi.fn(),
      },
      updateState: vi.fn(),
    });

    expect(isValidElement(rendered)).toBe(true);
    expect(rightSidebarDefinitionRegistry.getPresentation(state)).toEqual({
      title: "上下文讨论",
      icon: "message",
    });
  });
});
