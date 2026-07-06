export const APP_INSERT_MCP_PROMPT_DRAFT_EVENT = "keydex:insert-mcp-prompt-draft";
const PENDING_MCP_PROMPT_DRAFTS_KEY = "keydex:pending-mcp-prompt-drafts";

export interface InsertMcpPromptDraftDetail {
  text: string;
  serverId: string;
  promptId: string;
  rawName: string;
  sessionId?: string | null;
}

type InsertMcpPromptDraftListener = (detail: InsertMcpPromptDraftDetail) => boolean | void;

const listeners = new Set<InsertMcpPromptDraftListener>();
const pendingDrafts: InsertMcpPromptDraftDetail[] = loadPendingDrafts();

export function emitInsertMcpPromptDraft(detail: InsertMcpPromptDraftDetail): boolean {
  const normalized = normalizeDraftDetail(detail);
  const consumed = notifyListeners(normalized);
  document.dispatchEvent(
    new CustomEvent<InsertMcpPromptDraftDetail>(APP_INSERT_MCP_PROMPT_DRAFT_EVENT, {
      detail: normalized,
    }),
  );
  if (!consumed) {
    enqueuePendingDraft(normalized);
  }
  return consumed;
}

export function subscribeInsertMcpPromptDraft(
  listener: InsertMcpPromptDraftListener,
): () => void {
  listeners.add(listener);
  flushPendingDrafts(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearPendingMcpPromptDrafts(): void {
  pendingDrafts.length = 0;
  savePendingDrafts();
}

function notifyListeners(detail: InsertMcpPromptDraftDetail): boolean {
  let consumed = false;
  for (const listener of listeners) {
    consumed = listener(detail) === true || consumed;
  }
  return consumed;
}

function flushPendingDrafts(listener: InsertMcpPromptDraftListener): void {
  pendingDrafts.splice(0, pendingDrafts.length, ...loadPendingDrafts());
  let changed = false;
  for (let index = 0; index < pendingDrafts.length;) {
    if (listener(pendingDrafts[index]) === true) {
      pendingDrafts.splice(index, 1);
      changed = true;
      continue;
    }
    index += 1;
  }
  if (changed) {
    savePendingDrafts();
  }
}

function normalizeDraftDetail(detail: InsertMcpPromptDraftDetail): InsertMcpPromptDraftDetail {
  return {
    ...detail,
    text: detail.text.trim(),
    sessionId: detail.sessionId || null,
  };
}

function enqueuePendingDraft(detail: InsertMcpPromptDraftDetail): void {
  pendingDrafts.push(detail);
  savePendingDrafts();
}

function loadPendingDrafts(): InsertMcpPromptDraftDetail[] {
  const storage = sessionStorageSafe();
  if (!storage) {
    return [];
  }
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_MCP_PROMPT_DRAFTS_KEY) || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(coerceDraftDetail).filter(isDraftDetail);
  } catch {
    return [];
  }
}

function savePendingDrafts(): void {
  const storage = sessionStorageSafe();
  if (!storage) {
    return;
  }
  if (pendingDrafts.length === 0) {
    storage.removeItem(PENDING_MCP_PROMPT_DRAFTS_KEY);
    return;
  }
  storage.setItem(PENDING_MCP_PROMPT_DRAFTS_KEY, JSON.stringify(pendingDrafts));
}

function coerceDraftDetail(value: unknown): InsertMcpPromptDraftDetail | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.text !== "string" ||
    typeof record.serverId !== "string" ||
    typeof record.promptId !== "string" ||
    typeof record.rawName !== "string"
  ) {
    return null;
  }
  return normalizeDraftDetail({
    text: record.text,
    serverId: record.serverId,
    promptId: record.promptId,
    rawName: record.rawName,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
  });
}

function isDraftDetail(value: InsertMcpPromptDraftDetail | null): value is InsertMcpPromptDraftDetail {
  return value !== null;
}

function sessionStorageSafe(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
