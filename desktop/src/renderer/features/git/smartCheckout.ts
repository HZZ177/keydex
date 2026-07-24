import type {
  GitCommandBase,
  GitRuntime,
  GitStashEntry,
} from "@/runtime/git";
import type {
  GitCommandResult,
  GitRef,
  GitRepositoryVersion,
} from "@/runtime/gitTypes";

export type GitCheckoutIntent =
  | {
      kind: "switch";
      label: string;
      ref: string;
      detach: boolean;
    }
  | {
      kind: "track_remote";
      label: string;
      remoteRef: string;
      localBranch: string;
    };

export type GitCheckoutScope = Pick<
  GitCommandBase,
  "workspaceId" | "projectRoot" | "repositoryId"
>;

export type RunGitCommand = (
  submit: () => Promise<GitCommandResult>,
) => Promise<GitCommandResult>;

export interface RunCheckoutOptions {
  runtime: GitRuntime;
  runCommand: RunGitCommand;
  scope: GitCheckoutScope;
  intent: GitCheckoutIntent;
  expectedRepositoryVersion: GitRepositoryVersion | null;
  idempotencyKey: string;
}

export type SmartCheckoutFailureStage =
  | "stash"
  | "stash_lookup"
  | "checkout"
  | "restore";

export type SmartCheckoutResult =
  | {
      state: "succeeded";
      checkout: GitCommandResult;
      restore: GitCommandResult;
    }
  | {
      state: "failed";
      stage: SmartCheckoutFailureStage;
      operation: GitCommandResult | null;
      stash: GitStashEntry | null;
    };

export interface RunSmartCheckoutOptions
  extends Omit<RunCheckoutOptions, "expectedRepositoryVersion" | "idempotencyKey"> {
  expectedRepositoryVersion: GitRepositoryVersion | null;
  createIdempotencyKey: (action: string) => string;
}

export function checkoutIntentForRef(
  selected: GitRef,
  refs: readonly GitRef[],
): GitCheckoutIntent {
  if (selected.kind === "local") {
    return {
      kind: "switch",
      label: selected.shortName,
      ref: selected.shortName,
      detach: false,
    };
  }
  if (selected.kind === "remote") {
    const separator = selected.shortName.indexOf("/");
    const localBranch = separator >= 0
      ? selected.shortName.slice(separator + 1)
      : selected.shortName;
    const existingLocal = refs.find(
      (candidate) => candidate.kind === "local" && candidate.shortName === localBranch,
    );
    if (existingLocal) {
      return {
        kind: "switch",
        label: existingLocal.shortName,
        ref: existingLocal.shortName,
        detach: false,
      };
    }
    return {
      kind: "track_remote",
      label: selected.shortName,
      remoteRef: selected.shortName,
      localBranch,
    };
  }
  return {
    kind: "switch",
    label: selected.shortName,
    ref: selected.shortName,
    detach: true,
  };
}

export function checkoutIntentForRevision(
  ref: string,
  detach: boolean,
): GitCheckoutIntent {
  const normalized = ref.trim();
  return {
    kind: "switch",
    label: normalized,
    ref: normalized,
    detach,
  };
}

export function requiresSmartCheckout(operation: GitCommandResult): boolean {
  return operation.state === "failed"
    && operation.error?.code === "git_checkout_conflict";
}

export async function runCheckoutIntent({
  runtime,
  runCommand,
  scope,
  intent,
  expectedRepositoryVersion,
  idempotencyKey,
}: RunCheckoutOptions): Promise<GitCommandResult> {
  if (intent.kind === "track_remote") {
    return runCommand(() => runtime.createBranch({
      ...scope,
      idempotencyKey,
      expectedRepositoryVersion,
      branchName: intent.localBranch,
      startPoint: intent.remoteRef,
      track: true,
    }));
  }
  return runCommand(() => runtime.checkout({
    ...scope,
    idempotencyKey,
    expectedRepositoryVersion,
    ref: intent.ref,
    detach: intent.detach,
  }));
}

export async function runSmartCheckout({
  runtime,
  runCommand,
  scope,
  intent,
  expectedRepositoryVersion,
  createIdempotencyKey,
}: RunSmartCheckoutOptions): Promise<SmartCheckoutResult> {
  const marker = createIdempotencyKey("smart-checkout");
  let stashOperation: GitCommandResult;
  try {
    stashOperation = await runCommand(() => runtime.createStash({
      ...scope,
      idempotencyKey: createIdempotencyKey("smart-checkout-stash"),
      expectedRepositoryVersion,
      message: `${marker}：切换到 ${intent.label} 前的临时储藏`,
      staged: false,
      includeUntracked: true,
    }));
  } catch {
    return { state: "failed", stage: "stash", operation: null, stash: null };
  }
  if (stashOperation.state !== "succeeded") {
    return { state: "failed", stage: "stash", operation: stashOperation, stash: null };
  }

  let stashPage: Awaited<ReturnType<GitRuntime["stashList"]>>;
  try {
    stashPage = await runtime.stashList(scope, { limit: 50 });
  } catch {
    return { state: "failed", stage: "stash_lookup", operation: null, stash: null };
  }
  const stash = stashPage.entries.find((entry) => entry.message.includes(marker)) ?? null;
  if (!stash) {
    return { state: "failed", stage: "stash_lookup", operation: null, stash: null };
  }

  let checkout: GitCommandResult;
  try {
    checkout = await runCheckoutIntent({
      runtime,
      runCommand,
      scope,
      intent,
      expectedRepositoryVersion: null,
      idempotencyKey: createIdempotencyKey("smart-checkout-switch"),
    });
  } catch {
    return { state: "failed", stage: "checkout", operation: null, stash };
  }
  if (checkout.state !== "succeeded") {
    return { state: "failed", stage: "checkout", operation: checkout, stash };
  }

  let restore: GitCommandResult;
  try {
    restore = await runCommand(() => runtime.popStash({
      ...scope,
      idempotencyKey: createIdempotencyKey("smart-checkout-restore"),
      expectedRepositoryVersion: null,
      selector: stash.selector,
      objectId: stash.objectId,
      reinstateIndex: true,
    }));
  } catch {
    return { state: "failed", stage: "restore", operation: null, stash };
  }
  if (restore.state !== "succeeded") {
    return { state: "failed", stage: "restore", operation: restore, stash };
  }
  return { state: "succeeded", checkout, restore };
}

export function smartCheckoutFailureMessage(result: Extract<SmartCheckoutResult, { state: "failed" }>): string {
  const detail = result.operation?.error?.message?.trim();
  if (result.stage === "stash") {
    return detail ? `无法临时储藏本地改动：${detail}` : "无法临时储藏本地改动，尚未切换分支。";
  }
  if (result.stage === "stash_lookup") {
    return "本地改动已储藏，但无法确认本次储藏条目；尚未切换分支，请在 Git 面板的储藏中恢复。";
  }
  if (result.stage === "checkout") {
    return detail
      ? `本地改动已安全储藏，但签出失败：${detail}`
      : "本地改动已安全储藏，但签出失败；可在 Git 面板的储藏中恢复。";
  }
  return detail
    ? `已切换分支，但自动恢复改动时发生冲突：${detail}。储藏仍保留。`
    : "已切换分支，但自动恢复改动时发生冲突；储藏仍保留，请在 Git 面板中继续处理。";
}
