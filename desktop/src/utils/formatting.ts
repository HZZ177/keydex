export function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function compactPath(path: string, max = 44): string {
  if (path.length <= max) return path;
  return `...${path.slice(-(max - 3))}`;
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value, null, 2);
}
