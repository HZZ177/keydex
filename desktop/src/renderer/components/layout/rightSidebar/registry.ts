import {
  RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION,
  type AnyRightSidebarPanelDefinition,
  type JsonObject,
  type PanelCreateContext,
  type PanelNormalizeContext,
  type RightSidebarPanelCapabilities,
  type RightSidebarPanelDefinition,
  type RightSidebarRegisteredInitialAction,
  type RightSidebarPanelKind,
  type RightSidebarPanelPresentation,
  type RightSidebarPanelState,
  type RightSidebarPanelStateFor,
  type RightSidebarScopeStateV2,
} from "./types";
import { BROWSER_LIMITS } from "@/renderer/features/browser/config";

const SCOPE_STATE_KEYS = [
  "version",
  "activePanelId",
  "panelOrder",
  "panels",
  "nextPanelSeq",
] as const;

export class RightSidebarDefinitionRegistry {
  private readonly definitions = new Map<
    RightSidebarPanelKind,
    AnyRightSidebarPanelDefinition
  >();

  constructor(definitions: readonly AnyRightSidebarPanelDefinition[] = []) {
    definitions.forEach((definition) => this.register(definition));
  }

  register(definition: AnyRightSidebarPanelDefinition): void {
    if (this.definitions.has(definition.kind)) {
      throw new Error(`Right sidebar panel kind is already registered: ${definition.kind}`);
    }
    if (!Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
      throw new Error("Right sidebar panel definitions require a positive schemaVersion");
    }
    if (!definition.idPrefix.trim() || !definition.label.trim()) {
      throw new Error("Right sidebar panel definitions require label and idPrefix");
    }
    if (!Number.isFinite(definition.order)) {
      throw new Error("Right sidebar panel definitions require a finite order");
    }
    const existingActionIds = new Set(this.listInitialActions().map((action) => action.id));
    for (const action of definition.initialActions ?? []) {
      if (!action.id.trim() || !action.label.trim()) {
        throw new Error("Right sidebar initial actions require id and label");
      }
      if (existingActionIds.has(action.id)) {
        throw new Error(`Right sidebar initial action is already registered: ${action.id}`);
      }
      existingActionIds.add(action.id);
    }
    this.definitions.set(definition.kind, Object.freeze(definition));
  }

  get<K extends RightSidebarPanelKind>(kind: K): RightSidebarPanelDefinition<K> {
    const definition = this.definitions.get(kind);
    if (!definition) throw new Error(`Unknown right sidebar panel kind: ${kind}`);
    return definition as RightSidebarPanelDefinition<K>;
  }

  list(): readonly AnyRightSidebarPanelDefinition[] {
    return Array.from(this.definitions.values()).sort(
      (left, right) => left.order - right.order || left.kind.localeCompare(right.kind),
    );
  }

  listInitialActions(): readonly RightSidebarRegisteredInitialAction[] {
    return this.list().flatMap((definition) =>
      (definition.initialActions ?? []).map((action) => ({
        ...action,
        kind: definition.kind,
      })),
    );
  }

  panelId(kind: RightSidebarPanelKind, sequence: number): string {
    const definition = this.get(kind);
    return definition.multiplicity === "singleton"
      ? `${definition.idPrefix}singleton`
      : `${definition.idPrefix}${sequence}`;
  }

  create<K extends RightSidebarPanelKind>(
    kind: K,
    context: PanelCreateContext,
  ): RightSidebarPanelStateFor<K> {
    const definition = this.get(kind);
    const created = definition.create(context);
    return this.requireNormalized(definition, created, {
      now: context.now,
      source: "migration",
    });
  }

  normalizePanel(
    raw: unknown,
    context: PanelNormalizeContext,
  ): RightSidebarPanelState | null {
    if (!isRecord(raw) || !isRightSidebarPanelKind(raw.kind)) return null;
    const definition = this.definitions.get(raw.kind);
    if (!definition || raw.schemaVersion !== definition.schemaVersion) return null;
    const normalized = definition.normalize(raw, context);
    if (!normalized || normalized.kind !== definition.kind) return null;
    if (normalized.schemaVersion !== definition.schemaVersion) return null;
    return normalized;
  }

