import type {
  KeydexDiffHunkCapability,
  KeydexDiffProfileContract,
} from "../profiles";
import { KEYDEX_DIFF_HUNK_WRITE_CAPABILITIES } from "../profiles";

export interface KeydexDiffHunkActionTarget {
  readonly fileId: string;
  readonly fileCacheKey: string;
  readonly sourceVersion: string;
  readonly modelVersion: string;
  readonly hunkId: string | null;
  readonly changeId: string;
}

export interface KeydexDiffHunkActionEvent extends KeydexDiffHunkActionTarget {
  readonly action: KeydexDiffHunkCapability;
}

export type KeydexDiffHunkActionBlockReason =
  | "capability_not_allowed"
  | "stale_source"
  | "busy"
  | "disabled";

export type KeydexDiffHunkActionDecision =
  | { readonly allowed: true; readonly event: KeydexDiffHunkActionEvent }
  | { readonly allowed: false; readonly reason: KeydexDiffHunkActionBlockReason };

export interface ResolveKeydexDiffHunkActionOptions {
  readonly profile: Pick<KeydexDiffProfileContract, "hunkActions">;
  readonly action: KeydexDiffHunkCapability;
  readonly target: KeydexDiffHunkActionTarget;
  readonly currentSourceVersion: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
}

export function resolveKeydexDiffHunkAction(
  options: ResolveKeydexDiffHunkActionOptions,
): KeydexDiffHunkActionDecision {
  if (!options.profile.hunkActions.includes(options.action)) {
    return Object.freeze({ allowed: false, reason: "capability_not_allowed" });
  }
  if (options.target.sourceVersion !== options.currentSourceVersion) {
    return Object.freeze({ allowed: false, reason: "stale_source" });
  }
  if (options.busy) return Object.freeze({ allowed: false, reason: "busy" });
  if (options.disabled) return Object.freeze({ allowed: false, reason: "disabled" });
  return Object.freeze({
    allowed: true,
    event: Object.freeze({ action: options.action, ...options.target }),
  });
}

export function isKeydexDiffHunkWriteCapability(
  capability: KeydexDiffHunkCapability,
): boolean {
  return KEYDEX_DIFF_HUNK_WRITE_CAPABILITIES.includes(
    capability as (typeof KEYDEX_DIFF_HUNK_WRITE_CAPABILITIES)[number],
  );
}

export function dispatchKeydexDiffHunkAction(
  decision: KeydexDiffHunkActionDecision,
  dispatch: (event: KeydexDiffHunkActionEvent) => void,
): boolean {
  if (!decision.allowed) return false;
  dispatch(decision.event);
  return true;
}
