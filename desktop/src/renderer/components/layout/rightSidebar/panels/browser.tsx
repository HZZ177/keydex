import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { persistableBrowserMetadata, resolveBrowserAddress, sanitizeBrowserRestoreUrl } from "@/renderer/features/browser/domain/browserNavigation";
import {
  BROWSER_FEATURE_FLAGS,
  BROWSER_INTERNAL_BLANK_URL,
} from "@/renderer/features/browser/config";
import {
  createWebAnnotationClient,
  createWebAnnotationHighlightPort,
  createWebAnnotationResolverPort,
  createWebAnnotationSessionPort,
  createWebAnnotationStore,
  WebAnnotationHighlightSynchronizer,
  WebAnnotationDrawer,
  webAnnotationPanelRegistry,
  webAnnotationReferencePresentations,
  summarizeWebAnnotationChanges,
  WebAnnotationResolverCoordinator,
  WebAnnotationSession,
  type WebAnnotationCoordinatorResolution,
  type WebAnnotationItem,
  type WebAnnotationNavigationPanel,
  type WebAnnotationVisibleStatus,
} from "@/renderer/features/browser/annotations";
import {
  BrowserBridgeRouter,
  browserDownloadController,
  browserPanelRuntime,
  BrowserPolicyCoordinator,
  isBrowserHostRuntimeAvailable,
  type BrowserBridgeEnvelope,
  type BrowserExternalProtocolRequest,
} from "@/renderer/features/browser/runtime";
import {
  BrowserExternalProtocolPrompt,
  BrowserPanel,
  BrowserFindBar,
  BrowserZoomBar,
  DangerousDownloadPrompt,
  DownloadsView,
  PermissionPrompt,
  type BrowserPermissionRequest,
} from "@/renderer/features/browser/ui";
import { openExternalProtocol } from "@/runtime/externalLinks";
import { runtimeBridge } from "@/runtime";
import { emitAddWebAnnotationToComposer } from "@/renderer/events/webAnnotationContext";
import {
  COMPOSER_NEW_CHAT_DRAFT_SCOPE,
  composerNewWorkspaceDraftScope,
} from "@/renderer/features/composer";
import { useTheme } from "@/renderer/providers/ThemeProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";

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
const traceBrowserAnnotation = (stage: string, detail: Record<string, unknown> = {}) => {
  console.info("[Keydex Browser Annotation]", stage, detail);
};

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
    return { title: state.title || "浏览器", icon: "browser", badge: state.profileMode === "incognito" ? "无痕" : undefined };
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
    ...(typeof raw.faviconUrl === "string" && raw.faviconUrl ? { faviconUrl: raw.faviconUrl.slice(0, 2_048) } : {}),
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

function browserPanelRestoreUrl(value: string): { readonly restoreUrl: string; readonly sanitized: boolean } {
  if (!value) return { restoreUrl: BROWSER_START_URL, sanitized: false };
  const restore = sanitizeBrowserRestoreUrl(value);
  return {
    restoreUrl: restore.restoreUrl ?? BROWSER_START_URL,
    sanitized: restore.sanitized,
  };
}

function normalizedBrowserPanelRestoreUrl(
  value: string,
): { readonly restoreUrl: string; readonly sanitized: boolean } | null {
  if (!value || value === BROWSER_INTERNAL_BLANK_URL) {
    return { restoreUrl: BROWSER_START_URL, sanitized: false };
  }
  const restore = sanitizeBrowserRestoreUrl(value);
  return restore.restoreUrl ? { restoreUrl: restore.restoreUrl, sanitized: restore.sanitized } : null;
}

