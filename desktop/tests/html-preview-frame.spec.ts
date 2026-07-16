import { describe, expect, it } from "vitest";

import {
  resolveHtmlPreviewFrameSource,
  withHtmlPreviewViewportBridge,
} from "@/renderer/utils/htmlPreviewFrame";

describe("resolveHtmlPreviewFrameSource", () => {
  it("keeps self-contained html in an origin-isolated srcdoc", () => {
    const html = "<main id='app'></main><script>document.querySelector('#app').textContent = 'ready'</script>";

    expect(resolveHtmlPreviewFrameSource(html, { hostOrigin: "http://127.0.0.1:5173" })).toEqual({
      kind: "srcdoc",
      sandbox: "allow-scripts",
      srcDoc: withHtmlPreviewViewportBridge(html),
    });
  });

  it("opens loopback Vite html through its own origin", () => {
    const html = `
      <script type="module" src="http://localhost:4173/@vite/client"></script>
      <script type="module" src="http://localhost:4173/src/main.tsx?t=123"></script>
    `;

    expect(resolveHtmlPreviewFrameSource(html, {
      hostOrigin: "http://127.0.0.1:5173",
      sourcePath: String.raw`D:\prototypes\prototype-20260623-001-a2ui-config.html`,
    })).toEqual({
      kind: "url",
      sandbox: "allow-scripts allow-same-origin",
      src: "http://localhost:4173/prototype-20260623-001-a2ui-config.html",
    });
  });

  it("resolves a relative Vite client through an absolute loopback base URL", () => {
    const html = `
      <base href="http://127.0.0.1:4173/">
      <script type="module" src="/@vite/client"></script>
    `;

    expect(resolveHtmlPreviewFrameSource(html, {
      hostOrigin: "http://127.0.0.1:5173",
      sourcePath: "index.html",
    })).toEqual({
      kind: "url",
      sandbox: "allow-scripts allow-same-origin",
      src: "http://127.0.0.1:4173/",
    });
  });

  it("does not grant same-origin access to a Vite page on the Keydex host origin", () => {
    const html = '<script type="module" src="http://127.0.0.1:5173/@vite/client"></script>';

    expect(resolveHtmlPreviewFrameSource(html, { hostOrigin: "http://127.0.0.1:5173" })).toEqual({
      kind: "srcdoc",
      sandbox: "allow-scripts",
      srcDoc: withHtmlPreviewViewportBridge(html),
    });
  });

  it("does not turn remote Vite-like references into navigable previews", () => {
    const html = '<script type="module" src="https://example.test/@vite/client"></script>';

    expect(resolveHtmlPreviewFrameSource(html, { hostOrigin: "http://127.0.0.1:5173" })).toEqual({
      kind: "srcdoc",
      sandbox: "allow-scripts",
      srcDoc: withHtmlPreviewViewportBridge(html),
    });
  });
});
