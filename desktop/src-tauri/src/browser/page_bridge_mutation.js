(() => {
  "use strict";

  const responseEventName = "keydex:web-annotation-response";
  const responseTarget = typeof __KEYDEX_BRIDGE_RESPONSE_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_RESPONSE_TARGET__;
  const overlayAttribute = "data-keydex-annotation-overlay-root";
  const policy = window.KeydexAnnotationBridge?.resolverPolicy;
  if (!validPolicy(policy) || typeof MutationObserver !== "function") return;

  let disposed = false;
  let dirtySince = null;
  let timer = null;
  let revision = 0;

  const observer = new MutationObserver((mutations) => {
    if (disposed || !mutations.some(isSignificantMutation)) return;
    const now = resolverNow();
    if (dirtySince === null) dirtySince = now;
    if (timer !== null) clearTimeout(timer);
    const maxRemaining = Math.max(0, policy.mutationMaxDelayMs - (now - dirtySince));
    timer = setTimeout(flush, Math.min(policy.mutationDebounceMs, maxRemaining));
  });

  const flush = () => {
    timer = null;
    if (disposed || dirtySince === null) return;
    dirtySince = null;
    revision += 1;
    responseTarget.dispatchEvent(new CustomEvent(responseEventName, {
      detail: {
        kind: "page.changed",
        requestId: `page-change-${revision}`,
        payload: { reason: "dom", revision },
      },
    }));
  };

  const isSignificantMutation = (mutation) => {
    const targetElement = mutation.target instanceof Element
      ? mutation.target
      : mutation.target?.parentElement;
    if (targetElement?.closest?.(`[${overlayAttribute}='true']`)) return false;
    if (mutation.type !== "childList") return true;
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return changedNodes.length === 0 || changedNodes.some((node) => !isOverlayNode(node));
  };

  const isOverlayNode = (node) => {
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(element?.matches?.(`[${overlayAttribute}='true']`)
      || element?.closest?.(`[${overlayAttribute}='true']`));
  };

  const teardown = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    dirtySince = null;
  };

  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "id", "class", "role", "aria-label", "aria-labelledby", "href", "src", "alt",
      "title", "hidden", "style",
    ],
  });
  window.addEventListener("pagehide", teardown, { once: true });

  function validPolicy(value) {
    return value && typeof value === "object"
      && Number.isInteger(value.batchSize) && value.batchSize > 0 && value.batchSize <= 50
      && Number.isFinite(value.mutationDebounceMs) && value.mutationDebounceMs >= 0
      && Number.isFinite(value.mutationMaxDelayMs)
      && value.mutationMaxDelayMs >= value.mutationDebounceMs
      && Number.isFinite(value.sliceBudgetMs) && value.sliceBudgetMs > 0 && value.sliceBudgetMs <= 16;
  }

  function resolverNow() {
    return Date.now();
  }
})();
