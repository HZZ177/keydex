import type { HttpClient } from "./httpClient";
import { isTauriRuntime, type TauriInvoke } from "./agentConnection";
import {
  DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
  DocumentReadProtocolError,
  createDocumentReadRequest,
  createWholeDocumentReadResult,
  type DocumentReadResult,
  type DocumentReadSource,
} from "./documentRead";
import {
  DocumentReadCoordinator,
  readDocumentNdjsonResponse,
  type DocumentReadTransportDiagnostics,
} from "@/renderer/components/workspace/fileMarkdownAdapter/transport";
import {
  createDocumentWriteRequest,
  type DocumentWriteResult,
} from "./documentWrite";

export interface LocalPreviewFileResponse {
  path: string;
  content: string;
  encoding: string;
}

export interface LocalPreviewMediaResponse {
  path: string;
  media_type: string;
  size: number;
  data_url: string;
}

export interface LocalHtmlPreviewResponse {
  path: string;
  url: string;
}

export interface LocalHtmlContentPreviewResponse {
  url: string;
}

export interface LocalPreviewRuntime {
  readFile(path: string): Promise<LocalPreviewFileResponse>;
  prepareHtmlFile(path: string, scopePath?: string): Promise<LocalHtmlPreviewResponse>;
  prepareHtmlContent(content: string): Promise<LocalHtmlContentPreviewResponse>;
  readDocument(path: string, options?: LocalPreviewDocumentReadOptions): Promise<DocumentReadResult>;
  readMedia(path: string): Promise<LocalPreviewMediaResponse>;
  writeDocument(
    path: string,
    content: string,
    options: LocalPreviewDocumentWriteOptions,
  ): Promise<DocumentWriteResult>;
  releaseDocumentConsumer(consumerId: string): void;
}

export interface LocalPreviewDocumentWriteOptions {
  expectedRevision: string;
  writeId: string;
  signal?: AbortSignal;
}

export interface LocalPreviewDocumentReadOptions {
  signal?: AbortSignal;
  expectedRevision?: string | null;
  maxBytes?: number;
  consumerId?: string;
  onDiagnostics?: (diagnostics: DocumentReadTransportDiagnostics) => void;
}

export interface LocalPreviewRuntimeOptions {
  invoke?: TauriInvoke;
  loadInvoke?: () => Promise<TauriInvoke>;
  isTauriRuntime?: () => boolean;
}

export function createLocalPreviewRuntime(
  http: HttpClient,
  options: LocalPreviewRuntimeOptions = {},
): LocalPreviewRuntime {
  const coordinator = new DocumentReadCoordinator();
  return {
    readFile(path) {
      if ((options.isTauriRuntime ?? isTauriRuntime)()) {
        return readDesktopTextFile(path, options);
      }
      return http.request<LocalPreviewFileResponse>(
        `/api/local-preview/read?path=${encodeURIComponent(path)}`,
      );
    },
    async prepareHtmlFile(path, scopePath) {
      return http.request<LocalHtmlPreviewResponse>(
        "/api/local-preview/html/register",
        {
          method: "POST",
          body: {
            path,
            scope_path: scopePath,
          },
        },
      );
    },
    async prepareHtmlContent(content) {
      return http.request<LocalHtmlContentPreviewResponse>(
        "/api/local-preview/html/content/register",
        {
          method: "POST",
          body: { content },
        },
      );
    },
    readDocument(path, readOptions = {}) {
      const tauri = (options.isTauriRuntime ?? isTauriRuntime)();
      const source = tauri ? "tauri" : "local-preview";
      const consumerId = readOptions.consumerId ?? `local-document-call-${nextDocumentConsumerId++}`;
      return coordinator.read({
        consumerId,
        documentKey: `${source}:${path}`,
        signal: readOptions.signal,
        load: (signal) => tauri
          ? readDesktopDocument(path, options, { ...readOptions, signal })
          : readBrowserDocument(http, path, { ...readOptions, signal }),
      });
    },
    readMedia(path) {
      return http.request<LocalPreviewMediaResponse>(
        `/api/local-preview/media?path=${encodeURIComponent(path)}`,
      );
    },
    writeDocument(path, content, writeOptions) {
      return http.request<DocumentWriteResult>(
        "/api/local-preview/write/document",
        {
          method: "POST",
          body: createDocumentWriteRequest(
            path,
            content,
            writeOptions.expectedRevision,
            writeOptions.writeId,
          ),
          signal: writeOptions.signal,
          silentStatuses: [409],
        },
      );
    },
    releaseDocumentConsumer(consumerId) {
      coordinator.release(consumerId);
    },
  };
}

