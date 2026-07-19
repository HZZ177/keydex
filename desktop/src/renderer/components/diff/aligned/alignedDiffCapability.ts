import type { KeydexDiffFile } from "../model";
import type { KeydexDiffProfileContract } from "../profiles";
import {
  DIFF_RESPONSIVE_TARGET_BYTES,
  DIFF_RESPONSIVE_TARGET_LINES,
} from "../largeDiffPolicy";

export type AlignedDiffCapabilityReason =
  | "available"
  | "profile_disabled"
  | "worker_unavailable"
  | "binary"
  | "unsupported_encoding"
  | "truncated"
  | "responsive_limit";

export interface AlignedDiffCapabilityDecision {
  readonly renderer: "aligned" | "stacked";
  readonly reason: AlignedDiffCapabilityReason;
  readonly connector: boolean;
  readonly syncScroll: boolean;
  readonly allowPatchSelection: boolean;
}

export function resolveAlignedDiffCapability(
  file: KeydexDiffFile,
  profile: KeydexDiffProfileContract,
  workerAvailable: boolean,
): AlignedDiffCapabilityDecision {
  const reason = alignedUnavailableReason(file, profile, workerAvailable);
  const aligned = reason === "available";
  return Object.freeze({
    renderer: aligned ? "aligned" : "stacked",
    reason,
    connector: aligned && profile.connector,
    syncScroll: aligned && profile.syncScroll,
    allowPatchSelection: aligned
      && file.selectableForPatch
      && file.precision === "exact"
      && file.truncation.state === "complete",
  });
}

function alignedUnavailableReason(
  file: KeydexDiffFile,
  profile: KeydexDiffProfileContract,
  workerAvailable: boolean,
): AlignedDiffCapabilityReason {
  if (!profile.alignedSplit) return "profile_disabled";
  if (file.binary || file.contentKind === "binary" || file.contentKind === "submodule") return "binary";
  if (file.contentKind === "unknown_encoding") return "unsupported_encoding";
  if (file.truncation.state !== "complete" || file.truncated) return "truncated";
  const bytes = new TextEncoder().encode(file.patch).byteLength;
  const lines = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
  if (bytes > DIFF_RESPONSIVE_TARGET_BYTES || lines > DIFF_RESPONSIVE_TARGET_LINES) {
    return "responsive_limit";
  }
  return workerAvailable ? "available" : "worker_unavailable";
}
