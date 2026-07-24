function () {
  "use strict";

  const selected = this instanceof Element
    ? this
    : (this && this.parentElement instanceof Element ? this.parentElement : null);
  if (!selected) return null;

  const selectedRoot = selected.getRootNode();
  const existingAnnotationMarker = selectedRoot instanceof ShadowRoot
    && selectedRoot.host?.getAttribute?.("data-keydex-annotation-overlay-root") === "true"
    ? selected.closest?.("[part='annotation-highlight'][data-annotation-id]")
    : null;
  const existingAnnotationId = existingAnnotationMarker?.getAttribute("data-annotation-id")?.trim();
  if (existingAnnotationId) {
    return {
      keydexOverlayAction: "open_existing_annotation",
      annotationId: existingAnnotationId.slice(0, 128),
    };
  }

  const stableAttributeNames = [
    "id", "name", "type", "href", "src", "alt", "title", "aria-label", "role",
  ];
  const implicitRoles = new Map([
    ["A", "link"], ["BUTTON", "button"], ["SELECT", "combobox"],
    ["TEXTAREA", "textbox"], ["IMG", "img"], ["NAV", "navigation"],
    ["MAIN", "main"], ["FORM", "form"], ["TABLE", "table"],
  ]);

  const cssRect = (rect) => {
    const x = Number.isFinite(rect.x) ? rect.x : rect.left;
    const y = Number.isFinite(rect.y) ? rect.y : rect.top;
    if (![x, y, rect.width, rect.height].every(Number.isFinite)) return null;
    return {
      x,
      y,
      width: Math.max(0, rect.width),
      height: Math.max(0, rect.height),
    };
  };

  const domPath = (node) => {
    const path = [];
    let current = node;
    while (current && current !== document) {
      const parent = current.parentNode;
      if (!parent) return null;
      if (parent instanceof ShadowRoot) {
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

  const sanitizedUrlAttribute = (value) => {
    try {
      const url = new URL(value, location.href);
      const remote = /^https?:$/.test(url.protocol);
      const localFile = url.protocol === "file:" && location.protocol === "file:";
      if (!remote && !localFile) return "";
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString().slice(0, 2048);
    } catch {
      return "";
    }
  };

  const stableAttributes = (element) => stableAttributeNames.flatMap((name) => {
    const raw = element.getAttribute(name);
    if (raw === null || raw.length === 0) return [];
    const value = name === "href" || name === "src"
      ? sanitizedUrlAttribute(raw)
      : raw.slice(0, 2048);
    return value ? [{ name, value }] : [];
  }).slice(0, 20);

  const elementIsVisible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.visibility !== "collapse";
  };

  const visibleTextNode = (node) => {
    let element = node.parentElement;
    while (element) {
      if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
        || element.dataset?.keydexAnnotationOverlayRoot === "true"
        || element.hasAttribute("hidden")
        || element.getAttribute("aria-hidden") === "true"
        || !elementIsVisible(element)) return false;
      element = element.parentElement;
    }
    return Boolean(node.nodeValue);
  };

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

  const safeElementText = (element) => element
    ? visibleText(element).replace(/\s+/g, " ").trim()
    : "";

  const explicitOrImplicitRole = (element) => {
    const explicit = element.getAttribute("role")?.trim();
    if (explicit) return explicit.slice(0, 128);
    if (element.tagName === "INPUT") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      return ["button", "submit", "reset"].includes(type)
        ? "button"
        : (["checkbox", "radio"].includes(type) ? type : "textbox");
    }
    return implicitRoles.get(element.tagName) || "";
  };

  const accessibleName = (element) => {
    const ariaLabel = element.getAttribute("aria-label")?.trim();
    if (ariaLabel) return ariaLabel.slice(0, 1024);
    const labelledBy = element.getAttribute("aria-labelledby")?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (labelledBy.length > 0) {
      const label = labelledBy.slice(0, 8)
        .map((id) => safeElementText(document.getElementById(id)))
        .filter(Boolean)
        .join(" ");
      if (label) return label.slice(0, 1024);
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      || element instanceof HTMLTextAreaElement) {
      const labels = element.labels
        ? Array.from(element.labels).map(safeElementText).filter(Boolean).join(" ")
        : "";
      if (labels) return labels.slice(0, 1024);
    }
    const alt = element.getAttribute("alt")?.trim();
    if (alt) return alt.slice(0, 1024);
    const title = element.getAttribute("title")?.trim();
    if (title) return title.slice(0, 1024);
    return safeElementText(element).slice(0, 1024);
  };

  const headingContext = (element) => {
    const headings = [];
    const walker = document.createTreeWalker(
      document.body ?? document.documentElement,
      NodeFilter.SHOW_ELEMENT,
    );
    let candidate = walker.nextNode();
    while (candidate) {
      const match = /^H([1-6])$/.exec(candidate.tagName);
      if (match && elementIsVisible(candidate)
        && (candidate.contains(element)
          || Boolean(candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))) {
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

  const safePageUrl = () => {
    try {
      if (location.href === "about:blank"
        || /^https?:$/.test(location.protocol)
        || location.protocol === "file:") {
        return location.href.slice(0, 4096);
      }
    } catch {
      // Cross-origin target metadata is optional; retain a valid safe sentinel.
    }
    return "about:blank";
  };

  const frameLocator = () => {
    const indexPath = [];
    let current = window;
    try {
      while (current !== current.top && indexPath.length < 32) {
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
      // URL plus the CDP session still identifies a cross-origin frame.
    }
    const locator = { url: safePageUrl(), indexPath };
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

  const path = domPath(selected);
  const rect = cssRect(selected.getBoundingClientRect());
  if (!path || !rect) return null;
  const target = {
    type: "element",
    tag: selected.tagName.toLowerCase().slice(0, 64),
    stableAttributes: stableAttributes(selected),
    path,
    context: { headingPath: headingContext(selected) },
    rect,
    frame: frameLocator(),
  };
  const role = explicitOrImplicitRole(selected);
  if (role) target.role = role;
  const name = accessibleName(selected);
  if (name) target.accessibleName = name;
  const summary = visibleText(selected).replace(/\s+/g, " ").trim().slice(0, 1024);
  if (summary && summary !== name) target.textSummary = summary;
  const root = selected.getRootNode();
  if (root instanceof ShadowRoot) {
    const hostPath = domPath(root.host);
    if (hostPath) target.shadowHostPath = hostPath;
  }

  return target;
}
