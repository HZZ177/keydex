import type { WorkspaceSkillSummary } from "@/runtime";
import type { SelectedFile } from "@/renderer/components/chat/SendBox/fileSelection";
import { selectedQuotePreview, type SelectedQuote } from "@/renderer/components/chat/SendBox/quoteSelection";
import type { AgentContextItem } from "@/types/protocol";

export interface RuntimeMessageInjectionItem {
  type: "follow" | "slot";
  role: "SystemMessage" | "HumanMessage" | "AIMessage";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSkillActivation {
  skill_name: string;
  source: "workspace";
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
  quotes?: SelectedQuote[];
  selectedSkill?: WorkspaceSkillSummary | null;
}

export function prepareComposerMessage(
  value: string,
  files: SelectedFile[] = [],
  options: PrepareComposerMessageOptions = {},
): PreparedComposerMessage {
  const message = value.trim();
  const quoteItems = quoteContextItems(options.quotes ?? []);
  const fileItems = files.map(fileContextItem);
  const skillItems = options.selectedSkill ? [skillContextItem(options.selectedSkill)] : [];
  const contextItems = [...skillItems, ...quoteItems, ...fileItems];
  const injectableContextItems = [...quoteItems, ...fileItems];
  const messageInjection = injectableContextItems.map(contextItemToFollowInjection);
  const runtimeParams: RuntimeParamsWithInjection = {};
  if (messageInjection.length) {
    runtimeParams.message_injection = messageInjection;
  }
  if (options.selectedSkill) {
    runtimeParams.skill_activation = {
      skill_name: options.selectedSkill.name,
      source: "workspace",
      origin: "slash",
    };
  }
  return {
    message,
    contextItems,
    runtimeParams: Object.keys(runtimeParams).length ? runtimeParams : undefined,
  };
}

function skillContextItem(skill: WorkspaceSkillSummary): AgentContextItem {
  const label = skill.label || `/${skill.name}`;
  const id = `skill:${skill.name}`;
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
    const annotationId = normalizedOptionalText(quote.annotationId);
    const annotationComment = normalizedOptionalText(quote.annotationComment);
    if (quote.file) {
      const description = sourceQuoteDescription(quote, annotationComment);
      return [
        {
          id,
          type: "source_quote",
          label: sourceQuoteLabel(quote),
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
            label: sourceQuoteLabel(quote),
            preview,
            source: quote.source,
            path: quote.file.path,
            name: quote.file.name || fileName(quote.file.path),
            fileType: "file",
            line_start: quote.file.lineStart ?? null,
            line_end: quote.file.lineEnd ?? null,
            source_start: quote.file.sourceStart ?? null,
            source_end: quote.file.sourceEnd ?? null,
            annotation_id: annotationId,
            annotation_comment: annotationComment,
            description,
          },
        },
      ];
    }
    return [
      {
        id,
        type: "quote",
        label: "引用片段",
        content,
        role: "HumanMessage",
        source: "follow",
        metadata: {
          id,
          kind: "quote",
          label: "引用片段",
          preview,
          source: quote.source,
          annotation_id: annotationId,
          annotation_comment: annotationComment,
        },
      },
    ];
  });
}

function fileContextItem(file: SelectedFile, index: number): AgentContextItem {
  const id = `file:${index}:${hashText(file.path)}`;
  const annotationId = normalizedOptionalText(file.annotationId);
  const annotationComment = normalizedOptionalText(file.annotationComment);
  const description = [file.path, annotationComment ? `批注：${annotationComment}` : ""].filter(Boolean).join("\n\n");
  const kindLabel = selectedFileKindLabel(file);
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
      annotation_id: annotationId,
      annotation_comment: annotationComment,
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
  if (item.type === "file") {
    const target = contextFileKindLabel(item);
    const annotationComment = normalizedOptionalText(item.metadata?.annotation_comment);
    const annotationBlock = annotationComment ? `\n批注内容：\n${annotationComment}` : "";
    return `用户通过 @ 引用了${target}：${item.path || item.label}${annotationBlock}\n请在需要时使用可用工具读取或查看该路径，不要把路径当作用户普通文本。`;
  }
  if (item.type === "source_quote") {
    const lineRange = metadataLineRange(item.metadata);
    const sourceRange = metadataSourceRange(item.metadata);
    const annotationComment = normalizedOptionalText(item.metadata?.annotation_comment);
    const lineLocation = lineRange ? `行位置：${lineRange}\n` : "";
    const sourceLocation = sourceRange ? `源码范围：${sourceRange}\n` : "";
    const annotationBlock = annotationComment ? `批注内容：\n${annotationComment}\n\n` : "";
    return `用户引用了工作区文件中的一个自洽片段。\n文件：${item.path || item.label}\n${lineLocation}${sourceLocation}引用内容：\n${item.content}\n\n${annotationBlock}请把这条消息视为一个完整的文件来源片段，不要和其他文件或其他引用片段混淆。如需更多上下文，请使用文件工具读取该文件。`;
  }
  if (item.type === "quote") {
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

function sourceQuoteDescription(quote: SelectedQuote, annotationComment: string): string {
  const lineRange = sourceQuoteLineRange(quote.file?.lineStart, quote.file?.lineEnd);
  const location = quote.file?.path ? `${quote.file.path}${lineRange ? ` · ${lineRange}` : ""}` : "";
  return [location, quote.text, annotationComment ? `批注：${annotationComment}` : ""]
    .filter(Boolean)
    .join("\n\n");
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
