export type LaunchIntent = "resolving" | "normal" | "external-file";

export type LaunchIntentAction =
  | { type: "initial-resolution-complete" }
  | { type: "external-file-detected" };

export function initialLaunchIntent(search: string): LaunchIntent {
  return externalFilePathFromSearch(search) ? "external-file" : "resolving";
}

export function launchIntentReducer(state: LaunchIntent, action: LaunchIntentAction): LaunchIntent {
  if (state === "external-file" || action.type === "external-file-detected") {
    return "external-file";
  }
  if (action.type === "initial-resolution-complete") {
    return "normal";
  }
  return state;
}

export function externalFilePathFromSearch(search: string): string | null {
  const path = new URLSearchParams(search).get("file")?.trim();
  return path || null;
}

export function selectAssociatedFilePath(paths: string[]): string | null {
  return paths.map((path) => path.trim()).filter(Boolean).at(-1) ?? null;
}
