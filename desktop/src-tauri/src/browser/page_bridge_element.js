(() => {
  "use strict";

  const commandEventName = "keydex:web-annotation-command";
  const responseEventName = "keydex:web-annotation-response";
  const commandTarget = typeof __KEYDEX_BRIDGE_COMMAND_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_COMMAND_TARGET__;
  const responseTarget = typeof __KEYDEX_BRIDGE_RESPONSE_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_RESPONSE_TARGET__;
  const stableAttributeNames = ["id", "name", "type", "href", "src", "alt", "title", "aria-label", "role"];
  const materialAnnotationChangeSignals = new Set([
    "accessible_name_changed",
    "text_changed",
    "tag_changed",
    "role_changed",
    "stable_attributes_changed",
  ]);
  const hasMaterialAnnotationChange = (signals) => (
    Array.isArray(signals) && signals.some((signal) => materialAnnotationChangeSignals.has(signal))
  );
  const implicitRoles = new Map([
    ["A", "link"], ["BUTTON", "button"], ["SELECT", "combobox"], ["TEXTAREA", "textbox"],
    ["IMG", "img"], ["TABLE", "table"], ["TR", "row"], ["TH", "columnheader"], ["TD", "cell"],
    ["ARTICLE", "article"], ["MAIN", "main"], ["NAV", "navigation"], ["ASIDE", "complementary"],
    ["FORM", "form"], ["LI", "listitem"], ["SUMMARY", "button"],
  ]);
  const resolverLimits = Object.freeze({
    maxScannedElements: 5000,
    maxCandidates: 256,
    maxReturnedCandidates: 20,
    minimumScannedElements: 64,
    timeBudgetMs: 12,
  });
  const nodeBindings = window.KeydexAnnotationBridge?.nodeBindings ?? null;
  let active = null;
  let animationFrame = null;
  let pendingPointerTarget = null;
  let inspectorCursorStyle = null;
  const blockedInteractionEvents = Object.freeze([
    "pointerover", "pointerenter", "pointerdown", "pointerup", "pointercancel", "pointerleave",
    "mouseover", "mouseenter", "mousemove", "mousedown", "mouseup", "mouseout", "mouseleave",
    "auxclick", "dblclick", "contextmenu",
    "touchstart", "touchmove", "touchend", "touchcancel",
    "dragstart", "drag", "dragend", "dragenter", "dragover", "dragleave", "drop",
  ]);

  const respond = (kind, requestId, payload) => {
    responseTarget.dispatchEvent(new CustomEvent(responseEventName, {
      detail: { kind, requestId, payload },
    }));
  };

  const onCommand = (event) => {
    const envelope = event.detail;
    if (!envelope || typeof envelope !== "object") return;
    if (envelope.kind === "selection.start" && envelope.payload?.mode === "element") {
      stop(false);
      active = {
        requestId: envelope.requestId,
        selectionId: envelope.payload.selectionId,
        candidates: [],
        candidateIndex: 0,
        lastTarget: null,
      };
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerout", onPointerOut, true);
      for (const name of blockedInteractionEvents) window.addEventListener(name, suppressPageAction, true);
      window.addEventListener("click", onClick, true);
      window.addEventListener("keydown", onKeyDown, true);
      installInspectorCursor();
      return;
    }
    if (envelope.kind === "annotation.resolve" && envelope.payload?.target?.type === "element") {
      resolveElementCommand(envelope);
      return;
    }
    if (envelope.kind === "selection.cancel" && active
      && envelope.payload?.selectionId === active.selectionId) {
      cancel(envelope.payload.reason === "user" ? "user" : "navigation");
    }
  };

  const onPointerMove = (event) => {
    if (isAnnotationOverlayInteraction(event)) return;
    const target = eventElement(event);
    if (!active) return;
    stopPagePropagation(event);
    if (!target) return;
    pendingPointerTarget = target;
    if (animationFrame !== null) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = null;
      const target = pendingPointerTarget;
      pendingPointerTarget = null;
      if (target?.isConnected) updateCandidates(target, 0);
    });
  };

  const onPointerOut = (event) => {
    if (!active) return;
    if (isAnnotationOverlayInteraction(event)) return;
    stopPagePropagation(event);
    if (event.relatedTarget === null) clearCandidate();
  };

  const clearCandidate = () => {
    if (!active) return;
    pendingPointerTarget = null;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    active.candidates = [];
    active.candidateIndex = 0;
    active.lastTarget = null;
    respond("selection.candidate.cleared", active.requestId, {
      selectionId: active.selectionId,
    });
  };

  const suppressPageAction = (event) => {
    if (!active) return;
    if (isAnnotationOverlayInteraction(event)) return;
    if (event.cancelable) event.preventDefault();
    stopPagePropagation(event);
  };

  const stopPagePropagation = (event) => {
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const onClick = (event) => {
    if (!active) return;
    if (isAnnotationOverlayInteraction(event)) return;
    const target = eventElement(event);
    suppressPageAction(event);
    if (target?.isConnected) updateCandidates(target, active.candidateIndex);
    confirmCandidate();
  };

  const onKeyDown = (event) => {
    if (!active) return;
    if (isAnnotationOverlayInteraction(event)) return;
    stopPagePropagation(event);
    if (event.key === "Escape") {
      event.preventDefault();
      cancel("user");
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (active.candidates.length === 0) return;
      const delta = event.shiftKey ? -1 : 1;
      active.candidateIndex = Math.max(0, Math.min(
        active.candidates.length - 1,
        active.candidateIndex + delta,
      ));
      publishCandidate();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      confirmCandidate();
    }
  };

  const isAnnotationOverlayInteraction = (event) => (
    typeof event?.composedPath === "function"
    && event.composedPath().some((node) => (
      node !== null
      && typeof node === "object"
      && typeof node.getAttribute === "function"
      && node.getAttribute("data-keydex-annotation-overlay-root") === "true"
    ))
  );

  const updateCandidates = (target, preferredIndex) => {
    if (!active) return;
    const candidates = inspectableCandidates(target);
    active.lastTarget = target;
    active.candidates = candidates;
    active.candidateIndex = Math.max(0, Math.min(candidates.length - 1, preferredIndex));
    publishCandidate();
  };

  const publishCandidate = () => {
    if (!active) return;
    const candidate = active.candidates[active.candidateIndex];
    const rect = candidate ? cssRect(candidate.getBoundingClientRect()) : null;
    if (!candidate?.isConnected || !rect) return;
    respond("selection.candidate", active.requestId, {
      selectionId: active.selectionId,
      mode: "element",
      candidateId: `candidate:${active.requestId}:${active.candidateIndex}`.slice(0, 128),
      label: candidateLabel(candidate),
      rect,
      depth: domDepth(candidate),
    });
  };

  const confirmCandidate = () => {
    if (!active) return;
    const request = active;
    const candidate = request.candidates[request.candidateIndex];
    if (!candidate?.isConnected) {
      cancel("invalid_selection");
      return;
    }
    const target = createElementTarget(candidate);
    if (!target) {
      cancel("invalid_selection");
      return;
    }
    const binding = nodeBindings?.bindSelection(request.selectionId, candidate) ?? null;
    respond("selection.result", request.requestId, {
      selectionId: request.selectionId,
      target,
      ...(binding ? { binding } : {}),
    });
    stop(false);
  };

  const cancel = (reason) => {
    if (!active) return;
    const request = active;
    stop(false);
    respond("selection.cancelled", request.requestId, {
      selectionId: request.selectionId,
      reason,
    });
  };

  const resolveElementCommand = (envelope) => {
    const annotationId = envelope.payload?.annotationId;
    const target = envelope.payload?.target;
    if (typeof annotationId !== "string" || !target || target.type !== "element") return;
    const policy = window.KeydexAnnotationBridge?.scoringPolicy;
    if (!validScoringPolicy(policy)) {
      respond("bridge.error", envelope.requestId, {
        code: "internal",
        message: "Element resolver scoring policy is unavailable",
        retryable: false,
      });
      return;
    }
    if (!frameMatches(target.frame)) {
      respond("resolution.result", envelope.requestId, {
        annotationId,
        status: "orphaned",
        evidence: emptyResolutionEvidence("frame_unavailable"),
      });
      return;
    }
    try {
      respond("resolution.result", envelope.requestId, {
        annotationId,
        ...resolveElementTarget(annotationId, target, envelope.payload?.binding, policy),
      });
    } catch {
      respond("bridge.error", envelope.requestId, {
        code: "internal",
        message: "Element resolver failed",
        retryable: true,
      });
    }
  };

  const resolveElementTarget = (annotationId, target, preferredBinding, policy) => {
    const deadline = resolverNow() + resolverLimits.timeBudgetMs;
    const bound = nodeBindings?.resolveAnnotation(annotationId, preferredBinding) ?? null;
    if (bound) {
      const candidate = createElementResolutionCandidate(bound.node, target, "node_handle", 0, policy);
      if (candidate) {
        candidate.binding = bound.binding;
        return acceptedElementResolution(annotationId, candidate, 1, false);
      }
      nodeBindings?.releaseAnnotation(annotationId);
    }
    const scanned = scanVisibleElements(deadline);
    const persistedAttributes = new Map((target.stableAttributes ?? []).map((entry) => [entry.name, entry.value]));
    const stages = [
      {
        strategy: "stable_dom_path",
        elements: () => [resolvePath(target.path)].filter((element) => element instanceof Element),
      },
      {
        strategy: "unique_id",
        elements: () => {
          const id = persistedAttributes.get("id");
          return id ? scanned.elements.filter((element) => element.getAttribute("id") === id) : [];
        },
      },
      {
        strategy: "image_src_alt",
        elements: () => target.tag === "img" ? scanned.elements.filter((element) => {
          if (element.tagName !== "IMG") return false;
          const source = persistedAttributes.get("src");
          const alt = persistedAttributes.get("alt");
          return Boolean((source && sanitizedUrlAttribute(element.getAttribute("src") ?? "") === source)
            || (alt && element.getAttribute("alt") === alt));
        }) : [],
      },
      {
        strategy: "role_name",
        elements: () => scanned.elements.filter((element) => (
          Boolean(target.role)
          && explicitOrImplicitRole(element) === target.role
          && Boolean(target.accessibleName)
          && accessibleName(element) === target.accessibleName
        )),
      },
      {
        strategy: "stable_attributes",
        elements: () => scanned.elements.filter((element) => stableAttributeMatchCount(element, target) > 0),
      },
      {
        strategy: "text_context",
        elements: () => scanned.elements.filter((element) => {
          const summary = safeElementText(element).slice(0, 1024);
          return Boolean(target.textSummary && summary === target.textSummary)
            || Boolean(target.accessibleName && accessibleName(element) === target.accessibleName);
        }),
      },
    ];
    let bestRejectedScore = 0;
    let attemptedCandidates = 0;
    let lastStrategy = "text_context";
    for (const [stageIndex, stage] of stages.entries()) {
      if (stageIndex > 0 && scanned.truncated && resolverNow() >= deadline) {
        return orphanedElementResolution(lastStrategy, attemptedCandidates, true, bestRejectedScore);
      }
      lastStrategy = stage.strategy;
      const uniqueElements = [...new Set(stage.elements())].slice(0, resolverLimits.maxCandidates);
      const candidates = uniqueElements.flatMap((element, index) => {
        const candidate = createElementResolutionCandidate(element, target, stage.strategy, index, policy);
        return candidate ? [candidate] : [];
      });
      attemptedCandidates = Math.min(256, attemptedCandidates + candidates.length);
      if (candidates.length === 0) continue;
      const decision = decideElementCandidates(candidates, policy);
      bestRejectedScore = Math.max(bestRejectedScore, decision.bestScore ?? 0);
       if (decision.kind === "accepted") {
         return acceptedElementResolution(annotationId, decision.selected, candidates.length, scanned.truncated);
       }
       if (decision.kind === "ambiguous") {
         nodeBindings?.releaseAnnotation(annotationId);
         return ambiguousElementResolution(decision.candidates, candidates.length, scanned.truncated);
       }
     }
    nodeBindings?.releaseAnnotation(annotationId);
    return orphanedElementResolution(lastStrategy, attemptedCandidates, scanned.truncated, bestRejectedScore);
  };

  const createElementResolutionCandidate = (element, original, strategy, index, policy) => {
    if (!(element instanceof Element) || !element.isConnected || !elementIsVisible(element)) return null;
    const current = createElementTarget(element);
    if (!current) return null;
    const nameScore = stringSimilarity(original.accessibleName ?? "", current.accessibleName ?? "");
    const textScore = stringSimilarity(original.textSummary ?? "", current.textSummary ?? "");
    const attributeScore = stableAttributeScore(original.stableAttributes ?? [], current.stableAttributes ?? []);
    const roleMatches = !original.role || original.role === current.role;
    const tagMatches = original.tag === current.tag;
    const headingScore = orderedContextScore(original.context?.headingPath ?? [], current.context.headingPath);
    const position = geometryProximity(original.rect, current.rect);
    const signals = {
      quoteSimilarity: Math.max(nameScore, textScore, tagMatches && roleMatches ? 0.55 : 0),
      prefixSuffix: attributeScore,
      domContext: (Number(tagMatches) + Number(roleMatches)) / 2,
      heading: headingScore,
      position,
    };
    let score = scoreElementSignals(signals, policy);
    const idMatches = stableAttributeValue(original, "id")
      && stableAttributeValue(original, "id") === stableAttributeValue(current, "id");
    if (strategy === "node_handle") score = 1;
    if (strategy === "stable_dom_path" && tagMatches && roleMatches) score = Math.max(score, 0.9);
    if (strategy === "unique_id" && idMatches && tagMatches && roleMatches) score = Math.max(score, 0.92);
    if (strategy === "image_src_alt" && tagMatches) score = Math.max(score, 0.9);
    if (strategy === "role_name" && tagMatches && roleMatches && nameScore === 1) score = Math.max(score, 0.9);
    if (strategy === "stable_attributes" && tagMatches && roleMatches && attributeScore === 1) score = Math.max(score, 0.86);
    if (strategy === "text_context" && tagMatches && roleMatches && Math.max(nameScore, textScore) === 1) {
      score = Math.max(score, 0.84);
    }
    const changedSignals = [];
    if (!tagMatches) changedSignals.push("tag_changed");
    if (!roleMatches) changedSignals.push("role_changed");
    if (original.accessibleName && original.accessibleName !== current.accessibleName) changedSignals.push("accessible_name_changed");
    if (original.textSummary && original.textSummary !== current.textSummary) changedSignals.push("text_changed");
    if ((original.stableAttributes?.length ?? 0) > 0 && attributeScore < 1) changedSignals.push("stable_attributes_changed");
    if ((original.context?.headingPath?.length ?? 0) > 0 && headingScore < 1) changedSignals.push("heading_changed");
    const candidateId = `element:${strategy}:${index}`.slice(0, 128);
    return {
      candidateId,
      element,
      target: current,
      score,
      changedSignals: changedSignals.slice(0, 8),
      summary: minimalElementSummary(current, candidateId),
      strategy,
    };
  };

  const decideElementCandidates = (candidates, policy) => {
    const ranked = [...candidates].sort((left, right) => (
      right.score - left.score || left.candidateId.localeCompare(right.candidateId)
    ));
    const first = ranked[0];
    if (!first || first.score < policy.acceptThreshold) {
      return { kind: "rejected", bestScore: first?.score ?? 0 };
    }
    const second = ranked[1];
    if (second && second.score >= policy.acceptThreshold
      && roundScore(first.score - second.score) < policy.ambiguityGap) {
      return {
        kind: "ambiguous",
        bestScore: first.score,
        candidates: ranked.filter((candidate) => (
          candidate.score >= policy.acceptThreshold
          && roundScore(first.score - candidate.score) < policy.ambiguityGap
        )).slice(0, resolverLimits.maxReturnedCandidates),
      };
    }
    return { kind: "accepted", bestScore: first.score, selected: first };
  };

  const acceptedElementResolution = (annotationId, candidate, candidateCount, truncated) => {
    const binding = candidate.binding ?? nodeBindings?.bindAnnotation(annotationId, candidate.element) ?? null;
    return {
      status: hasMaterialAnnotationChange(candidate.changedSignals) ? "changed" : "resolved",
      target: candidate.target,
      evidence: {
        strategy: candidate.strategy,
        score: candidate.score,
        rects: [candidate.target.rect],
        candidateCount: Math.min(256, candidateCount),
        truncated,
        changedSignals: candidate.changedSignals,
        ...(binding ? { binding } : {}),
      },
    };
  };

  const ambiguousElementResolution = (candidates, candidateCount, truncated) => ({
    status: "ambiguous",
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    evidence: {
      strategy: candidates[0].strategy,
      score: candidates[0].score,
      rects: [],
      candidateCount: Math.min(256, candidateCount),
      truncated,
      changedSignals: [],
      candidateSummaries: candidates.map((candidate) => candidate.summary),
    },
  });

  const orphanedElementResolution = (strategy, candidateCount, truncated, score) => ({
    status: "orphaned",
    evidence: {
      strategy,
      score,
      rects: [],
      candidateCount: Math.min(256, candidateCount),
      truncated,
      changedSignals: [],
    },
  });

  const stop = (removeCommandListener) => {
    active = null;
    pendingPointerTarget = null;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerout", onPointerOut, true);
    for (const name of blockedInteractionEvents) window.removeEventListener(name, suppressPageAction, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKeyDown, true);
    removeInspectorCursor();
    if (removeCommandListener) commandTarget.removeEventListener(commandEventName, onCommand);
  };

  const installInspectorCursor = () => {
    removeInspectorCursor();
    const style = document.createElement("style");
    style.setAttribute("data-keydex-annotation-inspector-cursor", "true");
    style.textContent = "html,body,body *{cursor:crosshair!important}";
    (document.head ?? document.documentElement).append(style);
    inspectorCursorStyle = style;
  };

  const removeInspectorCursor = () => {
    inspectorCursorStyle?.remove();
    inspectorCursorStyle = null;
  };

  const inspectableCandidates = (start) => {
    const candidates = [];
    let element = start;
    while (element && candidates.length < 32) {
      if (elementIsVisible(element)
        && cssRect(element.getBoundingClientRect())
        && domPath(element)) {
        candidates.push(element);
      }
      const root = element.getRootNode();
      element = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return candidates;
  };

  const createElementTarget = (element) => {
    const path = domPath(element);
    const rect = cssRect(element.getBoundingClientRect());
    if (!path || !rect) return null;
    const target = {
      type: "element",
      tag: element.tagName.toLowerCase().slice(0, 64),
      stableAttributes: stableAttributes(element),
      path,
      context: { headingPath: headingContext(element) },
      rect,
      frame: frameLocator(),
    };
    const role = explicitOrImplicitRole(element);
    if (role) target.role = role;
    const name = accessibleName(element);
    if (name) target.accessibleName = name;
    const summary = visibleText(element).replace(/\s+/g, " ").trim().slice(0, 1024);
    if (summary && summary !== name) target.textSummary = summary;
    const root = element.getRootNode();
    if (root instanceof ShadowRoot && root.host.shadowRoot === root) {
      const hostPath = domPath(root.host);
      if (hostPath) target.shadowHostPath = hostPath;
    }
    return target;
  };

  const stableAttributes = (element) => stableAttributeNames.flatMap((name) => {
    const raw = element.getAttribute(name);
    if (raw === null || raw.length === 0) return [];
    const value = name === "href" || name === "src" ? sanitizedUrlAttribute(raw) : raw.slice(0, 2048);
    return value ? [{ name, value }] : [];
  }).slice(0, 20);

  const sanitizedUrlAttribute = (value) => {
    try {
      const url = new URL(value, location.href);
      if (!/^https?:$/.test(url.protocol)) return "";
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString().slice(0, 2048);
    } catch {
      return "";
    }
  };

  const explicitOrImplicitRole = (element) => {
    const explicit = element.getAttribute("role")?.trim();
    if (explicit) return explicit.slice(0, 128);
    if (element.tagName === "INPUT") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      return (["button", "submit", "reset"].includes(type) ? "button"
        : ["checkbox", "radio"].includes(type) ? type : "textbox");
    }
    return implicitRoles.get(element.tagName) || "";
  };

  const accessibleName = (element) => {
    const ariaLabel = element.getAttribute("aria-label")?.trim();
    if (ariaLabel) return ariaLabel.slice(0, 1024);
    const labelledBy = element.getAttribute("aria-labelledby")?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (labelledBy.length > 0) {
      const label = labelledBy.slice(0, 8).map((id) => safeElementText(document.getElementById(id))).filter(Boolean).join(" ");
      if (label) return label.slice(0, 1024);
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      || element instanceof HTMLTextAreaElement) {
      const labels = element.labels ? Array.from(element.labels).map(safeElementText).filter(Boolean).join(" ") : "";
      if (labels) return labels.slice(0, 1024);
    }
    const alt = element.getAttribute("alt")?.trim();
    if (alt) return alt.slice(0, 1024);
    const title = element.getAttribute("title")?.trim();
    if (title) return title.slice(0, 1024);
    return safeElementText(element).slice(0, 1024);
  };

  const safeElementText = (element) => element ? visibleText(element).replace(/\s+/g, " ").trim() : "";
  const visibleText = (container) => {
    if (container instanceof HTMLInputElement || container instanceof HTMLTextAreaElement
      || container instanceof HTMLSelectElement) return "";
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return visibleTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let value = "";
    let node = walker.nextNode();
    while (node && value.length < 4096) {
      value += node.nodeValue ?? "";
      node = walker.nextNode();
    }
    return value;
  };

  const visibleTextNode = (node) => {
    let element = node.parentElement;
    while (element) {
      if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
        || element.dataset?.keydexAnnotationOverlayRoot === "true"
        || element.hasAttribute("hidden")
        || element.getAttribute("aria-hidden") === "true") return false;
      if (!elementIsVisible(element)) return false;
      element = element.parentElement;
    }
    return Boolean(node.nodeValue);
  };

  const candidateLabel = (element) => {
    const tag = element.tagName.toLowerCase();
    const id = selectorToken(element.getAttribute("id"));
    const classes = Array.from(element.classList ?? []).map(selectorToken).filter(Boolean).slice(0, 3);
    return `${tag}${id ? `#${id}` : ""}${classes.map((name) => `.${name}`).join("")}`.slice(0, 1024);
  };

  const selectorToken = (value) => typeof value === "string"
    ? value.trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80)
    : "";

  const elementIsVisible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
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

  const headingContext = (element) => {
    const headings = [];
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    let candidate = walker.nextNode();
    while (candidate) {
      const match = /^H([1-6])$/.exec(candidate.tagName);
      if (match && elementIsVisible(candidate)
        && (candidate.contains(element) || Boolean(candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))) {
        const label = safeElementText(candidate).slice(0, 256);
        if (label) {
          const level = Number(match[1]);
          headings.splice(level - 1);
          headings[level - 1] = label;
        }
      }
      candidate = walker.nextNode();
    }
    return headings.filter(Boolean).slice(0, 16);
  };

  const frameLocator = () => {
    const indexPath = [];
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
        if (index < 0) break;
        indexPath.unshift(index);
        current = parent;
      }
    } catch {
      indexPath.length = 0;
    }
    const locator = { url: location.href, indexPath };
    try {
      if (window.name) locator.name = window.name.slice(0, 256);
    } catch {
      // Frame name is an optional persisted hint.
    }
    const parentElementPath = window.KeydexAnnotationFrameBridge?.parentElementPath?.();
    if (Array.isArray(parentElementPath) && parentElementPath.length > 0) {
      locator.parentElementPath = parentElementPath;
    }
    return locator;
  };

  const cssRect = (rect) => {
    const x = Number.isFinite(rect.x) ? rect.x : rect.left;
    const y = Number.isFinite(rect.y) ? rect.y : rect.top;
    if (![x, y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
    return { x, y, width: rect.width, height: rect.height };
  };
  const eventElement = (event) => {
    const original = typeof event.composedPath === "function" ? event.composedPath()[0] : event.target;
    return original instanceof Element ? original : original?.parentElement ?? null;
  };
  const domDepth = (element) => {
    let depth = 0;
    let current = element;
    while (current?.parentNode && depth < 128) {
      depth += 1;
      current = current.parentNode;
    }
    return depth;
  };

  const scanVisibleElements = (deadline) => {
    const elements = [];
    const all = document.querySelectorAll("*");
    let scanned = 0;
    let truncated = false;
    for (const element of all) {
      if ((scanned >= resolverLimits.minimumScannedElements && resolverNow() >= deadline)
        || scanned >= resolverLimits.maxScannedElements) {
        truncated = true;
        break;
      }
      scanned += 1;
      if (element.dataset?.keydexAnnotationOverlayRoot === "true"
        || !elementIsVisible(element)
        || !cssRect(element.getBoundingClientRect())) continue;
      elements.push(element);
    }
    return { elements, truncated };
  };

  const resolvePath = (path) => {
    if (!Array.isArray(path) || path.length === 0 || path.length > 128) return null;
    let current = document;
    for (const segment of path) {
      if (!segment || !Number.isInteger(segment.childIndex) || segment.childIndex < 0) return null;
      const parent = segment.shadowRoot ? current?.shadowRoot : current;
      current = parent?.childNodes?.[segment.childIndex] ?? null;
      if (!current) return null;
    }
    return current;
  };

  const stableAttributeMatchCount = (element, target) => (target.stableAttributes ?? []).reduce((count, entry) => {
    const current = entry.name === "href" || entry.name === "src"
      ? sanitizedUrlAttribute(element.getAttribute(entry.name) ?? "")
      : element.getAttribute(entry.name);
    return count + Number(current === entry.value);
  }, 0);

  const stableAttributeValue = (target, name) => target.stableAttributes
    ?.find((entry) => entry.name === name)?.value ?? "";

  const stableAttributeScore = (expected, current) => {
    if (expected.length === 0) return 0;
    const currentMap = new Map(current.map((entry) => [entry.name, entry.value]));
    return expected.reduce((sum, entry) => sum + Number(currentMap.get(entry.name) === entry.value), 0)
      / expected.length;
  };

  const stringSimilarity = (left, right) => {
    const normalizedLeft = left.replace(/\s+/g, " ").trim().toLocaleLowerCase().slice(0, 1024);
    const normalizedRight = right.replace(/\s+/g, " ").trim().toLocaleLowerCase().slice(0, 1024);
    if (!normalizedLeft || !normalizedRight) return 0;
    if (normalizedLeft === normalizedRight) return 1;
    if (normalizedLeft.length === 1 || normalizedRight.length === 1) return 0;
    const leftPairs = new Map();
    for (let index = 0; index < normalizedLeft.length - 1; index += 1) {
      const pair = normalizedLeft.slice(index, index + 2);
      leftPairs.set(pair, (leftPairs.get(pair) ?? 0) + 1);
    }
    let intersection = 0;
    for (let index = 0; index < normalizedRight.length - 1; index += 1) {
      const pair = normalizedRight.slice(index, index + 2);
      const count = leftPairs.get(pair) ?? 0;
      if (count > 0) {
        intersection += 1;
        leftPairs.set(pair, count - 1);
      }
    }
    return (2 * intersection) / (normalizedLeft.length + normalizedRight.length - 2);
  };

  const orderedContextScore = (expected, current) => {
    if (expected.length === 0) return 1;
    let matched = 0;
    while (matched < Math.min(expected.length, current.length) && expected[matched] === current[matched]) matched += 1;
    return matched / Math.max(expected.length, current.length, 1);
  };

  const geometryProximity = (expected, current) => {
    if (!expected || !current) return 0;
    const expectedX = expected.x + expected.width / 2;
    const expectedY = expected.y + expected.height / 2;
    const currentX = current.x + current.width / 2;
    const currentY = current.y + current.height / 2;
    const distance = Math.hypot(expectedX - currentX, expectedY - currentY);
    const diagonal = Math.hypot(Math.max(window.innerWidth, 1), Math.max(window.innerHeight, 1));
    return 1 - Math.min(1, distance / diagonal);
  };

  const scoreElementSignals = (signals, policy) => roundScore(
    signals.quoteSimilarity * policy.weights.quoteSimilarity
      + signals.prefixSuffix * policy.weights.prefixSuffix
      + signals.domContext * policy.weights.domContext
      + signals.heading * policy.weights.heading
      + signals.position * policy.weights.position,
  );

  const minimalElementSummary = (target, candidateId) => {
    const summary = {
      candidateId,
      label: (target.accessibleName || target.textSummary || target.role || target.tag).slice(0, 256),
      tag: target.tag,
    };
    if (target.role) summary.role = target.role;
    return summary;
  };

  const frameMatches = (targetFrame) => {
    if (!targetFrame || !Array.isArray(targetFrame.indexPath)) return false;
    const current = frameLocator();
    if (targetFrame.indexPath.length !== current.indexPath.length
      || targetFrame.indexPath.some((value, index) => value !== current.indexPath[index])) return false;
    try {
      const expected = new URL(targetFrame.url, location.href);
      const actual = new URL(location.href);
      expected.hash = "";
      actual.hash = "";
      return expected.href === actual.href;
    } catch {
      return false;
    }
  };

  const validScoringPolicy = (policy) => Boolean(policy
    && policy.schemaVersion === 1
    && policy.policyId === "keydex.web-annotation.scoring.v1"
    && Number.isFinite(policy.acceptThreshold)
    && Number.isFinite(policy.ambiguityGap)
    && policy.weights
    && Object.values(policy.weights).every((value) => Number.isFinite(value)));

  const emptyResolutionEvidence = (strategy) => ({
    strategy,
    score: 0,
    rects: [],
    candidateCount: 0,
    truncated: false,
    changedSignals: [],
  });

  const roundScore = (value) => Math.round(value * 1000000) / 1000000;
  const resolverNow = () => globalThis.performance?.now?.() ?? Date.now();

  commandTarget.addEventListener(commandEventName, onCommand);
  window.addEventListener("pagehide", () => stop(true), { once: true });
})();