  normalizeScopeState(
    raw: unknown,
    context: PanelNormalizeContext,
  ): RightSidebarScopeStateV2 | null {
    if (!isRecord(raw) || !hasExactKeys(raw, SCOPE_STATE_KEYS)) return null;
    if (raw.version !== RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION) return null;
    if (!Array.isArray(raw.panelOrder) || !raw.panelOrder.every(isNonEmptyString)) return null;
    if (!isRecord(raw.panels)) return null;
    if (!Number.isInteger(raw.nextPanelSeq) || Number(raw.nextPanelSeq) < 0) return null;
    if (raw.activePanelId !== null && !isNonEmptyString(raw.activePanelId)) return null;

    const panels: Record<string, RightSidebarPanelState> = {};
    for (const [panelId, panelValue] of Object.entries(raw.panels)) {
      if (!isNonEmptyString(panelId)) continue;
      const panel = this.normalizePanel(panelValue, context);
      if (panel?.id === panelId) panels[panelId] = panel;
    }

    const seen = new Set<string>();
    const panelOrder = raw.panelOrder.filter((panelId) => {
      if (!panels[panelId] || seen.has(panelId)) return false;
      seen.add(panelId);
      return true;
    });
    for (const panelId of Object.keys(panels).sort()) {
      if (!seen.has(panelId)) panelOrder.push(panelId);
    }
    let browserCount = 0;
    const boundedPanelOrder = panelOrder.filter((panelId) => {
      if (panels[panelId]?.kind !== "browser") return true;
      browserCount += 1;
      if (browserCount <= BROWSER_LIMITS.maxPanelMetadata) return true;
      delete panels[panelId];
      return false;
    });

    const requestedActivePanelId = raw.activePanelId;
    const activePanelId =
      requestedActivePanelId && panels[requestedActivePanelId]
        ? requestedActivePanelId
        : boundedPanelOrder[0] ?? null;

    return {
      version: RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION,
      activePanelId,
      panelOrder: boundedPanelOrder,
      panels,
      nextPanelSeq: Number(raw.nextPanelSeq),
    };
  }

  serializePanel(state: RightSidebarPanelState): JsonObject {
    return withDefinition(this, state, (definition, narrowedState) =>
      definition.serialize(narrowedState));
  }

  serializeScopeState(state: RightSidebarScopeStateV2): JsonObject {
    const panels: Record<string, JsonObject> = {};
    for (const [panelId, panel] of Object.entries(state.panels)) {
      panels[panelId] = this.serializePanel(panel);
    }
    return {
      version: RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION,
      activePanelId: state.activePanelId,
      panelOrder: [...state.panelOrder],
      panels,
      nextPanelSeq: state.nextPanelSeq,
    };
  }

  getPresentation(state: RightSidebarPanelState): RightSidebarPanelPresentation {
    return withDefinition(this, state, (definition, narrowedState) =>
      definition.getPresentation(narrowedState));
  }

  getCapabilities(state: RightSidebarPanelState): RightSidebarPanelCapabilities {
    return withDefinition(this, state, (definition, narrowedState) =>
      definition.getCapabilities(narrowedState));
  }

  private requireNormalized<K extends RightSidebarPanelKind>(
    definition: RightSidebarPanelDefinition<K>,
    state: RightSidebarPanelStateFor<K>,
    context: PanelNormalizeContext,
  ): RightSidebarPanelStateFor<K> {
    const serialized = definition.serialize(state);
    const normalized = definition.normalize(serialized, context);
    if (!normalized) {
      throw new Error(`Right sidebar panel definition failed roundtrip: ${definition.kind}`);
    }
    return normalized;
  }
}

function withDefinition<TResult>(
  registry: RightSidebarDefinitionRegistry,
  state: RightSidebarPanelState,
  operation: {
    bivarianceHack<K extends RightSidebarPanelKind>(
      definition: RightSidebarPanelDefinition<K>,
      state: RightSidebarPanelStateFor<K>,
    ): TResult;
  }["bivarianceHack"],
): TResult {
  switch (state.kind) {
    case "files":
      return operation(registry.get("files"), state);
    case "conversation":
      return operation(registry.get("conversation"), state);
    case "review":
      return operation(registry.get("review"), state);
    case "browser":
      return operation(registry.get("browser"), state);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRightSidebarPanelKind(value: unknown): value is RightSidebarPanelKind {
  return value === "files" || value === "conversation" || value === "review" || value === "browser";
}
