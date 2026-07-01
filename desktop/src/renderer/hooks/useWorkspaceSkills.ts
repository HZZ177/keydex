import { useCallback, useEffect, useRef, useState } from "react";

import type {
  KeydexDiagnostic,
  RuntimeBridge,
  WorkspaceScope,
  WorkspaceSkillSummary,
} from "@/runtime";

export type WorkspaceSkillLoadStatus = "idle" | "loading" | "ready" | "error";

export interface WorkspaceSkillState {
  workspaceRoot: string;
  skills: WorkspaceSkillSummary[];
  diagnostics: KeydexDiagnostic[];
  fingerprint: string | null;
  status: WorkspaceSkillLoadStatus;
  loadedAt: number | null;
  error: string | null;
}

export interface UseWorkspaceSkillsOptions {
  runtime: Pick<RuntimeBridge, "workspace">;
  scope: WorkspaceScope | null;
  enabled: boolean;
}

export interface RefreshWorkspaceSkillsOptions {
  forceReload?: boolean;
  reset?: boolean;
}

export function useWorkspaceSkills({
  runtime,
  scope,
  enabled,
}: UseWorkspaceSkillsOptions) {
  const [state, setState] = useState<WorkspaceSkillState>(() => idleWorkspaceSkillState());
  const requestIdRef = useRef(0);
  const sessionId = scope && "sessionId" in scope ? scope.sessionId : "";
  const workspaceId = scope && "workspaceId" in scope ? scope.workspaceId : "";

  const refresh = useCallback(
    async ({ forceReload = false, reset = false }: RefreshWorkspaceSkillsOptions = {}) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const activeScope: WorkspaceScope | null = sessionId
        ? { sessionId }
        : workspaceId
          ? { workspaceId }
          : null;
      if (!enabled || !activeScope) {
        setState(idleWorkspaceSkillState());
        return;
      }

      setState((previous) => ({
        ...(reset ? idleWorkspaceSkillState() : previous),
        status: "loading",
        error: null,
      }));

      try {
        const response = await runtime.workspace.listSkills(
          activeScope,
          { forceReload },
        );
        if (requestId !== requestIdRef.current) {
          return;
        }
        setState({
          workspaceRoot: response.workspace_root || "",
          skills: Array.isArray(response.skills) ? response.skills : [],
          diagnostics: Array.isArray(response.diagnostics) ? response.diagnostics : [],
          fingerprint: response.fingerprint || null,
          status: "ready",
          loadedAt: loadedAtMs(response.loaded_at),
          error: null,
        });
      } catch (reason) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setState((previous) => ({
          ...previous,
          status: "error",
          error: errorText(reason),
        }));
      }
    },
    [enabled, runtime, sessionId, workspaceId],
  );

  useEffect(() => {
    void refresh({ reset: true });
  }, [refresh]);

  return { state, refresh };
}

function idleWorkspaceSkillState(): WorkspaceSkillState {
  return {
    workspaceRoot: "",
    skills: [],
    diagnostics: [],
    fingerprint: null,
    status: "idle",
    loadedAt: null,
    error: null,
  };
}

function loadedAtMs(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason || "加载 Skill 列表失败");
}
