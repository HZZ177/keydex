import type { ReactNode } from "react";

import type { RuntimeBridge } from "@/runtime";
import { BROWSER_PROTOCOL_VERSIONS } from "@/renderer/features/browser/config";
import type { SelectedQuote } from "@/renderer/components/chat/SendBox";
import type { KeydexDiffDocument } from "@/renderer/components/diff/model";
import type { SubagentInvocationPanelDetails } from "@/renderer/components/layout/RightSidebarConversationContext";
import type { FileReviewChange } from "@/renderer/utils/fileReview";
import type {
  PreviewFileRevealTarget,
  PreviewRenderContext,
} from "@/renderer/providers/PreviewProvider";
import type { SubagentRunSnapshot } from "@/types/subagents";
import type { BrowserTabState } from "@/renderer/features/browser/domain";

export const RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION =
  BROWSER_PROTOCOL_VERSIONS.rightSidebarState;

export type RightSidebarPanelKind = "files" | "conversation" | "review" | "browser";
export type RightSidebarPanelIcon = "folder" | "message" | "bot" | "review" | "browser";

export interface RightSidebarInitialActionDefinition {
  readonly id: string;
  readonly label: string;
  readonly icon: RightSidebarPanelIcon;
}

export interface RightSidebarRegisteredInitialAction extends RightSidebarInitialActionDefinition {
  readonly kind: RightSidebarPanelKind;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

interface RightSidebarPanelStateBase<K extends RightSidebarPanelKind> {
  readonly id: string;
  readonly kind: K;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly lastActivatedAt: string;
}

export interface FilesPanelState extends RightSidebarPanelStateBase<"files"> {
  readonly filePreviewPath: string | null;
  readonly filePreviewRequestId: number;
  readonly filePreviewRevealTarget: PreviewFileRevealTarget | null;
  readonly directoryRevealPath: string | null;
  readonly directoryRevealRequestId: number;
}

export interface ConversationPanelState extends RightSidebarPanelStateBase<"conversation"> {
  readonly conversationKind: "conversation" | "subagent";
  readonly status: "opening" | "ready";
  readonly sessionId: string;
  readonly title: string;
  readonly sourceSessionId: string | null;
  readonly parentSessionId: string | null;
  readonly quoteRequest: ConversationPanelQuoteRequest | null;
  readonly loadedHistoryTurnCount: number | null;
  readonly subagentRun: SubagentRunSnapshot | null;
  readonly subagentInvocation: SubagentInvocationPanelDetails | null;
}

export interface ConversationPanelQuoteRequest {
  readonly requestId: number;
  readonly quote: SelectedQuote;
}

export interface ReviewPanelState extends RightSidebarPanelStateBase<"review"> {
  readonly title: string;
  readonly files: readonly FileReviewChange[];
  readonly document: KeydexDiffDocument | null;
  readonly focusedPath: string | null;
  readonly panelKey: string;
  readonly sourceMessageId: string | null;
  readonly toolCallId: string | null;
  readonly requestId: number;
}

export interface BrowserPanelState
  extends RightSidebarPanelStateBase<"browser">, BrowserTabState {}

export interface RightSidebarPanelStateMap {
  readonly files: FilesPanelState;
  readonly conversation: ConversationPanelState;
  readonly review: ReviewPanelState;
  readonly browser: BrowserPanelState;
}

export type RightSidebarPanelState = RightSidebarPanelStateMap[RightSidebarPanelKind];
export type RightSidebarPanelStateFor<K extends RightSidebarPanelKind> =
  RightSidebarPanelStateMap[K];

export interface RightSidebarScopeStateV2 {
  readonly version: typeof RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION;
  readonly activePanelId: string | null;
  readonly panelOrder: string[];
  readonly panels: Record<string, RightSidebarPanelState>;
  readonly nextPanelSeq: number;
}

export interface PanelCreateContext {
  readonly id: string;
  readonly sequence: number;
  readonly now: string;
  readonly input?: JsonObject;
}

export interface PanelNormalizeContext {
  readonly now: string;
  readonly source: "persistence" | "migration";
}

export interface RightSidebarPanelPresentation {
  readonly title: string;
  readonly icon?: RightSidebarPanelIcon;
  readonly badge?: string;
}

export interface RightSidebarPanelCapabilities {
  readonly closable: boolean;
  readonly duplicable: boolean;
  readonly persistable: boolean;
}

export interface RightSidebarPanelRenderProps<K extends RightSidebarPanelKind> {
  readonly active: boolean;
  readonly hostContext: RightSidebarPanelHostContextMap[K];
  readonly scopeKey: string;
  readonly state: RightSidebarPanelStateFor<K>;
  updateState(state: RightSidebarPanelStateFor<K>): void;
}

export interface FilesPanelHostContext {
  readonly maximized: boolean;
  readonly renderContext: PreviewRenderContext;
  onOpenHtmlBrowserPreview(absolutePath: string): void;
  onRestore(): void;
}

export interface BrowserPanelHostContext {
  onCreatePanel(url?: string): void;
  onActivatePanel(panelId: string): void;
  onClosePanel(panelId: string): void;
}

export interface ConversationPanelHostContext {
  readonly a2uiRenderSuspended: boolean;
  readonly runtime: RuntimeBridge;
  onNavigateToConversation?(sessionId: string): void;
  onOpenModelSettings?(): void;
  onQuoteRequestHandled(panelId: string, requestId: number): void;
  onOpenSubagentList(parentSessionId: string): void;
}

export interface ReviewPanelHostContext {
  onOpenFile?(path: string): void;
}

export interface RightSidebarPanelHostContextMap {
  readonly files: FilesPanelHostContext;
  readonly conversation: ConversationPanelHostContext;
  readonly review: ReviewPanelHostContext;
  readonly browser: BrowserPanelHostContext;
}

export interface RightSidebarPanelLifecycleContext {
  readonly scopeKey: string;
}

export interface RightSidebarPanelLifecycle<K extends RightSidebarPanelKind> {
  mount?(
    state: RightSidebarPanelStateFor<K>,
    context: RightSidebarPanelLifecycleContext,
  ): void | Promise<void>;
  activate?(
    state: RightSidebarPanelStateFor<K>,
    context: RightSidebarPanelLifecycleContext,
  ): void | Promise<void>;
  deactivate?(
    state: RightSidebarPanelStateFor<K>,
    context: RightSidebarPanelLifecycleContext,
  ): void | Promise<void>;
  destroy?(
    state: RightSidebarPanelStateFor<K>,
    context: RightSidebarPanelLifecycleContext,
  ): void | Promise<void>;
}

export interface RightSidebarPanelDefinition<K extends RightSidebarPanelKind> {
  readonly kind: K;
  readonly schemaVersion: number;
  readonly label: string;
  readonly order: number;
  readonly multiplicity: "multiple" | "singleton";
  readonly idPrefix: string;
  readonly initialActions?: readonly RightSidebarInitialActionDefinition[];
  create(context: PanelCreateContext): RightSidebarPanelStateFor<K>;
  normalize(
    raw: unknown,
    context: PanelNormalizeContext,
  ): RightSidebarPanelStateFor<K> | null;
  serialize(state: RightSidebarPanelStateFor<K>): JsonObject;
  getPresentation(state: RightSidebarPanelStateFor<K>): RightSidebarPanelPresentation;
  getCapabilities(state: RightSidebarPanelStateFor<K>): RightSidebarPanelCapabilities;
  render(props: RightSidebarPanelRenderProps<K>): ReactNode;
  readonly lifecycle?: RightSidebarPanelLifecycle<K>;
}

export type AnyRightSidebarPanelDefinition = {
  readonly [K in RightSidebarPanelKind]: RightSidebarPanelDefinition<K>;
}[RightSidebarPanelKind];

export function emptyRightSidebarScopeStateV2(): RightSidebarScopeStateV2 {
  return {
    version: RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION,
    activePanelId: null,
    panelOrder: [],
    panels: {},
    nextPanelSeq: 0,
  };
}
