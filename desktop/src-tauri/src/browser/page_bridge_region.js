(() => {
  "use strict";

  const commandEventName = "keydex:web-annotation-command";
  const responseEventName = "keydex:web-annotation-response";
  const commandTarget = typeof __KEYDEX_BRIDGE_COMMAND_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_COMMAND_TARGET__;
  const responseTarget = typeof __KEYDEX_BRIDGE_RESPONSE_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_RESPONSE_TARGET__;
  const overlayAttribute = "data-keydex-annotation-overlay-root";
  const minimumEdge = 8;
  const minimumArea = 256;
  const semanticSelector = [
    "button", "a[href]", "input", "textarea", "select", "img", "video", "canvas",
    "td", "th", "tr", "table", "article", "section", "main", "aside", "nav", "figure",
    "[role]", "[aria-label]",
  ].join(",");
  const stableAttributeNames = ["id", "name", "type", "href", "src", "alt", "title", "aria-label", "role"];
  const implicitRoles = new Map([
    ["A", "link"], ["BUTTON", "button"], ["IMG", "img"], ["TEXTAREA", "textbox"],
    ["SELECT", "combobox"], ["TABLE", "table"], ["TR", "row"], ["TH", "columnheader"],
    ["TD", "cell"], ["ARTICLE", "article"], ["MAIN", "main"], ["NAV", "navigation"],
    ["ASIDE", "complementary"], ["FORM", "form"], ["FIGURE", "figure"],
  ]);
  const resolverLimits = Object.freeze({
    maxScannedElements: 5000,
    minimumScannedElements: 64,
    maxCandidates: 20,
    timeBudgetMs: 12,
  });
  const materialAnnotationChangeSignals = new Set([
    "anchor_name_changed",
    "anchor_text_changed",
    "anchor_tag_changed",
    "anchor_role_changed",
    "anchor_attributes_changed",
    "local_fingerprint_changed",
  ]);
  const hasMaterialAnnotationChange = (signals) => (
    Array.isArray(signals) && signals.some((signal) => materialAnnotationChangeSignals.has(signal))
  );
  const nodeBindings = window.KeydexAnnotationBridge?.nodeBindings ?? null;
  let active = null;

  const respond = (kind, requestId, payload) => {
    responseTarget.dispatchEvent(new CustomEvent(responseEventName, {
      detail: { kind, requestId, payload },
    }));
  };

  const onCommand = (event) => {
    const envelope = event.detail;
    if (!envelope || typeof envelope !== "object") return;
    if (envelope.kind === "selection.start" && envelope.payload?.mode === "region") {
      stop(false);
      const overlay = createOverlay();
      active = {
        requestId: envelope.requestId,
        selectionId: envelope.payload.selectionId,
        overlay,
        outline: overlay.outline,
        start: null,
        pointerId: null,
      };
      overlay.layer.addEventListener("pointerdown", onPointerDown, true);
      overlay.layer.addEventListener("pointermove", onPointerMove, true);
      overlay.layer.addEventListener("pointerup", onPointerUp, true);
      overlay.layer.addEventListener("pointercancel", onPointerCancel, true);
      document.addEventListener("keydown", onKeyDown, true);
      return;
    }
    if (envelope.kind === "annotation.resolve" && envelope.payload?.target?.type === "region") {
      resolveRegionCommand(envelope);
      return;
    }
    if (envelope.kind === "selection.cancel" && active
      && envelope.payload?.selectionId === active.selectionId) {
      const request = active;
      stop(false);
      respond("selection.cancelled", request.requestId, {
        selectionId: request.selectionId,
        reason: envelope.payload.reason === "user" ? "user" : "navigation",
      });
    }
  };

  const onPointerDown = (event) => {
    if (!active || event.button !== 0 || active.start) return;
    suppress(event);
    const point = viewportPoint(event.clientX, event.clientY);
    active.start = point;
    active.pointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
    if (active.pointerId !== null && typeof active.overlay.layer.setPointerCapture === "function") {
      try {
        active.overlay.layer.setPointerCapture(active.pointerId);
      } catch {
        // The pointer can disappear between dispatch and capture.
      }
    }
    draw(active.outline, { x: point.x, y: point.y, width: 0, height: 0 });
  };

  const onPointerMove = (event) => {
    if (!active?.start || !samePointer(event, active.pointerId)) return;
    suppress(event);
    draw(active.outline, rectBetween(active.start, viewportPoint(event.clientX, event.clientY)));
  };

  const onPointerUp = (event) => {
    if (!active?.start || !samePointer(event, active.pointerId)) return;
    suppress(event);
    const request = active;
    if (!insideViewport(event.clientX, event.clientY)) {
      stop(false);
      respond("selection.cancelled", request.requestId, {
        selectionId: request.selectionId,
        reason: "invalid_selection",
      });
      return;
    }
    const rect = rectBetween(request.start, viewportPoint(event.clientX, event.clientY));
    const target = createRegionTarget(rect, request.overlay.root);
    stop(false);
    if (!target) {
      respond("selection.cancelled", request.requestId, {
        selectionId: request.selectionId,
        reason: "invalid_selection",
      });
      return;
    }
    const selectionAnchor = target.relativeElement ? resolvePath(target.relativeElement.path) : null;
    const binding = selectionAnchor
      ? nodeBindings?.bindSelection(request.selectionId, selectionAnchor) ?? null
      : null;
    respond("selection.candidate", request.requestId, {
      selectionId: request.selectionId,
      mode: "region",
      candidateId: `candidate:${request.requestId}`.slice(0, 128),
      label: `区域 ${Math.round(target.rect.width)} × ${Math.round(target.rect.height)}`,
      rect: target.rect,
      depth: target.relativeElement ? target.relativeElement.path.length : 0,
    });
    const mapping = window.KeydexAnnotationFrameBridge?.mapRectToSurface
      ? window.KeydexAnnotationFrameBridge.mapRectToSurface(target.rect, target.viewport)
      : window === window.top
        ? Promise.resolve({ rect: target.rect, viewport: target.viewport })
        : Promise.reject(new Error("unsupported frame geometry"));
    Promise.resolve(mapping).then((captureGeometry) => {
      respond("selection.result", request.requestId, {
        selectionId: request.selectionId,
        target,
        captureGeometry,
        ...(binding ? { binding } : {}),
      });
    }).catch(() => {
      respond("selection.cancelled", request.requestId, {
        selectionId: request.selectionId,
        reason: "unsupported_frame",
      });
    });
  };

  const onPointerCancel = (event) => {
    if (!active || !samePointer(event, active.pointerId)) return;
    suppress(event);
    const request = active;
    stop(false);
    respond("selection.cancelled", request.requestId, {
      selectionId: request.selectionId,
      reason: "invalid_selection",
    });
  };

  const onKeyDown = (event) => {
    if (event.key !== "Escape" || !active) return;
    suppress(event);
    const request = active;
    stop(false);
    respond("selection.cancelled", request.requestId, {
      selectionId: request.selectionId,
      reason: "user",
    });
  };

  const resolveRegionCommand = (envelope) => {
    const annotationId = envelope.payload?.annotationId;
    const target = envelope.payload?.target;
    if (typeof annotationId !== "string" || !target || target.type !== "region") return;
    const policy = window.KeydexAnnotationBridge?.scoringPolicy;
    if (!validScoringPolicy(policy)) {
      respond("bridge.error", envelope.requestId, {
        code: "internal",
        message: "Region resolver scoring policy is unavailable",
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
        ...resolveRegionTarget(annotationId, target, envelope.payload?.binding, policy),
      });
    } catch {
      respond("bridge.error", envelope.requestId, {
        code: "internal",
        message: "Region resolver failed",
        retryable: true,
      });
    }
  };

  const resolveRegionTarget = (annotationId, target, preferredBinding, policy) => {
    if (!target.relativeElement) {
      nodeBindings?.releaseAnnotation(annotationId);
      return orphanedRegionResolution(
        "coordinate_only_region",
        0,
        false,
        target.visual?.perceptualHash ? ["perceptual_hash_available"] : [],
      );
    }
    const deadline = resolverNow() + resolverLimits.timeBudgetMs;
    const bound = nodeBindings?.resolveAnnotation(annotationId, preferredBinding) ?? null;
    if (bound) {
      const boundCandidate = createRegionAnchorCandidate(bound.node, target, "node_handle", 0, policy);
      if (boundCandidate) {
        boundCandidate.binding = bound.binding;
        return acceptedRegionResolution(annotationId, boundCandidate, target, 1, false);
      }
      nodeBindings?.releaseAnnotation(annotationId);
    }
    const pathElement = resolvePath(target.relativeElement.path);
    const pathCandidate = createRegionAnchorCandidate(pathElement, target, "relative_region", 0, policy);
    if (pathCandidate && pathCandidate.score >= policy.acceptThreshold) {
      return acceptedRegionResolution(annotationId, pathCandidate, target, 1, false);
    }
    const scan = scanRegionAnchorCandidates(target.relativeElement, deadline);
    const candidates = scan.elements.flatMap((element, index) => {
      const candidate = createRegionAnchorCandidate(element, target, "region_semantic_search", index, policy);
      return candidate ? [candidate] : [];
    });
    const decision = decideRegionCandidates(candidates, policy);
    if (decision.kind === "accepted") {
      return acceptedRegionResolution(annotationId, decision.selected, target, candidates.length, scan.truncated);
    }
    if (decision.kind === "ambiguous") {
      nodeBindings?.releaseAnnotation(annotationId);
      return ambiguousRegionResolution(decision.candidates, candidates.length, scan.truncated);
    }
    nodeBindings?.releaseAnnotation(annotationId);
    return orphanedRegionResolution(
      "region_semantic_search",
      candidates.length,
      scan.truncated,
      target.visual?.perceptualHash ? ["perceptual_hash_available"] : [],
      decision.bestScore,
    );
  };

  const createRegionAnchorCandidate = (element, target, strategy, index, policy) => {
    if (!(element instanceof Element) || !element.isConnected || !elementIsVisible(element)) return null;
    const currentRect = cssRect(element.getBoundingClientRect());
    if (!currentRect) return null;
    const original = target.relativeElement;
    const current = semanticDescriptor(element, currentRect);
    if (!current.path) return null;
    const tagMatches = !original.tag || original.tag === current.tag;
    const roleMatches = !original.role || original.role === current.role;
    const nameScore = stringSimilarity(original.accessibleName ?? "", current.accessibleName ?? "");
    const textScore = stringSimilarity(original.textSummary ?? "", current.textSummary ?? "");
    const attributeScore = stableAttributeScore(original.stableAttributes ?? [], current.stableAttributes ?? []);
    const geometry = geometryProximity(original.rect, currentRect);
    const score = Math.max(
      scoreRegionSignals({
        quoteSimilarity: Math.max(nameScore, textScore, tagMatches && roleMatches ? 0.55 : 0),
        prefixSuffix: attributeScore,
        domContext: (Number(tagMatches) + Number(roleMatches)) / 2,
        heading: 1,
        position: geometry,
      }, policy),
      strategy === "node_handle" ? 1 : 0,
      strategy === "relative_region" && tagMatches && roleMatches ? 0.9 : 0,
      strategy === "region_semantic_search" && tagMatches && roleMatches
        && (nameScore === 1 || textScore === 1 || attributeScore === 1) ? 0.86 : 0,
    );
    const changedSignals = [];
    if (!tagMatches) changedSignals.push("anchor_tag_changed");
    if (!roleMatches) changedSignals.push("anchor_role_changed");
    if (original.accessibleName && original.accessibleName !== current.accessibleName) {
      changedSignals.push("anchor_name_changed");
    }
    if (original.textSummary && original.textSummary !== current.textSummary) changedSignals.push("anchor_text_changed");
    if ((original.stableAttributes?.length ?? 0) > 0 && attributeScore < 1) {
      changedSignals.push("anchor_attributes_changed");
    }
    if (Math.abs(original.rect.x - currentRect.x) > 0.5
      || Math.abs(original.rect.y - currentRect.y) > 0.5) changedSignals.push("anchor_position_changed");
    if (Math.abs(original.rect.width - currentRect.width) > 0.5
      || Math.abs(original.rect.height - currentRect.height) > 0.5) changedSignals.push("anchor_size_changed");
    const currentDigest = elementLocalDigest(element);
    if (target.visual?.localDigest && target.visual.localDigest !== currentDigest) {
      changedSignals.push("local_fingerprint_changed");
    }
    const candidateId = `region:${strategy}:${index}`.slice(0, 128);
    return {
      candidateId,
      element,
      elementRect: currentRect,
      descriptor: current,
      localDigest: currentDigest,
      score,
      changedSignals: changedSignals.slice(0, 8),
      summary: {
        candidateId,
        label: (current.accessibleName || current.textSummary || current.role || current.tag).slice(0, 256),
        tag: current.tag,
        ...(current.role ? { role: current.role } : {}),
      },
      strategy,
    };
  };

  const acceptedRegionResolution = (annotationId, candidate, original, candidateCount, truncated) => {
    const mappedRect = mapRelativeRegion(original.rect, original.relativeElement.rect, candidate.elementRect);
    const viewport = viewportSize();
    if (!mappedRect || !validRegion(mappedRect, viewport)) {
      return orphanedRegionResolution(candidate.strategy, candidateCount, truncated, ["mapped_region_invalid"], candidate.score);
    }
    const relativeElement = {
      path: candidate.descriptor.path,
      rect: candidate.elementRect,
      tag: candidate.descriptor.tag,
      stableAttributes: candidate.descriptor.stableAttributes,
      ...(candidate.descriptor.role ? { role: candidate.descriptor.role } : {}),
      ...(candidate.descriptor.accessibleName ? { accessibleName: candidate.descriptor.accessibleName } : {}),
      ...(candidate.descriptor.textSummary ? { textSummary: candidate.descriptor.textSummary } : {}),
    };
    const target = {
      type: "region",
      rect: mappedRect,
      viewport,
      scroll: {
        x: Number.isFinite(window.scrollX) ? window.scrollX : 0,
        y: Number.isFinite(window.scrollY) ? window.scrollY : 0,
      },
      relativeElement,
      visual: {
        fingerprintVersion: 1,
        localDigest: candidate.localDigest,
        ...(original.visual?.perceptualHash ? { perceptualHash: original.visual.perceptualHash } : {}),
      },
      frame: frameLocator(),
    };
    const binding = candidate.binding ?? nodeBindings?.bindAnnotation(annotationId, candidate.element) ?? null;
    return {
      status: hasMaterialAnnotationChange(candidate.changedSignals) ? "changed" : "resolved",
      target,
      evidence: {
        strategy: candidate.strategy,
        score: candidate.score,
        rects: [mappedRect],
        candidateCount: Math.min(256, candidateCount),
        truncated,
        changedSignals: candidate.changedSignals,
        ...(binding ? { binding } : {}),
      },
    };
  };

  const ambiguousRegionResolution = (candidates, candidateCount, truncated) => ({
    status: "ambiguous",
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    evidence: {
      strategy: "region_semantic_search",
      score: candidates[0]?.score ?? 0,
      rects: [],
      candidateCount: Math.min(256, candidateCount),
      truncated,
      changedSignals: [],
      candidateSummaries: candidates.map((candidate) => candidate.summary),
    },
  });

  const orphanedRegionResolution = (strategy, candidateCount, truncated, changedSignals = [], score = 0) => ({
    status: "orphaned",
    evidence: {
      strategy,
      score,
      rects: [],
      candidateCount: Math.min(256, candidateCount),
      truncated,
      changedSignals: changedSignals.slice(0, 8),
    },
  });

  const decideRegionCandidates = (candidates, policy) => {
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
        candidates: ranked.filter((candidate) => (
          candidate.score >= policy.acceptThreshold
          && roundScore(first.score - candidate.score) < policy.ambiguityGap
        )).slice(0, resolverLimits.maxCandidates),
      };
    }
    return { kind: "accepted", selected: first };
  };

  const semanticDescriptor = (element, rect) => {
    const descriptor = {
      path: domPath(element),
      rect,
      tag: element.tagName.toLowerCase().slice(0, 64),
      stableAttributes: stableAttributes(element),
    };
    const role = semanticRole(element);
    if (role) descriptor.role = role;
    const name = accessibleName(element);
    if (name) descriptor.accessibleName = name;
    const summary = safeElementText(element).slice(0, 1024);
    if (summary && summary !== name) descriptor.textSummary = summary;
    return descriptor;
  };

  const scanRegionAnchorCandidates = (anchor, deadline) => {
    const elements = [];
    let scanned = 0;
    let truncated = false;
    for (const element of document.querySelectorAll(semanticSelector)) {
      if ((scanned >= resolverLimits.minimumScannedElements && resolverNow() >= deadline)
        || scanned >= resolverLimits.maxScannedElements) {
        truncated = true;
        break;
      }
      scanned += 1;
      if (!(element instanceof Element)
        || element.closest(`[${overlayAttribute}='true']`)
        || !elementIsVisible(element)
        || !cssRect(element.getBoundingClientRect())) continue;
      const tagMatches = !anchor.tag || anchor.tag === element.tagName.toLowerCase();
      const roleMatches = !anchor.role || anchor.role === semanticRole(element);
      const nameMatches = Boolean(anchor.accessibleName)
        && stringSimilarity(anchor.accessibleName, accessibleName(element)) >= 0.72;
      const textMatches = Boolean(anchor.textSummary)
        && stringSimilarity(anchor.textSummary, safeElementText(element)) >= 0.72;
      const attributeMatches = stableAttributeScore(anchor.stableAttributes ?? [], stableAttributes(element)) > 0;
      if ((tagMatches && roleMatches && (nameMatches || textMatches || attributeMatches))
        || nameMatches || textMatches || attributeMatches) elements.push(element);
      if (elements.length >= resolverLimits.maxCandidates) {
        truncated = true;
        break;
      }
    }
    return { elements, truncated };
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

  const semanticRole = (element) => {
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
      const label = labelledBy.slice(0, 8).map((id) => safeElementText(document.getElementById(id)))
        .filter(Boolean).join(" ");
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
        || element.hasAttribute("inert")
        || element.getAttribute("aria-hidden") === "true"
        || !elementIsVisible(element)) return false;
      element = element.parentElement;
    }
    return Boolean(node.nodeValue);
  };

  const elementIsVisible = (element) => {
    if (element.hasAttribute("hidden") || element.hasAttribute("inert")
      || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  };

  const elementLocalDigest = (element) => digestText([
    element.tagName.toLowerCase(),
    semanticRole(element),
    accessibleName(element),
    safeElementText(element).slice(0, 2048),
    stableAttributes(element).map((entry) => `${entry.name}=${entry.value}`).join("|"),
  ].join("\n"));

  const pageLocalDigest = () => digestText([
    `${location.origin}${location.pathname}`,
    safeElementText(document.body ?? document.documentElement).slice(0, 4096),
  ].join("\n"));

  const digestText = (value) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
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

  const scoreRegionSignals = (signals, policy) => roundScore(
    signals.quoteSimilarity * policy.weights.quoteSimilarity
      + signals.prefixSuffix * policy.weights.prefixSuffix
      + signals.domContext * policy.weights.domContext
      + signals.heading * policy.weights.heading
      + signals.position * policy.weights.position,
  );

  const mapRelativeRegion = (region, originalAnchor, currentAnchor) => {
    if (![region?.x, region?.y, region?.width, region?.height,
      originalAnchor?.x, originalAnchor?.y, originalAnchor?.width, originalAnchor?.height,
      currentAnchor?.x, currentAnchor?.y, currentAnchor?.width, currentAnchor?.height].every(Number.isFinite)
      || originalAnchor.width <= 0 || originalAnchor.height <= 0
      || currentAnchor.width <= 0 || currentAnchor.height <= 0) return null;
    const viewport = viewportSize();
    const raw = {
      x: currentAnchor.x + ((region.x - originalAnchor.x) / originalAnchor.width) * currentAnchor.width,
      y: currentAnchor.y + ((region.y - originalAnchor.y) / originalAnchor.height) * currentAnchor.height,
      width: (region.width / originalAnchor.width) * currentAnchor.width,
      height: (region.height / originalAnchor.height) * currentAnchor.height,
    };
    const x = clamp(raw.x, 0, viewport.width);
    const y = clamp(raw.y, 0, viewport.height);
    return {
      x,
      y,
      width: Math.max(0, Math.min(raw.width, viewport.width - x)),
      height: Math.max(0, Math.min(raw.height, viewport.height - y)),
    };
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

  const stop = (removeCommandListener) => {
    const current = active;
    active = null;
    if (current) {
      current.overlay.layer.removeEventListener("pointerdown", onPointerDown, true);
      current.overlay.layer.removeEventListener("pointermove", onPointerMove, true);
      current.overlay.layer.removeEventListener("pointerup", onPointerUp, true);
      current.overlay.layer.removeEventListener("pointercancel", onPointerCancel, true);
      current.overlay.destroy();
    }
    document.removeEventListener("keydown", onKeyDown, true);
    if (removeCommandListener) commandTarget.removeEventListener(commandEventName, onCommand);
  };

  const createOverlay = () => {
    const managed = window.KeydexAnnotationOverlay?.beginRegion?.();
    if (managed?.root && managed?.layer && managed?.outline && typeof managed.destroy === "function") {
      return managed;
    }
    const root = document.createElement("div");
    root.setAttribute(overlayAttribute, "true");
    root.style.cssText = [
      "all:initial", "position:fixed", "inset:0", "z-index:2147483647",
      "pointer-events:auto", "cursor:crosshair", "user-select:none", "touch-action:none",
    ].join(";");
    const shadow = root.attachShadow({ mode: "open" });
    const layer = document.createElement("div");
    layer.setAttribute("part", "capture-layer");
    layer.style.cssText = "position:absolute;inset:0;pointer-events:auto;cursor:crosshair;background:transparent";
    const outline = document.createElement("div");
    outline.setAttribute("part", "capture-outline");
    outline.style.cssText = [
      "display:none", "position:absolute", "box-sizing:border-box", "pointer-events:none",
      "border:2px solid Highlight", "background:transparent",
    ].join(";");
    layer.append(outline);
    shadow.append(layer);
    (document.documentElement ?? document.body).append(root);
    return { root, layer, outline, destroy: () => root.remove() };
  };

  const createRegionTarget = (rect, overlayRoot) => {
    const viewport = viewportSize();
    if (!validRegion(rect, viewport)) return null;
    const target = {
      type: "region",
      rect,
      viewport,
      scroll: {
        x: Number.isFinite(window.scrollX) ? window.scrollX : 0,
        y: Number.isFinite(window.scrollY) ? window.scrollY : 0,
      },
      frame: frameLocator(),
    };
    const relativeElement = semanticAnchor(rect, overlayRoot);
    if (relativeElement) target.relativeElement = relativeElement;
    target.visual = {
      fingerprintVersion: 1,
      localDigest: relativeElement?.localDigest ?? pageLocalDigest(),
    };
    if (target.relativeElement) delete target.relativeElement.localDigest;
    return target;
  };

  const semanticAnchor = (rect, overlayRoot) => {
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const prior = overlayRoot.style.pointerEvents;
    const priorPriority = overlayRoot.style.getPropertyPriority("pointer-events");
    overlayRoot.style.setProperty("pointer-events", "none", "important");
    let candidates = [];
    try {
      if (typeof document.elementsFromPoint === "function") candidates = document.elementsFromPoint(x, y);
      else if (typeof document.elementFromPoint === "function") candidates = [document.elementFromPoint(x, y)];
    } finally {
      overlayRoot.style.setProperty("pointer-events", prior, priorPriority);
    }
    let element = candidates.find((candidate) => candidate instanceof Element
      && !candidate.closest(`[${overlayAttribute}='true']`)) ?? null;
    element = element?.closest(semanticSelector) ?? element;
    if (!(element instanceof Element) || !element.isConnected) return null;
    const path = domPath(element);
    const elementRect = cssRect(element.getBoundingClientRect());
    if (!path || !elementRect) return null;
    const anchor = {
      path,
      rect: elementRect,
      tag: element.tagName.toLowerCase().slice(0, 64),
      stableAttributes: stableAttributes(element),
      localDigest: elementLocalDigest(element),
    };
    const role = semanticRole(element);
    if (role) anchor.role = role;
    const name = accessibleName(element);
    if (name) anchor.accessibleName = name;
    const summary = safeElementText(element).slice(0, 1024);
    if (summary && summary !== name) anchor.textSummary = summary;
    return anchor;
  };

  const validRegion = (rect, viewport) => rect.width >= minimumEdge
    && rect.height >= minimumEdge
    && rect.width * rect.height >= minimumArea
    && rect.x >= 0 && rect.y >= 0
    && rect.x + rect.width <= viewport.width + 0.01
    && rect.y + rect.height <= viewport.height + 0.01;

  const viewportPoint = (x, y) => {
    const viewport = viewportSize();
    return {
      x: clamp(Number.isFinite(x) ? x : 0, 0, viewport.width),
      y: clamp(Number.isFinite(y) ? y : 0, 0, viewport.height),
    };
  };

  const insideViewport = (x, y) => {
    const viewport = viewportSize();
    return Number.isFinite(x) && Number.isFinite(y)
      && x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
  };

  const viewportSize = () => ({
    width: Math.max(1, document.documentElement?.clientWidth || window.innerWidth || 1),
    height: Math.max(1, document.documentElement?.clientHeight || window.innerHeight || 1),
  });

  const rectBetween = (start, end) => ({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  });

  const draw = (outline, rect) => {
    outline.style.display = "block";
    outline.style.left = `${rect.x}px`;
    outline.style.top = `${rect.y}px`;
    outline.style.width = `${rect.width}px`;
    outline.style.height = `${rect.height}px`;
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
      // Frame name is only a persisted hint.
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
    if (![x, y, rect.width, rect.height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0) return null;
    return { x, y, width: rect.width, height: rect.height };
  };

  const samePointer = (event, pointerId) => pointerId === null
    || !Number.isInteger(event.pointerId)
    || event.pointerId === pointerId;
  const suppress = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

  commandTarget.addEventListener(commandEventName, onCommand);
  window.addEventListener("pagehide", () => stop(true), { once: true });
})();
