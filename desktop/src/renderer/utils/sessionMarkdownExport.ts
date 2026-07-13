import type { AgentChatMessagePayload } from "@/types/protocol";

export type SessionMarkdownSaveResult = "saved" | "downloaded" | "cancelled";

interface SessionTranscriptEntry {
  role: "user" | "assistant" | "reasoning";
  content: string;
}

export function buildSessionMarkdown(title: string, messages: AgentChatMessagePayload[]): string {
  const entries = sessionTranscriptEntries(messages);
  if (entries.length === 0) {
    return "";
  }

  const documentTitle = normalizeDocumentTitle(title);
  const sections = entries.map(({ role, content }) => {
    const roleLabel = role === "user" ? "用户" : role === "assistant" ? "助手" : "思考";
    return `## ${roleLabel}\n\n${content}`;
  });
  return [`# ${documentTitle}`, ...sections].join("\n\n") + "\n";
}

export function createSessionMarkdownFilename(title: string, now = new Date()): string {
  const safeTitle = normalizeDocumentTitle(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80) || "session";
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${safeTitle}-${timestamp}.md`;
}

export async function saveSessionMarkdownFile(
  contents: string,
  filename: string,
): Promise<SessionMarkdownSaveResult> {
  if (!hasTauriInternals()) {
    downloadSessionMarkdownFile(contents, filename);
    return "downloaded";
  }

  const [{ save }, { invoke }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/api/core"),
  ]);
  const path = await save({
    defaultPath: filename,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) {
    return "cancelled";
  }
  await invoke("write_text_file", { path, contents });
  return "saved";
}

function sessionTranscriptEntries(messages: AgentChatMessagePayload[]): SessionTranscriptEntry[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "reasoning") {
      return [];
    }
    if (message.contentType === "a2ui" || message.content_type === "a2ui") {
      return [];
    }
    const content = normalizeMessageText(message.content);
    return content ? [{ role: message.role, content }] : [];
  });
}

function normalizeMessageText(content: unknown): string {
  if (typeof content !== "string") {
    return "";
  }
  return content.replace(/\r\n?/g, "\n").trim();
}

function normalizeDocumentTitle(title: string): string {
  return title.replace(/\r\n?/g, " ").replace(/\s+/g, " ").trim() || "会话记录";
}

function hasTauriInternals(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function downloadSessionMarkdownFile(contents: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
