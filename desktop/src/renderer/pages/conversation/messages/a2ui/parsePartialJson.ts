export interface PartialJsonParseResult {
  complete: boolean;
  value?: unknown;
  error?: string;
}

export function parsePartialJson(input: string): PartialJsonParseResult {
  const source = input.trim();
  if (!source) {
    return { complete: false, value: undefined };
  }

  const complete = parseJson(source);
  if (complete.ok) {
    return { complete: true, value: complete.value };
  }

  const repaired = repairPartialJson(source);
  if (!repaired || repaired === source) {
    return { complete: false, error: complete.error };
  }

  const partial = parseJson(repaired);
  if (partial.ok) {
    return { complete: false, value: partial.value };
  }
  return { complete: false, error: complete.error };
}

function parseJson(source: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
}

function repairPartialJson(source: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaping = false;

  for (const char of source) {
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if ((char === "}" || char === "]") && stack[stack.length - 1] === char) {
      stack.pop();
    }
  }

  let repaired = source.trimEnd();
  if (inString) {
    repaired += "\"";
  }
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length > 0) {
    repaired += stack.pop();
  }
  return repaired;
}
