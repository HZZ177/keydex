import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EffectiveSkillsMode,
  KeydexDiagnostic,
  RuntimeBridge,
  SkillSummary,
} from "@/runtime";

export type EffectiveSkillScope =
  | { type: "system" }
  | { type: "workspace"; workspaceId: string; workspaceRoot?: string | null }
  | { type: "session"; sessionId: string };

export type EffectiveSkillLoadStatus = "idle" | "loading" | "ready" | "error";

export interface EffectiveSkillState {
  mode: EffectiveSkillsMode | null;
  workspaceRoot: string | null;
  skills: SkillSummary[];
  diagnostics: KeydexDiagnostic[];
  fingerprint: string | null;
  status: EffectiveSkillLoadStatus;
  loadedAt: number | null;
  error: string | null;
}

export interface UseEffectiveSkillsOptions {
  runtime: Pick<RuntimeBridge, "skills">;
  scope: EffectiveSkillScope | null;
  enabled: boolean;
}

export interface RefreshEffectiveSkillsOptions {
  forceReload?: boolean;
  reset?: boolean;
}

export type SkillSelectionStatus = "valid" | "source_changed" | "missing";

export function useEffectiveSkills({
  runtime,
  scope,
  enabled,
}: UseEffectiveSkillsOptions) {
  const [state, setState] = useState<EffectiveSkillState>(() => idleEffectiveSkillState());
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fingerprintRef = useRef<string | null>(null);
  const lastEventFingerprintRef = useRef<string | null>(null);
  const scopeKey = effectiveSkillScopeKey(scope);

  const refresh = useCallback(
    async ({ forceReload = false, reset = false }: RefreshEffectiveSkillsOptions = {}) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      abortRef.current?.abort();
      abortRef.current = null;
      if (!enabled || !scope) {
        fingerprintRef.current = null;
        lastEventFingerprintRef.current = null;
        setState(idleEffectiveSkillState());
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setState((previous) => ({
        ...(reset ? idleEffectiveSkillState() : previous),
        status: "loading",
        error: null,
      }));

      try {
        const options = { forceReload, signal: controller.signal };
        const response = scope.type === "system"
          ? await runtime.skills.listSystem(options)
          : scope.type === "workspace"
            ? await runtime.skills.listWorkspace(scope.workspaceId, options)
            : await runtime.skills.listSession(scope.sessionId, options);
        if (requestId !== requestIdRef.current || controller.signal.aborted) {
          return;
        }
        const nextState: EffectiveSkillState = {
          mode: response.mode,
          workspaceRoot: response.workspace_root || null,
          skills: Array.isArray(response.skills) ? response.skills : [],
          diagnostics: Array.isArray(response.diagnostics) ? response.diagnostics : [],
          fingerprint: response.fingerprint || null,
          status: "ready",
          loadedAt: loadedAtMs(response.loaded_at),
          error: null,
        };
        fingerprintRef.current = nextState.fingerprint;
        setState(nextState);
      } catch (reason) {
        if (
          requestId !== requestIdRef.current ||
          controller.signal.aborted ||
          isAbortError(reason)
        ) {
          return;
        }
        lastEventFingerprintRef.current = null;
        setState((previous) => ({
          ...previous,
          status: "error",
          error: errorText(reason),
        }));
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [enabled, runtime, scopeKey],
  );

  const handleSkillsChanged = useCallback(
    (data: Record<string, unknown>) => {
      if (!enabled || !scope || !matchesEffectiveSkillScope(scope, data)) {
        return false;
      }
      const eventFingerprint = stringValue(
        data.effective_fingerprint ?? data.effectiveFingerprint ?? data.fingerprint,
      );
      if (
        eventFingerprint &&
        (eventFingerprint === fingerprintRef.current ||
          eventFingerprint === lastEventFingerprintRef.current)
      ) {
        return false;
      }
      lastEventFingerprintRef.current = eventFingerprint || null;
      void refresh({ forceReload: true });
      return true;
    },
    [enabled, refresh, scopeKey],
  );

  useEffect(() => {
    fingerprintRef.current = null;
    lastEventFingerprintRef.current = null;
    void refresh({ reset: true });
    return () => {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [refresh]);

  return { state, refresh, handleSkillsChanged };
}

export function skillSelectionStatus(
  selected: Pick<SkillSummary, "name" | "source">,
  skills: SkillSummary[],
): SkillSelectionStatus {
  const sameName = skills.filter((skill) => skill.name === selected.name);
  if (sameName.some((skill) => skill.source === selected.source)) {
    return "valid";
  }
  return sameName.length > 0 ? "source_changed" : "missing";
}

export function matchesEffectiveSkillScope(
  scope: EffectiveSkillScope,
  data: Record<string, unknown>,
): boolean {
  const sessionId = stringValue(data.session_id ?? data.sessionId);
  const sessionScope = stringValue(data.session_scope ?? data.sessionScope);
  const workspaceRoot = stringValue(data.workspace_root ?? data.workspaceRoot);
  if (scope.type === "session") {
    return sessionId === scope.sessionId;
  }
  if (scope.type === "system") {
    return sessionScope === "system" && !workspaceRoot;
  }
  if (sessionScope !== "workspace") {
    return false;
  }
  return !scope.workspaceRoot || normalizedPath(scope.workspaceRoot) === normalizedPath(workspaceRoot);
}

function effectiveSkillScopeKey(scope: EffectiveSkillScope | null): string {
  if (!scope) return "none";
  if (scope.type === "system") return "system";
  if (scope.type === "workspace") {
    const rootKey = scope.workspaceRoot ? normalizedPath(scope.workspaceRoot) : "";
    return `workspace:${scope.workspaceId}:${rootKey}`;
  }
  return `session:${scope.sessionId}`;
}

function idleEffectiveSkillState(): EffectiveSkillState {
  return {
    mode: null,
    workspaceRoot: null,
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason || "加载 Skill 列表失败");
}
