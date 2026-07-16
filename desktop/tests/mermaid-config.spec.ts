import { describe, expect, it } from "vitest";

import { getMermaidConfig } from "@/renderer/utils/mermaidConfig";

describe("getMermaidConfig", () => {
  it("keeps Mermaid's built-in neutral theme in light mode", () => {
    const config = getMermaidConfig("light");

    expect(config.theme).toBe("neutral");
    expect(config.look).toBe("classic");
    expect(config.securityLevel).toBe("strict");
    expect(config.flowchart).toEqual({ useMaxWidth: false });
    expect(config.themeVariables).toBeUndefined();
  });

  it("uses readable Dracula variables for dark Mermaid diagrams", () => {
    const config = getMermaidConfig("dark");

    expect(config.theme).toBe("base");
    expect(config.themeVariables).toMatchObject({
      darkMode: true,
      background: "#282a36",
      primaryColor: "#343746",
      primaryTextColor: "#f8f8f2",
      textColor: "#f8f8f2",
      nodeTextColor: "#f8f8f2",
      actorTextColor: "#f8f8f2",
      signalTextColor: "#f8f8f2",
      labelTextColor: "#f8f8f2",
      loopTextColor: "#f8f8f2",
      lineColor: "#a9acc2",
    });
  });
});