async function readBrowserDocument(
  http: HttpClient,
  path: string,
  options: LocalPreviewDocumentReadOptions,
): Promise<DocumentReadResult> {
  const request = documentRequest(path, "local-preview", options);
  const response = await http.requestRaw("/api/local-preview/read/document", {
    method: "POST",
    body: request,
    signal: options.signal,
  });
  return readDocumentNdjsonResponse(response, request, {
    signal: options.signal,
    onDiagnostics: options.onDiagnostics,
  });
}

async function readDesktopDocument(
  path: string,
  runtimeOptions: LocalPreviewRuntimeOptions,
  readOptions: LocalPreviewDocumentReadOptions,
): Promise<DocumentReadResult> {
  assertNotCancelled(readOptions.signal);
  let response: LocalPreviewFileResponse;
  try {
    response = await readDesktopTextFile(path, runtimeOptions);
  } catch (error) {
    throw normalizeDesktopReadError(error);
  }
  assertNotCancelled(readOptions.signal);
  return adaptWholeFileToDocument(response, "tauri", readOptions);
}

async function adaptWholeFileToDocument(
  response: LocalPreviewFileResponse,
  source: DocumentReadSource,
  options: LocalPreviewDocumentReadOptions,
): Promise<DocumentReadResult> {
  const request = documentRequest(response.path, source, options);
  const { revision, byteLength } = await sha256Revision(response.content);
  if (byteLength > request.max_bytes) {
    throw new DocumentReadProtocolError(
      "too_large",
      `Document byte size ${byteLength} exceeds preview contract`,
    );
  }
  assertNotCancelled(options.signal);
  return createWholeDocumentReadResult({
    request,
    revision,
    content: response.content,
    byteLength,
  });
}

function documentRequest(
  path: string,
  source: DocumentReadSource,
  options: LocalPreviewDocumentReadOptions,
) {
  return createDocumentReadRequest({
    request_id: `local-document-${nextDocumentRequestId++}`,
    document_id: `${source}:${path}`,
    source,
    path,
    expected_revision: options.expectedRevision,
    preferred_transport: "auto",
    max_bytes: options.maxBytes ?? DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
  });
}

async function sha256Revision(content: string): Promise<{ revision: string; byteLength: number }> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new DocumentReadProtocolError("io_error", "Web Crypto SHA-256 is unavailable");
  }
  const bytes = new TextEncoder().encode(content);
  const digest = await subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return {
    revision: `sha256:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`,
    byteLength: bytes.byteLength,
  };
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DocumentReadProtocolError("cancelled", "Document preview read cancelled", true);
  }
}

function normalizeDesktopReadError(error: unknown): DocumentReadProtocolError {
  if (error instanceof DocumentReadProtocolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/utf-?8|unicode|invalid data/i.test(message)) {
    return new DocumentReadProtocolError("unsupported_encoding", message);
  }
  if (/not found|cannot find|does not exist|no such file|不是文件|不存在/i.test(message)) {
    return new DocumentReadProtocolError("not_found", message);
  }
  return new DocumentReadProtocolError("io_error", message || "Desktop document read failed", true);
}

let nextDocumentRequestId = 1;
let nextDocumentConsumerId = 1;

async function readDesktopTextFile(
  path: string,
  options: LocalPreviewRuntimeOptions,
): Promise<LocalPreviewFileResponse> {
  const invoke = options.invoke ?? (await (options.loadInvoke ?? loadTauriInvoke)());
  return invoke<LocalPreviewFileResponse>("read_text_file", { path });
}

async function loadTauriInvoke(): Promise<TauriInvoke> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke as TauriInvoke;
}
