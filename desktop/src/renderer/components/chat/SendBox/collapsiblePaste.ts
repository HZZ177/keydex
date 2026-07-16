export const COLLAPSIBLE_PASTE_MIN_CHARACTERS = 200;
export const COLLAPSIBLE_PASTE_EDGE_CHARACTERS = 10;

export const PASTED_TEXT_FRAGMENT_SELECTOR = '[data-sendbox-pasted-text="true"]';
export const PASTED_TEXT_RAW_SELECTOR = '[data-paste-raw="true"]';
export const PASTED_TEXT_SUMMARY_SELECTOR = '[data-paste-summary="true"]';
export const PASTED_TEXT_TOGGLE_SELECTOR = '[data-paste-toggle="true"]';
export const PASTED_TEXT_BOUNDARY_SELECTOR = '[data-paste-boundary]';
export const PASTED_TEXT_CARET_HOST_SELECTOR = '[data-paste-caret-host]';

const PASTED_TEXT_CARET_PLACEHOLDER = "\u200B";

export interface PastedTextFragment {
  id: string;
  start: number;
  end: number;
  collapsed: boolean;
}

export interface PastedTextDocument {
  value: string;
  fragments: PastedTextFragment[];
}

let pastedTextFragmentSequence = 0;

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

export function shouldCollapsePastedText(text: string): boolean {
  return pastedTextCharacters(text).length >= COLLAPSIBLE_PASTE_MIN_CHARACTERS;
}

export function createPastedTextFragmentId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `paste-${globalThis.crypto.randomUUID()}`;
  }
  pastedTextFragmentSequence += 1;
  return `paste-${Date.now().toString(36)}-${pastedTextFragmentSequence.toString(36)}`;
}

export function normalizePastedTextFragments(text: string, value: unknown): PastedTextFragment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const candidates = value
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const raw = item as Partial<PastedTextFragment>;
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      const start = typeof raw.start === "number" ? raw.start : Number.NaN;
      const end = typeof raw.end === "number" ? raw.end : Number.NaN;
      if (
        !id ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > text.length
      ) {
        return [];
      }
      return [{ id, start, end, collapsed: raw.collapsed !== false }];
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const normalized: PastedTextFragment[] = [];
  let previousEnd = -1;
  for (const fragment of candidates) {
    if (fragment.start < previousEnd) {
      continue;
    }
    normalized.push(fragment);
    previousEnd = fragment.end;
  }
  return normalized;
}

