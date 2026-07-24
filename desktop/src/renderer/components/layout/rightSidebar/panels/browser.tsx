import { useMemo } from "react";

import {
  BROWSER_INTERNAL_BLANK_URL,
} from "@/renderer/features/browser/config";
import {
  sanitizeBrowserRestoreUrl,
  type BrowserTabHostAdapter,
} from "@/renderer/features/browser/domain";
import { BrowserTabSurface } from "@/renderer/features/browser/ui/BrowserTabSurface";
import {
  COMPOSER_NEW_CHAT_DRAFT_SCOPE,
  composerNewWorkspaceDraftScope,
} from "@/renderer/features/composer";
import browserStyles from "@/renderer/features/browser/ui/BrowserPanel.module.css";

import layoutStyles from "../../Layout.module.css";
import type {
  BrowserPanelState,
  JsonObject,
  PanelCreateContext,
  RightSidebarPanelDefinition,
  RightSidebarPanelRenderProps,
} from "../types";

export const BROWSER_PANEL_SCHEMA_VERSION = 1 as const;
export const BROWSER_START_URL = "" as const;

const BROWSER_PANEL_KEYS = [
  "id", "kind", "schemaVersion", "title", "faviconUrl", "restoreUrl",
  "restoreUrlSanitized", "profileMode", "zoomFactor", "createdAt", "lastActivatedAt",
] as const;

export const browserPanelDefinition = Object.freeze<RightSidebarPanelDefinition<"browser">>({
  kind: "browser",
  schemaVersion: BROWSER_PANEL_SCHEMA_VERSION,
  label: "浏览器",
  order: 40,
  multiplicity: "multiple",
  idPrefix: "right-sidebar:browser:",
  initialActions: [{ id: "browser", label: "浏览器", icon: "browser" }],
  create(context) {
    return createBrowserPanelState(context);
  },
  normalize(raw) {
    return normalizeBrowserPanelState(raw);
  },
  serialize(state) {
    return serializeBrowserPanelState(state);
  },
  getPresentation(state) {
    return {
      title: state.title || "浏览器",
      icon: "browser",
      badge: state.profileMode === "incognito" ? "无痕" : undefined,
    };
  },
  getCapabilities() {
    return { closable: true, duplicable: true, persistable: true };
  },
  render(props) {
    return <BrowserSidebarPanel key={`${props.scopeKey}:${props.state.id}`} {...props} />;
  },
});

export function browserPanelCreateInput(input: {
  readonly profileMode?: "persistent" | "incognito";
  readonly restoreUrl?: string;
} = {}): JsonObject {
  const restore = browserPanelRestoreUrl(input.restoreUrl ?? BROWSER_START_URL);
  return {
    profileMode: input.profileMode ?? "persistent",
    restoreUrl: restore.restoreUrl,
  };
}

export function normalizeBrowserPanelState(raw: unknown): BrowserPanelState | null {
  if (
    !isRecord(raw)
    || Object.keys(raw).some((key) => !BROWSER_PANEL_KEYS.includes(key as typeof BROWSER_PANEL_KEYS[number]))
    || BROWSER_PANEL_KEYS.some((key) => key !== "faviconUrl" && !Object.prototype.hasOwnProperty.call(raw, key))
  ) return null;
  if (raw.kind !== "browser" || raw.schemaVersion !== BROWSER_PANEL_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.createdAt) || !isNonEmptyString(raw.lastActivatedAt)) return null;
  if (typeof raw.title !== "string" || typeof raw.restoreUrlSanitized !== "boolean") return null;
  if (raw.faviconUrl !== undefined && raw.faviconUrl !== null && typeof raw.faviconUrl !== "string") return null;
  if (raw.profileMode !== "persistent" && raw.profileMode !== "incognito") return null;
  if (typeof raw.zoomFactor !== "number" || raw.zoomFactor < 0.5 || raw.zoomFactor > 3) return null;
  const restore = typeof raw.restoreUrl === "string" ? normalizedBrowserPanelRestoreUrl(raw.restoreUrl) : null;
  if (!restore) return null;
  return {
    id: raw.id,
    kind: "browser",
    schemaVersion: BROWSER_PANEL_SCHEMA_VERSION,
    title: raw.title.slice(0, 512),
    ...(typeof raw.faviconUrl === "string" && raw.faviconUrl
      ? { faviconUrl: raw.faviconUrl.slice(0, 2_048) }
      : {}),
    restoreUrl: restore.restoreUrl,
    restoreUrlSanitized: raw.restoreUrlSanitized || restore.sanitized,
    profileMode: raw.profileMode,
    zoomFactor: raw.zoomFactor,
    createdAt: raw.createdAt,
    lastActivatedAt: raw.lastActivatedAt,
  };
}

