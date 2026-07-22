import type { HttpClient } from "./httpClient";
import { normalizeRuntimeErrorEnvelope, RuntimeHttpError } from "./errors";

export interface AttachmentRecord {
  id: string;
  attachment_id: string;
  session_id?: string | null;
  user_id: string;
  type: "image" | "document" | "file" | (string & {});
  source: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
  created_at: string;
  updated_at: string;
}

export interface AttachmentMediaResponse {
  attachment_id: string;
  path: string;
  name: string;
  media_type: string;
  mime_type: string;
  size: number;
  data_url: string;
}

export interface StoredLocalFileResponse {
  id: string;
  source: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
}

export interface AttachmentDiscardResponse {
  attachment_id: string;
  deleted: boolean;
}

export interface UploadImageOptions {
  source?: "pasted" | "dropped" | "picker" | "url" | string;
  sessionId?: string | null;
  userId?: string | null;
}

export interface UploadLocalFileOptions {
  source?: "pasted" | "dropped" | "picker" | string;
  filename?: string | null;
}

export interface RegisterImagePathOptions extends UploadImageOptions {
  name?: string | null;
}

export interface ImportImageUrlOptions extends UploadImageOptions {
  name?: string | null;
}

export interface AttachmentsRuntime {
  uploadImage(file: Blob, options?: UploadImageOptions & { filename?: string | null }): Promise<AttachmentRecord>;
  uploadLocalFile(file: Blob, options?: UploadLocalFileOptions): Promise<StoredLocalFileResponse>;
  registerImagePath(path: string, options?: RegisterImagePathOptions): Promise<AttachmentRecord>;
  importImageUrl(url: string, options?: ImportImageUrlOptions): Promise<AttachmentRecord>;
  readMedia(attachmentId: string): Promise<AttachmentMediaResponse>;
  deleteUnreferencedWebAnnotation(attachmentId: string): Promise<AttachmentDiscardResponse>;
}

export function createAttachmentsRuntime(http: HttpClient): AttachmentsRuntime {
  return {
    async uploadImage(file, options = {}) {
      const params = new URLSearchParams();
      const filename = options.filename || blobName(file) || "image";
      params.set("filename", filename);
      params.set("source", options.source || "pasted");
      if (options.sessionId) {
        params.set("session_id", options.sessionId);
      }
      if (options.userId) {
        params.set("user_id", options.userId);
      }
      return rawJsonRequest<AttachmentRecord>(
        http,
        `/api/attachments/upload?${params.toString()}`,
        {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        },
      );
    },
    async uploadLocalFile(file, options = {}) {
      const params = new URLSearchParams();
      params.set("filename", options.filename || blobName(file) || "file");
      params.set("source", options.source || "pasted");
      return rawJsonRequest<StoredLocalFileResponse>(
        http,
        `/api/attachments/local-file?${params.toString()}`,
        {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        },
      );
    },
    registerImagePath(path, options = {}) {
      return http.request<AttachmentRecord>("/api/attachments/register-path", {
        method: "POST",
        body: {
          path,
          name: options.name,
          source: options.source || "path",
          session_id: options.sessionId,
          user_id: options.userId,
        },
      });
    },
    importImageUrl(url, options = {}) {
      return http.request<AttachmentRecord>("/api/attachments/import-url", {
        method: "POST",
        body: {
          url,
          name: options.name,
          source: options.source || "url",
          session_id: options.sessionId,
          user_id: options.userId,
        },
      });
    },
    readMedia(attachmentId) {
      return http.request<AttachmentMediaResponse>(
        `/api/attachments/${encodeURIComponent(attachmentId)}/media`,
      );
    },
    deleteUnreferencedWebAnnotation(attachmentId) {
      return rawJsonRequest<AttachmentDiscardResponse>(
        http,
        `/api/attachments/${encodeURIComponent(attachmentId)}/unreferenced-web-annotation`,
        { method: "DELETE", keepalive: true },
      );
    },
  };
}

async function rawJsonRequest<T>(
  http: HttpClient,
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`${http.getBaseUrl()}${path}`, init);
  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    let body: unknown = rawText;
    if (rawText.trim()) {
      try {
        body = JSON.parse(rawText);
      } catch {
        // Keep the original text as the legacy input for the shared normalizer.
      }
    }
    const envelope = normalizeRuntimeErrorEnvelope(body, {
      fallbackCode: `http_${response.status}`,
      fallbackMessage: rawText.trim() || `请求失败：HTTP ${response.status}`,
      status: response.status,
    });
    throw new RuntimeHttpError({
      ...envelope,
      method: init.method ?? "GET",
      path,
      status: response.status,
      body,
      rawText,
    });
  }
  return (await response.json()) as T;
}

function blobName(file: Blob): string | null {
  const maybeFile = file as File;
  return typeof maybeFile.name === "string" && maybeFile.name.trim() ? maybeFile.name : null;
}
