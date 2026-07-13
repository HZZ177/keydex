import type { MarkdownSnapshotBlockKind } from "../document/MarkdownSnapshot";
import type {
  MarkdownBlockRendererDefinition,
  MarkdownBlockRendererDefinitions,
} from "./types";

export class SemanticMarkdownRendererRegistry {
  private readonly definitions = new Map<MarkdownSnapshotBlockKind, MarkdownBlockRendererDefinition>();

  constructor(
    defaults: MarkdownBlockRendererDefinitions,
    overrides: MarkdownBlockRendererDefinitions = {},
  ) {
    for (const [kind, definition] of Object.entries({ ...defaults, ...overrides })) {
      if (definition) this.definitions.set(kind as MarkdownSnapshotBlockKind, definition);
    }
  }

  resolve(kind: MarkdownSnapshotBlockKind): MarkdownBlockRendererDefinition {
    const definition = this.definitions.get(kind) ?? this.definitions.get("unknown");
    if (!definition) throw new Error(`No semantic Markdown renderer for ${kind}`);
    return definition;
  }

  register(kind: MarkdownSnapshotBlockKind, definition: MarkdownBlockRendererDefinition): () => void {
    const previous = this.definitions.get(kind);
    this.definitions.set(kind, definition);
    return () => {
      if (this.definitions.get(kind) !== definition) return;
      if (previous) this.definitions.set(kind, previous);
      else this.definitions.delete(kind);
    };
  }
}
