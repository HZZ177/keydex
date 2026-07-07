import type { HttpClient } from "./httpClient";
import { isTauriRuntime, type TauriInvoke } from "./agentConnection";

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

export interface LocalPreviewRuntime {
  readFile(path: string): Promise<LocalPreviewFileResponse>;
  readMedia(path: string): Promise<LocalPreviewMediaResponse>;
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
  return {
    readFile(path) {
      if ((options.isTauriRuntime ?? isTauriRuntime)()) {
        return readDesktopTextFile(path, options);
      }
      return http.request<LocalPreviewFileResponse>(
        `/api/local-preview/read?path=${encodeURIComponent(path)}`,
      );
    },
    readMedia(path) {
      return http.request<LocalPreviewMediaResponse>(
        `/api/local-preview/media?path=${encodeURIComponent(path)}`,
      );
    },
  };
}

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
