export const textualToolProtocolNotice = "模型输出了文本形式的工具协议，已隐藏；该内容不是后端真实工具执行结果。";

const TEXTUAL_TOOL_PROTOCOL_BLOCK_PATTERN =
  /[\t ]*<\s*(tool_call|tool_result)\s*>[\s\S]*?<\s*\/\s*\1\s*>[\t ]*/gi;
const TEXTUAL_TOOL_PROTOCOL_TAG_PATTERN = /<\s*\/?\s*(?:tool_call|tool_result)\b[^>]*>/i;

export interface NormalizeMarkdownOptions {
  streaming?: boolean;
}

export function normalizeMarkdownContent(content: string, options: NormalizeMarkdownOptions = {}): string {
  const normalized = convertLatexDelimiters(content.replace(/file:\/\//g, ""));
  return options.streaming ? repairStreamingMarkdown(normalized) : normalized;
}

export function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("当前环境不支持剪贴板");
  }
  await navigator.clipboard.writeText(text);
}

export function stripThinkTags(content: string): string {
  if (!content || !hasThinkTags(content)) {
    return content;
  }
  return content
    .replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
    .replace(/<\s*thinking\s*>[\s\S]*?<\s*\/\s*thinking\s*>/gi, "")
    .replace(/^[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/i, "")
    .replace(/<\s*\/\s*think(?:ing)?\s*>/gi, "")
    .replace(/<\s*think(?:ing)?\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}

export interface TextualToolProtocolRedaction {
  content: string;
  redacted: boolean;
}

export function redactTextualToolProtocol(content: string): TextualToolProtocolRedaction {
  if (!content || !TEXTUAL_TOOL_PROTOCOL_TAG_PATTERN.test(content)) {
    return { content, redacted: false };
  }
  const redacted = content
    .replace(TEXTUAL_TOOL_PROTOCOL_BLOCK_PATTERN, "\n")
    .replace(TEXTUAL_TOOL_PROTOCOL_TAG_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { content: redacted, redacted: true };
}

function hasThinkTags(content: string): boolean {
  return /<\s*\/?\s*think(?:ing)?\s*>/i.test(content);
}

function convertLatexDelimiters(text: string): string {
  const segments: string[] = [];
  let position = 0;
  const codePattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(text)) !== null) {
    if (match.index > position) {
      segments.push(replaceLatexDelimiters(text.slice(position, match.index)));
    }
    segments.push(match[0]);
    position = match.index + match[0].length;
  }

  if (position < text.length) {
    segments.push(replaceLatexDelimiters(text.slice(position)));
  }

  return segments.join("");
}

function replaceLatexDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, content: string) => `$$${content}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, content: string) => `$${content}$`);
}

function repairStreamingMarkdown(content: string): string {
  return closeUnclosedDisplayMath(closeUnclosedFence(content));
}

function closeUnclosedFence(content: string): string {
  const lines = content.split("\n");
  let activeFence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    const match = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (!match) {
      continue;
    }
    const markerText = match[2];
    const marker = markerText[0] as "`" | "~";
    if (!activeFence) {
      activeFence = { marker, length: markerText.length };
      continue;
    }
    if (activeFence.marker === marker && markerText.length >= activeFence.length) {
      activeFence = null;
    }
  }

  if (!activeFence) {
    return content;
  }
  const closingFence = activeFence.marker.repeat(activeFence.length);
  return `${content.endsWith("\n") ? content : `${content}\n`}${closingFence}`;
}

function closeUnclosedDisplayMath(content: string): string {
  const outsideCode = stripCompleteCodeSegments(content);
  const delimiterCount = outsideCode.match(/(^|[^\\])\$\$/g)?.length ?? 0;
  if (delimiterCount % 2 === 0) {
    return content;
  }
  return `${content.endsWith("\n") ? content : `${content}\n`}$$`;
}

function stripCompleteCodeSegments(content: string): string {
  return content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, "");
}
