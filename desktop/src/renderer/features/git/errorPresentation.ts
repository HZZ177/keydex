export const GIT_ERROR_CODES = [
  "git_invalid_request",
  "git_access_denied",
  "git_ancestor_not_authorized",
  "git_repository_not_found",
  "git_operation_conflict",
  "git_validation_failed",
  "git_cancelled",
  "git_unavailable",
  "git_timeout",
  "git_failed",
  "git_credentials_missing",
  "git_credential_helper_failed",
  "git_host_key_failed",
  "git_network_unavailable",
  "git_parse_failed",
  "git_output_too_large",
] as const;

export type GitErrorCode = (typeof GIT_ERROR_CODES)[number];
export type GitErrorRetryAction = "immediate" | "after_fix" | "refresh" | "never";
export type GitErrorConfirmationAction = "none" | "grant" | "repreview" | "reconfirm";

export interface GitErrorPresentation {
  title: string;
  fallbackMessage: string;
  retryAction: GitErrorRetryAction;
  confirmationAction: GitErrorConfirmationAction;
  helpAction: string;
}

export const GIT_ERROR_PRESENTATIONS = {
  git_invalid_request: entry("Git 请求无效", "请求的 Git 操作或参数无效。", "never", "none", "检查当前操作的输入后重新发起。"),
  git_access_denied: entry("仓库访问被拒绝", "当前项目没有访问该仓库的权限。", "after_fix", "grant", "检查项目路径和仓库授权；不要通过扩大工作区范围绕过授权。"),
  git_ancestor_not_authorized: entry("祖先仓库尚未授权", "项目位于更上层 Git 仓库中。", "after_fix", "grant", "核对候选根路径后，显式授权这个祖先仓库。"),
  git_repository_not_found: entry("仓库或修订不存在", "目标仓库、操作或修订已经不存在。", "refresh", "none", "刷新仓库发现、引用或历史后重新选择目标。"),
  git_operation_conflict: entry("仓库状态已变化", "预览后的仓库状态、引用或冲突阶段发生了变化。", "refresh", "repreview", "刷新状态并重新预览；旧确认不会被复用。"),
  git_validation_failed: entry("Git 输入不符合要求", "操作参数、路径、引用或选项未通过校验。", "never", "none", "修正界面中标出的输入后再试。"),
  git_cancelled: entry("Git 操作已取消", "操作已取消，相关进程树已停止。", "never", "none", "只有仍需要该操作时才重新发起。"),
  git_unavailable: entry("系统 Git 不可用", "Keydex 没有找到可用的系统 Git。", "after_fix", "none", "安装或修复系统 Git，并确认它可从当前用户环境访问。"),
  git_timeout: entry("Git 操作超时", "Git 命令未在安全时限内完成。", "immediate", "none", "检查仓库、网络或远程响应后重试。"),
  git_failed: entry("Git 操作失败", "Git 返回了未分类的失败。", "never", "none", "查看已清洗的操作日志，再判断是否应修改配置或重试。"),
  git_credentials_missing: entry("Git 凭据不可用", "远程拒绝了当前凭据，或非交互环境没有可用凭据。", "after_fix", "none", "在系统凭据管理器或外部 Git 客户端中配置凭据后重试。"),
  git_credential_helper_failed: entry("凭据助手失败", "系统配置的 Git Credential Helper 执行失败。", "after_fix", "none", "在 Keydex 外修复或登录凭据助手后重试。"),
  git_host_key_failed: entry("SSH 主机密钥校验失败", "远程主机指纹尚未被信任或已经变化。", "after_fix", "none", "在 Keydex 外核对真实指纹并更新 known_hosts；不要跳过校验。"),
  git_network_unavailable: entry("Git 远程不可达", "无法连接 Git 远程。", "immediate", "none", "检查远程地址、代理、VPN 和网络连接后重试。"),
  git_parse_failed: entry("无法解析 Git 输出", "系统 Git 返回了 Keydex 无法安全解析的内容。", "never", "none", "复制已清洗诊断并报告 Git 版本与操作，不要继续危险动作。"),
  git_output_too_large: entry("Git 输出超过安全上限", "结果太大，无法在当前请求中安全处理。", "after_fix", "none", "缩小修订范围、路径范围或行范围后重试。"),
} satisfies Record<GitErrorCode, GitErrorPresentation>;

const UNKNOWN_GIT_ERROR: GitErrorPresentation = entry(
  "未知 Git 错误",
  "Git 返回了当前版本尚未识别的错误。",
  "never",
  "none",
  "复制已清洗诊断并升级 Keydex；未知错误不会自动重试。",
);

export function gitErrorPresentation(code: string): GitErrorPresentation {
  return Object.prototype.hasOwnProperty.call(GIT_ERROR_PRESENTATIONS, code)
    ? GIT_ERROR_PRESENTATIONS[code as GitErrorCode]
    : UNKNOWN_GIT_ERROR;
}

export function gitUiErrorMessage(error: unknown, fallback = "Git 操作失败"): string {
  if (typeof error === "string") return error.trim() || fallback;
  if (!error || typeof error !== "object") return fallback;
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code !== "string" || !value.code.startsWith("git_")) {
    return error instanceof Error ? error.message : typeof value.message === "string" ? value.message : fallback;
  }
  return formatGitErrorMessage(value.code, typeof value.message === "string" ? value.message : "");
}

export function formatGitErrorMessage(code: string, message: string, serverHelp = ""): string {
  const presentation = gitErrorPresentation(code);
  const detail = message.trim() || presentation.fallbackMessage;
  const help = serverHelp.trim() || presentation.helpAction;
  return `${presentation.title}：${detail}${help ? ` ${help}` : ""}`;
}

export function gitOperationErrorMessage(result: {
  summary: string;
  result: Record<string, unknown>;
}): string {
  const rawMessage = result.result.error;
  const message = typeof rawMessage === "string" && rawMessage.trim()
    ? rawMessage
    : `${result.summary} failed`;
  const rawHelp = result.result.help_action;
  const rawCode = result.result.error_code;
  if (typeof rawCode === "string" && rawCode.startsWith("git_")) {
    return formatGitErrorMessage(
      rawCode,
      message,
      typeof rawHelp === "string" ? rawHelp : "",
    );
  }
  return typeof rawHelp === "string" && rawHelp.trim() ? `${message} ${rawHelp}` : message;
}

function entry(
  title: string,
  fallbackMessage: string,
  retryAction: GitErrorRetryAction,
  confirmationAction: GitErrorConfirmationAction,
  helpAction: string,
): GitErrorPresentation {
  return { title, fallbackMessage, retryAction, confirmationAction, helpAction };
}
