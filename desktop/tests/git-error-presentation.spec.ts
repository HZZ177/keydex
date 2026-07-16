import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GIT_ERROR_CODES,
  GIT_ERROR_PRESENTATIONS,
  formatGitErrorMessage,
  gitErrorPresentation,
  gitOperationErrorMessage,
  gitUiErrorMessage,
} from "@/renderer/features/git/errorPresentation";
import { RuntimeHttpError } from "@/runtime/errors";
import { normalizeErrorEnvelope } from "@/runtime/httpClient";

describe("Git error presentation contract", () => {
  it("matches the backend source-of-truth codes exactly", () => {
    const backendContract = readFileSync(resolve(process.cwd(), "../backend/app/git/error_contract.py"), "utf8");
    const backendCodes = [...backendContract.matchAll(/^\s{4}"(git_[a-z0-9_]+)":/gm)].map((match) => match[1]);
    expect([...GIT_ERROR_CODES].sort()).toEqual(backendCodes.sort());
    expect(Object.keys(GIT_ERROR_PRESENTATIONS).sort()).toEqual([...GIT_ERROR_CODES].sort());
  });

  it("gives every error explicit Chinese copy, retry, confirmation and help behavior", () => {
    for (const code of GIT_ERROR_CODES) {
      const presentation = GIT_ERROR_PRESENTATIONS[code];
      expect(presentation.title).toMatch(/[\u4e00-\u9fff]/);
      expect(presentation.fallbackMessage).toMatch(/[\u4e00-\u9fff]/);
      expect(presentation.helpAction).toMatch(/[\u4e00-\u9fff]/);
      expect(["immediate", "after_fix", "refresh", "never"]).toContain(presentation.retryAction);
      expect(["none", "grant", "repreview", "reconfirm"]).toContain(presentation.confirmationAction);
    }
    expect(GIT_ERROR_PRESENTATIONS.git_network_unavailable.retryAction).toBe("immediate");
    expect(GIT_ERROR_PRESENTATIONS.git_operation_conflict.confirmationAction).toBe("repreview");
    expect(GIT_ERROR_PRESENTATIONS.git_ancestor_not_authorized.confirmationAction).toBe("grant");
  });

  it("preserves retryable HTTP metadata and renders mapped and unknown errors safely", () => {
    expect(normalizeErrorEnvelope(503, {
      code: "git_network_unavailable",
      message: "offline",
      retryable: true,
    })).toMatchObject({ code: "git_network_unavailable", retryable: true });

    const error = new RuntimeHttpError({
      code: "git_credentials_missing",
      message: "credential rejected",
      retryable: true,
      status: 401,
      method: "POST",
      path: "/api/git/push",
      body: {},
      rawText: "",
    });
    expect(error.retryable).toBe(true);
    expect(gitUiErrorMessage(error)).toContain("Git 凭据不可用：credential rejected");
    expect(formatGitErrorMessage("git_timeout", "", "")).toContain("检查仓库、网络或远程响应后重试");
    expect(gitOperationErrorMessage({
      summary: "fetch",
      result: { error_code: "git_network_unavailable", error: "offline" },
    })).toContain("Git 远程不可达：offline");
    expect(gitErrorPresentation("git_future_error").title).toBe("未知 Git 错误");
  });
});
