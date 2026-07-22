(() => {
  "use strict";

  const commandEventName = "keydex:web-annotation-command";
  const responseEventName = "keydex:web-annotation-response";
  const nativeSelectionEventName = "keydex:web-annotation-native-selection";
  const nativeCancelEventName = "keydex:web-annotation-native-cancel";
  const commandTarget = typeof __KEYDEX_BRIDGE_COMMAND_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_COMMAND_TARGET__;
  const responseTarget = typeof __KEYDEX_BRIDGE_RESPONSE_TARGET__ === "undefined"
    ? document : __KEYDEX_BRIDGE_RESPONSE_TARGET__;
  const overlayAttribute = "data-keydex-annotation-overlay-root";
  const colorTokenNames = ["accent", "surface", "text", "border", "focus", "warning", "danger"];
  const highlights = new Map();
  const defaultConfiguration = Object.freeze({
    theme: window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light",
    tokens: Object.freeze({
      accent: "Highlight",
      surface: "Canvas",
      text: "CanvasText",
      border: "GrayText",
      focus: "Highlight",
      warning: "Mark",
      danger: "CanvasText",
    }),
    radiusPx: 4,
    motionMs: 0,
    reducedMotion: true,
  });
  let configuration = defaultConfiguration;
  let overlay = null;
  let selectionId = null;
  let editorDraft = null;
  let updateFrame = null;
  let lastGeometryRequestId = null;
  let disposed = false;
  const traceConsole = typeof console?.info === "function" ? console.info.bind(console) : null;
  const trace = (stage, detail = {}) => {
    try {
      traceConsole?.("[Keydex Browser Annotation]", stage, detail);
      if (typeof __KEYDEX_BRIDGE_DIAGNOSTICS_POST__ === "function") {
        __KEYDEX_BRIDGE_DIAGNOSTICS_POST__(stage, detail);
      }
    } catch {
      // Diagnostics must never affect page interaction.
    }
  };

  const stylesheet = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: block;
      overflow: hidden;
      pointer-events: none;
      contain: strict;
      color-scheme: light dark;
      font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    .layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
    .rect {
      position: absolute;
      min-width: 1px;
      min-height: 1px;
      border: 2px solid var(--keydex-overlay-accent);
      border-radius: var(--keydex-overlay-radius);
      background: color-mix(in srgb, var(--keydex-overlay-accent) 12%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--keydex-overlay-surface) 78%, transparent) inset;
      transition:
        transform var(--keydex-overlay-motion) cubic-bezier(0.16, 1, 0.3, 1),
        opacity var(--keydex-overlay-motion) cubic-bezier(0.16, 1, 0.3, 1);
    }
    .rect[data-kind="candidate"] {
      border-color: var(--keydex-overlay-focus);
      background: color-mix(in srgb, var(--keydex-overlay-focus) 14%, transparent);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--keydex-overlay-surface) 82%, transparent) inset,
        0 0 0 3px color-mix(in srgb, var(--keydex-overlay-focus) 20%, transparent);
    }
    .inspector-label {
      position: absolute;
      z-index: 2;
      max-width: min(360px, calc(100vw - 16px));
      min-height: 22px;
      overflow: hidden;
      border-radius: max(3px, calc(var(--keydex-overlay-radius) - 1px));
      padding: 3px 7px;
      background: var(--keydex-overlay-focus);
      color: var(--keydex-overlay-surface);
      box-shadow: 0 3px 10px color-mix(in srgb, var(--keydex-overlay-text) 18%, transparent);
      font: 600 11px/16px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rect[data-state="changed"], .rect[data-state="ambiguous"] {
      border-color: var(--keydex-overlay-warning);
      background: color-mix(in srgb, var(--keydex-overlay-warning) 12%, transparent);
    }
    .rect[data-state="orphaned"] {
      border-color: var(--keydex-overlay-danger);
      border-style: dashed;
      background: color-mix(in srgb, var(--keydex-overlay-danger) 9%, transparent);
    }
    .rect[data-flash="true"] { animation: keydex-overlay-flash 720ms ease-out 1; }
    .status {
      position: absolute;
      top: 12px;
      left: 50%;
      max-width: min(440px, calc(100vw - 32px));
      translate: -50% 0;
      padding: 6px 10px;
      border: 1px solid var(--keydex-overlay-border);
      border-radius: var(--keydex-overlay-radius);
      background: color-mix(in srgb, var(--keydex-overlay-surface) 94%, transparent);
      color: var(--keydex-overlay-text);
      box-shadow: 0 6px 20px color-mix(in srgb, var(--keydex-overlay-text) 12%, transparent);
      font: 12px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      text-align: center;
      opacity: 0;
      transform: translateY(-4px);
      transition:
        transform var(--keydex-overlay-motion) cubic-bezier(0.16, 1, 0.3, 1),
        opacity var(--keydex-overlay-motion) cubic-bezier(0.16, 1, 0.3, 1);
    }
    .status[data-visible="true"] { opacity: 1; transform: translateY(0); }
    .annotation-editor {
      position: absolute;
      display: flex;
      width: min(340px, calc(100vw - 24px));
      min-height: 44px;
      align-items: center;
      gap: 4px;
      pointer-events: auto;
      border: 1px solid color-mix(in srgb, var(--keydex-overlay-border) 82%, transparent);
      border-radius: 22px;
      padding: 5px 5px 5px 11px;
      background: color-mix(in srgb, var(--keydex-overlay-surface) 96%, white);
      color: var(--keydex-overlay-text);
      box-shadow:
        0 10px 24px color-mix(in srgb, var(--keydex-overlay-text) 10%, transparent),
        0 2px 7px color-mix(in srgb, var(--keydex-overlay-text) 7%, transparent);
      font: 12px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      backdrop-filter: blur(12px);
    }
    .annotation-editor:focus-within {
      border-color: color-mix(in srgb, var(--keydex-overlay-border) 78%, var(--keydex-overlay-focus));
      box-shadow:
        0 10px 24px color-mix(in srgb, var(--keydex-overlay-text) 10%, transparent),
        0 2px 7px color-mix(in srgb, var(--keydex-overlay-text) 7%, transparent),
        0 0 0 2px color-mix(in srgb, var(--keydex-overlay-focus) 16%, transparent);
    }
    .annotation-editor::before {
      content: "";
      position: absolute;
      left: var(--keydex-editor-arrow-left, 24px);
      width: 11px;
      height: 11px;
      border: solid color-mix(in srgb, var(--keydex-overlay-border) 82%, transparent);
      background: color-mix(in srgb, var(--keydex-overlay-surface) 96%, white);
      rotate: 45deg;
    }
    .annotation-editor[data-side="below"]::before {
      top: -6px;
      border-width: 1px 0 0 1px;
    }
    .annotation-editor[data-side="above"]::before {
      bottom: -6px;
      border-width: 0 1px 1px 0;
    }
    .editor-close,
    .editor-action {
      appearance: none;
      border: 0;
      border-radius: max(var(--keydex-overlay-radius), 6px);
      font: inherit;
      cursor: pointer;
    }
    .editor-close {
      display: inline-grid;
      width: 24px;
      height: 24px;
      flex: 0 0 auto;
      place-items: center;
      padding: 0;
      background: transparent;
      color: color-mix(in srgb, var(--keydex-overlay-text) 68%, transparent);
      font-size: 18px;
      line-height: 1;
    }
    .editor-close:hover,
    .editor-close:focus-visible { background: color-mix(in srgb, var(--keydex-overlay-text) 8%, transparent); }
    .editor-input {
      display: block;
      min-width: 0;
      min-height: 32px;
      max-height: min(96px, 24vh);
      flex: 1 1 auto;
      resize: none;
      overflow-x: hidden;
      overflow-y: auto;
      border: 0;
      border-radius: 0;
      outline: 0;
      padding: 7px 4px;
      background: transparent;
      color: var(--keydex-overlay-text);
      caret-color: var(--keydex-overlay-accent);
      font: inherit;
      line-height: 1.5;
    }
    .editor-input::placeholder { color: color-mix(in srgb, var(--keydex-overlay-text) 46%, transparent); }
    .editor-input:focus {
      box-shadow: none;
    }
    .editor-error {
      position: absolute;
      top: calc(100% + 7px);
      left: 14px;
      max-width: calc(100% - 28px);
      margin: 0;
      padding: 3px 7px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--keydex-overlay-surface) 96%, transparent);
      color: var(--keydex-overlay-danger);
      font-size: 11px;
      box-shadow: 0 3px 10px color-mix(in srgb, var(--keydex-overlay-text) 10%, transparent);
    }
    .editor-error:empty { display: none; }
    .editor-action { min-width: 52px; height: 30px; flex: 0 0 auto; padding: 0 11px; }
    .editor-action[data-kind="cancel"] {
      background: transparent;
      color: color-mix(in srgb, var(--keydex-overlay-text) 68%, transparent);
    }
    .editor-action[data-kind="cancel"]:hover,
    .editor-action[data-kind="cancel"]:focus-visible {
      background: color-mix(in srgb, var(--keydex-overlay-text) 7%, transparent);
      color: var(--keydex-overlay-text);
    }
    .editor-action[data-kind="save"] {
      border-radius: 15px;
      background: color-mix(in srgb, var(--keydex-overlay-text) 8%, transparent);
      color: var(--keydex-overlay-text);
    }
    .editor-action[data-kind="save"]:hover,
    .editor-action[data-kind="save"]:focus-visible {
      background: color-mix(in srgb, var(--keydex-overlay-text) 13%, transparent);
    }
    .capture {
      position: absolute;
      inset: 0;
      pointer-events: auto;
      cursor: crosshair;
      user-select: none;
      touch-action: none;
      background: transparent;
    }
    .capture-outline {
      display: none;
      position: absolute;
      min-width: 1px;
      min-height: 1px;
      pointer-events: none;
      border: 2px solid var(--keydex-overlay-accent);
      border-radius: var(--keydex-overlay-radius);
      background: color-mix(in srgb, var(--keydex-overlay-accent) 12%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--keydex-overlay-surface) 78%, transparent) inset;
    }
    @keyframes keydex-overlay-flash {
      0% { opacity: 1; box-shadow: 0 0 0 1px var(--keydex-overlay-accent), 0 0 0 8px color-mix(in srgb, var(--keydex-overlay-accent) 26%, transparent); }
      100% { opacity: 1; box-shadow: 0 0 0 1px color-mix(in srgb, var(--keydex-overlay-surface) 78%, transparent) inset; }
    }
    :host([data-reduced-motion="true"]) *,
    :host([data-reduced-motion="true"]) *::before,
    :host([data-reduced-motion="true"]) *::after {
      animation: none !important;
      scroll-behavior: auto !important;
      transition-duration: 0ms !important;
    }
  `;

  const ensureOverlay = () => {
    if (overlay?.root?.isConnected) return overlay;
    const root = document.createElement("div");
    root.setAttribute(overlayAttribute, "true");
    root.setAttribute("data-keydex-overlay-theme", configuration.theme);
    root.setAttribute("data-reduced-motion", String(configuration.reducedMotion));
    for (const [property, value] of [
      ["all", "initial"], ["position", "fixed"], ["inset", "0"],
      ["z-index", "2147483647"], ["display", "block"], ["overflow", "hidden"],
      ["pointer-events", "none"], ["contain", "strict"],
    ]) root.style.setProperty(property, value, "important");
    const shadow = root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = stylesheet;
    const highlightLayer = layer("highlights");
    const selectionLayer = layer("selection");
    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("part", "status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    shadow.append(style, highlightLayer, selectionLayer, status);
    (document.documentElement ?? document.body).append(root);
    overlay = { root, shadow, highlightLayer, selectionLayer, status, captureLayer: null, editor: null };
    applyConfiguration();
    updateCounters();
    return overlay;
  };

  const layer = (name) => {
    const value = document.createElement("div");
    value.className = "layer";
    value.setAttribute("part", `${name}-layer`);
    return value;
  };

  const applyConfiguration = () => {
    if (!overlay) return;
    overlay.root.setAttribute("data-keydex-overlay-theme", configuration.theme);
    overlay.root.setAttribute("data-reduced-motion", String(configuration.reducedMotion));
    for (const name of colorTokenNames) {
      overlay.root.style.setProperty(`--keydex-overlay-${name}`, configuration.tokens[name]);
    }
    overlay.root.style.setProperty("--keydex-overlay-radius", `${configuration.radiusPx}px`);
    overlay.root.style.setProperty("--keydex-overlay-motion", `${configuration.motionMs}ms`);
  };

  const onCommand = (event) => {
    const envelope = event.detail;
    if (!envelope || typeof envelope !== "object") return;
    if (envelope.kind === "overlay.configure") {
      const next = parseConfiguration(envelope.payload);
      if (!next) return;
      configuration = next;
      applyConfiguration();
      return;
    }
    if (envelope.kind === "selection.start") {
      closeEditor();
      selectionId = envelope.payload?.selectionId ?? null;
      const current = ensureOverlay();
      clearLayer(current.selectionLayer);
      showStatus(selectionInstruction(envelope.payload?.mode));
      updateCounters();
      return;
    }
    if (envelope.kind === "selection.cancel") {
      clearSelection();
      return;
    }
    if (envelope.kind === "highlight.render") {
      highlights.set(envelope.payload.annotationId, {
        requestId: envelope.requestId,
        target: envelope.payload.target,
        state: envelope.payload.state,
        rects: [],
        flash: false,
      });
      lastGeometryRequestId = envelope.requestId;
      renderHighlights(false);
      return;
    }
    if (envelope.kind === "highlight.clear") {
      for (const annotationId of envelope.payload.annotationIds) highlights.delete(annotationId);
      renderHighlights(false);
      return;
    }
    if (envelope.kind === "navigate.toTarget") navigateToTarget(envelope);
  };

  const onResponse = (event) => {
    const detail = event.detail;
    if (!detail || typeof detail !== "object") return;
    if (detail.kind === "selection.candidate" && detail.payload?.selectionId === selectionId) {
      const current = ensureOverlay();
      clearLayer(current.selectionLayer);
      renderRects(current.selectionLayer, [detail.payload.rect], {
        kind: "candidate",
        state: "resolved",
        annotationId: detail.payload.candidateId,
      });
      renderInspectorLabel(current.selectionLayer, detail.payload);
      showStatus("点击元素添加批注 · Tab 切换层级 · Esc 退出");
      updateCounters();
    } else if (detail.kind === "selection.candidate.cleared" && detail.payload?.selectionId === selectionId) {
      const current = ensureOverlay();
      clearLayer(current.selectionLayer);
      showStatus("移动到元素并点击添加批注 · Tab 切换层级 · Esc 退出");
      updateCounters();
    } else if (detail.kind === "selection.result") {
      if (detail.payload?.selectionId === selectionId) {
        openEditor(detail.requestId, detail.payload.selectionId, detail.payload.target);
      }
    } else if (detail.kind === "selection.cancelled") {
      if (detail.payload?.selectionId === selectionId) clearSelection();
    }
  };

  const openNativeEditor = (detail) => {
    if (!detail || typeof detail !== "object"
      || typeof detail.requestId !== "string"
      || typeof detail.selectionId !== "string"
      || detail.requestId !== detail.selectionId
      || !detail.target || detail.target.type !== "element") return false;
    selectionId = detail.selectionId;
    openEditor(detail.requestId, detail.selectionId, detail.target);
    return Boolean(editorDraft?.editor?.isConnected);
  };

  const cancelNativeEditor = (currentSelectionId) => {
    if (typeof currentSelectionId !== "string" || currentSelectionId !== selectionId) return false;
    clearSelection();
    return true;
  };

  const onNativeSelection = (event) => {
    openNativeEditor(event.detail);
  };

  const onNativeCancel = (event) => {
    const detail = event.detail;
    if (!detail) return;
    cancelNativeEditor(detail.selectionId);
  };

  const parseConfiguration = (value) => {
    if (!value || typeof value !== "object" || !value.tokens || typeof value.tokens !== "object") return null;
    if (value.theme !== "light" && value.theme !== "dark") return null;
    const tokens = {};
    for (const name of colorTokenNames) {
      const color = value.tokens[name];
      if (!safeColor(color)) return null;
      tokens[name] = color;
    }
    if (!boundedNumber(value.radiusPx, 0, 32) || !boundedNumber(value.motionMs, 0, 2000)
      || typeof value.reducedMotion !== "boolean") return null;
    return Object.freeze({
      theme: value.theme,
      tokens: Object.freeze(tokens),
      radiusPx: value.radiusPx,
      motionMs: value.reducedMotion ? 0 : value.motionMs,
      reducedMotion: value.reducedMotion,
    });
  };

  const safeColor = (value) => typeof value === "string" && value.length > 0 && value.length <= 128
    && !/[;{}'"\\]/.test(value) && !/url\s*\(/i.test(value)
    && (typeof CSS === "undefined" || typeof CSS.supports !== "function" || CSS.supports("color", value));
  const boundedNumber = (value, minimum, maximum) => Number.isFinite(value)
    && value >= minimum && value <= maximum;
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const utf8Size = (value) => {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(value).byteLength;
    try {
      return unescape(encodeURIComponent(value)).length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const beginRegion = () => {
    const current = ensureOverlay();
    current.captureLayer?.remove();
    const captureLayer = document.createElement("div");
    captureLayer.className = "capture";
    captureLayer.setAttribute("part", "capture-layer");
    captureLayer.setAttribute("aria-label", "拖拽选择网页区域，按 Escape 取消");
    const outline = document.createElement("div");
    outline.className = "capture-outline";
    outline.setAttribute("part", "capture-outline");
    captureLayer.append(outline);
    current.shadow.append(captureLayer);
    current.captureLayer = captureLayer;
    current.root.setAttribute("data-capturing", "true");
    showStatus("拖拽选择区域 · Esc 取消");
    return Object.freeze({
      root: current.root,
      layer: captureLayer,
      outline,
      destroy() {
        if (current.captureLayer !== captureLayer) return;
        captureLayer.remove();
        current.captureLayer = null;
        current.root.removeAttribute("data-capturing");
        removeIfEmpty();
      },
    });
  };

  const openEditor = (requestId, currentSelectionId, target) => {
    const rect = targetRects(target)[0];
    trace("overlay.editor.open.requested", {
      requestId,
      selectionId: currentSelectionId,
      targetKind: target?.kind ?? "unknown",
      validRect: validRect(rect),
    });
    if (!validRect(rect)) {
      trace("overlay.editor.open.rejected", {
        requestId,
        selectionId: currentSelectionId,
        reason: "invalid_rect",
      });
      clearSelection();
      respond("annotation.cancelled", requestId, { selectionId: currentSelectionId });
      return;
    }
    const current = ensureOverlay();
    closeEditor();
    current.root.setAttribute("data-editor-open", "true");
    current.root.style.setProperty("pointer-events", "auto", "important");
    clearLayer(current.selectionLayer);
    renderRects(current.selectionLayer, [rect], {
      kind: "candidate",
      state: "resolved",
      annotationId: currentSelectionId,
    });
    hideStatus();

    const editor = document.createElement("div");
    editor.className = "annotation-editor";
    editor.setAttribute("part", "annotation-editor");
    editor.setAttribute("role", "dialog");
    editor.setAttribute("aria-label", "添加网页批注");

    const cancel = document.createElement("button");
    cancel.className = "editor-action";
    cancel.type = "button";
    cancel.dataset.kind = "cancel";
    cancel.setAttribute("aria-label", "取消批注");
    cancel.textContent = "取消";

    const input = document.createElement("textarea");
    input.className = "editor-input";
    input.name = "annotation";
    input.maxLength = 32 * 1024;
    input.placeholder = "添加批注";
    input.setAttribute("aria-label", "批注内容");

    const error = document.createElement("p");
    error.className = "editor-error";
    error.setAttribute("role", "alert");

    const save = document.createElement("button");
    save.className = "editor-action";
    save.type = "button";
    save.dataset.kind = "save";
    save.textContent = "保存";
    editor.append(input, cancel, save, error);

    const stopPageInteraction = (event) => event.stopPropagation();
    editor.addEventListener("pointerdown", (event) => {
      trace("overlay.editor.pointerdown", {
        requestId,
        selectionId: currentSelectionId,
        action: event.target?.dataset?.kind ?? event.target?.tagName?.toLowerCase() ?? "unknown",
      });
      stopPageInteraction(event);
    });
    editor.addEventListener("click", (event) => {
      trace("overlay.editor.click", {
        requestId,
        selectionId: currentSelectionId,
        action: event.target?.dataset?.kind ?? event.target?.tagName?.toLowerCase() ?? "unknown",
      });
      stopPageInteraction(event);
    });
    const cancelDraft = () => finishEditor("annotation.cancelled", requestId, currentSelectionId);
    const submitDraft = () => {
      const bodyMarkdown = input.value.trim();
      trace("overlay.editor.save.invoked", {
        requestId,
        selectionId: currentSelectionId,
        bodyLength: bodyMarkdown.length,
        bodyBytes: utf8Size(bodyMarkdown),
      });
      if (!bodyMarkdown) {
        trace("overlay.editor.save.rejected", { requestId, selectionId: currentSelectionId, reason: "empty" });
        error.textContent = "请输入批注内容";
        input.focus({ preventScroll: true });
        return;
      }
      if (utf8Size(bodyMarkdown) > 32 * 1024) {
        trace("overlay.editor.save.rejected", { requestId, selectionId: currentSelectionId, reason: "too_large" });
        error.textContent = "批注内容不能超过 32 KiB";
        input.focus({ preventScroll: true });
        return;
      }
      finishEditor("annotation.submit", requestId, currentSelectionId, { bodyMarkdown });
    };
    cancel.addEventListener("click", cancelDraft);
    save.addEventListener("click", submitDraft);
    editor.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDraft();
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submitDraft();
      }
    });
    input.addEventListener("input", () => {
      if (error.textContent) error.textContent = "";
      input.style.height = "0px";
      input.style.height = `${Math.min(96, Math.max(32, input.scrollHeight))}px`;
      positionEditor();
    });

    current.shadow.append(editor);
    current.editor = editor;
    editorDraft = { requestId, selectionId: currentSelectionId, target, editor };
    trace("overlay.editor.opened", {
      requestId,
      selectionId: currentSelectionId,
      hostPointerEvents: current.root.style.getPropertyValue("pointer-events"),
      editorConnected: editor.isConnected,
    });
    positionEditor();
    requestAnimationFrame(positionEditor);
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
    updateCounters();
  };

  const finishEditor = (kind, requestId, currentSelectionId, payload = {}) => {
    const draftMatches = Boolean(editorDraft)
      && editorDraft.requestId === requestId
      && editorDraft.selectionId === currentSelectionId;
    trace("overlay.editor.finish.requested", {
      kind,
      requestId,
      selectionId: currentSelectionId,
      draftMatches,
      bodyLength: typeof payload.bodyMarkdown === "string" ? payload.bodyMarkdown.length : undefined,
    });
    if (!draftMatches) return;
    clearSelection();
    respond(kind, requestId, { selectionId: currentSelectionId, ...payload });
  };

  const closeEditor = () => {
    editorDraft = null;
    if (overlay) {
      overlay.root.removeAttribute("data-editor-open");
      overlay.root.style.setProperty("pointer-events", "none", "important");
    }
    if (!overlay?.editor) return;
    overlay.editor.remove();
    overlay.editor = null;
  };

  const positionEditor = () => {
    if (!editorDraft?.editor?.isConnected) return;
    const rect = targetRects(editorDraft.target)[0];
    if (!validRect(rect)) return;
    const editor = editorDraft.editor;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
    const margin = 12;
    const gap = 9;
    const width = Math.min(340, Math.max(220, viewportWidth - margin * 2));
    const measuredHeight = editor.getBoundingClientRect().height || 44;
    const left = clamp(rect.x, margin, Math.max(margin, viewportWidth - width - margin));
    const below = rect.y + rect.height + gap;
    const fitsBelow = below + measuredHeight <= viewportHeight - margin;
    const top = fitsBelow
      ? below
      : Math.max(margin, rect.y - gap - measuredHeight);
    editor.dataset.side = fitsBelow ? "below" : "above";
    editor.style.left = `${Math.round(left)}px`;
    editor.style.top = `${Math.round(top)}px`;
    editor.style.width = `${Math.round(width)}px`;
    const arrowLeft = clamp(rect.x + rect.width / 2 - left - 5, 16, width - 26);
    editor.style.setProperty("--keydex-editor-arrow-left", `${Math.round(arrowLeft)}px`);
  };

  const refreshEditor = () => {
    if (!editorDraft || !overlay) return;
    const rect = targetRects(editorDraft.target)[0];
    if (!validRect(rect)) return;
    clearLayer(overlay.selectionLayer);
    renderRects(overlay.selectionLayer, [rect], {
      kind: "candidate",
      state: "resolved",
      annotationId: editorDraft.selectionId,
    });
    positionEditor();
    updateCounters();
  };

  const clearSelection = () => {
    selectionId = null;
    if (!overlay) return;
    closeEditor();
    clearLayer(overlay.selectionLayer);
    hideStatus();
    updateCounters();
    removeIfEmpty();
  };

  const showStatus = (message) => {
    const current = ensureOverlay();
    current.status.textContent = String(message ?? "").slice(0, 1024);
    current.status.setAttribute("data-visible", current.status.textContent ? "true" : "false");
  };

  const hideStatus = () => {
    if (!overlay) return;
    overlay.status.textContent = "";
    overlay.status.removeAttribute("data-visible");
  };

  const selectionInstruction = (mode) => mode === "element"
    ? "移动到元素并点击添加批注 · Tab 切换层级 · Esc 退出"
    : mode === "region"
      ? "拖拽选择区域 · Esc 取消"
      : "选择网页文字 · Esc 取消";

  const renderHighlights = (geometryEvent) => {
    if (highlights.size === 0) {
      if (overlay) clearLayer(overlay.highlightLayer);
      updateCounters();
      removeIfEmpty();
      return;
    }
    const current = ensureOverlay();
    clearLayer(current.highlightLayer);
    const changed = [];
    for (const [annotationId, entry] of highlights) {
      const rects = targetRects(entry.target);
      if (!sameRects(rects, entry.rects)) changed.push(annotationId);
      entry.rects = rects;
      renderRects(current.highlightLayer, rects, {
        kind: "highlight",
        state: entry.state,
        annotationId,
        flash: entry.flash,
      });
      entry.flash = false;
    }
    updateCounters();
    if (geometryEvent && changed.length > 0 && lastGeometryRequestId) {
      respond("geometry.changed", lastGeometryRequestId, { annotationIds: changed.slice(0, 50) });
    }
  };

  const renderRects = (targetLayer, rects, metadata) => {
    for (const rect of rects.slice(0, 128)) {
      if (!validRect(rect)) continue;
      const marker = document.createElement("div");
      marker.className = "rect";
      marker.setAttribute("part", metadata.kind === "candidate" ? "selection-candidate" : "annotation-highlight");
      marker.setAttribute("data-kind", metadata.kind);
      marker.setAttribute("data-state", metadata.state);
      marker.setAttribute("data-annotation-id", metadata.annotationId);
      if (metadata.flash) marker.setAttribute("data-flash", "true");
      marker.style.left = `${rect.x}px`;
      marker.style.top = `${rect.y}px`;
      marker.style.width = `${rect.width}px`;
      marker.style.height = `${rect.height}px`;
      targetLayer.append(marker);
    }
  };

  const renderInspectorLabel = (targetLayer, candidate) => {
    if (!candidate || typeof candidate.label !== "string" || !validRect(candidate.rect)) return;
    const rect = candidate.rect;
    const label = document.createElement("div");
    label.className = "inspector-label";
    label.setAttribute("part", "selection-candidate-label");
    label.textContent = `${candidate.label}  ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    label.style.left = `${clamp(rect.x, 8, Math.max(8, window.innerWidth - 180))}px`;
    label.style.top = `${rect.y >= 28
      ? rect.y - 26
      : clamp(rect.y + rect.height + 4, 4, Math.max(4, window.innerHeight - 26))}px`;
    targetLayer.append(label);
  };

  const targetRects = (target) => {
    if (!target || typeof target !== "object") return [];
    if (target.type === "text") {
      const range = rangeFromTarget(target);
      if (range) {
        const rects = Array.from(range.getClientRects?.() ?? []).map(toRect).filter(Boolean);
        if (rects.length > 0) return rects;
      }
      return Array.isArray(target.rects) ? target.rects.filter(validRect) : [];
    }
    if (target.type === "element") {
      const element = resolvePath(target.path);
      const rect = element instanceof Element ? toRect(element.getBoundingClientRect()) : null;
      return rect ? [rect] : validRect(target.rect) ? [target.rect] : [];
    }
    if (target.type === "region") {
      if (target.relativeElement) {
        const element = resolvePath(target.relativeElement.path);
        const anchor = element instanceof Element ? toRect(element.getBoundingClientRect()) : null;
        if (anchor) return [{
          x: anchor.x + target.rect.x - target.relativeElement.rect.x,
          y: anchor.y + target.rect.y - target.relativeElement.rect.y,
          width: target.rect.width,
          height: target.rect.height,
        }];
      }
      return [{
        x: target.rect.x + (target.scroll?.x ?? 0) - (window.scrollX || 0),
        y: target.rect.y + (target.scroll?.y ?? 0) - (window.scrollY || 0),
        width: target.rect.width,
        height: target.rect.height,
      }].filter(validRect);
    }
    return [];
  };

  const rangeFromTarget = (target) => {
    if (!target.domRange) return null;
    const start = resolvePath(target.domRange.startPath);
    const end = resolvePath(target.domRange.endPath);
    if (!(start instanceof Node) || !(end instanceof Node)) return null;
    try {
      const range = document.createRange();
      range.setStart(start, target.domRange.startOffset);
      range.setEnd(end, target.domRange.endOffset);
      return range;
    } catch {
      return null;
    }
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

  const navigateToTarget = (envelope) => {
    const target = envelope.payload?.target;
    const node = target?.type === "text"
      ? resolvePath(target.domRange?.startPath)
      : target?.type === "element"
        ? resolvePath(target.path)
        : target?.relativeElement
          ? resolvePath(target.relativeElement.path)
          : null;
    const element = node instanceof Element
      ? node
      : node instanceof Node && node.parentElement instanceof Element
        ? node.parentElement
        : null;
    if (element) {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: configuration.reducedMotion ? "auto" : "smooth" });
    } else if (target?.type === "region") {
      window.scrollTo({
        left: target.scroll?.x ?? window.scrollX,
        top: target.scroll?.y ?? window.scrollY,
        behavior: configuration.reducedMotion ? "auto" : "smooth",
      });
    }
    const existing = highlights.get(envelope.payload.annotationId);
    if (existing) {
      existing.flash = true;
      lastGeometryRequestId = envelope.requestId;
      scheduleGeometryUpdate(false);
    }
  };

  const scheduleGeometryUpdate = (emitEvent = true) => {
    if (updateFrame !== null || disposed) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = null;
      renderHighlights(emitEvent);
      refreshEditor();
    });
  };

  const updateCounters = () => {
    if (!overlay) return;
    overlay.root.setAttribute("data-highlight-count", String(overlay.highlightLayer.childElementCount));
    overlay.root.setAttribute(
      "data-selection-count",
      String(overlay.selectionLayer.querySelectorAll("[part='selection-candidate']").length),
    );
  };

  const removeIfEmpty = () => {
    if (!overlay || overlay.captureLayer || selectionId || highlights.size > 0) return;
    overlay.root.remove();
    overlay = null;
  };

  const clearLayer = (value) => value.replaceChildren();
  const validRect = (value) => value && [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && value.width > 0 && value.height > 0;
  const toRect = (value) => {
    const x = Number.isFinite(value?.x) ? value.x : value?.left;
    const y = Number.isFinite(value?.y) ? value.y : value?.top;
    const rect = { x, y, width: value?.width, height: value?.height };
    return validRect(rect) ? rect : null;
  };
  const sameRects = (left, right) => left.length === right.length && left.every((rect, index) => {
    const other = right[index];
    return other && Math.abs(rect.x - other.x) < 0.25 && Math.abs(rect.y - other.y) < 0.25
      && Math.abs(rect.width - other.width) < 0.25 && Math.abs(rect.height - other.height) < 0.25;
  });
  const respond = (kind, requestId, payload) => {
    trace("overlay.response.dispatch", {
      kind,
      requestId,
      selectionId: payload?.selectionId,
      bodyLength: typeof payload?.bodyMarkdown === "string" ? payload.bodyMarkdown.length : undefined,
    });
    const dispatched = responseTarget.dispatchEvent(new CustomEvent(responseEventName, {
      detail: { kind, requestId, payload },
    }));
    trace("overlay.response.dispatched", { kind, requestId, dispatched });
    return dispatched;
  };

  const teardown = () => {
    if (disposed) return;
    disposed = true;
    if (updateFrame !== null) cancelAnimationFrame(updateFrame);
    updateFrame = null;
    commandTarget.removeEventListener(commandEventName, onCommand);
    responseTarget.removeEventListener(responseEventName, onResponse);
    window.removeEventListener(nativeSelectionEventName, onNativeSelection, true);
    window.removeEventListener(nativeCancelEventName, onNativeCancel, true);
    window.removeEventListener("scroll", scheduleGeometryUpdate, true);
    window.removeEventListener("resize", scheduleGeometryUpdate);
    overlay?.root.remove();
    overlay = null;
    editorDraft = null;
    highlights.clear();
    try {
      delete window.KeydexAnnotationOverlay;
    } catch {
      // The page lifecycle still removes the DOM root even if metadata was frozen by hostile code.
    }
  };

  commandTarget.addEventListener(commandEventName, onCommand);
  responseTarget.addEventListener(responseEventName, onResponse);
  window.addEventListener(nativeSelectionEventName, onNativeSelection, true);
  window.addEventListener(nativeCancelEventName, onNativeCancel, true);
  window.addEventListener("scroll", scheduleGeometryUpdate, true);
  window.addEventListener("resize", scheduleGeometryUpdate);
  window.addEventListener("pagehide", teardown, { once: true });
  Object.defineProperty(window, "KeydexAnnotationOverlay", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({ beginRegion, openNativeEditor, cancelNativeEditor }),
  });
})();
