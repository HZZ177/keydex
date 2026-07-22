(() => {
  "use strict";

  const bootstrap = __KEYDEX_BRIDGE_BOOTSTRAP__;
  const protocol = "keydex.web-annotation.v1";
  const pageToHostKinds = new Set([
    "bridge.ready",
    "selection.candidate",
    "selection.result",
    "selection.cancelled",
    "annotation.submit",
    "annotation.cancelled",
    "resolution.result",
    "geometry.changed",
    "page.changed",
    "bridge.error",
  ]);
  const hostToPageKinds = new Set([
    "selection.start",
    "selection.cancel",
    "overlay.configure",
    "annotation.resolve",
    "highlight.render",
    "highlight.clear",
    "navigate.toTarget",
  ]);
  const relayChannel = "keydex.web-annotation.frame-relay.v1";
  const bridgeEventName = "keydex:web-annotation-command";
  const bridgeResponseEventName = "keydex:web-annotation-response";
  const bridgeBootstrapCompleteEventName = "keydex:web-annotation-bootstrap-complete";
  const commandTarget = typeof __KEYDEX_BRIDGE_COMMAND_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_COMMAND_TARGET__;
  const responseTarget = typeof __KEYDEX_BRIDGE_RESPONSE_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_RESPONSE_TARGET__;
  // Capture the native WebView2 channel before untrusted page scripts can
  // replace or wrap window.chrome. Every later bridge operation uses these
  // bound functions instead of resolving a mutable page global again.
  const nativeWebview = window.chrome?.webview ?? null;
  const postNativeMessage = typeof nativeWebview?.postMessage === "function"
    ? nativeWebview.postMessage.bind(nativeWebview) : null;
  const addNativeMessageListener = typeof nativeWebview?.addEventListener === "function"
    ? nativeWebview.addEventListener.bind(nativeWebview) : null;
  const removeNativeMessageListener = typeof nativeWebview?.removeEventListener === "function"
    ? nativeWebview.removeEventListener.bind(nativeWebview) : null;
  const overlaySelector = "[data-keydex-annotation-overlay-root='true']";
  const exactEnvelopeKeys = [
    "protocol",
    "kind",
    "panelId",
    "surfaceId",
    "generation",
    "navigationId",
    "frameKey",
    "requestId",
    "sequence",
    "payload",
  ];
  const activeRequests = new Map();
  let disposed = false;
  let sequence = 0;
  const traceConsole = typeof console?.info === "function" ? console.info.bind(console) : null;
  const trace = (stage, detail = {}) => {
    try {
      traceConsole?.("[Keydex Browser Annotation]", stage, detail);
    } catch {
      // Diagnostics must never affect the page bridge.
    }
  };

  const randomId = () => {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  };

  const frameKey = (() => {
    if (window === window.top) return "main";
    const path = [];
    let current = window;
    try {
      while (current !== current.top) {
        const parent = current.parent;
        let index = -1;
        for (let cursor = 0; cursor < parent.frames.length; cursor += 1) {
          if (parent.frames[cursor] === current) {
            index = cursor;
            break;
          }
        }
        if (index < 0) throw new Error("frame path unavailable");
        path.unshift(index);
        current = parent;
      }
      return `frame:${path.join(".")}`;
    } catch {
      return `frame:runtime-${randomId()}`;
    }
  })();
  const navigationId = `navigation:${randomId()}`;
  if (bootstrap.diagnostics && postNativeMessage) {
    __KEYDEX_BRIDGE_DIAGNOSTICS_POST__ = (stage, detail = {}) => {
      if (typeof stage !== "string" || stage.length === 0 || stage.length > 128) return;
      try {
        postNativeMessage({
          protocol: "keydex.web-annotation.debug.v1",
          stage,
          frameKey,
          navigationId,
          detail,
        });
      } catch {
        // Debug forwarding is deliberately isolated from the production bridge.
      }
    };
    __KEYDEX_BRIDGE_DIAGNOSTICS_POST__("page-bridge.diagnostics.ready", {});
  }

  const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const isId = (value) => typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9._:@/-]+$/.test(value);
  const hasExactKeys = (value, keys) => {
    if (!isRecord(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  };
  const parseEnvelope = (value) => {
    let candidate = value;
    if (typeof candidate === "string") {
      if (candidate.length > 262144) return null;
      try {
        candidate = JSON.parse(candidate);
      } catch {
        return null;
      }
    }
    if (!hasExactKeys(candidate, exactEnvelopeKeys)) return null;
    if (candidate.protocol !== protocol || !hostToPageKinds.has(candidate.kind)) return null;
    if (candidate.panelId !== bootstrap.panelId
      || candidate.surfaceId !== bootstrap.surfaceId
      || candidate.generation !== bootstrap.generation
      || candidate.navigationId !== navigationId
      || candidate.frameKey !== frameKey) return null;
    if (!isId(candidate.requestId)
      || !Number.isSafeInteger(candidate.sequence)
      || candidate.sequence <= 0
      || !isRecord(candidate.payload)) return null;
    return candidate;
  };

  const post = (kind, requestId, payload) => {
    const valid = !disposed && pageToHostKinds.has(kind) && isId(requestId) && isRecord(payload);
    trace("page-bridge.post.requested", {
      kind,
      requestId,
      frameKey,
      valid,
      nativeChannelAvailable: Boolean(postNativeMessage),
      selectionId: payload?.selectionId,
      bodyLength: typeof payload?.bodyMarkdown === "string" ? payload.bodyMarkdown.length : undefined,
    });
    if (!valid) return;
    const envelope = {
      protocol,
      kind,
      panelId: bootstrap.panelId,
      surfaceId: bootstrap.surfaceId,
      generation: bootstrap.generation,
      navigationId,
      frameKey,
      requestId,
      sequence: ++sequence,
      payload,
    };
    if (!postNativeMessage) {
      trace("page-bridge.post.dropped", { kind, requestId, sequence: envelope.sequence, reason: "native_channel_missing" });
      return;
    }
    try {
      postNativeMessage(envelope);
      trace("page-bridge.post.sent", {
        kind,
        requestId,
        frameKey,
        sequence: envelope.sequence,
        transport: "webview2_composition",
      });
    } catch (error) {
      trace("page-bridge.post.failed", {
        kind,
        requestId,
        sequence: envelope.sequence,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const announceReady = () => {
    post("bridge.ready", "bridge-ready", { href: location.href, top: window === window.top });
  };

  const relayToChildren = (envelope) => {
    for (let index = 0; index < window.frames.length; index += 1) {
      try {
        window.frames[index].postMessage({ channel: relayChannel, envelope }, "*");
      } catch {
        // A frame can disappear between enumeration and dispatch.
      }
    }
  };

  const dispatch = (candidate) => {
    const envelope = parseEnvelope(candidate);
    if (!envelope) {
      if (isRecord(candidate) && candidate.frameKey !== frameKey) relayToChildren(candidate);
      return;
    }
    if (envelope.kind === "selection.start") {
      activeRequests.set(envelope.requestId, {
        kind: envelope.kind,
        selectionId: envelope.payload.selectionId,
      });
    } else if (envelope.kind === "annotation.resolve" || envelope.kind === "navigate.toTarget") {
      activeRequests.set(envelope.requestId, { kind: envelope.kind });
    } else if (envelope.kind === "selection.cancel") {
      for (const [requestId, request] of activeRequests) {
        if (request.selectionId === envelope.payload.selectionId) activeRequests.delete(requestId);
      }
    }
    commandTarget.dispatchEvent(new CustomEvent(bridgeEventName, {
      detail: Object.freeze(envelope),
    }));
  };

  const onNativeMessage = (event) => dispatch(event.data);
  const onBootstrapComplete = () => {
    commandTarget.removeEventListener(bridgeBootstrapCompleteEventName, onBootstrapComplete);
    announceReady();
  };
  const onBridgeResponse = (event) => {
    const detail = event.detail;
    trace("page-bridge.response.received", {
      kind: detail?.kind,
      requestId: detail?.requestId,
      selectionId: detail?.payload?.selectionId,
      bodyLength: typeof detail?.payload?.bodyMarkdown === "string" ? detail.payload.bodyMarkdown.length : undefined,
    });
    if (!hasExactKeys(detail, ["kind", "requestId", "payload"])) {
      trace("page-bridge.response.rejected", { reason: "shape" });
      return;
    }
    if (!pageToHostKinds.has(detail.kind) || !isId(detail.requestId) || !isRecord(detail.payload)) {
      trace("page-bridge.response.rejected", { kind: detail.kind, requestId: detail.requestId, reason: "values" });
      return;
    }
    // Native element inspection can open the editor even when the host attached
    // after this document's one-shot bootstrap message. Re-announce the exact
    // frame/navigation immediately before a terminal annotation response so the
    // authenticated host and React cursors can recover without losing the draft.
    if (detail.kind === "annotation.submit" || detail.kind === "annotation.cancelled") {
      announceReady();
    }
    trace("page-bridge.response.forwarding", { kind: detail.kind, requestId: detail.requestId });
    post(detail.kind, detail.requestId, detail.payload);
    if (detail.kind === "selection.result") {
      const request = activeRequests.get(detail.requestId);
      if (request?.kind === "selection.start") {
        activeRequests.set(detail.requestId, { ...request, kind: "annotation.draft" });
      }
    } else if (["selection.cancelled", "annotation.submit", "annotation.cancelled", "resolution.result", "bridge.error"].includes(detail.kind)) {
      activeRequests.delete(detail.requestId);
    }
  };
  const onFrameRelay = (event) => {
    if (window === window.top || event.source !== window.parent) return;
    if (!isRecord(event.data) || event.data.channel !== relayChannel) return;
    dispatch(event.data.envelope);
  };
  const teardown = () => {
    if (disposed) return;
    for (const [requestId, request] of activeRequests) {
      if (request.kind === "selection.start" && isId(request.selectionId)) {
        post("selection.cancelled", requestId, {
          selectionId: request.selectionId,
          reason: "navigation",
        });
      } else if (request.kind === "annotation.draft" && isId(request.selectionId)) {
        post("annotation.cancelled", requestId, {
          selectionId: request.selectionId,
        });
      }
    }
    disposed = true;
    removeNativeMessageListener?.("message", onNativeMessage);
    window.removeEventListener("message", onFrameRelay);
    window.removeEventListener("pagehide", teardown);
    if (typeof __KEYDEX_BRIDGE_RESPONSE_HANDLER__ === "undefined") {
      responseTarget.removeEventListener(bridgeResponseEventName, onBridgeResponse);
    } else if (__KEYDEX_BRIDGE_RESPONSE_HANDLER__ === onBridgeResponse) {
      __KEYDEX_BRIDGE_RESPONSE_HANDLER__ = null;
    }
    commandTarget.removeEventListener(bridgeBootstrapCompleteEventName, onBootstrapComplete);
    __KEYDEX_BRIDGE_DIAGNOSTICS_POST__ = null;
    activeRequests.clear();
    document.querySelectorAll(overlaySelector).forEach((element) => element.remove());
    try {
      delete window.KeydexAnnotationBridge;
    } catch {
      // Metadata is non-authoritative; lifecycle cleanup must still continue.
    }
  };

  addNativeMessageListener?.("message", onNativeMessage);
  window.addEventListener("message", onFrameRelay);
  window.addEventListener("pagehide", teardown, { once: true });
  if (typeof __KEYDEX_BRIDGE_RESPONSE_HANDLER__ === "undefined") {
    responseTarget.addEventListener(bridgeResponseEventName, onBridgeResponse);
  } else {
    __KEYDEX_BRIDGE_RESPONSE_HANDLER__ = onBridgeResponse;
  }
  commandTarget.addEventListener(bridgeBootstrapCompleteEventName, onBootstrapComplete, { once: true });
  Object.defineProperty(window, "KeydexAnnotationBridge", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      protocol,
      version: 1,
      frameKey,
      navigationId,
      scoringPolicy: bootstrap.scoringPolicy,
      resolverPolicy: bootstrap.resolverPolicy,
      commandEvent: bridgeEventName,
      responseEvent: bridgeResponseEventName,
    }),
  });
})();
