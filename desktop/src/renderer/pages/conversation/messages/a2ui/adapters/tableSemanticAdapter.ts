import type { ParsedA2UIMessage } from "../A2UIBlock";
import type { A2UISemanticAdapter, A2UISemanticSnapshot, A2UISemanticUnit } from "../runtime/useA2UISemanticStream";

const TABLE_UNIT_KIND = "__a2ui_table_unit_kind";
const TABLE_UNIT_VALUE = "__a2ui_table_unit_value";

export const tableSemanticAdapter: A2UISemanticAdapter = {
  renderKey: "table",
  unitKind: "row",
  extract(payload: Record<string, unknown>, _parsed: ParsedA2UIMessage): A2UISemanticSnapshot {
    const { rows: _rows, ...meta } = payload;
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    return {
      meta,
      units: rows
        .map((row, index) => tableRowUnit(row, index))
        .filter((unit): unit is A2UISemanticUnit => Boolean(unit)),
    };
  },
  build(snapshot: A2UISemanticSnapshot, visibleUnits: A2UISemanticUnit[]): Record<string, unknown> {
    const rows: Record<string, unknown>[] = [];
    for (const unit of visibleUnits.slice().sort((first, second) => first.order - second.order)) {
      const kind = scalarText(unit.payload[TABLE_UNIT_KIND]);
      const value = asRecord(unit.payload[TABLE_UNIT_VALUE]);
      if (!value) {
        continue;
      }
      if (kind === "row") {
        rows.push(value);
      }
    }
    return {
      ...snapshot.meta,
      rows,
    };
  },
};

function tableRowUnit(value: unknown, index: number): A2UISemanticUnit | null {
  const row = asRecord(value);
  const id = scalarText(row?.id);
  if (!row || !id) {
    return null;
  }
  return {
    key: `table:row:${id}`,
    order: index,
    payload: {
      [TABLE_UNIT_KIND]: "row",
      [TABLE_UNIT_VALUE]: row,
    },
    signature: safeJsonStringify(row),
  };
}

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
