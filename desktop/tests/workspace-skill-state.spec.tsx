import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  matchesEffectiveSkillScope,
  skillSelectionStatus,
  useEffectiveSkills,
} from "@/renderer/hooks/useEffectiveSkills";
import type { EffectiveSkillsResponse, RuntimeBridge, SkillSummary } from "@/runtime";

describe("useEffectiveSkills", () => {
  it("stays idle while disabled", () => {
    const runtime = runtimeWithSkills();
    const { result } = renderHook(() =>
      useEffectiveSkills({ runtime, scope: { type: "system" }, enabled: false }),
    );

    expect(result.current.state.status).toBe("idle");
    expect(runtime.skills.listSystem).not.toHaveBeenCalled();
  });

  it("loads system, workspace and session scopes through one runtime", async () => {
    const runtime = runtimeWithSkills();
    const { result, rerender } = renderHook(
      ({ scope }) => useEffectiveSkills({ runtime, scope, enabled: true }),
      { initialProps: { scope: { type: "system" } as constScope } },
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(runtime.skills.listSystem).toHaveBeenCalledWith(
      expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
    );

    rerender({ scope: { type: "workspace", workspaceId: "ws-1" } });
    await waitFor(() => expect(runtime.skills.listWorkspace).toHaveBeenCalled());
    expect(runtime.skills.listWorkspace).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
    );

    rerender({ scope: { type: "session", sessionId: "ses-1" } });
    await waitFor(() => expect(runtime.skills.listSession).toHaveBeenCalled());
    expect(runtime.skills.listSession).toHaveBeenCalledWith(
      "ses-1",
      expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
    );
  });

  it("aborts and ignores a late response after a fast scope switch", async () => {
    let resolveFirst!: (value: EffectiveSkillsResponse) => void;
    let firstSignal: AbortSignal | undefined;
    const first = new Promise<EffectiveSkillsResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const runtime = runtimeWithSkills({
      listSession: vi.fn((_id, options) => {
        firstSignal = options?.signal;
        return first;
      }),
      listWorkspace: vi.fn().mockResolvedValue(response("workspace-new", [skill("new", "workspace")])),
    });
    const { result, rerender } = renderHook(
      ({ scope }) => useEffectiveSkills({ runtime, scope, enabled: true }),
      { initialProps: { scope: { type: "session", sessionId: "ses-old" } as constScope } },
    );
    await waitFor(() => expect(runtime.skills.listSession).toHaveBeenCalled());

    rerender({ scope: { type: "workspace", workspaceId: "ws-new" } });
    await waitFor(() => expect(result.current.state.fingerprint).toBe("workspace-new"));
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      resolveFirst(response("late-old", [skill("old", "system")]));
      await first;
    });
    expect(result.current.state.fingerprint).toBe("workspace-new");
    expect(result.current.state.skills.map((item) => item.name)).toEqual(["new"]);
  });

  it("reloads when the workspace root changes without changing the workspace id", async () => {
    const runtime = runtimeWithSkills();
    const { rerender } = renderHook(
      ({ workspaceRoot }) =>
        useEffectiveSkills({
          runtime,
          scope: { type: "workspace", workspaceId: "ws-1", workspaceRoot },
          enabled: true,
        }),
      { initialProps: { workspaceRoot: "D:/repo-a" } },
    );
    await waitFor(() => expect(runtime.skills.listWorkspace).toHaveBeenCalledTimes(1));

    rerender({ workspaceRoot: "D:/repo-b" });

    await waitFor(() => expect(runtime.skills.listWorkspace).toHaveBeenCalledTimes(2));
  });

  it("atomically replaces winners instead of merging layer arrays", async () => {
    const listSystem = vi
      .fn()
      .mockResolvedValueOnce(
        response("fp-1", [skill("shared", "system"), skill("global", "system")]),
      )
      .mockResolvedValueOnce(response("fp-2", [skill("shared", "workspace")]));
    const runtime = runtimeWithSkills({ listSystem });
    const { result } = renderHook(() =>
      useEffectiveSkills({ runtime, scope: { type: "system" }, enabled: true }),
    );
    await waitFor(() => expect(result.current.state.fingerprint).toBe("fp-1"));

    await act(async () => {
      await result.current.refresh({ forceReload: true });
    });

    expect(result.current.state.fingerprint).toBe("fp-2");
    expect(result.current.state.skills).toEqual([skill("shared", "workspace")]);
  });

  it("preserves the last complete response when a refresh fails", async () => {
    const listSystem = vi
      .fn()
      .mockResolvedValueOnce(response("fp-1", [skill("review", "system")]))
      .mockRejectedValueOnce(new Error("offline"));
    const runtime = runtimeWithSkills({ listSystem });
    const { result } = renderHook(() =>
      useEffectiveSkills({ runtime, scope: { type: "system" }, enabled: true }),
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      await result.current.refresh({ forceReload: true });
    });

    expect(result.current.state.status).toBe("error");
    expect(result.current.state.fingerprint).toBe("fp-1");
    expect(result.current.state.skills).toEqual([skill("review", "system")]);
  });

  it("refreshes only matching watcher events and ignores duplicate fingerprints", async () => {
    const listSession = vi
      .fn()
      .mockResolvedValueOnce(response("fp-1"))
      .mockResolvedValue(response("fp-2"));
    const runtime = runtimeWithSkills({ listSession });
    const { result } = renderHook(() =>
      useEffectiveSkills({
        runtime,
        scope: { type: "session", sessionId: "ses-1" },
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.state.fingerprint).toBe("fp-1"));

    act(() => {
      expect(result.current.handleSkillsChanged({
        session_id: "ses-other",
        fingerprint: "fp-other",
      })).toBe(false);
      expect(result.current.handleSkillsChanged({
        session_id: "ses-1",
        fingerprint: "fp-2",
      })).toBe(true);
      expect(result.current.handleSkillsChanged({
        session_id: "ses-1",
        fingerprint: "fp-2",
      })).toBe(false);
    });
    await waitFor(() => expect(result.current.state.fingerprint).toBe("fp-2"));
    expect(listSession).toHaveBeenCalledTimes(2);
    expect(listSession).toHaveBeenLastCalledWith(
      "ses-1",
      expect.objectContaining({ forceReload: true }),
    );
  });
});

