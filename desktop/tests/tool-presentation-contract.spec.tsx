import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ToolProjectionNotice,
  ToolStructuredContent,
} from "@/renderer/pages/conversation/messages/ToolStructuredContent";
import { buildToolPresentation } from "@/renderer/pages/conversation/messages/toolPresentation";

const ALL_TOOL_NAMES = [
  // Default local registry.
  "read_file",
  "create_file",
  "list_dir",
  "edit_file",
  "delete_file",
  "move_file",
  "search_text",
  "grep_files",
  "search_files",
  "apply_patch",
  "update_plan",
  "get_thread_task",
  "update_thread_task",
  "read_tool_result",
  // Runtime tools.
  "run_git_bash",
  "run_powershell",
  "run_cmd",
  "load_skill",
  "delegate_subagent",
  "continue_subagent",
  "web_search",
  "web_fetch",
  "discover_mcp_tools",
  // A2UI tools have dedicated renderers; the lossless generic renderer remains
  // their safe fallback for historical or partially hydrated events.
  "chart",
  "choice",
  "form",
  "table",
  // Dynamic and future tools must not need a frontend schema to stay lossless.
  "mcp__fixture_server__query_records",
  "future_unknown_tool",
] as const;

describe("tool presentation contract", () => {
  it.each(ALL_TOOL_NAMES)("preserves every %s field in the generic presentation fallback", (toolName) => {
    const args = {
      tool_marker: `input:${toolName}`,
      enabled: false,
      limit: 0,
      optional: null,
    };
    const output = {
      tool: toolName,
      marker: `output:${toolName}`,
      status: "success",
      multiline: "first line\nsecond line",
      nested: {
        count: 0,
        complete: false,
        absent: null,
      },
      rows: [
        { id: `${toolName}:1`, value: "alpha" },
        { id: `${toolName}:2`, value: "beta" },
      ],
      _keydex_projection: {
        truncated: false,
        full_bytes: 189,
        model_bytes: 497,
      },
    };
    const modelContent = JSON.stringify(output);
    const presentation = buildToolPresentation({
      args,
      result: {
        status: "success",
        model_content: modelContent,
        ui_payload: output,
      },
      payload: {},
    });

    expect(presentation.inputValue).toEqual(args);
    expect(presentation.inputRawText).toContain(`input:${toolName}`);
    expect(JSON.parse(presentation.outputRawText)).toEqual(output);
    expect(presentation.outputValue).toEqual({
      tool: toolName,
      marker: `output:${toolName}`,
      status: "success",
      multiline: "first line\nsecond line",
      nested: {
        count: 0,
        complete: false,
        absent: null,
      },
      rows: [
        { id: `${toolName}:1`, value: "alpha" },
        { id: `${toolName}:2`, value: "beta" },
      ],
    });

    const { container } = render(
      <ToolStructuredContent value={presentation.outputValue} toolName={toolName} mode="output" />,
    );
    const visibleText = container.textContent ?? "";
    expect(visibleText).toContain(`output:${toolName}`);
    expect(visibleText).toContain("first line");
    expect(visibleText).toContain("second line");
    expect(visibleText).toContain(`${toolName}:1`);
    expect(visibleText).toContain("alpha");
    expect(visibleText).toContain("0");
    expect(visibleText).toContain("否");
    expect(visibleText).not.toContain("absent");
    expect(visibleText).not.toContain("_keydex_projection");
  });

  it("treats Agent model_content as authoritative when ui_payload drifts", () => {
    const agentOutput = { source: "agent", value: "Agent 实际看到的内容" };
    const presentation = buildToolPresentation({
      args: {},
      result: {
        status: "success",
        model_content: JSON.stringify(agentOutput),
        ui_payload: { source: "stale-ui", value: "人类不应看到的旧内容" },
      },
      payload: {},
    });

    expect(presentation.outputSource).toBe("model_content");
    expect(presentation.outputValue).toEqual(agentOutput);
    expect(presentation.outputRawText).toBe(JSON.stringify(agentOutput));
  });

  it("keeps complete Agent output free of projection telemetry", () => {
    const agentOutput = { path: "D:/project", tree: "D:/project/\nsrc/", truncated: false };
    const presentation = buildToolPresentation({
      args: {},
      result: { status: "success", model_content: JSON.stringify(agentOutput) },
      payload: {},
    });

    expect(presentation.outputValue).toEqual(agentOutput);
    expect(presentation.projection).toBeNull();
    expect(presentation.outputRawText).toBe(JSON.stringify(agentOutput));
  });

  it("keeps only actionable projection fields for truncated Agent output", () => {
    const agentOutput = {
      path: "D:/project",
      tree: "D:/project/\nsrc/",
      truncated: true,
      next_offset: 1,
      _keydex_projection: {
        truncated: true,
        continuation: { kind: "next_offset", value: 1 },
        artifact_id: "tra_example",
      },
    };
    const presentation = buildToolPresentation({
      args: {},
      result: { status: "success", model_content: JSON.stringify(agentOutput) },
      payload: {},
    });

    expect(presentation.outputValue).toEqual({
      path: "D:/project",
      tree: "D:/project/\nsrc/",
      truncated: true,
      next_offset: 1,
    });
    expect(presentation.projection).toEqual({
      truncated: true,
      continuation: { kind: "next_offset", value: 1 },
      artifactId: "tra_example",
    });
    expect(JSON.parse(presentation.outputRawText)).toEqual(agentOutput);
  });

  it("uses structured ui_payload only for legacy events without model_content", () => {
    const uiPayload = { path: "legacy.txt", numbered_content: "1 legacy" };
    const presentation = buildToolPresentation({
      args: { path: "legacy.txt" },
      result: { status: "success", model_content: "", ui_payload: uiPayload },
      payload: {},
    });

    expect(presentation.outputSource).toBe("ui_payload");
    expect(presentation.outputValue).toEqual(uiPayload);
    expect(JSON.parse(presentation.outputRawText)).toEqual(uiPayload);
  });

  it("keeps null fields in raw data while omitting them from the product view", () => {
    const output = {
      path: "D:/project",
      next_offset: null,
      truncation_reason: null,
      truncated: false,
      tree: "D:/project/\nsrc/",
    };
    const presentation = buildToolPresentation({
      args: {},
      result: { status: "success", model_content: JSON.stringify(output), ui_payload: output },
      payload: {},
    });
    const { container } = render(
      <ToolStructuredContent value={presentation.outputValue} toolName="list_dir" mode="output" />,
    );

    expect(container.textContent).toContain("D:/project");
    expect(container.textContent).toContain("src/");
    expect(container.textContent).not.toContain("next_offset");
    expect(container.textContent).not.toContain("truncation_reason");
    expect(JSON.parse(presentation.outputRawText)).toEqual(output);
  });

  it("does not show byte accounting for a complete result whose envelope is larger", () => {
    const { rerender } = render(
      <ToolProjectionNotice
        projection={{ truncated: false, fullBytes: 189, modelBytes: 497 }}
      />,
    );

    expect(screen.queryByLabelText("工具结果投影信息")).toBeNull();

    rerender(
      <ToolProjectionNotice
        projection={{ truncated: true, fullBytes: 20_000, modelBytes: 5_000 }}
      />,
    );
    expect(screen.getByLabelText("工具结果投影信息").textContent).toContain("Agent 可见 4.9 KB");
    expect(screen.getByLabelText("工具结果投影信息").textContent).toContain("工具原始 20 KB");
  });
});