export function rebasePastedTextFragments(
  previousValue: string,
  nextValue: string,
  fragments: readonly PastedTextFragment[],
): PastedTextFragment[] {
  const normalized = normalizePastedTextFragments(previousValue, fragments);
  if (previousValue === nextValue) {
    return normalizePastedTextFragments(nextValue, normalized);
  }

  let prefixLength = 0;
  const prefixLimit = Math.min(previousValue.length, nextValue.length);
  while (prefixLength < prefixLimit && previousValue[prefixLength] === nextValue[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  const suffixLimit = Math.min(previousValue.length - prefixLength, nextValue.length - prefixLength);
  while (
    suffixLength < suffixLimit &&
    previousValue[previousValue.length - suffixLength - 1] === nextValue[nextValue.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const previousChangeEnd = previousValue.length - suffixLength;
  const nextChangeEnd = nextValue.length - suffixLength;
  const delta = nextChangeEnd - previousChangeEnd;
  const rebased = normalized.flatMap((fragment) => {
    let start = fragment.start;
    let end = fragment.end;
    if (fragment.end <= prefixLength) {
      // The edit is after this fragment.
    } else if (fragment.start >= previousChangeEnd) {
      start += delta;
      end += delta;
    } else {
      return [];
    }
    const rawText = previousValue.slice(fragment.start, fragment.end);
    if (nextValue.slice(start, end) !== rawText) {
      return [];
    }
    return [{ ...fragment, start, end }];
  });
  return normalizePastedTextFragments(nextValue, rebased);
}

export function samePastedTextFragments(
  left: readonly PastedTextFragment[],
  right: readonly PastedTextFragment[],
): boolean {
  return left.length === right.length && left.every((fragment, index) => {
    const candidate = right[index];
    return Boolean(
      candidate &&
        fragment.id === candidate.id &&
        fragment.start === candidate.start &&
        fragment.end === candidate.end &&
        fragment.collapsed === candidate.collapsed,
    );
  });
}

export function createPastedTextFragmentElement(
  rawText: string,
  fragment: Pick<PastedTextFragment, "id" | "collapsed">,
): HTMLSpanElement {
  const wrapper = document.createElement("span");
  wrapper.dataset.sendboxPastedText = "true";
  wrapper.dataset.fragmentId = fragment.id;

  const leadingBoundary = document.createElement("span");
  leadingBoundary.setAttribute("contenteditable", "false");
  leadingBoundary.dataset.pasteBoundary = "leading";
  leadingBoundary.textContent = "[";
  leadingBoundary.setAttribute("aria-hidden", "true");

  const leadingToggle = document.createElement("span");
  leadingToggle.setAttribute("contenteditable", "false");
  leadingToggle.dataset.pasteToggle = "true";
  leadingToggle.dataset.pasteTogglePosition = "leading";

  const summary = document.createElement("span");
  summary.setAttribute("contenteditable", "false");
  summary.dataset.pasteSummary = "true";
  summary.dataset.pasteToggle = "true";

  const raw = document.createElement("span");
  raw.dataset.pasteRaw = "true";
  raw.textContent = rawText;

  const trailingToggle = document.createElement("span");
  trailingToggle.setAttribute("contenteditable", "false");
  trailingToggle.dataset.pasteToggle = "true";
  trailingToggle.dataset.pasteTogglePosition = "trailing";

  const trailingBoundary = document.createElement("span");
  trailingBoundary.setAttribute("contenteditable", "false");
  trailingBoundary.dataset.pasteBoundary = "trailing";
  trailingBoundary.textContent = "]";
  trailingBoundary.setAttribute("aria-hidden", "true");

  wrapper.append(leadingBoundary, leadingToggle, summary, raw, trailingToggle, trailingBoundary);
  setPastedTextElementCollapsed(wrapper, fragment.collapsed);
  return wrapper;
}

export function createPastedTextCaretHostElement(
  position: "leading" | "trailing",
): HTMLSpanElement {
  const host = document.createElement("span");
  host.dataset.pasteCaretHost = position;
  host.setAttribute("aria-hidden", "true");
  host.textContent = PASTED_TEXT_CARET_PLACEHOLDER;
  return host;
}

export function pastedTextCaretHostValue(element: Element): string {
  return normalizePastedText(element.textContent ?? "").replaceAll(PASTED_TEXT_CARET_PLACEHOLDER, "");
}

export function setPastedTextElementCollapsed(element: HTMLElement, collapsed: boolean): void {
  const rawText = pastedTextRaw(element);
  const characterCount = pastedTextCharacters(rawText).length;
  const summary = element.querySelector<HTMLElement>(PASTED_TEXT_SUMMARY_SELECTOR);
  const leadingToggle = element.querySelector<HTMLElement>('[data-paste-toggle-position="leading"]');
  const trailingToggle = element.querySelector<HTMLElement>('[data-paste-toggle-position="trailing"]');
  element.dataset.collapsed = collapsed ? "true" : "false";
  element.removeAttribute("contenteditable");
  element.setAttribute(
    "aria-label",
    collapsed
      ? `已折叠的粘贴内容，共 ${characterCount} 个字符，点击展开`
      : `已展开的粘贴内容，共 ${characterCount} 个字符`,
  );
  if (summary) {
    renderPastedTextSummary(summary, rawText);
    summary.setAttribute("role", "button");
    summary.setAttribute("aria-expanded", collapsed ? "false" : "true");
    summary.setAttribute("aria-label", collapsed ? `展开粘贴内容，共 ${characterCount} 个字符` : "粘贴内容已展开");
    if (collapsed) {
      summary.title = "展开粘贴内容";
    } else {
      summary.removeAttribute("title");
    }
    summary.removeAttribute("tabindex");
  }
  if (leadingToggle) {
    leadingToggle.textContent = collapsed ? "" : "⌃";
    leadingToggle.setAttribute("role", collapsed ? "presentation" : "button");
    leadingToggle.setAttribute("aria-label", collapsed ? "" : "折叠粘贴内容");
    if (collapsed) {
      leadingToggle.removeAttribute("aria-expanded");
      leadingToggle.removeAttribute("title");
    } else {
      leadingToggle.setAttribute("aria-expanded", "true");
      leadingToggle.title = "收起粘贴内容";
    }
    leadingToggle.removeAttribute("tabindex");
  }
  if (trailingToggle) {
    trailingToggle.textContent = collapsed ? "⌄" : "⌃";
    trailingToggle.setAttribute("role", "button");
    trailingToggle.setAttribute("aria-label", collapsed ? "展开粘贴内容" : "折叠粘贴内容");
    trailingToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    trailingToggle.title = collapsed ? "展开粘贴内容" : "收起粘贴内容";
    trailingToggle.removeAttribute("tabindex");
  }
}

export function closestPastedTextFragment(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return element?.closest<HTMLElement>(PASTED_TEXT_FRAGMENT_SELECTOR) ?? null;
}

export function isPastedTextToggle(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return Boolean(element?.closest(PASTED_TEXT_TOGGLE_SELECTOR));
}

export function pastedTextBoundaryPosition(target: EventTarget | null): "leading" | "trailing" | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const boundary = element?.closest<HTMLElement>(PASTED_TEXT_BOUNDARY_SELECTOR);
  const position = boundary?.dataset.pasteBoundary;
  return position === "leading" || position === "trailing" ? position : null;
}

export function readPastedTextAwareDocument(root: Node): PastedTextDocument | null {
  if (!containsPastedTextFragment(root)) {
    return null;
  }
  let value = "";
  const fragments: PastedTextFragment[] = [];

  const appendChildren = (parent: Node) => {
    let previousWasBlock = false;
    Array.from(parent.childNodes).forEach((node, index) => {
      const currentIsBlock = node instanceof HTMLElement && isBlockEditorNode(node);
      if (index > 0 && (previousWasBlock || currentIsBlock)) {
        value += "\n";
      }
      appendNode(node);
      previousWasBlock = currentIsBlock;
    });
  };

  const appendNode = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      value += normalizePastedText(node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) {
      appendChildren(node);
      return;
    }
    if (node.matches(PASTED_TEXT_CARET_HOST_SELECTOR)) {
      value += pastedTextCaretHostValue(node);
      return;
    }
    if (node.matches(PASTED_TEXT_FRAGMENT_SELECTOR)) {
      const rawText = normalizePastedText(pastedTextRaw(node));
      const start = value.length;
      value += rawText;
      const id = node.dataset.fragmentId?.trim() ?? "";
      if (id) {
        fragments.push({
          id,
          start,
          end: value.length,
          collapsed: node.dataset.collapsed !== "false",
        });
      }
      return;
    }
    if (node.tagName === "BR") {
      value += "\n";
      return;
    }
    appendChildren(node);
  };

  appendChildren(root);
  return { value, fragments: normalizePastedTextFragments(value, fragments) };
}

export function readPastedTextSelection(range: Range): string | null {
  const fragment = range.cloneContents();
  return readPastedTextAwareDocument(fragment)?.value ?? null;
}

function containsPastedTextFragment(root: Node): boolean {
  if (
    root instanceof HTMLElement &&
    (root.matches(PASTED_TEXT_FRAGMENT_SELECTOR) || root.matches(PASTED_TEXT_CARET_HOST_SELECTOR))
  ) {
    return true;
  }
  return "querySelector" in root && typeof root.querySelector === "function"
    ? Boolean(root.querySelector(`${PASTED_TEXT_FRAGMENT_SELECTOR}, ${PASTED_TEXT_CARET_HOST_SELECTOR}`))
    : false;
}

function pastedTextRaw(element: Element): string {
  return element.querySelector(PASTED_TEXT_RAW_SELECTOR)?.textContent ?? "";
}

function pastedTextSummary(text: string): { prefix: string; omission: string; suffix: string } {
  const characters = pastedTextCharacters(text);
  const prefix = displayPreview(characters.slice(0, COLLAPSIBLE_PASTE_EDGE_CHARACTERS).join(""));
  const suffix = displayPreview(characters.slice(-COLLAPSIBLE_PASTE_EDGE_CHARACTERS).join(""));
  const omitted = Math.max(0, characters.length - COLLAPSIBLE_PASTE_EDGE_CHARACTERS * 2);
  return {
    prefix,
    omission: `…省略 ${new Intl.NumberFormat("zh-CN").format(omitted)} 个字符…`,
    suffix,
  };
}

function renderPastedTextSummary(summary: HTMLElement, rawText: string) {
  const parts = pastedTextSummary(rawText);
  const omission = document.createElement("span");
  omission.dataset.pasteSummaryOmission = "true";
  omission.textContent = parts.omission;
  summary.replaceChildren(parts.prefix, omission, parts.suffix);
}

function pastedTextCharacters(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

function displayPreview(value: string): string {
  return value.replace(/\s/gu, " ");
}

function isBlockEditorNode(node: HTMLElement): boolean {
  return node.tagName === "DIV" || node.tagName === "P";
}
