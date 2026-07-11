export class AnnotationGeometryScheduler {
  private frameId: number | null = null;
  private microtaskRevision = 0;

  constructor(private readonly flush: () => void) {}

  request(): void {
    if (this.frameId !== null) {
      return;
    }
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      const revision = ++this.microtaskRevision;
      this.frameId = -1;
      queueMicrotask(() => {
        if (this.frameId !== -1 || revision !== this.microtaskRevision) {
          return;
        }
        this.frameId = null;
        this.flush();
      });
      return;
    }
    this.frameId = window.requestAnimationFrame(() => {
      this.frameId = null;
      this.flush();
    });
  }

  cancel(): void {
    this.microtaskRevision += 1;
    if (this.frameId !== null && this.frameId >= 0 && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.frameId);
    }
    this.frameId = null;
  }
}
