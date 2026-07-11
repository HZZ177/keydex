import { describe, expect, it } from "vitest";

import { selectedQuoteFromText } from "@/renderer/components/chat/SendBox";
import { prepareComposerMessage } from "@/renderer/utils/messageInjection";

describe("message injection composer helpers", () => {
  it("moves selected quotes and selected files into follow injections", () => {
    const quote = selectedQuoteFromText("selected text");
    if (!quote) {
      throw new Error("quote not created");
    }
    const prepared = prepareComposerMessage("please review now", [
      { path: "src/main.ts", name: "main.ts", type: "file", source: "workspace" },
    ], { quotes: [quote] });

    expect(prepared.message).toBe("please review now");
    expect(prepared.contextItems.map((item) => item.type)).toEqual(["quote", "file"]);
    expect(prepared.contextItems[0]).toMatchObject({
      type: "quote",
      content: "selected text",
      role: "HumanMessage",
      source: "follow",
    });
    expect(prepared.contextItems[1]).toMatchObject({
      type: "file",
      label: "main.ts",
      path: "src/main.ts",
      fileType: "file",
      role: "HumanMessage",
      source: "follow",
    });

    const injections = prepared.runtimeParams?.message_injection;
    expect(injections).toHaveLength(2);
    if (!injections) {
      throw new Error("message injection not created");
    }
    expect(injections[0]).toMatchObject({
      type: "follow",
      role: "HumanMessage",
      metadata: {
        kind: "quote",
      },
    });
    expect(injections[0]?.content).toContain("selected text");
    expect(injections[1]).toMatchObject({
      type: "follow",
      role: "HumanMessage",
      metadata: {
        kind: "file",
        path: "src/main.ts",
        fileType: "file",
      },
    });
    expect(injections[1]?.content).toContain("src/main.ts");
  });

  it("allows file-only sends without polluting the visible message", () => {
    const prepared = prepareComposerMessage("", [
      { path: "README.md", name: "README.md", type: "file", source: "workspace" },
    ]);

    expect(prepared.message).toBe("");
    expect(prepared.contextItems).toHaveLength(1);
    expect(prepared.runtimeParams?.message_injection).toHaveLength(1);
  });

  it("packs file-backed quote context into one self-contained injection", () => {
    const quote = selectedQuoteFromText("selected text", {
      source: "selection",
      file: {
        path: "README.md",
        name: "README.md",
        lineStart: 3,
        lineEnd: 4,
        sourceStart: 18,
        sourceEnd: 31,
      },
    });
    if (!quote) {
      throw new Error("quote not created");
    }
    const prepared = prepareComposerMessage("comment stays visible", [], { quotes: [quote] });

    expect(prepared.message).toBe("comment stays visible");
    expect(prepared.contextItems).toHaveLength(1);
    expect(prepared.contextItems[0]).toMatchObject({
      type: "source_quote",
      label: "README.md · L3-L4",
      content: "selected text",
      path: "README.md",
      role: "HumanMessage",
      source: "follow",
      metadata: {
        kind: "source_quote",
        line_start: 3,
        line_end: 4,
        source_start: 18,
        source_end: 31,
      },
    });
    const injections = prepared.runtimeParams?.message_injection;
    expect(injections).toHaveLength(1);
    if (!injections) {
      throw new Error("message injection not created");
    }
    expect(injections[0]).toMatchObject({
      type: "follow",
      role: "HumanMessage",
      metadata: {
        kind: "source_quote",
        path: "README.md",
        line_start: 3,
        line_end: 4,
        source_start: 18,
        source_end: 31,
      },
    });
    expect(injections[0]?.content).toContain("README.md");
    expect(injections[0]?.content).toContain("L3-L4");
    expect(injections[0]?.content).toContain("18-31");
    expect(injections[0]?.content).toContain("selected text");
    expect(injections[0]?.content).not.toContain("comment stays visible");
  });

  it("keeps bracket syntax as ordinary user text", () => {
    const prepared = prepareComposerMessage("please review [[selected text]] now");

    expect(prepared.message).toBe("please review [[selected text]] now");
    expect(prepared.contextItems).toEqual([]);
    expect(prepared.runtimeParams).toBeUndefined();
  });

  it("adds selected skill as context item and skill_activation without message injection", () => {
    const prepared = prepareComposerMessage("拆 issues", [], {
      selectedSkill: {
        name: "dev-plan",
        label: "/dev-plan",
        description: "Plan work from a design doc",
        source: "workspace",
        locator: ".keydex/skills/dev-plan/SKILL.md",
      },
    });

    expect(prepared.contextItems).toHaveLength(1);
    expect(prepared.contextItems[0]).toMatchObject({
      id: "skill:dev-plan",
      type: "skill",
      label: "/dev-plan",
      content: "Plan work from a design doc",
      source: "workspace",
      skill_name: "dev-plan",
      description: "Plan work from a design doc",
    });
    expect(prepared.runtimeParams).toEqual({
      skill_activation: {
        skill_name: "dev-plan",
        source: "workspace",
        origin: "slash",
      },
    });
  });

  it("keeps skill out of message_injection when files or quotes are also attached", () => {
    const quote = selectedQuoteFromText("selected text");
    if (!quote) {
      throw new Error("quote not created");
    }
    const prepared = prepareComposerMessage(
      "拆 issues",
      [{ path: "README.md", name: "README.md", type: "file", source: "workspace" }],
      {
        quotes: [quote],
        selectedSkill: {
          name: "dev-plan",
          label: "/dev-plan",
          description: "Plan work from a design doc",
          source: "workspace",
          locator: ".keydex/skills/dev-plan/SKILL.md",
        },
      },
    );

    expect(prepared.contextItems.map((item) => item.type)).toEqual(["skill", "quote", "file"]);
    expect(prepared.runtimeParams?.skill_activation?.skill_name).toBe("dev-plan");
    expect(prepared.runtimeParams?.message_injection).toHaveLength(2);
    expect(prepared.runtimeParams?.message_injection?.map((item) => item.metadata?.kind)).toEqual([
      "quote",
      "file",
    ]);
  });
});