export function serializeBrowserPanelState(state: BrowserPanelState): JsonObject {
  return {
    id: state.id,
    kind: state.kind,
    schemaVersion: state.schemaVersion,
    title: state.title,
    faviconUrl: state.faviconUrl ?? null,
    restoreUrl: state.restoreUrl || BROWSER_INTERNAL_BLANK_URL,
    restoreUrlSanitized: state.restoreUrlSanitized,
    profileMode: state.profileMode,
    zoomFactor: state.zoomFactor,
    createdAt: state.createdAt,
    lastActivatedAt: state.lastActivatedAt,
  };
}

function BrowserSidebarPanel({
  active,
  hostContext,
  scopeKey,
  state,
  updateState,
}: RightSidebarPanelRenderProps<"browser">) {
  const host = useMemo<BrowserTabHostAdapter<BrowserPanelState>>(() => ({
    kind: "agent",
    scopeKey,
    composerScopeKey: browserAnnotationComposerScopeKey(scopeKey),
    active,
    state,
    updateState,
    createTab: (options) => hostContext.onCreatePanel(options?.restoreUrl),
    activateTab: hostContext.onActivatePanel,
    closeTab: hostContext.onClosePanel,
  }), [active, hostContext, scopeKey, state, updateState]);

  return (
    <div
      className={`${layoutStyles.rightSidebarBody} ${browserStyles.workspace}`}
      data-browser-adapter="agent"
      hidden={!active}
    >
      <BrowserTabSurface host={host} />
    </div>
  );
}

function createBrowserPanelState(context: PanelCreateContext): BrowserPanelState {
  const input = context.input ?? {};
  const restore = browserPanelRestoreUrl(
    typeof input.restoreUrl === "string" ? input.restoreUrl : BROWSER_START_URL,
  );
  return {
    id: context.id,
    kind: "browser",
    schemaVersion: BROWSER_PANEL_SCHEMA_VERSION,
    title: "新标签页",
    restoreUrl: restore.restoreUrl,
    restoreUrlSanitized: restore.sanitized,
    profileMode: input.profileMode === "incognito" ? "incognito" : "persistent",
    zoomFactor: 1,
    createdAt: context.now,
    lastActivatedAt: context.now,
  };
}

function browserPanelRestoreUrl(value: string): {
  readonly restoreUrl: string;
  readonly sanitized: boolean;
} {
  if (!value) return { restoreUrl: BROWSER_START_URL, sanitized: false };
  const restore = sanitizeBrowserRestoreUrl(value);
  return {
    restoreUrl: restore.restoreUrl ?? BROWSER_START_URL,
    sanitized: restore.sanitized,
  };
}

function normalizedBrowserPanelRestoreUrl(value: string): {
  readonly restoreUrl: string;
  readonly sanitized: boolean;
} | null {
  if (!value || value === BROWSER_INTERNAL_BLANK_URL) {
    return { restoreUrl: BROWSER_START_URL, sanitized: false };
  }
  const restore = sanitizeBrowserRestoreUrl(value);
  return restore.restoreUrl
    ? { restoreUrl: restore.restoreUrl, sanitized: restore.sanitized }
    : null;
}

export function browserAnnotationComposerScopeKey(scopeKey: string): string | null {
  const normalized = scopeKey.trim();
  if (normalized === "global") return COMPOSER_NEW_CHAT_DRAFT_SCOPE;
  if (normalized.startsWith("session:")) {
    return normalized.slice("session:".length).trim() ? normalized : null;
  }
  if (normalized.startsWith("workspace:")) {
    const workspaceId = normalized.slice("workspace:".length).trim();
    return workspaceId ? composerNewWorkspaceDraftScope(workspaceId) : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
