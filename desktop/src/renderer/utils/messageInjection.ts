import type { SkillSummary } from "@/runtime";
import type { SelectedFile } from "@/renderer/components/chat/SendBox/fileSelection";
import { selectedQuotePreview, type SelectedQuote } from "@/renderer/components/chat/SendBox/quoteSelection";
import type { AgentContextItem } from "@/types/protocol";
import type { AssembledAnnotationContext } from "@/renderer/features/annotations/chat/AnnotationContextAssembler";
import {
  renderWebAnnotationContextSnapshot,
  type WebAnnotationContextSnapshot,
} from "@/renderer/features/browser/annotations/chat";

export interface RuntimeMessageInjectionItem {
  type: "follow" | "slot";
  role: "SystemMessage" | "HumanMessage" | "AIMessage";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSkillActivation {
  skill_name: string;
  source: SkillSummary["source"];
  origin: "slash";
}

export interface RuntimeParamsWithInjection extends Record<string, unknown> {
  message_injection?: RuntimeMessageInjectionItem[];
  message_context_items?: AgentContextItem[];
  skill_activation?: RuntimeSkillActivation;
}

export interface PreparedComposerMessage {
  message: string;
  contextItems: AgentContextItem[];
  runtimeParams?: RuntimeParamsWithInjection;
}

export interface PrepareComposerMessageOptions {
  annotationContexts?: readonly AssembledAnnotationContext[];
  webAnnotationContexts?: readonly WebAnnotationContextSnapshot[];
  quotes?: SelectedQuote[];
  selectedSkill?: SkillSummary | null;
}

export function prepareComposerMessage(
  value: string,
  files: SelectedFile[] = [],
  options: PrepareComposerMessageOptions = {},
): PreparedComposerMessage {
  const message = value.trim();
  const quoteItems = quoteContextItems(options.quotes ?? []);
  const fileItems = files.filter((file) => !file.annotationReference).map(fileContextItem);
  const annotationItems = (options.annotationContexts ?? []).map(annotationContextItem);
  const webAnnotationItems = (options.webAnnotationContexts ?? []).map(webAnnotationContextItemFromSnapshot);
  const skillItems = options.selectedSkill ? [skillContextItem(options.selectedSkill)] : [];
  const contextItems = [...skillItems, ...quoteItems, ...fileItems, ...annotationItems, ...webAnnotationItems];
  const injectableContextItems = [...quoteItems, ...fileItems, ...annotationItems, ...webAnnotationItems];
  const messageInjection = injectableContextItems.map(contextItemToFollowInjection);
  const runtimeParams: RuntimeParamsWithInjection = {};
  if (messageInjection.length) {
    runtimeParams.message_injection = messageInjection;
  }
  if (options.selectedSkill) {
    runtimeParams.skill_activation = {
      skill_name: options.selectedSkill.name,
      source: options.selectedSkill.source,
      origin: "slash",
    };
  }
  return {
    message,
    contextItems,
    runtimeParams: Object.keys(runtimeParams).length ? runtimeParams : undefined,
  };
}

export function prepareReplayedContextItems(
  items: readonly AgentContextItem[],
): PreparedComposerMessage {
  const contextItems = [...items];
  const messageInjection = contextItems.map(contextItemToFollowInjection);
  return {
    message: "",
    contextItems,
    runtimeParams: messageInjection.length ? { message_injection: messageInjection } : undefined,
  };
}

export function webAnnotationContextItemFromSnapshot(
  snapshot: WebAnnotationContextSnapshot,
): AgentContextItem {
  const content = renderWebAnnotationContextSnapshot(snapshot);
  const localFile = snapshot.page.sourceKind === "local_file";
  return {
    id: `web-annotation:${snapshot.reference.annotationId}:${snapshot.integrity.digest}`,
    type: "web_annotation",
    label: `${localFile ? "本地页面批注" : "网页批注"} · ${snapshot.page.title || snapshot.page.origin}`,
    content,
    description: snapshot.comment.bodyMarkdown,
    role: "HumanMessage",
    source: "follow",
    metadata: {
      schema_version: snapshot.schemaVersion,
      annotation_id: snapshot.reference.annotationId,
      annotation_revision: snapshot.reference.revision,
      anchor_id: snapshot.reference.anchorId,
      reference_code: `webann:${snapshot.reference.annotationId}@r${snapshot.reference.revision}#${snapshot.integrity.digest.slice(7, 15)}`,
      snapshot_digest: snapshot.integrity.digest,
      resolution: snapshot.observation.status,
      freshness: snapshot.observation.freshness,
      url_key: snapshot.page.urlKey,
      source_url: snapshot.page.documentUrl,
      source_kind: localFile ? "local_file" : "web",
      source_display_address: snapshot.page.displayAddress || snapshot.page.documentUrl,
      snapshot,
    },
  };
}

function annotationContextItem(context: AssembledAnnotationContext): AgentContextItem {
  const htmlSource = context.sourceKind === "html_source";
  return {
    id: `annotation:${context.workspaceId}:${context.annotationId}`,
    type: "annotation",
    label: htmlSource
      ? `HTML 源码批注 · ${context.kind === "text" ? "选区" : "全文"}`
      : context.kind === "text" ? "选区批注" : "全文批注",
    content: context.kind === "text" ? context.exact : context.content,
    description: context.body,
    role: "HumanMessage",
    source: "follow",
    path: context.path,
    name: fileName(context.path),
    fileType: "file",
    metadata: {
      annotation_id: context.annotationId,
      annotation_kind: context.kind,
      annotation_source_kind: context.sourceKind,
      annotation_body: context.body,
      document_revision: context.documentRevision,
      text_revision: context.textRevision,
      source_ranges: context.kind === "text" ? context.sourceRanges : [],
      workspace_id: context.workspaceId,
      path: context.path,
    },
  };
}

function skillContextItem(skill: SkillSummary): AgentContextItem {
  const label = skill.label || `/${skill.name}`;
  const id = `skill:${skill.source}:${skill.name}`;
  return {
    id,
    type: "skill",
    label,
    content: skill.description,
    source: skill.source,
    skill_name: skill.name,
    skillName: skill.name,
    description: skill.description,
    locator: skill.locator,
    metadata: {
      id,
      kind: "skill",
      label,
      skill_name: skill.name,
      skillName: skill.name,
      source: skill.source,
      description: skill.description,
      locator: skill.locator,
    },
  };
}

function quoteContextItems(quotes: SelectedQuote[]): AgentContextItem[] {
  return quotes.flatMap((quote, index) => {
    const content = quote.text.trim();
    if (!content) {
      return [];
    }
    const id = quote.id || `quote:${index}:${hashText(content)}`;
    const preview = quote.preview || selectedQuotePreview(content);
    const comment = normalizedOptionalText(quote.comment);
    if (quote.file) {
      const description = sourceQuoteDescription(quote);
      const label = comment ? "评论" : sourceQuoteLabel(quote);
      return [
        {
          id,
          type: "source_quote",
          label,
          content,
          description,
          role: "HumanMessage",
          source: "follow",
          path: quote.file.path,
          name: quote.file.name || fileName(quote.file.path),
          fileType: "file",
          metadata: {
            id,
            kind: "source_quote",
            label,
            preview,
            source: quote.source,
            path: quote.file.path,
            name: quote.file.name || fileName(quote.file.path),
            fileType: "file",
            line_start: quote.file.lineStart ?? null,
            line_end: quote.file.lineEnd ?? null,
            source_start: quote.file.sourceStart ?? null,
            source_end: quote.file.sourceEnd ?? null,
            ...(comment ? { comment } : {}),
            description,
          },
        },
      ];
    }
    const description = comment ? quoteDescription(content, comment) : "";
    const label = comment ? "评论" : "引用片段";
    return [
      {
        id,
        type: "quote",
        label,
        content,
        role: "HumanMessage",
        source: "follow",
        ...(description ? { description } : {}),
        metadata: {
          id,
          kind: "quote",
          label,
          preview,
          source: quote.source,
          ...(comment ? { comment, description } : {}),
        },
      },
    ];
  });
}

function fileContextItem(file: SelectedFile, index: number): AgentContextItem {
  const id = `file:${index}:${hashText(file.path)}`;
  const kindLabel = selectedFileKindLabel(file);
  const description = file.type === "directory" ? `${kindLabel}\n${file.path}` : file.path;
  return {
    id,
    type: "file",
    label: file.name || file.path,
    content: `${kindLabel}：${file.path}`,
    description,
    role: "HumanMessage",
    source: "follow",
    path: file.path,
    name: file.name,
    fileType: file.type,
    metadata: {
      id,
      kind: "file",
      label: file.name || file.path,
      path: file.path,
      name: file.name,
      fileType: file.type,
      source: file.source,
      description,
    },
  };
}

function contextItemToFollowInjection(item: AgentContextItem): RuntimeMessageInjectionItem {
  return {
    type: "follow",
    role: "HumanMessage",
    content: injectionContent(item),
    metadata: {
      ...(item.metadata ?? {}),
      id: item.id,
      kind: item.type,
      label: item.label,
      path: item.path,
      name: item.name,
      fileType: item.fileType,
    },
  };
}

function injectionContent(item: AgentContextItem): string {
  if (item.type === "web_annotation") return item.content;
  if (item.type === "annotation") {
    const kind = item.metadata?.annotation_kind === "document" ? "全文批注" : "选区批注";
    return `用户引用了当前文档中的${kind}。\n文件：${item.path || item.label}\n批注：${item.description || ""}\n当前内容：\n${item.content}\n文档版本：${normalizedOptionalText(item.metadata?.document_revision)}\n请只依据这次发送时解析出的当前内容处理该批注。`;
  }
  if (item.type === "file") {
    const target = contextFileKindLabel(item);
    if (item.fileType === "directory") {
      return `用户通过 @ 引用了${target}：${item.path || item.label}\n请将该目录作为本次请求的范围上下文。需要了解内容时，先使用可用工具列出或搜索该目录，再按需读取相关文件；不要默认递归读取整个目录，也不要把路径当作用户普通文本。`;
    }
    return `用户通过 @ 引用了${target}：${item.path || item.label}\n请在需要时使用可用工具读取或查看该路径，不要把路径当作用户普通文本。`;
  }
  if (item.type === "source_quote") {
    const lineRange = metadataLineRange(item.metadata);
    const sourceRange = metadataSourceRange(item.metadata);
    const lineLocation = lineRange ? `行位置：${lineRange}\n` : "";
    const sourceLocation = sourceRange ? `源码范围：${sourceRange}\n` : "";
    const comment = contextItemComment(item);
    const commentSection = comment ? `\n\n用户评论：\n${comment}` : "";
    return `用户引用了工作区文件中的一个自洽片段。\n文件：${item.path || item.label}\n${lineLocation}${sourceLocation}引用内容：\n${item.content}${commentSection}\n\n请把这条消息视为一个完整的文件来源片段，不要和其他文件或其他引用片段混淆。如需更多上下文，请使用文件工具读取该文件。`;
  }
  if (item.type === "quote") {
    const comment = contextItemComment(item);
    if (comment) {
      return `用户添加了以下引用片段作为上下文：\n引用片段：${item.content}\n\n评论：${comment}`;
    }
    return `用户添加了以下引用片段作为上下文：\n${item.content}`;
  }
  return item.content;
}

function selectedFileKindLabel(file: SelectedFile): string {
  if (file.source === "workspace") {
    return file.type === "directory" ? "工作区目录" : "工作区文件";
  }
  return file.type === "directory" ? "本地目录" : "本地文件";
}

function contextFileKindLabel(item: AgentContextItem): string {
  const metadataSource = normalizedOptionalText(item.metadata?.source);
  const source = metadataSource || normalizedOptionalText(item.source);
  if (source === "workspace") {
    return item.fileType === "directory" ? "工作区目录" : "工作区文件";
  }
  return item.fileType === "directory" ? "本地目录" : "本地文件";
}

function sourceQuoteLabel(quote: SelectedQuote): string {
  const name = quote.file?.name || (quote.file?.path ? fileName(quote.file.path) : "文件片段");
  const lineRange = sourceQuoteLineRange(quote.file?.lineStart, quote.file?.lineEnd);
  return lineRange ? `${name} · ${lineRange}` : `${name} · 引用`;
}

function sourceQuoteDescription(quote: SelectedQuote): string {
  const lineRange = sourceQuoteLineRange(quote.file?.lineStart, quote.file?.lineEnd);
  const location = quote.file?.path ? `${quote.file.path}${lineRange ? ` · ${lineRange}` : ""}` : "";
  const comment = normalizedOptionalText(quote.comment);
  return [location, `引用片段：${quote.text}`, comment ? `评论：${comment}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

function quoteDescription(content: string, comment: string): string {
  return `引用片段：${content}\n\n评论：${comment}`;
}

function contextItemComment(item: AgentContextItem): string {
  return normalizedOptionalText(item.metadata?.comment);
}

function metadataLineRange(metadata: Record<string, unknown> | undefined): string | null {
  const start = numberValue(metadata?.line_start);
  const end = numberValue(metadata?.line_end);
  return sourceQuoteLineRange(start, end);
}

function metadataSourceRange(metadata: Record<string, unknown> | undefined): string | null {
  const start = numberValue(metadata?.source_start);
  const end = numberValue(metadata?.source_end);
  if (start === null || end === null || end <= start) {
    return null;
  }
  return `${start}-${end}`;
}

function sourceQuoteLineRange(start?: number | null, end?: number | null): string | null {
  if (!start || !end) {
    return null;
  }
  return start === end ? `L${start}` : `L${start}-L${end}`;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedOptionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
