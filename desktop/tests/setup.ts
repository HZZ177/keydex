class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "__KEYDEX_TEST_FILE_MARKDOWN_SNAPSHOT_LOADER__", {
  configurable: true,
  writable: true,
  value: async ({ source, revision }: { source: string; revision: string }) => {
    const { parseCanonicalMarkdownSnapshot } = await import("@/renderer/markdownRuntime/worker/parser");
    return parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:test-runtime-oracle",
      revision,
      source,
      rendererProfile: "file-preview",
    });
  },
});

if (typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.scrollTo !== "function") {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: function scrollTo(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
      if (typeof options === "number") {
        this.scrollLeft = options;
        this.scrollTop = y ?? this.scrollTop;
      } else {
        this.scrollLeft = options.left ?? this.scrollLeft;
        this.scrollTop = options.top ?? this.scrollTop;
      }
    },
  });
}

if (typeof globalThis.ResizeObserver === "undefined") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: TestResizeObserver,
  });
}

if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: () => ({
      measureText: (text: unknown) => ({
        width: String(text ?? "").length * 7,
      }),
    }),
  });
}
