(() => {
  "use strict";

  const commandEventName = "keydex:web-annotation-command";
  const responseEventName = "keydex:web-annotation-response";
  const commandTarget = typeof __KEYDEX_BRIDGE_COMMAND_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_COMMAND_TARGET__;
  const responseTarget = typeof __KEYDEX_BRIDGE_RESPONSE_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_RESPONSE_TARGET__;
  const forbiddenTags = new Set([
    "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "INPUT", "TEXTAREA", "SELECT", "OPTION",
  ]);
  const semanticRoles = new Map([
    ["ARTICLE", "article"], ["SECTION", "region"], ["MAIN", "main"], ["ASIDE", "complementary"],
    ["NAV", "navigation"], ["P", "paragraph"], ["LI", "listitem"], ["TD", "cell"],
    ["TH", "columnheader"], ["FIGURE", "figure"], ["BLOCKQUOTE", "blockquote"],
  ]);
  const resolverLimits = Object.freeze({
    maxExactMatches: 256,
    maxReturnedCandidates: 20,
    maxFuzzyWindowChars: 32768,
    maxFuzzyStarts: 256,
    maxFuzzyQuoteChars: 512,
    guaranteedExactScanChars: 16 * 1024,
    timeBudgetMs: 12,
  });
  const materialAnnotationChangeSignals = new Set(["quote_changed"]);
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
    if (envelope.kind === "selection.start" && envelope.payload?.mode === "text") {
      stop(false);
      active = {
        requestId: envelope.requestId,
        selectionId: envelope.payload.selectionId,
      };
      document.addEventListener("pointerup", onCommit, true);
      document.addEventListener("keyup", onKeyUp, true);
      document.addEventListener("keydown", onKeyDown, true);
      return;
    }
    if (envelope.kind === "annotation.resolve" && envelope.payload?.target?.type === "text") {
      resolveTextCommand(envelope);
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

  const onKeyDown = (event) => {
    if (event.key !== "Escape" || !active) return;
    event.preventDefault();
    event.stopPropagation();
    const request = active;
    stop(false);
    respond("selection.cancelled", request.requestId, {
      selectionId: request.selectionId,
      reason: "user",
    });
  };

  const onKeyUp = (event) => {
    if (event.key === "Escape" || isEditableEventTarget(event.target)) return;
    onCommit();
  };

  const onCommit = () => {
    if (!active) return;
    const request = active;
    const target = createTextTarget(window.getSelection());
    if (!target) {
      stop(false);
      respond("selection.cancelled", request.requestId, {
        selectionId: request.selectionId,
        reason: "invalid_selection",
      });
      return;
    }
    const rect = target.rects[0];
    const selection = window.getSelection();
    const bindingNode = selection?.rangeCount
      ? semanticContainer(selection.getRangeAt(0).commonAncestorContainer)
        ?? selection.getRangeAt(0).commonAncestorContainer.parentElement
      : null;
    const binding = bindingNode ? nodeBindings?.bindSelection(request.selectionId, bindingNode) ?? null : null;
    respond("selection.candidate", request.requestId, {
      selectionId: request.selectionId,
      mode: "text",
      candidateId: `candidate:${request.requestId}`.slice(0, 128),
      label: compactLabel(target.quote.exact),
      rect,
      depth: domDepth(window.getSelection()?.anchorNode ?? null),
    });
    respond("selection.result", request.requestId, {
      selectionId: request.selectionId,
      target,
      ...(binding ? { binding } : {}),
    });
    stop(false);
  };

  const resolveTextCommand = (envelope) => {
    const annotationId = envelope.payload?.annotationId;
    const target = envelope.payload?.target;
    if (typeof annotationId !== "string" || !target || target.type !== "text") return;
    const policy = window.KeydexAnnotationBridge?.scoringPolicy;
    if (!validScoringPolicy(policy)) {
      respond("bridge.error", envelope.requestId, {
        code: "internal",
        message: "Text resolver scoring policy is unavailable",
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
      const resolution = resolveTextTarget(annotationId, target, envelope.payload?.binding, policy);
      if (resolution.status === "ambiguous" || resolution.status === "orphaned") {
        nodeBindings?.releaseAnnotation(annotationId);
      }
      respond("resolution.result", envelope.requestId, { annotationId, ...resolution });
    } catch {
      respond("bridge.error", envelope.requestId, {
        code: "internal",
        message: "Text resolver failed",
        retryable: true,
      });
    }
  };

  const resolveTextTarget = (annotationId, target, preferredBinding, policy) => {
    const startedAt = resolverNow();
    const deadline = startedAt + resolverLimits.timeBudgetMs;
    const model = buildVisibleTextModel();
    const bound = nodeBindings?.resolveAnnotation(annotationId, preferredBinding) ?? null;
    const boundDecision = bound
      ? candidateFromBoundNode(model, target, bound.node, policy, deadline)
      : null;
    if (boundDecision?.kind === "accepted") {
      boundDecision.selected.binding = bound.binding;
      return acceptedResolution(
        annotationId,
        boundDecision.selected,
        "node_handle",
        boundDecision.total,
        boundDecision.selected.changedSignals.length > 0,
        boundDecision.truncated,
      );
    }
    const domCandidate = candidateFromDomRange(model, target, policy, deadline);
    if (domCandidate && domCandidate.currentQuote === target.quote.exact) {
      return acceptedResolution(annotationId, domCandidate, "dom_range", 1, false);
    }
    const positionCandidate = candidateFromPosition(model, target, policy);
    if (positionCandidate && positionCandidate.currentQuote === target.quote.exact) {
      return acceptedResolution(annotationId, positionCandidate, "text_position", 1, false);
    }

    const exactSearch = exactQuoteCandidates(model, target, policy, deadline);
    if (exactSearch.candidates.length === 1 && !exactSearch.truncated) {
      const selected = exactSearch.candidates[0];
      return acceptedResolution(annotationId, selected, "exact_quote", 1, selected.changedSignals.length > 0);
    }
    if (exactSearch.candidates.length > 1 || exactSearch.truncated) {
      const exactDecision = decideCandidates(exactSearch.candidates, policy);
      if (exactDecision.kind === "accepted") {
        return acceptedResolution(
          annotationId,
          exactDecision.selected,
          "exact_quote",
          exactSearch.total,
          exactDecision.selected.changedSignals.length > 0,
          exactSearch.truncated,
        );
      }
      if (exactDecision.kind === "ambiguous") {
        return ambiguousResolution(exactDecision.candidates, "exact_quote", exactSearch.total, exactSearch.truncated);
      }
      if (model.text.length > resolverLimits.guaranteedExactScanChars && resolverNow() >= deadline) {
        return orphanedResolution("exact_quote", exactSearch.total, exactSearch.truncated, exactDecision.bestScore);
      }
    }

    const fuzzySearch = fuzzyQuoteCandidates(model, target, policy, deadline);
    const fuzzyDecision = decideCandidates(fuzzySearch.candidates, policy);
    if (fuzzyDecision.kind === "accepted") {
      return acceptedResolution(
        annotationId,
        fuzzyDecision.selected,
        "fuzzy_quote",
        fuzzySearch.total,
        true,
        fuzzySearch.truncated,
      );
    }
    if (fuzzyDecision.kind === "ambiguous") {
      return ambiguousResolution(fuzzyDecision.candidates, "fuzzy_quote", fuzzySearch.total, fuzzySearch.truncated);
    }
    return orphanedResolution(
      "fuzzy_quote",
      fuzzySearch.total,
      fuzzySearch.truncated,
      fuzzyDecision.bestScore,
    );
  };

  const candidateFromBoundNode = (model, target, boundNode, policy, deadline) => {
    const scoped = buildVisibleTextModel(boundNode);
    const candidates = [];
    let cursor = 0;
    let total = 0;
    let truncated = false;
    while (cursor <= scoped.text.length - target.quote.exact.length) {
      if (resolverNow() >= deadline) {
        truncated = true;
        break;
      }
      const start = scoped.text.indexOf(target.quote.exact, cursor);
      if (start < 0) break;
      total += 1;
      const range = rangeFromLogical(scoped, start, start + target.quote.exact.length);
      const projection = range ? projectRange(model, range) : null;
      const candidate = range && projection
        ? createResolutionCandidate(model, target, range, projection, "node_handle", false, policy)
        : null;
      if (candidate) candidates.push(candidate);
      cursor = start + 1;
      if (candidates.length >= resolverLimits.maxExactMatches) {
        truncated = scoped.text.indexOf(target.quote.exact, cursor) >= 0;
        break;
      }
    }
    const decision = decideCandidates(candidates, policy);
    return { ...decision, total, truncated };
  };

  const candidateFromDomRange = (model, target, policy, deadline) => {
    if (!target.domRange) return null;
    const start = resolvePath(target.domRange.startPath);
    const end = resolvePath(target.domRange.endPath);
    if (!(start instanceof Node) || !(end instanceof Node)) return null;
    try {
      const range = document.createRange();
      range.setStart(start, target.domRange.startOffset);
      range.setEnd(end, target.domRange.endOffset);
      const projection = projectRange(model, range);
      return projection ? createResolutionCandidate(model, target, range, projection, "dom_range", false, policy) : null;
    } catch {
      return null;
    }
  };

  const candidateFromPosition = (model, target, policy) => {
    const position = target.position;
    if (!position || position.textModelVersion !== 1
      || !Number.isSafeInteger(position.start) || !Number.isSafeInteger(position.end)
      || position.start < 0 || position.end <= position.start || position.end > model.text.length) return null;
    const range = rangeFromLogical(model, position.start, position.end);
    if (!range) return null;
    return createResolutionCandidate(
      model,
      target,
      range,
      { start: position.start, end: position.end },
      "text_position",
      false,
      policy,
    );
  };

  const exactQuoteCandidates = (model, target, policy, deadline) => {
    const candidates = [];
    let cursor = 0;
    let total = 0;
    let truncated = false;
    while (cursor <= model.text.length - target.quote.exact.length) {
      if (model.text.length > resolverLimits.guaranteedExactScanChars && resolverNow() >= deadline) {
        truncated = true;
        break;
      }
      const start = model.text.indexOf(target.quote.exact, cursor);
      if (start < 0) break;
      total += 1;
      if (candidates.length < resolverLimits.maxExactMatches) {
        const end = start + target.quote.exact.length;
        const range = rangeFromLogical(model, start, end);
        const candidate = range && createResolutionCandidate(
          model,
          target,
          range,
          { start, end },
          "exact_quote",
          false,
          policy,
        );
        if (candidate) candidates.push(candidate);
      } else {
        truncated = true;
      }
      cursor = start + 1;
      if (total >= resolverLimits.maxExactMatches) {
        truncated = model.text.indexOf(target.quote.exact, cursor) >= 0;
        break;
      }
    }
    return { candidates, total, truncated };
  };

  const fuzzyQuoteCandidates = (model, target, policy, deadline) => {
    const exact = target.quote.exact;
    if (exact.length === 0 || exact.length > resolverLimits.maxFuzzyQuoteChars
      || (model.text.length > resolverLimits.guaranteedExactScanChars && resolverNow() >= deadline)) {
      return { candidates: [], total: 0, truncated: exact.length > resolverLimits.maxFuzzyQuoteChars };
    }
    const origin = Number.isSafeInteger(target.position?.start) ? target.position.start : 0;
    const radius = Math.floor(resolverLimits.maxFuzzyWindowChars / 2);
    const windowStart = Math.max(0, Math.min(model.text.length, origin - radius));
    const windowEnd = Math.min(model.text.length, Math.max(windowStart, origin + radius));
    const starts = fuzzyCandidateStarts(model.text, windowStart, windowEnd, origin);
    const maxDistance = Math.max(1, Math.min(32, Math.floor(exact.length * 0.3)));
    const candidates = [];
    const seen = new Set();
    let total = 0;
    let truncated = starts.truncated;
    outer: for (const start of starts.values) {
      for (const delta of [0, -1, 1, -2, 2]) {
        if (model.text.length > resolverLimits.guaranteedExactScanChars && resolverNow() >= deadline) {
          truncated = true;
          break outer;
        }
        const length = exact.length + delta;
        const end = start + length;
        if (length <= 0 || end > windowEnd || end > model.text.length) continue;
        const key = `${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const currentQuote = model.text.slice(start, end);
        if (!currentQuote.trim() || currentQuote === exact) continue;
        const distance = boundedLevenshtein(exact, currentQuote, maxDistance);
        if (distance === null) continue;
        const similarity = 1 - distance / Math.max(exact.length, currentQuote.length);
        if (similarity < 0.55) continue;
        total += 1;
        const range = rangeFromLogical(model, start, end);
        const candidate = range && createResolutionCandidate(
          model,
          target,
          range,
          { start, end },
          "fuzzy_quote",
          true,
          policy,
          similarity,
        );
        if (candidate) candidates.push(candidate);
        if (candidates.length >= resolverLimits.maxExactMatches) {
          truncated = true;
          break outer;
        }
      }
    }
    return { candidates, total, truncated };
  };

  const createResolutionCandidate = (
    model,
    original,
    range,
    projection,
    strategy,
    fuzzy,
    policy,
    quoteSimilarity = 1,
  ) => {
    const rects = selectionRects(range);
    if (rects.length === 0) return null;
    const startPath = domPath(range.startContainer);
    const endPath = domPath(range.endContainer);
    if (!startPath || !endPath) return null;
    const currentQuote = model.text.slice(projection.start, projection.end);
    if (!currentQuote || currentQuote.length > 8192) return null;
    const prefix = safeTail(model.text.slice(0, projection.start), 256);
    const suffix = safeHead(model.text.slice(projection.end), 256);
    const container = semanticContainer(range.startContainer);
    const headingPath = headingContext(range);
    const containerRoleValue = containerRole(container);
    const digestSource = container ? visibleTextWithin(container).slice(0, 2048) : "";
    const containerTextDigest = digestSource ? digestText(digestSource) : "";
    const prefixScore = adjacentContextScore(original.quote.prefix, prefix, "tail");
    const suffixScore = adjacentContextScore(original.quote.suffix, suffix, "head");
    const contextSignals = [];
    if (currentQuote !== original.quote.exact) contextSignals.push("quote_changed");
    if (original.quote.prefix && prefixScore < 1) contextSignals.push("prefix_changed");
    if (original.quote.suffix && suffixScore < 1) contextSignals.push("suffix_changed");
    const domContext = domContextScore(original.context, containerRoleValue, containerTextDigest);
    if (hasPersistedDomContext(original.context) && domContext < 1) contextSignals.push("container_changed");
    const heading = headingContextScore(original.context?.headingPath ?? [], headingPath);
    if ((original.context?.headingPath?.length ?? 0) > 0 && heading < 1) contextSignals.push("heading_changed");
    const position = positionScore(original.position?.start, projection.start, model.text.length);
    const score = scoreSignals({
      quoteSimilarity,
      prefixSuffix: (prefixScore + suffixScore) / 2,
      domContext,
      heading,
      position,
    }, policy);
    const context = { headingPath };
    if (containerRoleValue) context.containerRole = containerRoleValue;
    if (containerTextDigest) context.containerTextDigest = containerTextDigest;
    return {
      candidateId: `text:${projection.start}:${projection.end}`,
      currentQuote,
      score,
      changedSignals: contextSignals.slice(0, 8),
      bindingNode: container ?? range.commonAncestorContainer.parentElement,
      target: {
        type: "text",
        quote: { exact: currentQuote, prefix, suffix },
        position: { start: projection.start, end: projection.end, textModelVersion: 1 },
        domRange: {
          startPath,
          startOffset: range.startOffset,
          endPath,
          endOffset: range.endOffset,
        },
        context,
        rects,
        frame: frameLocator(),
      },
      evidence: {
        strategy,
        score,
        currentQuote,
        rects,
        candidateCount: 1,
        truncated: false,
        changedSignals: contextSignals.slice(0, 8),
      },
      fuzzy,
    };
  };

  const acceptedResolution = (annotationId, candidate, strategy, candidateCount, _changed, truncated = false) => {
    const binding = candidate.binding ?? (candidate.bindingNode
      ? nodeBindings?.bindAnnotation(annotationId, candidate.bindingNode) ?? null
      : null);
    return {
      status: hasMaterialAnnotationChange(candidate.changedSignals) || candidate.fuzzy ? "changed" : "resolved",
      target: candidate.target,
      evidence: {
        ...candidate.evidence,
        strategy,
        candidateCount: Math.min(256, candidateCount),
        truncated,
        ...(binding ? { binding } : {}),
      },
    };
  };

  const ambiguousResolution = (candidates, strategy, candidateCount, truncated) => ({
    status: "ambiguous",
    candidateIds: candidates.slice(0, resolverLimits.maxReturnedCandidates).map((candidate) => candidate.candidateId),
    evidence: {
      strategy,
      score: candidates[0]?.score ?? 0,
      rects: [],
      candidateCount: Math.min(256, candidateCount),
      truncated,
      changedSignals: [],
    },
  });

  const orphanedResolution = (strategy, candidateCount, truncated, score = 0) => ({
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

  const decideCandidates = (candidates, policy) => {
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
        )).slice(0, resolverLimits.maxReturnedCandidates),
      };
    }
    return { kind: "accepted", selected: first };
  };

  const scoreSignals = (signals, policy) => roundScore(
    signals.quoteSimilarity * policy.weights.quoteSimilarity
      + signals.prefixSuffix * policy.weights.prefixSuffix
      + signals.domContext * policy.weights.domContext
      + signals.heading * policy.weights.heading
      + signals.position * policy.weights.position,
  );

  const rangeFromLogical = (model, start, end) => {
    const startPosition = logicalPosition(model, start, false);
    const endPosition = logicalPosition(model, end, true);
    if (!startPosition || !endPosition) return null;
    try {
      const range = document.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);
      return range;
    } catch {
      return null;
    }
  };

  const logicalPosition = (model, offset, preferEnd) => {
    for (const segment of model.nodes) {
      const matches = preferEnd
        ? offset > segment.start && offset <= segment.end
        : offset >= segment.start && offset < segment.end;
      if (matches) return { node: segment.node, offset: offset - segment.start };
    }
    if (preferEnd && offset === 0 && model.nodes[0]) return { node: model.nodes[0].node, offset: 0 };
    return null;
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

  const fuzzyCandidateStarts = (text, start, end, origin) => {
    const values = new Set([Math.max(start, Math.min(end, origin))]);
    const windowText = text.slice(start, end);
    const matcher = /\S+/gu;
    let match = matcher.exec(windowText);
    let truncated = false;
    while (match) {
      values.add(start + match.index);
      if (values.size >= resolverLimits.maxFuzzyStarts) {
        truncated = matcher.exec(windowText) !== null;
        break;
      }
      match = matcher.exec(windowText);
    }
    return { values: [...values].sort((left, right) => Math.abs(left - origin) - Math.abs(right - origin)), truncated };
  };

  const boundedLevenshtein = (left, right, maximum) => {
    if (Math.abs(left.length - right.length) > maximum) return null;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      let rowMinimum = current[0];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
        const value = Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1, substitution);
        current.push(value);
        rowMinimum = Math.min(rowMinimum, value);
      }
      if (rowMinimum > maximum) return null;
      previous = current;
    }
    const distance = previous[right.length];
    return distance <= maximum ? distance : null;
  };

  const adjacentContextScore = (expected, current, edge) => {
    if (!expected) return 1;
    const maximum = Math.max(expected.length, current.length, 1);
    let matched = 0;
    while (matched < Math.min(expected.length, current.length)) {
      const expectedIndex = edge === "tail" ? expected.length - 1 - matched : matched;
      const currentIndex = edge === "tail" ? current.length - 1 - matched : matched;
      if (expected[expectedIndex] !== current[currentIndex]) break;
      matched += 1;
    }
    return matched / maximum;
  };

  const domContextScore = (expected, role, digest) => {
    const signals = [];
    if (expected?.containerRole) signals.push(expected.containerRole === role ? 1 : 0);
    if (expected?.containerTextDigest) signals.push(expected.containerTextDigest === digest ? 1 : 0);
    return signals.length === 0 ? 1 : signals.reduce((sum, value) => sum + value, 0) / signals.length;
  };

  const hasPersistedDomContext = (context) => Boolean(context?.containerRole || context?.containerTextDigest);

  const headingContextScore = (expected, current) => {
    if (expected.length === 0) return 1;
    let matched = 0;
    while (matched < Math.min(expected.length, current.length) && expected[matched] === current[matched]) matched += 1;
    return matched / Math.max(expected.length, current.length, 1);
  };

  const positionScore = (expected, current, length) => Number.isSafeInteger(expected)
    ? 1 - Math.min(1, Math.abs(expected - current) / Math.max(length, 1))
    : 1;

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
    active = null;
    document.removeEventListener("pointerup", onCommit, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (removeCommandListener) commandTarget.removeEventListener(commandEventName, onCommand);
  };

  const createTextTarget = (selection) => {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) return null;
    const model = buildVisibleTextModel();
    const projection = projectRange(model, range);
    if (!projection || projection.start >= projection.end) return null;
    const exact = model.text.slice(projection.start, projection.end);
    if (!exact.trim() || exact.length > 8192) return null;
    if (!isCodePointBoundary(model.text, projection.start)
      || !isCodePointBoundary(model.text, projection.end)) return null;
    const startPath = domPath(projection.startNode);
    const endPath = domPath(projection.endNode);
    if (!startPath || !endPath) return null;
    const rects = selectionRects(range);
    if (rects.length === 0) return null;
    const container = semanticContainer(projection.startNode);
    const headingPath = headingContext(range);
    const context = { headingPath };
    const role = containerRole(container);
    if (role) context.containerRole = role;
    const digestSource = container ? visibleTextWithin(container).slice(0, 2048) : "";
    if (digestSource) context.containerTextDigest = digestText(digestSource);
    return {
      type: "text",
      quote: {
        exact,
        prefix: safeTail(model.text.slice(0, projection.start), 256),
        suffix: safeHead(model.text.slice(projection.end), 256),
      },
      position: {
        start: projection.start,
        end: projection.end,
        textModelVersion: 1,
      },
      domRange: {
        startPath,
        startOffset: projection.startOffset,
        endPath,
        endOffset: projection.endOffset,
      },
      context,
      rects,
      frame: frameLocator(),
    };
  };

  const buildVisibleTextModel = (scope) => {
    const root = scope ?? document.body ?? document.documentElement;
    const nodes = [];
    let text = "";
    if (!root) return { text, nodes };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isVisibleTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node = walker.nextNode();
    while (node) {
      const value = node.nodeValue ?? "";
      const start = text.length;
      text += value;
      nodes.push({ node, start, end: text.length });
      node = walker.nextNode();
    }
    return { text, nodes };
  };

  const projectRange = (model, range) => {
    let first = null;
    let last = null;
    for (const segment of model.nodes) {
      if (!safeIntersects(range, segment.node)) continue;
      const valueLength = segment.end - segment.start;
      let localStart = segment.node === range.startContainer ? range.startOffset : 0;
      let localEnd = segment.node === range.endContainer ? range.endOffset : valueLength;
      localStart = clampOffset(localStart, valueLength);
      localEnd = clampOffset(localEnd, valueLength);
      if (localStart >= localEnd) continue;
      const projected = {
        start: segment.start + localStart,
        end: segment.start + localEnd,
        node: segment.node,
        localStart,
        localEnd,
      };
      first ??= projected;
      last = projected;
    }
    if (!first || !last) return null;
    return {
      start: first.start,
      end: last.end,
      startNode: first.node,
      endNode: last.node,
      startOffset: first.localStart,
      endOffset: last.localEnd,
    };
  };

  const safeIntersects = (range, node) => {
    try {
      return range.intersectsNode(node);
    } catch {
      return false;
    }
  };

  const isVisibleTextNode = (node) => {
    if (!node.nodeValue || !node.parentElement) return false;
    let element = node.parentElement;
    while (element) {
      if (forbiddenTags.has(element.tagName)
        || element.dataset?.keydexAnnotationOverlayRoot === "true"
        || element.hasAttribute("hidden")
        || element.hasAttribute("inert")
        || element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      element = element.parentElement;
    }
    return true;
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

  const selectionRects = (range) => {
    const candidates = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
    if (candidates.length === 0 && typeof range.getBoundingClientRect === "function") {
      candidates.push(range.getBoundingClientRect());
    }
    return candidates.slice(0, 128).map(cssRect).filter(Boolean);
  };

  const cssRect = (rect) => {
    const x = Number.isFinite(rect.x) ? rect.x : rect.left;
    const y = Number.isFinite(rect.y) ? rect.y : rect.top;
    if (![x, y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
    return { x, y, width: rect.width, height: rect.height };
  };

  const headingContext = (selectionRange) => {
    const root = document.body ?? document.documentElement;
    if (!root) return [];
    const headings = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let element = walker.nextNode();
    while (element) {
      const match = /^H([1-6])$/.exec(element.tagName);
      if (match && elementIsBeforeOrContainsRange(element, selectionRange) && elementIsVisible(element)) {
        const label = visibleTextWithin(element).replace(/\s+/g, " ").trim().slice(0, 256);
        if (label) {
          const level = Number(match[1]);
          headings.splice(level - 1);
          headings[level - 1] = label;
        }
      }
      element = walker.nextNode();
    }
    return headings.filter(Boolean).slice(0, 16);
  };

  const elementIsBeforeOrContainsRange = (element, range) => {
    if (element.contains(range.startContainer)) return true;
    return Boolean(element.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING);
  };

  const elementIsVisible = (element) => {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  };

  const visibleTextWithin = (container) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isVisibleTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let text = "";
    let node = walker.nextNode();
    while (node && text.length < 4096) {
      text += node.nodeValue ?? "";
      node = walker.nextNode();
    }
    return text;
  };

  const semanticContainer = (node) => {
    let element = node.parentElement;
    while (element && element !== document.body) {
      if (element.hasAttribute("role") || semanticRoles.has(element.tagName)) return element;
      element = element.parentElement;
    }
    return node.parentElement;
  };

  const containerRole = (element) => {
    if (!element) return "";
    const explicit = element.getAttribute("role")?.trim();
    return (explicit || semanticRoles.get(element.tagName) || "").slice(0, 128);
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
      // Cross-origin frame names are optional persisted hints.
    }
    const parentElementPath = window.KeydexAnnotationFrameBridge?.parentElementPath?.();
    if (Array.isArray(parentElementPath) && parentElementPath.length > 0) {
      locator.parentElementPath = parentElementPath;
    }
    return locator;
  };

  const compactLabel = (value) => value.replace(/\s+/g, " ").trim().slice(0, 1024);
  const clampOffset = (value, length) => Math.max(0, Math.min(length, Number.isInteger(value) ? value : 0));
  const domDepth = (node) => {
    let depth = 0;
    let current = node;
    while (current?.parentNode && depth < 128) {
      depth += 1;
      current = current.parentNode;
    }
    return depth;
  };
  const digestText = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  };
  const isCodePointBoundary = (value, offset) => {
    if (offset <= 0 || offset >= value.length) return true;
    const previous = value.charCodeAt(offset - 1);
    const next = value.charCodeAt(offset);
    return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
  };
  const safeHead = (value, limit) => {
    let result = value.slice(0, limit);
    if (result.length > 0 && /[\uD800-\uDBFF]/.test(result.at(-1))) result = result.slice(0, -1);
    return result;
  };
  const safeTail = (value, limit) => {
    let result = value.slice(Math.max(0, value.length - limit));
    if (result.length > 0 && /[\uDC00-\uDFFF]/.test(result[0])) result = result.slice(1);
    return result;
  };
  const isEditableEventTarget = (target) => target instanceof Element
    && (target.matches("input, textarea, select") || target.closest("[contenteditable='true']"));

  commandTarget.addEventListener(commandEventName, onCommand);
  window.addEventListener("pagehide", () => stop(true), { once: true });
})();
