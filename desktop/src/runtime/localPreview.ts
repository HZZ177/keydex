import type { HttpClient } from "./httpClient";

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

export function createLocalPreviewRuntime(http: HttpClient): LocalPreviewRuntime {
  return {
    readFile(path) {
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
