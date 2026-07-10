import type { ParsedA2UIMessage } from "../A2UIBlock";
import type { A2UISemanticAdapter, A2UISemanticSnapshot, A2UISemanticUnit } from "../runtime/useA2UISemanticStream";

export const formSemanticAdapter: A2UISemanticAdapter = {
  renderKey: "form",
  unitKind: "field",
  extract(payload: Record<string, unknown>, _parsed: ParsedA2UIMessage): A2UISemanticSnapshot {
    const { fields: _fields, ...meta } = payload;
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    return {
      meta,
      units: fields
        .map((field, index): A2UISemanticUnit | null => {
          const record = asRecord(field);
          if (!record) {
            return null;
          }
          const name = scalarText(record.name) || scalarText(record.key) || `field_${index + 1}`;
          return {
            key: `form:field:${name}`,
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
      fields: visibleUnits
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
