import type { WorkspaceSearchResult } from "@/runtime";

export function getAtQuery(value: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value);
  return match ? match[1] : null;
}

export function replaceAtQuery(value: string, result: WorkspaceSearchResult): string {
  return value.replace(/(?:^|\s)@[^\s@]*$/, (match) => {
    const prefix = match.startsWith(" ") ? " " : "";
    return `${prefix}@${result.path} `;
  });
}
