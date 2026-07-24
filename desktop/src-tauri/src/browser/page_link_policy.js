(() => {
  "use strict";

  // tauri-plugin-shell installs a global `_blank` anchor interceptor in every
  // Tauri WebView. Browser surfaces must keep those links inside Keydex instead
  // of delegating them to the operating system through shell.open.
  const nativeOpen = window.open.bind(window);
  const closest = Element.prototype.closest;

  window.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (!(event.target instanceof Element)) return;

    const anchor = closest.call(event.target, "a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (anchor.target.toLowerCase() !== "_blank" || anchor.hasAttribute("download")) return;

    let target;
    try {
      target = new URL(anchor.href, window.location.href);
    } catch {
      return;
    }
    const targetIsRemote = target.protocol === "http:" || target.protocol === "https:";
    const targetIsFile = target.protocol === "file:";
    if (!targetIsRemote && !targetIsFile) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (targetIsFile && window.location.protocol !== "file:") return;
    nativeOpen(target.toString(), "_blank", "noopener,noreferrer");
  }, true);
})();
