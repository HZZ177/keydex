import { isTauriRuntime, type TauriInvoke } from "./agentConnection";

export const ASSOCIATED_FILE_OPEN_REQUESTED_EVENT = "keydex://associated-file-open-requested";

export async function takeAssociatedFileOpenPaths(): Promise<string[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  const invoke = await loadTauriInvoke();
  return invoke<string[]>("take_associated_file_open_paths");
}

export async function listenForAssociatedFileOpenRequested(handler: () => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen(ASSOCIATED_FILE_OPEN_REQUESTED_EVENT, handler);
}

async function loadTauriInvoke(): Promise<TauriInvoke> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke as TauriInvoke;
}
