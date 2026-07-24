import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const policySource = readFileSync(
  resolve(process.cwd(), "src-tauri", "src", "browser", "page_link_policy.js"),
  "utf8",
);

describe("browser surface link policy", () => {
  it("routes an HTTP _blank anchor through the native new-window event and blocks shell interception", () => {
    const dom = createDocument();
    const browserWindow = dom.window;
    const nativeOpen = vi.fn();
    Object.defineProperty(browserWindow, "open", { configurable: true, value: nativeOpen });
    browserWindow.eval(policySource);

    const shellOpen = vi.fn();
    browserWindow.document.body.addEventListener("click", shellOpen);
    const anchor = browserWindow.document.createElement("a");
    anchor.href = "https://www.bing.com/search?q=keydex";
    anchor.target = "_blank";
    const child = browserWindow.document.createElement("span");
    anchor.append(child);
    browserWindow.document.body.append(anchor);

    child.dispatchEvent(new browserWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(nativeOpen).toHaveBeenCalledWith(
      "https://www.bing.com/search?q=keydex",
      "_blank",
      "noopener,noreferrer",
    );
    expect(shellOpen).not.toHaveBeenCalled();
  });

  it("does not rewrite same-tab, download, or non-HTTP links", () => {
    const dom = createDocument();
    const browserWindow = dom.window;
    const nativeOpen = vi.fn();
    Object.defineProperty(browserWindow, "open", { configurable: true, value: nativeOpen });
    browserWindow.eval(policySource);
    browserWindow.document.body.addEventListener("click", (event) => event.preventDefault());

    const inputs = [
      { href: "https://example.com/current", target: "" },
      { href: "https://example.com/file", target: "_blank", download: "file.txt" },
      { href: "mailto:test@example.com", target: "_blank" },
    ];
    for (const input of inputs) {
      const anchor = browserWindow.document.createElement("a");
      anchor.href = input.href;
      anchor.target = input.target;
      if (input.download) anchor.download = input.download;
      browserWindow.document.body.append(anchor);
      anchor.dispatchEvent(new browserWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    }

    expect(nativeOpen).not.toHaveBeenCalled();
  });

  it("routes relative and absolute file popups only when the current page is also local", () => {
    const local = createDocument("file:///D:/workspace/index.html");
    const localOpen = vi.fn();
    Object.defineProperty(local.window, "open", { configurable: true, value: localOpen });
    local.window.eval(policySource);

    for (const href of ["nested/page.html", "file:///D:/workspace/absolute.html"]) {
      const anchor = local.window.document.createElement("a");
      anchor.href = href;
      anchor.target = "_blank";
      local.window.document.body.append(anchor);
      anchor.dispatchEvent(new local.window.MouseEvent(
        "click",
        { bubbles: true, cancelable: true, button: 0 },
      ));
    }

    expect(localOpen).toHaveBeenNthCalledWith(
      1,
      "file:///D:/workspace/nested/page.html",
      "_blank",
      "noopener,noreferrer",
    );
    expect(localOpen).toHaveBeenNthCalledWith(
      2,
      "file:///D:/workspace/absolute.html",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("consumes a remote-page file popup before shell interception without opening it", () => {
    const remote = createDocument("https://example.test/article");
    const nativeOpen = vi.fn();
    const shellOpen = vi.fn();
    Object.defineProperty(remote.window, "open", { configurable: true, value: nativeOpen });
    remote.window.eval(policySource);
    remote.window.document.body.addEventListener("click", shellOpen);

    const anchor = remote.window.document.createElement("a");
    anchor.href = "file:///D:/workspace/private.html";
    anchor.target = "_blank";
    remote.window.document.body.append(anchor);
    anchor.dispatchEvent(new remote.window.MouseEvent(
      "click",
      { bubbles: true, cancelable: true, button: 0 },
    ));

    expect(nativeOpen).not.toHaveBeenCalled();
    expect(shellOpen).not.toHaveBeenCalled();
  });
});

function createDocument(url = "https://www.bing.com/"): JSDOM {
  return new JSDOM("<!doctype html><body></body>", {
    runScripts: "outside-only",
    url,
  });
}
