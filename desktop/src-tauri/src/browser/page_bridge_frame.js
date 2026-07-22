(() => {
  "use strict";

  const channel = "keydex.web-annotation.frame-geometry.v1";
  const commandTarget = typeof __KEYDEX_BRIDGE_COMMAND_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_COMMAND_TARGET__;
  const maximumRoutes = 64;
  const pending = new Map();
  const routes = new Map();
  let cachedParentElementPath = null;
  let disposed = false;

  const randomId = () => {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  };

  const mapRectToSurface = (rect, viewport) => {
    if (disposed || !validRect(rect) || !validViewport(viewport)) {
      return Promise.reject(new Error("invalid frame capture geometry"));
    }
    if (window === window.top) {
      return Promise.resolve({
        rect: cloneRect(rect),
        viewport: viewportSize(),
      });
    }
    if (pending.size >= maximumRoutes) {
      return Promise.reject(new Error("frame capture geometry is busy"));
    }
    const requestId = `frame-geometry:${randomId()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("frame capture geometry timed out"));
      }, 1000);
      pending.set(requestId, { resolve, reject, timer });
      window.parent.postMessage({
        channel,
        type: "map-request",
        requestId,
        rect: cloneRect(rect),
        viewport: cloneViewport(viewport),
      }, "*");
    });
  };

  const onMessage = (event) => {
    if (disposed || !isRecord(event.data) || event.data.channel !== channel) return;
    if (event.data.type === "locator-request") {
      const frameElement = directChildFrameElement(event.source);
      if (!frameElement || typeof event.data.requestId !== "string") return;
      event.source?.postMessage({
        channel,
        type: "locator-response",
        requestId: event.data.requestId,
        parentElementPath: domPath(frameElement),
      }, "*");
      return;
    }
    if (event.data.type === "locator-response") {
      if (event.source !== window.parent || !validDomPath(event.data.parentElementPath)) return;
      cachedParentElementPath = event.data.parentElementPath.map((segment) => ({ ...segment }));
      return;
    }
    if (event.data.type === "map-request") {
      onMapRequest(event);
      return;
    }
    if (event.data.type === "map-response") onMapResponse(event);
  };

  const onMapRequest = (event) => {
    const data = event.data;
    if (typeof data.requestId !== "string" || data.requestId.length > 128
      || !validRect(data.rect) || !validViewport(data.viewport)) return;
    const frameElement = directChildFrameElement(event.source);
    if (!frameElement) return;
    const mapped = mapChildRect(frameElement, data.rect, data.viewport);
    if (!mapped) return;
    const parentElementPath = validDomPath(data.parentElementPath)
      ? data.parentElementPath
      : domPath(frameElement);
    if (window === window.top) {
      event.source?.postMessage({
        channel,
        type: "map-response",
        requestId: data.requestId,
        rect: mapped,
        viewport: viewportSize(),
        parentElementPath,
      }, "*");
      return;
    }
    if (routes.size >= maximumRoutes || routes.has(data.requestId)) return;
    const timer = setTimeout(() => routes.delete(data.requestId), 1000);
    routes.set(data.requestId, { source: event.source, timer });
    window.parent.postMessage({
      channel,
      type: "map-request",
      requestId: data.requestId,
      rect: mapped,
      viewport: viewportSize(),
      parentElementPath,
    }, "*");
  };

  const onMapResponse = (event) => {
    const data = event.data;
    if (event.source !== window.parent || typeof data.requestId !== "string"
      || !validRect(data.rect) || !validViewport(data.viewport)) return;
    const local = pending.get(data.requestId);
    if (local) {
      clearTimeout(local.timer);
      pending.delete(data.requestId);
      if (validDomPath(data.parentElementPath)) {
        cachedParentElementPath = data.parentElementPath.map((segment) => ({ ...segment }));
      }
      local.resolve({
        rect: cloneRect(data.rect),
        viewport: cloneViewport(data.viewport),
      });
      return;
    }
    const route = routes.get(data.requestId);
    if (!route) return;
    clearTimeout(route.timer);
    routes.delete(data.requestId);
    route.source?.postMessage({
      channel,
      type: "map-response",
      requestId: data.requestId,
      rect: cloneRect(data.rect),
      viewport: cloneViewport(data.viewport),
      parentElementPath: validDomPath(data.parentElementPath) ? data.parentElementPath : undefined,
    }, "*");
  };

  const mapChildRect = (frameElement, childRect, childViewport) => {
    const bounds = cssRect(frameElement.getBoundingClientRect());
    if (!bounds) return null;
    const layoutWidth = frameElement.offsetWidth || frameElement.clientWidth || childViewport.width;
    const layoutHeight = frameElement.offsetHeight || frameElement.clientHeight || childViewport.height;
    if (layoutWidth <= 0 || layoutHeight <= 0) return null;
    const transformScaleX = bounds.width / layoutWidth;
    const transformScaleY = bounds.height / layoutHeight;
    const clientWidth = frameElement.clientWidth || childViewport.width;
    const clientHeight = frameElement.clientHeight || childViewport.height;
    const contentLeft = bounds.x + (frameElement.clientLeft || 0) * transformScaleX;
    const contentTop = bounds.y + (frameElement.clientTop || 0) * transformScaleY;
    const contentWidth = clientWidth * transformScaleX;
    const contentHeight = clientHeight * transformScaleY;
    const scaleX = contentWidth / childViewport.width;
    const scaleY = contentHeight / childViewport.height;
    const mapped = {
      x: contentLeft + childRect.x * scaleX,
      y: contentTop + childRect.y * scaleY,
      width: childRect.width * scaleX,
      height: childRect.height * scaleY,
    };
    return validRect(mapped) ? mapped : null;
  };

  const directChildFrameElement = (source) => {
    if (!source) return null;
    for (const element of document.querySelectorAll("iframe, frame")) {
      try {
        if (element.contentWindow === source) return element;
      } catch {
        // Cross-origin child identity comparison can fail during teardown.
      }
    }
    return null;
  };

  const domPath = (node) => {
    const path = [];
    let current = node;
    while (current && current !== document) {
      const parent = current.parentNode;
      if (!parent) return null;
      if (parent instanceof ShadowRoot) {
        if (parent.host.shadowRoot !== parent) return null;
        const childIndex = Array.prototype.indexOf.call(parent.childNodes, current);
        if (childIndex < 0) return null;
        path.unshift({ childIndex, shadowRoot: true });
        current = parent.host;
      } else {
        const childIndex = Array.prototype.indexOf.call(parent.childNodes, current);
        if (childIndex < 0) return null;
        path.unshift({ childIndex, shadowRoot: false });
        current = parent;
      }
      if (path.length > 128) return null;
    }
    return current === document && path.length > 0 ? path : null;
  };

  const requestParentLocator = () => {
    if (window === window.top) return;
    window.parent.postMessage({
      channel,
      type: "locator-request",
      requestId: `frame-locator:${randomId()}`,
    }, "*");
  };

  const onBridgeCommand = (event) => {
    if (event.detail?.kind === "selection.start") requestParentLocator();
  };

  const teardown = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("message", onMessage);
    commandTarget.removeEventListener("keydex:web-annotation-command", onBridgeCommand, true);
    for (const value of pending.values()) {
      clearTimeout(value.timer);
      value.reject(new Error("frame navigation changed"));
    }
    for (const value of routes.values()) clearTimeout(value.timer);
    pending.clear();
    routes.clear();
    try {
      delete window.KeydexAnnotationFrameBridge;
    } catch {
      // The bridge has no authority; teardown still removes its listeners and timers.
    }
  };

  const cssRect = (rect) => {
    const x = Number.isFinite(rect.x) ? rect.x : rect.left;
    const y = Number.isFinite(rect.y) ? rect.y : rect.top;
    if (![x, y, rect.width, rect.height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0) return null;
    return { x, y, width: rect.width, height: rect.height };
  };
  const viewportSize = () => ({
    width: Math.max(1, document.documentElement?.clientWidth || window.innerWidth || 1),
    height: Math.max(1, document.documentElement?.clientHeight || window.innerHeight || 1),
  });
  const validRect = (value) => isRecord(value)
    && [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && value.width > 0 && value.height > 0;
  const validViewport = (value) => isRecord(value)
    && Number.isFinite(value.width) && value.width > 0
    && Number.isFinite(value.height) && value.height > 0;
  const validDomPath = (value) => Array.isArray(value) && value.length > 0 && value.length <= 128
    && value.every((segment) => isRecord(segment)
      && Number.isSafeInteger(segment.childIndex) && segment.childIndex >= 0
      && typeof segment.shadowRoot === "boolean");
  const cloneRect = (value) => ({ x: value.x, y: value.y, width: value.width, height: value.height });
  const cloneViewport = (value) => ({ width: value.width, height: value.height });
  const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

  window.addEventListener("message", onMessage);
  commandTarget.addEventListener("keydex:web-annotation-command", onBridgeCommand, true);
  window.addEventListener("pagehide", teardown, { once: true });
  Object.defineProperty(window, "KeydexAnnotationFrameBridge", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      mapRectToSurface,
      parentElementPath: () => cachedParentElementPath?.map((segment) => ({ ...segment })) ?? null,
    }),
  });
  requestParentLocator();
})();
