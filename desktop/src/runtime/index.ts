export { HttpClient, createHttpClient, normalizeErrorEnvelope, redactForLog } from "./httpClient";
export { RuntimeWsClient, buildWsUrl, createWsClient, toWebSocketBaseUrl } from "./wsClient";
export {
  RuntimeError,
  RuntimeHttpError,
  extractRuntimeErrorContext,
  isRuntimeHttpError,
  normalizeRuntimeErrorEnvelope,
  notImplemented,
} from "./errors";
export { createRuntimeBridge, runtimeBridge } from "./bridge";
export {
  DEV_AGENT_CONNECTION,
  configureAgentConnection,
  isTauriRuntime,
  resolveAgentConnection,
  waitForAgentHealth,
} from "./agentConnection";
export { createSettingsRuntime } from "./settings";
export { createLocalPreviewRuntime } from "./localPreview";
export {
  DEFAULT_DOCUMENT_CHUNK_BYTES,
  DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
  DOCUMENT_READ_PROTOCOL_VERSION,
  DocumentReadAssembler,
  DocumentReadProtocolError,
  createDocumentReadMessages,
  createDocumentReadRequest,
  createWholeDocumentReadResult,
} from "./documentRead";
export {
  DOCUMENT_WRITE_PROTOCOL_VERSION,
  createDocumentWriteId,
  createDocumentWriteRequest,
} from "./documentWrite";
export type {
  DocumentReadChunkMessage,
  DocumentReadCompleteMessage,
  DocumentReadErrorCode,
  DocumentReadErrorMessage,
  DocumentReadMessage,
  DocumentReadRequest,
  DocumentReadResult,
  DocumentReadSource,
  DocumentReadStartMessage,
  DocumentReadTransport,
} from "./documentRead";
export type { DocumentWriteRequest, DocumentWriteResult } from "./documentWrite";
export { createModelsRuntime } from "./models";
export { createConversationRuntime } from "./conversation";
export { createUsageRuntime } from "./usage";
export { createWorkspaceRuntime } from "./workspace";
export { createWorkspacesRuntime } from "./workspaces";
export { createArchiveRuntime, createLifecycleRequestId, decodeLifecycleRuntimeError } from "./archive";
export { createDesktopPickerRuntime } from "./desktopPicker";
export { createAttachmentsRuntime } from "./attachments";
export { createAnnotationsRuntime } from "./annotations";
export { createMcpRuntime } from "./mcp";
export { createKeydexRuntime, createSkillRuntime } from "./skills";
export { createGitRuntime } from "./git";
export {
  canUseAppUpdater,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  getCurrentAppVersion,
} from "./appUpdate";
export {
  loadAppReleaseHistory,
  normalizeReleaseMarkdown,
  parseGitHubReleaseList,
} from "./appReleaseNotes";
export {
  ASSOCIATED_FILE_OPEN_REQUESTED_EVENT,
  listenForAssociatedFileOpenRequested,
  takeAssociatedFileOpenPaths,
} from "./associatedFiles";
export type { HttpClientOptions, RequestOptions } from "./httpClient";
export type { WebSocketConstructor, WebSocketLike, WsClientOptions, WsConnectionStatus } from "./wsClient";
export type {
  NormalizeRuntimeErrorOptions,
  RuntimeErrorContext,
  RuntimeErrorEnvelope,
  RuntimeErrorEnvelopeInput,
  RuntimeHttpErrorParams,
} from "./errors";
export type { RuntimeBridge, RuntimeBridgeOptions } from "./bridge";
export type {
  GitBranchCommand,
  GitCheckoutCommand,
  GitCommandBase,
  GitCommitCommand,
  GitMetadataListener,
  GitPathsCommand,
  GitProjectScope,
  GitQueryOptions,
  GitRemoteCommand,
  GitRepositoryScope,
  GitRuntime,
} from "./git";
export type * from "./gitTypes";
export type {
  AgentConnection,
  AgentConnectionOptions,
  AgentConnectionRuntime,
  TauriInvoke,
} from "./agentConnection";
export type {
  HealthResponse,
  SettingsRuntime,
  UpdateWebSettingsPayload,
  WebCapability,
  WebConnectionCheckDraft,
  WebConnectionCheckError,
  WebConnectionCheckResponse,
  WebProviderConfigField,
  WebProviderConfigStatus,
  WebProviderFieldType,
  WebProviderSelectOption,
  WebProviderSettings,
  WebProviderSettingsUpdate,
  WebSecretState,
  WebSecretRevealResponse,
  WebSecretUpdate,
  WebSettingsResponse,
} from "./settings";
export type {
  LocalHtmlPreviewResponse,
  LocalPreviewFileResponse,
  LocalPreviewDocumentReadOptions,
  LocalPreviewDocumentWriteOptions,
  LocalPreviewMediaResponse,
  LocalPreviewRuntimeOptions,
  LocalPreviewRuntime,
} from "./localPreview";
export type {
  ModelHealth,
  ModelHealthResponse,
  ModelListResponse,
  ModelProvider,
  ModelProviderInput,
  ModelsRuntime,
} from "./models";
export type {
  UsageQueryOptions,
  UsageRequestListOptions,
  UsageRuntime,
  UsageTrendOptions,
} from "./usage";
export type {
  ChatChannel,
  ChatChannelOptions,
  ChatPayload,
  ConversationRuntime,
  ConversationRuntimeOptions,
  CreateSessionPayload,
  ListSessionsOptions,
  LoadHistoryOptions,
  LoadToolDetailsOptions,
  ReorderPendingInputsPayload,
  ResumePendingInputsPayload,
  SessionReverseDecision,
  SessionReverseExecutePayload,
  SessionReverseFilePreview,
  SessionReverseMode,
  SessionReverseOperationStatus,
  SessionReversePreview,
  SessionReverseResult,
  SessionReverseStatus,
  UpdatePendingInputPayload,
  UpdateSessionPayload,
} from "./conversation";
export type {
  WorkspaceEntry,
  WorkspaceFileResponse,
  WorkspaceMediaResponse,
  WorkspaceRuntime,
  WorkspaceDocumentReadOptions,
  WorkspaceDocumentWriteOptions,
  WorkspaceScope,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
  WorkspaceSessionScope,
  WorkspaceSubtreeOptions,
  WorkspaceSubtreeResponse,
  WorkspaceTreeResponse,
} from "./workspace";
export type {
  EffectiveSkillsMode,
  EffectiveSkillsResponse,
  KeydexCapabilityOverview,
  KeydexDiagnostic,
  KeydexLayerCapabilityOverview,
  KeydexLayerOverview,
  KeydexRuntime,
  KeydexRuntimeDiagnostic,
  RuntimeOverviewResponse,
  SkillListOptions,
  SkillResourceReadOptions,
  SkillResourceReadRequest,
  SkillResourceReadResponse,
  SkillRuntime,
  SkillSource,
  SkillSummary,
} from "./skills";
export type {
  CreateWorkspacePayload,
  UpdateWorkspacePayload,
  WorkspaceListResponse,
  WorkspaceResponse,
  WorkspacesRuntime,
} from "./workspaces";
export type {
  ArchiveCatalogPage,
  ArchiveListOptions,
  ArchiveOrigin,
  ArchiveRuntime,
  ArchiveSessionPayload,
  ArchiveWorkspacePayload,
  ArchivedSessionItem,
  ArchivedWorkspaceItem,
  LifecycleEventPayload,
  LifecycleRuntimeError,
  PurgeResult,
  RestoreSessionPayload,
  RestoreWorkspacePayload,
  SessionArchiveResult,
  SessionRestoreResult,
  WorkspaceArchiveResult,
  WorkspaceRestoreMode,
  WorkspaceRestoreResult,
} from "./archive";
export type {
  AttachmentMediaResponse,
  AttachmentRecord,
  AttachmentsRuntime,
  ImportImageUrlOptions,
  RegisterImagePathOptions,
  StoredLocalFileResponse,
  UploadImageOptions,
  UploadLocalFileOptions,
} from "./attachments";
export type {
  AnnotationBodyUpdate,
  AnnotationCreateInput,
  AnnotationListOptions,
  AnnotationRecord,
  AnnotationRetargetInput,
  AnnotationTarget,
  AnnotationsRuntime,
  DocumentAnnotationTarget,
  TextAnnotationTarget,
  TextContext,
  TextPosition,
  TextQuote,
  TextSelector,
} from "./annotations";
export type {
  DesktopPickerRuntime,
  DesktopPickerRuntimeOptions,
} from "./desktopPicker";
export type {
  McpAuditListOptions,
  McpRuntime,
  McpServerListOptions,
  McpToolListOptions,
  McpTrustRuleListOptions,
} from "./mcp";
export type { AppUpdateProgress, PendingAppUpdate } from "./appUpdate";
export type { AppReleaseHistory, AppReleaseNote } from "./appReleaseNotes";
export {
  createTerminalRuntime,
  decodeRuntimeEvent,
  encodeTerminalInput,
  isTerminalRuntimeAvailable,
  terminalRuntime,
  TerminalRuntimeError,
} from "./terminal";
export type {
  TerminalAttachment,
  TerminalAttachOptions,
  TerminalChannel,
  TerminalCreateOptions,
  TerminalIpcAdapter,
  TerminalResizeOptions,
  TerminalRuntime,
  TerminalRuntimeEvent,
} from "./terminal";
export type * from "./terminalTypes";
