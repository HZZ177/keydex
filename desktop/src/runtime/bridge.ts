import { createConversationRuntime, type ConversationRuntime, type ConversationRuntimeOptions } from "./conversation";
import { createHttpClient, HttpClient, type HttpClientOptions } from "./httpClient";
import { createModelsRuntime, type ModelsRuntime } from "./models";
import { createSettingsRuntime, type HealthResponse, type SettingsRuntime } from "./settings";
import { createWorkspaceRuntime, type WorkspaceRuntime } from "./workspace";

export interface RuntimeBridgeOptions extends HttpClientOptions, ConversationRuntimeOptions {
  httpClient?: HttpClient;
}

export interface RuntimeBridge {
  http: HttpClient;
  conversation: ConversationRuntime;
  models: ModelsRuntime;
  settings: SettingsRuntime;
  workspace: WorkspaceRuntime;
  getBaseUrl(): string;
  setBaseUrl(baseUrl: string): void;
  health(): Promise<HealthResponse>;
}

export function createRuntimeBridge(options: RuntimeBridgeOptions = {}): RuntimeBridge {
  const http = options.httpClient ?? createHttpClient(options);
  const settings = createSettingsRuntime(http);

  return {
    http,
    conversation: createConversationRuntime(http, options),
    models: createModelsRuntime(http),
    settings,
    workspace: createWorkspaceRuntime(http),
    getBaseUrl() {
      return http.getBaseUrl();
    },
    setBaseUrl(baseUrl) {
      http.setBaseUrl(baseUrl);
    },
    health() {
      return settings.health();
    },
  };
}

export const runtimeBridge = createRuntimeBridge();
