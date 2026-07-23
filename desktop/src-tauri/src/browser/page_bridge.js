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
    "highlight.action",
    "resolution.result",
    "geometry.changed",
    "page.changed",
    "page.interaction",
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

  // Resolution and change detection are intentionally separate. Geometry and
  // surrounding-page context may drift while the exact annotation target is
  // still uniquely bound; those signals remain available as evidence but must
  // not turn a successful location into a material target change.
  const materialAnnotationChangeSignals = new Set([
    "quote_changed",
    "accessible_name_changed",
    "text_changed",
    "anchor_name_changed",
    "anchor_text_changed",
    "tag_changed",
    "role_changed",
    "anchor_tag_changed",
    "anchor_role_changed",
    "stable_attributes_changed",
    "anchor_attributes_changed",
    "local_fingerprint_changed",
  ]);
  const hasMaterialAnnotationChange = (signals) => (
    Array.isArray(signals) && signals.some((signal) => materialAnnotationChangeSignals.has(signal))
  );

  const randomId = () => {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  };

  const nodeBindings = (() => {
    const documentId = `document:${randomId()}`.slice(0, 128);
    const handles = new Map();
    const handleByNode = new WeakMap();
    const annotations = new Map();
    let handleSequence = 0;

    const nodeElement = (node) => node instanceof Element
      ? node
      : (node?.parentElement instanceof Element ? node.parentElement : null);
    const bindingForNode = (node) => {
      const element = nodeElement(node);
      if (!element?.isConnected) return null;
      let nodeHandleId = handleByNode.get(element);
      if (!nodeHandleId) {
        nodeHandleId = `node:${++handleSequence}`;
        handleByNode.set(element, nodeHandleId);
        handles.set(nodeHandleId, element);
      }
      return Object.freeze({ documentId, nodeHandleId });
    };
    const bindSelection = (_selectionId, node) => bindingForNode(node);
    const bindAnnotation = (annotationId, node) => {
      const binding = bindingForNode(node);
      if (!binding) return null;
      annotations.set(annotationId, binding.nodeHandleId);
      return binding;
    };
    const resolveAnnotation = (annotationId, preferredBinding) => {
      let nodeHandleId = annotations.get(annotationId) ?? null;
      if (preferredBinding?.documentId === documentId
        && typeof preferredBinding.nodeHandleId === "string") {
        nodeHandleId = preferredBinding.nodeHandleId;
      }
      const node = nodeHandleId ? handles.get(nodeHandleId) : null;
      if (!(node instanceof Element) || !node.isConnected) {
        annotations.delete(annotationId);
        if (nodeHandleId) handles.delete(nodeHandleId);
        return null;
      }
      annotations.set(annotationId, nodeHandleId);
      return Object.freeze({ node, binding: Object.freeze({ documentId, nodeHandleId }) });
    };
    const releaseAnnotation = (annotationId) => {
      annotations.delete(annotationId);
    };
    const affectedAnnotationIds = (mutations) => {
      const affected = new Set();
      for (const [annotationId, nodeHandleId] of annotations) {
        const node = handles.get(nodeHandleId);
        if (!(node instanceof Element) || !node.isConnected) {
          affected.add(annotationId);
          continue;
        }
        for (const mutation of mutations) {
          const mutationElement = nodeElement(mutation.target);
          if (mutationElement && (mutationElement === node
            || node.contains(mutationElement)
            || mutationElement.contains(node))) {
            affected.add(annotationId);
            break;
          }
          if (mutation.type === "childList") {
            const removed = Array.from(mutation.removedNodes ?? []);
            if (removed.some((candidate) => candidate === node
              || (candidate instanceof Element && candidate.contains(node)))) {
              affected.add(annotationId);
              break;
            }
          }
        }
      }
      return Object.freeze([...affected].sort());
    };
    const dispose = () => {
      handles.clear();
      annotations.clear();
    };
    return Object.freeze({
      documentId,
      bindSelection,
      bindAnnotation,
      resolveAnnotation,
      releaseAnnotation,
      affectedAnnotationIds,
      dispose,
    });
  })();

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
  const onPagePointerDown = (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(overlaySelector)) return;
    post("page.interaction", `page-interaction-${randomId()}`.slice(0, 128), {});
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
    document.removeEventListener("pointerdown", onPagePointerDown, true);
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
    nodeBindings.dispose();
    document.querySelectorAll(overlaySelector).forEach((element) => element.remove());
    try {
      delete window.KeydexAnnotationBridge;
    } catch {
      // Metadata is non-authoritative; lifecycle cleanup must still continue.
    }
  };

  addNativeMessageListener?.("message", onNativeMessage);
  document.addEventListener("pointerdown", onPagePointerDown, true);
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
      nodeBindings,
      commandEvent: bridgeEventName,
      responseEvent: bridgeResponseEventName,
    }),
  });
})();