function BrowserSidebarPanel({ active, hostContext, scopeKey, state, updateState }: RightSidebarPanelRenderProps<"browser">) {
  const { theme } = useTheme();
  const notifications = useNotifications();
  const generationRef = useRef(0);
  const [activatedGeneration, setActivatedGeneration] = useState(0);
  const runtime = useSyncExternalStore(
    browserPanelRuntime.store.subscribe,
    () => browserPanelRuntime.store.getState().surfaces[state.id],
    () => browserPanelRuntime.store.getState().surfaces[state.id],
  );
  const generation = runtime?.generation ?? activatedGeneration;
  generationRef.current = generation;
  const [address, setAddress] = useState(state.restoreUrl);
  const [permissionRequest, setPermissionRequest] = useState<BrowserPermissionRequest | null>(null);
  const [externalProtocolRequest, setExternalProtocolRequest] = useState<BrowserExternalProtocolRequest | null>(null);
  const [respondingPermission, setRespondingPermission] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatchCase, setFindMatchCase] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [annotationSession, setAnnotationSession] = useState<WebAnnotationSession | null>(null);
  const [annotationModeActive, setAnnotationModeActive] = useState(false);
  const [annotationResolver, setAnnotationResolver] = useState<WebAnnotationResolverCoordinator | null>(null);
  const [annotationResolutionStatuses, setAnnotationResolutionStatuses] = useState<
    Readonly<Record<string, WebAnnotationVisibleStatus | undefined>>
  >({});
  const [annotationResolutionDetails, setAnnotationResolutionDetails] = useState<
    Readonly<Record<string, WebAnnotationCoordinatorResolution | undefined>>
  >({});
  const annotationStore = useMemo(
    () => createWebAnnotationStore(createWebAnnotationClient(runtimeBridge.http)),
    [],
  );
  const annotationHighlightPort = useMemo(
    () => createWebAnnotationHighlightPort(browserPanelRuntime),
    [],
  );
  const annotationState = useSyncExternalStore(
    annotationStore.subscribe,
    annotationStore.getState,
    annotationStore.getState,
  );
  const addressInputRef = useRef<HTMLInputElement>(null);
  const [respondingDownload, setRespondingDownload] = useState(false);
  const downloads = useSyncExternalStore(
    browserDownloadController.store.subscribe,
    () => browserDownloadController.store.getState().items,
    () => browserDownloadController.store.getState().items,
  );
  const surface = runtime?.generation === generation ? runtime.surface : null;
  const navigation = runtime?.generation === generation ? runtime.navigation : null;
  const dangerousDownload = Object.values(downloads).find((item) =>
    item?.state === "requested"
    && item.dangerous
    && item.surface.panelId === state.id
    && item.surface.generation === generation) ?? null;
  const browserHostAvailable = isBrowserHostRuntimeAvailable();
  const annotationsAvailable = BROWSER_FEATURE_FLAGS.annotationsEnabled;
  const annotationEntry = annotationState.activePage
    ? annotationState.pages[annotationState.activePage.pageKey]
    : null;
  const activeRef = useRef(active);
  const hostContextRef = useRef(hostContext);
  const surfaceRef = useRef(surface);
  const navigationRef = useRef(navigation);
  const annotationResolverRef = useRef(annotationResolver);
  const annotationModeActiveRef = useRef(annotationModeActive);
  const lastUrlKeyRef = useRef<string | null>(null);
  const lastUrlKeyNavigationIdRef = useRef<string | null>(null);
  const lastDocumentUrlRef = useRef(state.restoreUrl);
  activeRef.current = active;
  hostContextRef.current = hostContext;
  surfaceRef.current = surface;
  navigationRef.current = navigation;
  annotationResolverRef.current = annotationResolver;
  annotationModeActiveRef.current = annotationModeActive;
  const updateAnnotationModeActive = (next: boolean) => {
    annotationModeActiveRef.current = next;
    setAnnotationModeActive(next);
  };
  if (annotationEntry?.resource) {
    lastUrlKeyRef.current = annotationEntry.resource.urlKey;
    lastUrlKeyNavigationIdRef.current = annotationState.activePage?.navigationId ?? null;
    lastDocumentUrlRef.current = annotationEntry.resource.documentUrl;
  } else if (
    active
    && navigation?.url
    && navigation.navigationId !== lastUrlKeyNavigationIdRef.current
  ) {
    lastUrlKeyRef.current = null;
    lastDocumentUrlRef.current = navigation.url;
  }
  const navigationPanelRef = useRef<WebAnnotationNavigationPanel | null>(null);
  if (!navigationPanelRef.current) {
    navigationPanelRef.current = {
      getSnapshot: () => ({
        scopeKey,
        panelId: state.id,
        active: activeRef.current,
        ready: Boolean(
          surfaceRef.current
          && navigationRef.current
          && !navigationRef.current.loading
          && annotationResolverRef.current,
        ),
        urlKey: lastUrlKeyRef.current,
        documentUrl: lastDocumentUrlRef.current,
      }),
      getResolution: (annotationId) => (
        annotationResolverRef.current?.getSnapshot().resolutions[annotationId]
      ),
      activate: () => hostContextRef.current.onActivatePanel(state.id),
      reveal: async (annotationId, target) => {
        const currentSurface = surfaceRef.current;
        if (!currentSurface) throw new Error("浏览器页面尚未就绪");
        await annotationHighlightPort.navigateToTarget({
          surface: currentSurface,
          annotationId,
          target,
        });
      },
    };
  }

  useEffect(() => (
    state.profileMode === "persistent"
      ? webAnnotationPanelRegistry.register(navigationPanelRef.current!)
      : undefined
  ), [scopeKey, state.id, state.profileMode]);
  useEffect(() => {
    webAnnotationPanelRegistry.notify();
  }, [
    active,
    annotationEntry?.resource?.documentUrl,
    annotationEntry?.resource?.urlKey,
    annotationResolutionStatuses,
    annotationResolver,
    navigation?.loading,
    navigation?.navigationId,
    navigation?.url,
    surface?.generation,
    surface?.surfaceId,
  ]);

  useEffect(() => {
    if (active) {
      const next = browserPanelRuntime.activate(state);
      generationRef.current = next;
      setActivatedGeneration(next);
    } else if (generationRef.current > 0) {
      browserPanelRuntime.deactivate(state.id, generationRef.current);
    }
  }, [active, state.id]);
  useEffect(() => {
    setPermissionRequest(null);
    setRespondingPermission(false);
    setExternalProtocolRequest(null);
  }, [generation]);
  useEffect(() => () => {
    if (generationRef.current > 0) browserPanelRuntime.dispose(state.id, generationRef.current);
  }, [state.id]);
  useEffect(() => () => annotationStore.getState().dispose(), [annotationStore]);
  useEffect(() => {
    if (!surface || !annotationsAvailable) {
      setAnnotationSession(null);
      updateAnnotationModeActive(false);
      setAnnotationsOpen(false);
      return;
    }
    updateAnnotationModeActive(false);
    const session = new WebAnnotationSession({
      surface,
      port: createWebAnnotationSessionPort(browserPanelRuntime),
    });
    const resolver = new WebAnnotationResolverCoordinator({
      surface,
      port: createWebAnnotationResolverPort(browserPanelRuntime),
    });
    const highlighter = new WebAnnotationHighlightSynchronizer({
      surface,
      port: annotationHighlightPort,
    });
    const router = new BrowserBridgeRouter(surface);
    const savingSelectionIds = new Set<string>();
    let disposed = false;
    const settleDraft = async (action: "save" | "cancel") => {
      if (disposed) return;
      const continueSelecting = annotationModeActiveRef.current;
      traceBrowserAnnotation("renderer.draft.settle.started", {
        action,
        continueSelecting,
        sessionStatus: session.getSnapshot().status,
      });
      try {
        if (action === "save") {
          if (continueSelecting) await session.completeDraftSaveAndContinue("element");
          else session.completeDraftSave();
        } else if (continueSelecting) {
          await session.cancelDraftAndContinue("element");
        } else {
          session.cancelDraft();
        }
        traceBrowserAnnotation("renderer.draft.settle.completed", {
          action,
          continueSelecting,
          sessionStatus: session.getSnapshot().status,
          annotationModeActive: annotationModeActiveRef.current,
        });
      } catch (error) {
        traceBrowserAnnotation("renderer.draft.settle.failed", {
          action,
          continueSelecting,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!disposed) {
          updateAnnotationModeActive(false);
          notifications.error(error instanceof Error ? error.message : "无法继续网页批注模式");
        }
      }
    };
    const unbindRouter = router.bind(browserPanelRuntime.client);
    const unsubscribeBridgeErrors = router.subscribeErrors((failure) => {
      if (!annotationModeActiveRef.current && session.getSnapshot().status === "idle") return;
      const code = failure.hostCode ?? failure.code;
      console.warn("[Keydex web annotation bridge] message rejected", failure);
      notifications.error(`网页批注消息链路异常（${code}）`);
    });
    const unsubscribeBridge = router.subscribe((envelope) => {
      traceBrowserAnnotation("renderer.bridge.received", {
        kind: envelope.kind,
        requestId: envelope.requestId,
        selectionId: "selectionId" in envelope.payload ? envelope.payload.selectionId : undefined,
        bodyLength: "bodyMarkdown" in envelope.payload && typeof envelope.payload.bodyMarkdown === "string"
          ? envelope.payload.bodyMarkdown.length
          : undefined,
      });
      session.applyBridgeEnvelope(envelope);
      resolver.applyBridgeEnvelope(envelope);
      if (envelope.kind === "annotation.cancelled") {
        const cancellation = envelope as BrowserBridgeEnvelope<"annotation.cancelled">;
        const snapshot = session.getSnapshot();
        if (
          snapshot.status === "draft"
          && snapshot.draft.request.selectionId === cancellation.payload.selectionId
        ) {
          void settleDraft("cancel");
        }
        return;
      }
      if (envelope.kind === "selection.cancelled" || envelope.kind === "bridge.error") {
        if (session.getSnapshot().status === "idle") updateAnnotationModeActive(false);
        return;
      }
      if (envelope.kind !== "annotation.submit") return;
      const submission = envelope as BrowserBridgeEnvelope<"annotation.submit">;
      const snapshot = session.getSnapshot();
      const submissionMatches = (
        snapshot.status !== "draft"
          ? false
          : snapshot.draft.request.requestId === submission.requestId
            && snapshot.draft.request.selectionId === submission.payload.selectionId
            && !savingSelectionIds.has(submission.payload.selectionId)
      );
      traceBrowserAnnotation("renderer.annotation.submit.checked", {
        requestId: submission.requestId,
        selectionId: submission.payload.selectionId,
        sessionStatus: snapshot.status,
        submissionMatches,
        alreadySaving: savingSelectionIds.has(submission.payload.selectionId),
      });
      if (!submissionMatches || snapshot.status !== "draft") return;
      const bodyMarkdown = submission.payload.bodyMarkdown.trim();
      if (!bodyMarkdown) {
        void settleDraft("cancel");
        notifications.warning("批注内容不能为空");
        return;
      }
      savingSelectionIds.add(submission.payload.selectionId);
      traceBrowserAnnotation("renderer.annotation.create.started", {
        requestId: submission.requestId,
        selectionId: submission.payload.selectionId,
        bodyLength: bodyMarkdown.length,
        activePage: Boolean(annotationStore.getState().activePage),
      });
      void annotationStore.getState().createAnnotation({
        target: snapshot.draft.target,
        bodyMarkdown,
      }).then((detail) => {
        if (snapshot.draft.liveBinding) {
          resolver.confirmCreatedAnnotation({
            resourceId: detail.resource.id,
            annotationId: detail.annotation.id,
            target: detail.annotation.target,
            binding: snapshot.draft.liveBinding,
          });
        }
        traceBrowserAnnotation("renderer.annotation.create.completed", {
          requestId: submission.requestId,
          selectionId: submission.payload.selectionId,
          annotationId: detail.annotation.id,
        });
        notifications.success("网页批注已创建");
        void settleDraft("save");
      }).catch((error: unknown) => {
        traceBrowserAnnotation("renderer.annotation.create.failed", {
          requestId: submission.requestId,
          selectionId: submission.payload.selectionId,
          error: error instanceof Error ? error.message : String(error),
        });
        notifications.error(error instanceof Error ? error.message : "创建网页批注失败");
        void settleDraft("cancel");
      }).finally(() => {
        savingSelectionIds.delete(submission.payload.selectionId);
      });
    });
    const unsubscribeNavigation = browserPanelRuntime.client.subscribe((event) => {
      if (
        event.panelId === surface.panelId
        && event.surfaceId === surface.surfaceId
        && event.generation === surface.generation
        && (event.kind === "selection.result"
          || event.kind === "selection.cancelled"
          || event.kind === "selection.failed")
      ) {
        traceBrowserAnnotation("renderer.host.received", {
          kind: event.kind,
          selectionRequestId: event.payload.selectionRequestId,
          sessionStatus: session.getSnapshot().status,
        });
      }
      if (
        event.panelId === surface.panelId
        && event.surfaceId === surface.surfaceId
        && event.generation === surface.generation
        && event.kind === "navigation.started"
      ) {
        updateAnnotationModeActive(false);
        setAnnotationsOpen(false);
        void session.handleNavigation();
        resolver.handleNavigation(event.navigationId);
      } else if (
        event.panelId === surface.panelId
        && event.surfaceId === surface.surfaceId
        && event.generation === surface.generation
        && event.kind === "resource.state_changed"
      ) {
        resolver.setSuspended(event.payload.next === "native_suspended" || event.payload.next === "discarded");
      } else if (
        event.panelId === surface.panelId
        && event.surfaceId === surface.surfaceId
        && event.generation === surface.generation
        && event.kind === "surface.destroyed"
      ) {
        updateAnnotationModeActive(false);
        resolver.setSuspended(true);
      } else if (
        event.panelId === surface.panelId
        && event.surfaceId === surface.surfaceId
        && event.generation === surface.generation
        && (event.kind === "selection.cancelled" || event.kind === "selection.failed")
        && session.getSnapshot().status === "idle"
      ) {
        updateAnnotationModeActive(false);
      }
    });
    const unsubscribeSession = session.subscribe(() => {
      const sessionStatus = session.getSnapshot().status;
      resolver.setPaused(sessionStatus === "starting" || sessionStatus === "selecting"
        || sessionStatus === "candidate" || sessionStatus === "cancelling");
    });
    const unsubscribeResolver = resolver.subscribe(() => {
      const snapshot = resolver.getSnapshot();
      setAnnotationResolutionStatuses(snapshot.visibleStatuses);
      setAnnotationResolutionDetails(snapshot.resolutions);
      void highlighter.sync(snapshot.resolutions).catch(() => undefined);
      webAnnotationPanelRegistry.notify();
    });
    setAnnotationSession(session);
    setAnnotationResolver(resolver);
    return () => {
      disposed = true;
      unsubscribeResolver();
      unsubscribeSession();
      unsubscribeNavigation();
      unsubscribeBridge();
      unsubscribeBridgeErrors();
      unbindRouter();
      resolver.dispose();
      void highlighter.dispose().catch(() => undefined);
      void session.closePanel();
      setAnnotationSession((current) => current === session ? null : current);
      updateAnnotationModeActive(false);
      setAnnotationResolver((current) => current === resolver ? null : current);
      setAnnotationResolutionStatuses({});
      setAnnotationResolutionDetails({});
    };
  }, [annotationsAvailable, surface?.generation, surface?.panelId, surface?.surfaceId]);
  useEffect(() => {
    const activePage = annotationState.activePage;
    if (!annotationResolver || !activePage || !annotationEntry?.resource) return;
    annotationResolver.activatePage({
      resourceId: annotationEntry.resource.id,
      hostNavigationId: activePage.navigationId,
      annotations: annotationEntry.items.map((item) => ({
        resourceId: item.resource.id,
        annotationId: item.annotation.id,
        target: item.annotation.target,
      })),
    });
  }, [annotationEntry?.items, annotationEntry?.resource, annotationResolver, annotationState.activePage]);
  useEffect(() => {
    for (const item of annotationEntry?.items ?? []) {
      const settled = annotationResolutionDetails[item.annotation.id]?.settled
        ?? annotationResolutionDetails[item.annotation.id]?.lastKnown
        ?? null;
      webAnnotationReferencePresentations.upsert({
        annotationId: item.annotation.id,
        title: item.resource.title,
        summary: webAnnotationTargetSummary(item.annotation.target),
        bodyMarkdown: item.annotation.bodyMarkdown,
        origin: item.resource.origin,
        status: annotationResolutionStatuses[item.annotation.id],
        change: summarizeWebAnnotationChanges(settled?.evidence?.changedSignals),
        updatedAt: item.annotation.updatedAt,
      });
    }
  }, [annotationEntry?.items, annotationResolutionDetails, annotationResolutionStatuses]);
  useEffect(() => {
    if (
      !annotationsAvailable
      || state.profileMode !== "persistent"
      || !active
      || !surface
      || !navigation?.navigationId
      || !navigation.url
      || navigation.loading
    ) return;
    void annotationStore.getState().activatePage({
      scope: webAnnotationScope(scopeKey),
      url: navigation.url,
      title: navigation.title,
      canonicalUrl: null,
      profileMode: state.profileMode,
      surface,
      navigationId: navigation.navigationId,
    });
  }, [
    active,
    annotationStore,
    annotationsAvailable,
    navigation?.loading,
    navigation?.navigationId,
    navigation?.url,
    scopeKey,
    state.profileMode,
    surface?.generation,
    surface?.panelId,
    surface?.surfaceId,
  ]);
  useEffect(() => {
    if (active || !surface) return;
    annotationStore.getState().closeSurface(surface);
  }, [active, annotationStore, surface?.generation, surface?.panelId, surface?.surfaceId]);
  useEffect(() => browserPanelRuntime.client.subscribe((event) => {
    if (event.panelId !== state.id || event.generation !== generation) return;
    if (event.kind === "permission.requested") setPermissionRequest(event.payload);
    if (event.kind === "shortcut.requested") {
      if (event.payload.shortcut === "find") {
        setZoomOpen(false);
        setFindOpen(true);
      } else if (event.payload.shortcut === "focus_address") {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      } else if (event.payload.shortcut === "reload" && surface) {
        void browserPanelRuntime.history(surface, "reload");
      } else if (event.payload.shortcut === "close_panel") {
        hostContext.onClosePanel(state.id);
      }
    }
    if (
      event.kind === "permission.expired"
      && permissionRequest?.permissionRequestId === event.payload.permissionRequestId
    ) setPermissionRequest(null);
  }), [generation, hostContext, permissionRequest?.permissionRequestId, state.id, surface?.surfaceId]);
  useEffect(() => {
    if (!surface) return;
    const coordinator = new BrowserPolicyCoordinator({
      client: browserPanelRuntime.client,
      surface,
      onExternalProtocolRequest: setExternalProtocolRequest,
      onNavigationFailure: () => undefined,
      onOpenPanel: (url) => hostContext.onCreatePanel(url),
    });
    coordinator.start();
    return () => coordinator.stop();
  }, [hostContext, surface?.generation, surface?.panelId, surface?.surfaceId]);
  useEffect(() => {
    if (navigation?.url) setAddress(navigation.url);
  }, [navigation?.url]);
  useEffect(() => {
    if (!surface) return;
    void browserPanelRuntime.setZoom(surface, state.zoomFactor).catch(() => undefined);
  }, [surface?.generation, surface?.surfaceId]);
  useEffect(() => {
    if (!surface) return;
    const motion = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    const configure = () => {
      void browserPanelRuntime.configureOverlay(surface, theme, motion?.matches ?? false).catch(() => undefined);
    };
    configure();
    const unsubscribe = browserPanelRuntime.client.subscribe((event) => {
      if (event.panelId !== surface.panelId
        || event.surfaceId !== surface.surfaceId
        || event.generation !== surface.generation
        || event.kind !== "bridge.message"
        || event.payload.bridgeEnvelope.kind !== "bridge.ready") return;
      configure();
    });
    motion?.addEventListener("change", configure);
    return () => {
      unsubscribe();
      motion?.removeEventListener("change", configure);
    };
  }, [surface?.generation, surface?.panelId, surface?.surfaceId, theme]);
  useEffect(() => {
    if (!navigation) return;
    const metadata = persistableBrowserMetadata({ navigation });
    if (!metadata) return;
    const next = normalizeBrowserPanelState({
      ...serializeBrowserPanelState(state),
      title: metadata.title,
      faviconUrl: metadata.faviconUrl,
      restoreUrl: metadata.restoreUrl,
      restoreUrlSanitized: metadata.restoreUrlSanitized,
    });
    if (next && JSON.stringify(serializeBrowserPanelState(next)) !== JSON.stringify(serializeBrowserPanelState(state))) {
      updateState(next);
    }
  }, [navigation?.faviconUrl, navigation?.title, navigation?.url, state, updateState]);

  const run = (operation: (surface: import("@/renderer/features/browser/domain").BrowserSurfaceRef) => Promise<void>) => {
    if (!surface) return;
    void operation(surface).catch((error: unknown) => {
      browserPanelRuntime.store.getState().failCommand(state.id, generation, error instanceof Error ? error.message : "浏览器操作失败");
    });
  };
  const respondPermission = (decision: "allow_once" | "deny") => {
    if (!surface || !permissionRequest || respondingPermission) return;
    setRespondingPermission(true);
    void browserPanelRuntime.client.send("browser_respond_permission", {
      ...surface,
      permissionRequestId: permissionRequest.permissionRequestId,
      origin: permissionRequest.origin,
      decision,
    }).then(() => {
      browserPanelRuntime.setProtection(state.id, "permission", false);
      setPermissionRequest(null);
      setRespondingPermission(false);
    }).catch(() => {
      browserPanelRuntime.setProtection(state.id, "permission", false);
      setPermissionRequest(null);
      setRespondingPermission(false);
    });
  };
  const stopFind = () => {
    setFindOpen(false);
    run((current) => browserPanelRuntime.stopFind(current));
  };
  const setZoom = (factor: number) => {
    if (!surface || factor === state.zoomFactor) return;
    void browserPanelRuntime.setZoom(surface, factor).then(() => {
      updateState({ ...state, zoomFactor: factor, lastActivatedAt: new Date().toISOString() });
    }).catch((error: unknown) => {
      browserPanelRuntime.store.getState().failCommand(state.id, generation, error instanceof Error ? error.message : "页面缩放失败");
    });
  };
  const annotationDisabledReason = state.profileMode === "incognito"
    ? "无痕模式不保存网页批注"
    : !annotationSession || !annotationState.activePage || !surface || !navigation || navigation.loading
        ? "网页批注正在准备"
        : undefined;

  const stopAnnotationMode = () => {
    updateAnnotationModeActive(false);
    if (!annotationSession) return;
    const snapshot = annotationSession.getSnapshot();
    if (snapshot.status === "draft") {
      annotationSession.cancelDraft();
    } else if (snapshot.status !== "idle" && snapshot.status !== "cancelling") {
      void annotationSession.cancelSelection("user");
    }
  };

  const startAnnotationMode = () => {
    if (!annotationSession) return;
    setAnnotationsOpen(false);
    updateAnnotationModeActive(true);
    void annotationSession.startSelection("element").catch((error: unknown) => {
      updateAnnotationModeActive(false);
      notifications.error(error instanceof Error ? error.message : "无法进入网页批注模式");
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.metaKey || !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "l") {
        event.preventDefault();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      } else if (key === "f") {
        event.preventDefault();
        setZoomOpen(false);
        setFindOpen(true);
      } else if (key === "r") {
        event.preventDefault();
        run((current) => browserPanelRuntime.history(current, "reload"));
      } else if (key === "w") {
        event.preventDefault();
        hostContext.onClosePanel(state.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [generation, hostContext, state.id, surface?.surfaceId]);

  return (
    <div className={layoutStyles.rightSidebarBody} data-content="browser" hidden={!active}>
      <BrowserPanel
        active={active && !annotationsOpen}
        address={address}
        addressInputRef={addressInputRef}
        canGoBack={navigation?.canGoBack ?? false}
        canGoForward={navigation?.canGoForward ?? false}
        error={!browserHostAvailable
          ? { category: "desktop_runtime_required", url: state.restoreUrl }
          : navigation?.errorCategory
          ? { category: navigation.errorCategory, url: navigation.url }
          : runtime?.status === "failed"
            ? { category: "process_failure", url: navigation?.url ?? state.restoreUrl }
            : null}
        empty={!navigation?.url}
        loading={navigation?.loading ?? runtime?.status === "creating"}
        annotationActive={annotationModeActive}
        annotationCount={annotationEntry?.items.length ?? 0}
        annotationDisabled={Boolean(annotationDisabledReason)}
        annotationDisabledReason={annotationDisabledReason}
        profileMode={state.profileMode}
        resourceState={runtime?.resourceState ?? "discarded"}
        surfaceReady={runtime?.status === "ready"}
        surface={surface}
        title={navigation?.title || state.title}
        toolbarAccessory={findOpen ? (
          <BrowserFindBar
            matchCase={findMatchCase}
            query={findQuery}
            onClose={stopFind}
            onMatchCaseChange={setFindMatchCase}
            onQueryChange={(value) => {
              setFindQuery(value);
              if (!value) run((current) => browserPanelRuntime.stopFind(current));
            }}
            onSearch={(backwards) => {
              if (findQuery) run((current) => browserPanelRuntime.find(current, findQuery, findMatchCase, backwards));
            }}
          />
        ) : zoomOpen ? (
          <BrowserZoomBar factor={state.zoomFactor} onChange={setZoom} onClose={() => setZoomOpen(false)} />
        ) : null}
        zoomFactor={state.zoomFactor}
        onAddressChange={setAddress}
        onAddressSubmit={(value) => {
          try {
            const target = resolveBrowserAddress(value).url;
            setAddress(target);
            run((current) => browserPanelRuntime.navigate(current, target));
          } catch (error) {
            browserPanelRuntime.store.getState().failCommand(state.id, generation, error instanceof Error ? error.message : "地址无效");
          }
        }}
        onAnnotations={annotationsAvailable
          ? () => {
              if (annotationModeActiveRef.current) stopAnnotationMode();
              else startAnnotationMode();
            }
          : undefined}
        onAnnotationList={annotationsAvailable && state.profileMode === "persistent"
          ? () => {
              stopAnnotationMode();
              setAnnotationsOpen(true);
            }
          : undefined}
        onBack={() => run((current) => browserPanelRuntime.history(current, "back"))}
        onForward={() => run((current) => browserPanelRuntime.history(current, "forward"))}
        onDownloads={() => setDownloadsOpen(true)}
        onFind={() => {
          setZoomOpen(false);
          setFindOpen(true);
        }}
        onReload={() => run((current) => browserPanelRuntime.history(current, "reload"))}
        onRetry={() => {
          if (surface) {
            run((current) => browserPanelRuntime.navigate(current, navigation?.url ?? state.restoreUrl));
          } else {
            const next = browserPanelRuntime.activate(state);
            generationRef.current = next;
            setActivatedGeneration(next);
          }
        }}
        onStop={() => run((current) => browserPanelRuntime.history(current, "stop"))}
        onZoom={() => {
          setFindOpen(false);
          setZoomOpen((value) => !value);
        }}
        onVisibilityChange={({ visible, reason }) => run((current) => browserPanelRuntime.setVisibility(current, visible, reason))}
      />
      {permissionRequest ? (
        <PermissionPrompt
          request={permissionRequest}
          responding={respondingPermission}
          onAllow={() => respondPermission("allow_once")}
          onDeny={() => respondPermission("deny")}
        />
      ) : null}
      {externalProtocolRequest ? (
        <BrowserExternalProtocolPrompt
          request={externalProtocolRequest}
          onCancel={() => setExternalProtocolRequest(null)}
          onConfirm={(target) => {
            void openExternalProtocol(target).finally(() => setExternalProtocolRequest(null));
          }}
        />
      ) : null}
      {dangerousDownload ? (
        <DangerousDownloadPrompt
          item={dangerousDownload}
          responding={respondingDownload}
          onAccept={() => {
            setRespondingDownload(true);
            void browserDownloadController.respond(dangerousDownload.id, "accept")
              .finally(() => setRespondingDownload(false));
          }}
          onCancel={() => {
            setRespondingDownload(true);
            void browserDownloadController.respond(dangerousDownload.id, "cancel")
              .finally(() => setRespondingDownload(false));
          }}
        />
      ) : null}
      {downloadsOpen ? <DownloadsView onClose={() => setDownloadsOpen(false)} /> : null}
      {annotationsOpen && annotationSession ? (
        <WebAnnotationDrawer
          open
          profileMode={state.profileMode}
          resolutionDetails={annotationResolutionDetails}
          resolutions={annotationResolutionStatuses}
          session={annotationSession}
          showCreationActions={false}
          store={annotationStore}
          onAddToComposer={(item) => {
            const composerScopeKey = browserAnnotationComposerScopeKey(scopeKey);
            if (!composerScopeKey) return "unhandled";
            const settled = annotationResolutionDetails[item.annotation.id]?.settled
              ?? annotationResolutionDetails[item.annotation.id]?.lastKnown
              ?? null;
            return emitAddWebAnnotationToComposer({
              composerScopeKey,
              reference: {
                annotationId: item.annotation.id,
                selectedRevision: item.annotation.revision,
                selectedAt: new Date().toISOString(),
                sourcePanelId: state.id,
              },
              presentation: {
                annotationId: item.annotation.id,
                title: item.resource.title,
                summary: webAnnotationTargetSummary(item.annotation.target),
                bodyMarkdown: item.annotation.bodyMarkdown,
                origin: item.resource.origin,
                status: annotationResolutionStatuses[item.annotation.id],
                change: summarizeWebAnnotationChanges(settled?.evidence?.changedSignals),
                updatedAt: item.annotation.updatedAt,
              },
            });
          }}
          onClose={() => setAnnotationsOpen(false)}
        />
      ) : null}
    </div>
  );
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

function webAnnotationScope(scopeKey: string): import("@/renderer/features/browser/annotations").WebAnnotationScope {
  if (scopeKey === "global") return { kind: "global", id: null };
  const separator = scopeKey.indexOf(":");
  const kind = scopeKey.slice(0, separator);
  const id = scopeKey.slice(separator + 1).trim();
  if ((kind !== "session" && kind !== "workspace") || !id) {
    throw new Error(`Invalid browser annotation scope: ${scopeKey}`);
  }
  return { kind, id };
}

function webAnnotationTargetSummary(
  target: WebAnnotationItem["annotation"]["target"],
): string {
  if (target.type === "text") return target.quote.exact;
  if (target.type === "element") return target.accessibleName || target.textSummary || `<${target.tag}>`;
  return `${Math.round(target.rect.width)} × ${Math.round(target.rect.height)} 区域`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
