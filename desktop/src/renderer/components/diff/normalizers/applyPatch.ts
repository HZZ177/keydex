import { createDiffSourceVersion } from "../identity";
import {
  createKeydexDiffDocument,
  type KeydexDiffDiagnostic,
  type KeydexDiffDocument,
} from "../model";
import {
  normalizeUnifiedPatch,
  type UnifiedPatchNormalizationOptions,
} from "./unifiedPatch";

type ApplyPatchOperation = "add" | "update" | "delete";

interface ApplyPatchFileBlock {
  operation: ApplyPatchOperation;
  path: string;
  moveTo: string | null;
  lines: string[];
}

export function normalizeApplyPatch(
  input: string,
  options: Omit<UnifiedPatchNormalizationOptions, "precision" | "selectableForPatch"> = {},
): KeydexDiffDocument {
  const normalizedInput = input.replace(/\r\n?/gu, "\n");
  const blocks = parseApplyPatchBlocks(normalizedInput);
  const canonicalPatch = blocks.map(canonicalBlockPatch).join("");
  const sourceVersion =
    options.sourceVersion ??
    createDiffSourceVersion({ revision: "apply-patch", content: normalizedInput });
  const document = normalizeUnifiedPatch(canonicalPatch, {
    ...options,
    source: options.source ?? "agent",
    sourceVersion,
    precision: "approximate",
    selectableForPatch: false,
  });
  const diagnostics: KeydexDiffDiagnostic[] = [...document.diagnostics];
  if (blocks.length) {
    diagnostics.push({
      id: "diff-diagnostic:approximate_hunk:apply-patch",
      code: "approximate_hunk",
      severity: "warning",
      message: "历史变更缺少精确行号，当前内容仅用于近似预览。",
    });
  }
  if (!normalizedInput.includes("*** End Patch")) {
    diagnostics.push({
      id: "diff-diagnostic:incomplete_apply_patch:streaming",
      code: "incomplete_apply_patch",
      severity: "info",
      message: "变更仍在生成，当前展示的是不完整预览。",
    });
  }
  return createKeydexDiffDocument({ ...document, diagnostics });
}

export function parseApplyPatchBlocks(input: string): readonly ApplyPatchFileBlock[] {
  const lines = input.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: ApplyPatchFileBlock[] = [];
  let current: ApplyPatchFileBlock | null = null;

  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const line of lines) {
    const marker = fileMarker(line);
    if (marker) {
      flush();
      current = { ...marker, moveTo: null, lines: [] };
      continue;
    }
    if (line.startsWith("*** Move to: ") && current?.operation === "update") {
      current.moveTo = line.slice("*** Move to: ".length).trim() || null;
      continue;
    }
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    if (current) current.lines.push(line);
  }
  flush();
  return blocks;
}

function fileMarker(line: string): Pick<ApplyPatchFileBlock, "operation" | "path"> | null {
  for (const [prefix, operation] of [
    ["*** Add File: ", "add"],
    ["*** Update File: ", "update"],
    ["*** Delete File: ", "delete"],
  ] as const) {
    if (line.startsWith(prefix)) {
      return { operation, path: line.slice(prefix.length).trim() };
    }
  }
  return null;
}

function canonicalBlockPatch(block: ApplyPatchFileBlock): string {
  const oldPath = block.operation === "add" ? null : block.path;
  const newPath = block.operation === "delete" ? null : block.moveTo ?? block.path;
  const headerOld = oldPath ? `a/${oldPath}` : "/dev/null";
  const headerNew = newPath ? `b/${newPath}` : "/dev/null";
  const lines = [
    `diff --git a/${oldPath ?? block.path} b/${newPath ?? block.path}`,
    ...(block.moveTo ? [`rename from ${block.path}`, `rename to ${block.moveTo}`] : []),
    `--- ${headerOld}`,
    `+++ ${headerNew}`,
  ];
  if (block.operation === "delete" && !block.lines.some(isDiffBodyLine)) {
    return `${lines.join("\n")}\n`;
  }

  const bodies = splitRelaxedHunks(block.lines);
  let oldCursor = block.operation === "add" ? 0 : 1;
  let newCursor = block.operation === "delete" ? 0 : 1;
  for (const body of bodies) {
    const oldLines = body.filter((line) => line.startsWith("-") || line.startsWith(" ")).length;
    const newLines = body.filter((line) => line.startsWith("+") || line.startsWith(" ")).length;
    lines.push(
      `@@ -${oldCursor},${oldLines} +${newCursor},${newLines} @@`,
      ...body,
    );
    oldCursor += oldLines;
    newCursor += newLines;
  }
  return `${lines.join("\n")}\n`;
}

function splitRelaxedHunks(lines: readonly string[]): string[][] {
  const hunks: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) hunks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      continue;
    }
    if (isDiffBodyLine(line)) current.push(line);
  }
  flush();
  return hunks.length ? hunks : [[]];
}

function isDiffBodyLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-") || line.startsWith(" ");
}