describe("effective skill helpers", () => {
  it("matches system and workspace watcher scopes without cross-refresh", () => {
    expect(matchesEffectiveSkillScope(
      { type: "system" },
      { session_scope: "system", workspace_root: null },
    )).toBe(true);
    expect(matchesEffectiveSkillScope(
      { type: "workspace", workspaceId: "ws-1", workspaceRoot: "D:/Repo" },
      { session_scope: "workspace", workspace_root: "d:\\repo" },
    )).toBe(true);
    expect(matchesEffectiveSkillScope(
      { type: "workspace", workspaceId: "ws-1", workspaceRoot: "D:/Repo" },
      { session_scope: "workspace", workspace_root: "D:/Other" },
    )).toBe(false);
  });

  it("validates selected skills by both name and source", () => {
    const selected = skill("shared", "system");
    expect(skillSelectionStatus(selected, [selected])).toBe("valid");
    expect(skillSelectionStatus(selected, [skill("shared", "workspace")])).toBe(
      "source_changed",
    );
    expect(skillSelectionStatus(selected, [])).toBe("missing");
  });
});

type constScope =
  | { readonly type: "system" }
  | { readonly type: "workspace"; readonly workspaceId: string }
  | { readonly type: "session"; readonly sessionId: string };

function runtimeWithSkills(overrides: {
  listSystem?: ReturnType<typeof vi.fn>;
  listWorkspace?: ReturnType<typeof vi.fn>;
  listSession?: ReturnType<typeof vi.fn>;
} = {}) {
  const defaultResponse = response("fp");
  return {
    skills: {
      listSystem: overrides.listSystem ?? vi.fn().mockResolvedValue(defaultResponse),
      listWorkspace: overrides.listWorkspace ?? vi.fn().mockResolvedValue(defaultResponse),
      listSession: overrides.listSession ?? vi.fn().mockResolvedValue(defaultResponse),
    },
  } as unknown as Pick<RuntimeBridge, "skills">;
}

function response(
  fingerprint: string,
  skills: SkillSummary[] = [],
): EffectiveSkillsResponse {
  return {
    mode: "workspace_effective",
    workspace_root: "D:/repo",
    fingerprint,
    loaded_at: "2026-07-15T00:00:00Z",
    skills,
    diagnostics: [],
  };
}

function skill(name: string, source: SkillSummary["source"]): SkillSummary {
  return {
    name,
    source,
    description: `${source} ${name}`,
    label: `/${name}`,
    locator: `.keydex/skills/${name}/SKILL.md`,
  };
}
