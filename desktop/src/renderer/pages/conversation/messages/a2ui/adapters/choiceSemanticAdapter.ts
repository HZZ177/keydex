import type { ParsedA2UIMessage } from "../A2UIBlock";
import type { A2UISemanticAdapter, A2UISemanticSnapshot, A2UISemanticUnit } from "../runtime/useA2UISemanticStream";

export const choiceSemanticAdapter: A2UISemanticAdapter = {
  renderKey: "choice",
  unitKind: "option",
  extract(payload: Record<string, unknown>, _parsed: ParsedA2UIMessage): A2UISemanticSnapshot {
    const { options: _options, ...meta } = payload;
    const options = Array.isArray(payload.options) ? payload.options : [];
    return {
      meta,
      units: options
        .map((option, index): A2UISemanticUnit | null => {
          const record = asRecord(option);
          if (!record) {
            return null;
          }
          const value = scalarText(record.value) || scalarText(record.key) || scalarText(record.label) || `option_${index + 1}`;
          return {
            key: `choice:option:${value}`,
            order: index,
            payload: record,
            signature: safeJsonStringify(record),
          };
        })
        .filter((unit): unit is A2UISemanticUnit => Boolean(unit)),
    };
  },
  build(snapshot: A2UISemanticSnapshot, visibleUnits: A2UISemanticUnit[]): Record<string, unknown> {
    return {
      ...snapshot.meta,
      options: visibleUnits
        .slice()
        .sort((first, second) => first.order - second.order)
        .map((unit) => unit.payload),
    };
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
