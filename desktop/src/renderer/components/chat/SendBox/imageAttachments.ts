import type { AttachmentRecord } from "@/runtime";
import type { AgentFileAttachment } from "@/types/protocol";

export interface SelectedImageAttachment {
  id: string;
  attachment_id: string;
  type: "image";
  name: string;
  path: string;
  mime_type: string;
  size: number;
  source: string;
  previewUrl?: string | null;
}

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif)$/i;

export function selectedImageAttachmentFromRecord(
  record: AttachmentRecord,
  previewUrl?: string | null,
): SelectedImageAttachment {
  return {
    id: record.id,
    attachment_id: record.attachment_id || record.id,
    type: "image",
    name: record.name,
    path: record.path,
    mime_type: record.mime_type,
    size: record.size,
    source: record.source,
    previewUrl: previewUrl ?? null,
  };
}

export function agentAttachmentFromSelected(
  attachment: SelectedImageAttachment,
): AgentFileAttachment {
  return {
    id: attachment.id,
    attachment_id: attachment.attachment_id,
    type: "image",
    name: attachment.name,
    path: attachment.path,
    source: attachment.source,
    mime_type: attachment.mime_type,
    size: attachment.size,
  };
}

export function selectedImageAttachmentFromAgent(
  attachment: AgentFileAttachment,
): SelectedImageAttachment | null {
  const id = normalizedText(attachment.id) || normalizedText(attachment.attachment_id);
  const attachmentId = normalizedText(attachment.attachment_id) || id;
  const name = normalizedText(attachment.name) || fileName(normalizedText(attachment.path)) || "image";
  if (!attachmentId) {
    return null;
  }
  return {
    id: id || attachmentId,
    attachment_id: attachmentId,
    type: "image",
    name,
    path: normalizedText(attachment.path),
    mime_type: normalizedText(attachment.mime_type) || "image/*",
    size: typeof attachment.size === "number" ? attachment.size : 0,
    source: normalizedText(attachment.source),
    previewUrl: normalizedText(attachment.data_url) || normalizedText(attachment.dataUrl) || normalizedText(attachment.url) || null,
  };
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSION_RE.test(file.name);
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION_RE.test(path);
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || "";
}
