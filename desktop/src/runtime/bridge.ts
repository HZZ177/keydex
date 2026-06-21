import { createConversationRuntime, type ConversationRuntime, type ConversationRuntimeOptions } from "./conversation";
import { createHttpClient, HttpClient, type HttpClientOptions } from "./httpClient";
import { createModelsRuntime, type ModelsRuntime } from "./models";
import { createSettingsRuntime, type HealthResponse, type SettingsRuntime } from "./settings";
import { createUsageRuntime, type UsageRuntime } from "./usage";
import { createWorkspaceRuntime, type WorkspaceRuntime } from "./workspace";
import { createWorkspacesRuntime, type WorkspacesRuntime } from "./workspaces";
import { createDesktopPickerRuntime, type DesktopPickerRuntime } from "./desktopPicker";

export interface RuntimeBridgeOptions extends HttpClientOptions, ConversationRuntimeOptions {
  httpClient?: HttpClient;
}

export interface RuntimeBridge {
  http: HttpClient;
  conversation: ConversationRuntime;
  models: ModelsRuntime;
  settings: SettingsRuntime;
  usage: UsageRuntime;
  workspace: WorkspaceRuntime;
  workspaces: WorkspacesRuntime;
  desktopPicker: DesktopPickerRuntime;
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
    usage: createUsageRuntime(http),
    workspace: createWorkspaceRuntime(http),
    workspaces: createWorkspacesRuntime(http),
    desktopPicker: createDesktopPickerRuntime(),
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
