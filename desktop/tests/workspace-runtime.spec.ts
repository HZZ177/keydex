import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "@/runtime/httpClient";
import {
  createKeydexRuntime,
  createSkillRuntime,
  type EffectiveSkillsResponse,
  type RuntimeOverviewResponse,
  type SkillResourceReadResponse,
} from "@/runtime/skills";

describe("skill runtime", () => {
  it("loads effective skills through the session endpoint", async () => {
    const response: EffectiveSkillsResponse = {
      mode: "workspace_effective",
      workspace_root: "D:/repo",
      fingerprint: "abc123",
      loaded_at: "2026-06-25T12:00:00Z",
      skills: [
        {
          name: "dev-plan",
          description: "Create a development plan",
          source: "workspace",
          label: "/dev-plan",
          locator: ".keydex/skills/dev-plan/SKILL.md",
        },
      ],
      diagnostics: [],
    };
    const request = vi.fn(async () => response);
    const runtime = createSkillRuntime({ request } as unknown as HttpClient);

    await expect(runtime.listSession("ses 1")).resolves.toBe(response);

    expect(request).toHaveBeenCalledWith("/api/sessions/ses%201/skills", {
      signal: undefined,
    });
  });

  it("loads workspace skills through the workspace endpoint before a session exists", async () => {
    const response: EffectiveSkillsResponse = {
      mode: "workspace_effective",
      workspace_root: "D:/repo",
      fingerprint: "abc123",
      loaded_at: "2026-06-25T12:00:00Z",
      skills: [],
      diagnostics: [],
    };
    const request = vi.fn(async () => response);
    const runtime = createSkillRuntime({ request } as unknown as HttpClient);

    await expect(runtime.listWorkspace("ws 1")).resolves.toBe(response);

    expect(request).toHaveBeenCalledWith("/api/workspaces/ws%201/skills", {
      signal: undefined,
    });
  });

  it("loads system-only bootstrap without a workspace root", async () => {
    const response: EffectiveSkillsResponse = {
      mode: "system_only",
      workspace_root: null,
      fingerprint: "system-fingerprint",
      loaded_at: "2026-07-15T00:00:00Z",
      skills: [],
      diagnostics: [],
    };
    const request = vi.fn(async () => response);
    const runtime = createSkillRuntime({ request } as unknown as HttpClient);

    await expect(runtime.listSystem()).resolves.toBe(response);

    expect(request).toHaveBeenCalledWith("/api/keydex/skills", { signal: undefined });
  });

  it("passes force reload and abort signal when loading effective skills", async () => {
    const response: EffectiveSkillsResponse = {
      mode: "workspace_effective",
      workspace_root: "D:/repo",
      fingerprint: "abc123",
      loaded_at: "2026-06-25T12:00:00Z",
      skills: [],
      diagnostics: [
        {
          code: "skill_frontmatter_missing_description",
          reason: "frontmatter field 'description' is required",
          path: ".keydex/skills/broken/SKILL.md",
          severity: "error",
          details: {},
        },
      ],
    };
    const signal = new AbortController().signal;
    const request = vi.fn(async () => response);
    const runtime = createSkillRuntime({ request } as unknown as HttpClient);

    await expect(
      runtime.listSession("ses 1", { forceReload: true, signal }),
    ).resolves.toBe(response);

    expect(request).toHaveBeenCalledWith(
      "/api/sessions/ses%201/skills?force_reload=true",
      { signal },
    );
  });

  it("reads resources through all three scopes without workspace file paths", async () => {
    const response: SkillResourceReadResponse = {
      skill_name: "review",
      source: "system",
      resource_path: "references/guide.md",
      locator: ".keydex/skills/review/references/guide.md",
      content: "guide",
      encoding: "utf-8",
      revision: "sha256",
      fingerprint: "system-fingerprint",
    };
    const signal = new AbortController().signal;
    const request = vi.fn(async () => response);
    const runtime = createSkillRuntime({ request } as unknown as HttpClient);
    const body = {
      skill_name: "review",
      source: "system" as const,
      resource_path: "references/guide.md",
    };

    await expect(runtime.readSystemResource(body, { signal })).resolves.toBe(response);
    await expect(runtime.readWorkspaceResource("ws 1", body)).resolves.toBe(response);
    await expect(runtime.readSessionResource("ses 1", body)).resolves.toBe(response);

    expect(response.locator).toBe(".keydex/skills/review/references/guide.md");
    expect(response).not.toHaveProperty("path");
    expect(request).toHaveBeenNthCalledWith(1, "/api/keydex/skills/read", {
      method: "POST",
      body,
      signal,
    });
    expect(request).toHaveBeenNthCalledWith(2, "/api/workspaces/ws%201/skills/read", {
      method: "POST",
      body,
      signal: undefined,
    });
    expect(request).toHaveBeenNthCalledWith(3, "/api/sessions/ses%201/skills/read", {
      method: "POST",
      body,
      signal: undefined,
    });
  });
});

describe("keydex runtime overview", () => {
  const response: RuntimeOverviewResponse = {
    mode: "workspace_effective",
    fingerprint: "runtime-fingerprint",
    loaded_at: "2026-07-15T12:00:00Z",
    layers: [],
    capabilities: {
      skills: {
        available: true,
        fingerprint: "skills-fingerprint",
        sources: [],
        diagnostics: [],
        count: 2,
      },
      keydex_markdown: {
        available: true,
        fingerprint: "markdown-fingerprint",
        sources: ["system:keydex.md", "workspace:.keydex/keydex.md"],
        diagnostics: [],
        document_count: 2,
        total_bytes: 42,
      },
    },
    diagnostics: [],
  };

  it("routes all three overview scopes with encoded ids", async () => {
    const request = vi.fn(async () => response);
    const runtime = createKeydexRuntime({ request } as unknown as HttpClient);

    await expect(runtime.listSystem()).resolves.toBe(response);
    await expect(runtime.listWorkspace("ws 1")).resolves.toBe(response);
    await expect(runtime.listSession("ses 1")).resolves.toBe(response);

    expect(request).toHaveBeenNthCalledWith(1, "/api/keydex/runtime", {
      signal: undefined,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/workspaces/ws%201/keydex/runtime",
      { signal: undefined },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "/api/sessions/ses%201/keydex/runtime",
      { signal: undefined },
    );
  });

  it("passes force reload and abort signal", async () => {
    const request = vi.fn(async () => response);
    const runtime = createKeydexRuntime({ request } as unknown as HttpClient);
    const signal = new AbortController().signal;

    await runtime.listSession("ses 1", { forceReload: true, signal });

    expect(request).toHaveBeenCalledWith(
      "/api/sessions/ses%201/keydex/runtime?force_reload=true",
      { signal },
    );
  });
});
