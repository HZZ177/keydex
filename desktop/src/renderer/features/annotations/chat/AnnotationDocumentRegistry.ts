import type { AnnotationAssemblyDocument } from "./AnnotationContextAssembler";

export interface AnnotationDocumentRegistration {
  dispose(): void;
  update(document: AnnotationAssemblyDocument): void;
}

export class AnnotationDocumentRegistry {
  private readonly documents = new Map<string, Map<symbol, AnnotationAssemblyDocument>>();

  register(document: AnnotationAssemblyDocument): AnnotationDocumentRegistration {
    const token = Symbol("annotation-document");
    let currentKey = key(document.workspaceId, document.path);
    this.bucket(currentKey).set(token, document);
    return {
      dispose: () => {
        const bucket = this.documents.get(currentKey);
        bucket?.delete(token);
        if (bucket?.size === 0) this.documents.delete(currentKey);
      },
      update: (next) => {
        const nextKey = key(next.workspaceId, next.path);
        if (nextKey !== currentKey) {
          const previous = this.documents.get(currentKey);
          previous?.delete(token);
          if (previous?.size === 0) this.documents.delete(currentKey);
          currentKey = nextKey;
        }
        this.bucket(currentKey).set(token, next);
      },
    };
  }

  get(workspaceId: string, path: string): AnnotationAssemblyDocument | null {
    const values = this.documents.get(key(workspaceId, path));
    return values ? [...values.values()].at(-1) ?? null : null;
  }

  clear(): void {
    this.documents.clear();
  }

  private bucket(value: string): Map<symbol, AnnotationAssemblyDocument> {
    const current = this.documents.get(value) ?? new Map();
    this.documents.set(value, current);
    return current;
  }
}

export const annotationDocumentRegistry = new AnnotationDocumentRegistry();

function key(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`;
}
