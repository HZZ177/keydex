import {
  isRuntimeHttpError,
  type RuntimeBridge,
  type SkillResourceReadResponse,
  type SkillSource,
  type WorkspaceScope,
} from "@/runtime";
import type {
  PreviewContextValue,
  PreviewRenderContext,
} from "@/renderer/providers/PreviewProvider";
import type {
  PreviewContentKind,
  PreviewRequest,
} from "@/renderer/providers/previewTypes";

export interface SkillResourcePreviewTarget {
  skillName: string;
  source: SkillSource;
  resourcePath?: string;
}

export async function openSkillResourcePreview({
  preview,
  renderContext,
  runtime,
  scope,
  target,
}: {
  preview: Pick<PreviewContextValue, "openPreview">;
  renderContext?: PreviewRenderContext;
  runtime: RuntimeBridge;
  scope?: WorkspaceScope | null;
  target: SkillResourcePreviewTarget;
}): Promise<SkillResourceReadResponse> {
  const response = await readSkillResource(runtime, scope, target);
  preview.openPreview(skillResourcePreviewRequest(response), renderContext);
  return response;
}

export async function readSkillResource(
  runtime: RuntimeBridge,
  scope: WorkspaceScope | null | undefined,
  target: SkillResourcePreviewTarget,
): Promise<SkillResourceReadResponse> {
  const request = {
    skill_name: target.skillName.trim(),
    source: target.source,
    resource_path: target.resourcePath?.trim() || "SKILL.md",
  };
  const response = "sessionId" in (scope ?? {}) && scope?.sessionId
    ? await runtime.skills.readSessionResource(scope.sessionId, request)
    : "workspaceId" in (scope ?? {}) && scope?.workspaceId
      ? await runtime.skills.readWorkspaceResource(scope.workspaceId, request)
      : await runtime.skills.readSystemResource(request);
  if (
    response.skill_name !== request.skill_name
    || response.source !== request.source
    || response.resource_path !== request.resource_path
  ) {
    throw new Error("Skill 资源响应与请求不一致");
  }
  return response;
}

export function skillResourcePreviewRequest(response: SkillResourceReadResponse): PreviewRequest {
  return {
    type: "skill-resource",
    title: skillResourceTitle(response.skill_name, response.resource_path),
    content: response.content,
    contentType: skillResourceContentKind(response.resource_path),
    skillName: response.skill_name,
    skillSource: response.source,
    resourcePath: response.resource_path,
    locator: response.locator,
    revision: response.revision,
  };
}

export function skillResourcePreviewError(reason: unknown): string {
  if (isRuntimeHttpError(reason)) {
    if (reason.code === "skill_source_stale") {
      return "Skill 的有效来源已变化，请刷新列表后重新选择";
    }
    if (reason.code === "skill_resource_not_found") {
      return "Skill 资源不存在或已被删除";
    }
    if (reason.code === "skill_resource_forbidden") {
      return "该 Skill 资源不允许预览";
    }
  }
  const message = reason instanceof Error && reason.message
    ? reason.message
    : "Skill 资源读取失败";
  return `Skill 资源打开失败：${message}`;
}

function skillResourceTitle(skillName: string, resourcePath: string): string {
  return resourcePath === "SKILL.md"
    ? skillName
    : `${skillName} / ${fileName(resourcePath)}`;
}

function skillResourceContentKind(path: string): PreviewContentKind {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "mdx", "markdown"].includes(extension)) return "markdown";
  if (["html", "htm", "xml"].includes(extension)) return "html";
  if (["diff", "patch"].includes(extension)) return "diff";
  if (extension === "json") return "json";
  if (["mmd", "mermaid"].includes(extension)) return "mermaid";
  if ([
    "bash", "c", "cjs", "cpp", "cs", "css", "go", "h", "java", "js", "jsx",
    "kt", "less", "mjs", "ps1", "py", "rs", "sass", "scss", "sh", "sql",
    "toml", "ts", "tsx", "vue", "yaml", "yml",
  ].includes(extension)) return "code";
  return "text";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
