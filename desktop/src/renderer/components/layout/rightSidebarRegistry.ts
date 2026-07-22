import { RightSidebarDefinitionRegistry } from "./rightSidebar/registry";
import { filesPanelDefinition } from "./rightSidebar/panels/files";
import { conversationPanelDefinition } from "./rightSidebar/panels/conversation";
import { reviewPanelDefinition } from "./rightSidebar/panels/review";
import { browserPanelDefinition } from "./rightSidebar/panels/browser";
import { BROWSER_FEATURE_FLAGS } from "@/renderer/features/browser/config";

export { RightSidebarDefinitionRegistry } from "./rightSidebar/registry";
export {
  reduceRightSidebarState,
} from "./rightSidebar/reducer";
export type {
  RightSidebarLifecycleIntent,
  RightSidebarLifecycleIntentType,
  RightSidebarReducerAction,
  RightSidebarReducerResult,
  RightSidebarReducerWarning,
} from "./rightSidebar/reducer";
export {
  panelStateFromLifecycleIntent,
  runRightSidebarLifecycleIntents,
} from "./rightSidebar/lifecycle";
export type {
  RightSidebarLifecycleFailure,
} from "./rightSidebar/lifecycle";
export type {
  AnyRightSidebarPanelDefinition,
  BrowserPanelState,
  ConversationPanelQuoteRequest,
  ConversationPanelState,
  FilesPanelState,
  JsonObject,
  JsonValue,
  PanelCreateContext,
  PanelNormalizeContext,
  ReviewPanelState,
  RightSidebarPanelCapabilities,
  RightSidebarPanelDefinition,
  RightSidebarPanelKind,
  RightSidebarRegisteredInitialAction,
  RightSidebarPanelLifecycle,
  RightSidebarPanelPresentation,
  RightSidebarPanelRenderProps,
  RightSidebarPanelState,
  RightSidebarPanelStateFor,
  RightSidebarScopeStateV2,
} from "./rightSidebar/types";
export {
  RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION,
  emptyRightSidebarScopeStateV2,
} from "./rightSidebar/types";

export type RightSidebarRegisteredPanelType = "files" | "conversation" | "review";

export function createRightSidebarDefinitionRegistry(
  browserEnabled = BROWSER_FEATURE_FLAGS.browserEnabled,
): RightSidebarDefinitionRegistry {
  return new RightSidebarDefinitionRegistry([
    conversationPanelDefinition,
    filesPanelDefinition,
    reviewPanelDefinition,
    ...(browserEnabled ? [browserPanelDefinition] : []),
  ]);
}

export const rightSidebarDefinitionRegistry = createRightSidebarDefinitionRegistry();

export interface RightSidebarPanelMetadataDefinition {
  type: RightSidebarRegisteredPanelType;
  label: string;
  icon: "folder" | "message" | "review";
  order: number;
  multiplicity: "multiple" | "singleton";
  idPrefix: string;
}

export class RightSidebarPanelRegistry {
  private readonly definitions = new Map<
    RightSidebarRegisteredPanelType,
    RightSidebarPanelMetadataDefinition
  >();

  constructor(definitions: readonly RightSidebarPanelMetadataDefinition[] = []) {
    definitions.forEach((definition) => this.register(definition));
  }

  register(definition: RightSidebarPanelMetadataDefinition): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Right sidebar panel type is already registered: ${definition.type}`);
    }
    if (!definition.idPrefix.trim() || !definition.label.trim()) {
      throw new Error("Right sidebar panel definitions require label and idPrefix");
    }
    this.definitions.set(definition.type, Object.freeze({ ...definition }));
  }

  get(type: RightSidebarRegisteredPanelType): RightSidebarPanelMetadataDefinition {
    const definition = this.definitions.get(type);
    if (!definition) throw new Error(`Unknown right sidebar panel type: ${type}`);
    return definition;
  }

  list(): readonly RightSidebarPanelMetadataDefinition[] {
    return Array.from(this.definitions.values()).sort(
      (left, right) => left.order - right.order || left.type.localeCompare(right.type),
    );
  }

  resolve(panelId: string): RightSidebarPanelMetadataDefinition | null {
    return this.list().find((definition) => panelId.startsWith(definition.idPrefix)) ?? null;
  }

  panelId(type: RightSidebarRegisteredPanelType, sequence = 1): string {
    const definition = this.get(type);
    return definition.multiplicity === "singleton"
      ? `${definition.idPrefix}singleton`
      : `${definition.idPrefix}${sequence}`;
  }
}

export const rightSidebarPanelRegistry = new RightSidebarPanelRegistry([
  {
    type: "conversation",
    label: "旁路对话",
    icon: "message",
    order: 10,
    multiplicity: "multiple",
    idPrefix: "right-sidebar:conversation:",
  },
  {
    type: "files",
    label: "文件",
    icon: "folder",
    order: 20,
    multiplicity: "multiple",
    idPrefix: "right-sidebar:files:",
  },
  {
    type: "review",
    label: "审阅",
    icon: "review",
    order: 30,
    multiplicity: "multiple",
    idPrefix: "right-sidebar:review:",
  },
]);
