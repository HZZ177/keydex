export const textualToolProtocolNotice = "模型输出了文本形式的工具协议，已隐藏；该内容不是后端真实工具执行结果。";

const TEXTUAL_TOOL_PROTOCOL_BLOCK_PATTERN =
  /[\t ]*<\s*(tool_call|tool_result)\s*>[\s\S]*?<\s*\/\s*\1\s*>[\t ]*/gi;
const TEXTUAL_TOOL_PROTOCOL_TAG_PATTERN = /<\s*\/?\s*(?:tool_call|tool_result)\b[^>]*>/i;

import { conversationBaselineDiagnostics } from "./conversationBaselineDiagnostics";
import {
  repairStreamingDisplayMathTail,
  repairStreamingMarkdownTail,
} from "@/renderer/markdownRuntime/streaming";

export interface NormalizeMarkdownOptions {
  streaming?: boolean;
  repairFence?: boolean;
}

export function normalizeMarkdownContent(content: string, options: NormalizeMarkdownOptions = {}): string {
  const startedAt = conversationBaselineDiagnostics.isEnabled() && typeof performance !== "undefined"
    ? performance.now()
    : null;
  let normalized = content;
  if (normalized.includes("file://")) normalized = normalized.replace(/file:\/\//g, "");
  if (normalized.includes("\\(") || normalized.includes("\\[")) normalized = convertLatexDelimiters(normalized);
  const result = options.streaming
    ? options.repairFence === false
      ? repairStreamingDisplayMathTail(normalized)
      : repairStreamingMarkdownTail(normalized)
    : normalized;
  if (startedAt !== null) {
    conversationBaselineDiagnostics.record({
      stage: "markdown-normalize",
      characters: content.length,
      durationMs: performance.now() - startedAt,
    });
  }
  return result;
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
