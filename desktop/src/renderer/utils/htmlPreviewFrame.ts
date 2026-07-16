export const ISOLATED_HTML_PREVIEW_SANDBOX = "allow-scripts";
export const LOOPBACK_DEV_HTML_PREVIEW_SANDBOX = "allow-scripts allow-same-origin";
export const HTML_PREVIEW_VIEWPORT_MESSAGE_TYPE = "keydex:html-preview-viewport-state/v1";
export const HTML_PREVIEW_VIEWPORT_BRIDGE_MARKER = "data-keydex-preview-viewport-bridge";

export type HtmlPreviewFrameSource =
  | {
      kind: "srcdoc";
      sandbox: typeof ISOLATED_HTML_PREVIEW_SANDBOX;
      srcDoc: string;
    }
  | {
      kind: "url";
      sandbox: typeof LOOPBACK_DEV_HTML_PREVIEW_SANDBOX;
      src: string;
    };

export interface ResolveHtmlPreviewFrameSourceOptions {
  hostOrigin?: string;
  sourcePath?: string;
}

export function resolveHtmlPreviewFrameSource(
  html: string,
  options: ResolveHtmlPreviewFrameSourceOptions = {},
): HtmlPreviewFrameSource {
  const fallback = (): HtmlPreviewFrameSource => ({
    kind: "srcdoc",
    sandbox: ISOLATED_HTML_PREVIEW_SANDBOX,
    srcDoc: withHtmlPreviewViewportBridge(html),
  });
  const viteClientUrl = findLoopbackViteClientUrl(html);
  if (!viteClientUrl) {
    return fallback();
  }

  const hostOrigin = options.hostOrigin ?? globalThis.location?.origin ?? "";
  if (hostOrigin && sameOrigin(viteClientUrl.origin, hostOrigin)) {
    return fallback();
  }

  // `allow-same-origin` is only used for a cross-origin loopback page loaded by URL.
  // Combining it with `srcdoc` would give workspace HTML access to the Keydex origin.
  return {
    kind: "url",
    sandbox: LOOPBACK_DEV_HTML_PREVIEW_SANDBOX,
    src: vitePreviewDocumentUrl(viteClientUrl, options.sourcePath),
  };
}

export function withHtmlPreviewViewportBridge(html: string): string {
  if (html.includes(HTML_PREVIEW_VIEWPORT_BRIDGE_MARKER)) {
    return html;
  }
  const script = `<script ${HTML_PREVIEW_VIEWPORT_BRIDGE_MARKER}>(function(){var type=${JSON.stringify(HTML_PREVIEW_VIEWPORT_MESSAGE_TYPE)};var frame=0;var last="";function report(){frame=0;var root=document.scrollingElement||document.documentElement;var viewport=Math.max(window.innerHeight||0,document.documentElement?document.documentElement.clientHeight:0);var scrollHeight=Math.max(root?root.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0,document.body?document.body.scrollHeight:0);var scrollTop=Math.max(window.scrollY||0,root?root.scrollTop:0);var threshold=Math.max(72,Math.min(160,viewport*0.12));var nearBottom=viewport>0&&(scrollHeight<=viewport+1||scrollHeight-viewport-scrollTop<=threshold);var key=[nearBottom,Math.round(scrollTop),Math.round(scrollHeight),Math.round(viewport)].join(":");if(key===last){return;}last=key;window.parent.postMessage({type:type,nearBottom:nearBottom,scrollTop:scrollTop,scrollHeight:scrollHeight,clientHeight:viewport},"*");}function schedule(){if(frame){return;}frame=window.requestAnimationFrame(report);}window.addEventListener("scroll",schedule,{passive:true});window.addEventListener("resize",schedule,{passive:true});window.addEventListener("load",schedule,{once:true});if(typeof ResizeObserver!=="undefined"){var resizeObserver=new ResizeObserver(schedule);if(document.documentElement){resizeObserver.observe(document.documentElement);}if(document.body){resizeObserver.observe(document.body);}}if(typeof MutationObserver!=="undefined"){new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true,attributes:true});}schedule();window.setTimeout(schedule,120);window.setTimeout(schedule,600);})();</script>`;
  const bodyCloseIndex = html.toLowerCase().lastIndexOf("</body>");
  if (bodyCloseIndex >= 0) {
    return `${html.slice(0, bodyCloseIndex)}${script}${html.slice(bodyCloseIndex)}`;
  }
  const htmlCloseIndex = html.toLowerCase().lastIndexOf("</html>");
  if (htmlCloseIndex >= 0) {
    return `${html.slice(0, htmlCloseIndex)}${script}${html.slice(htmlCloseIndex)}`;
  }
  return `${html}${script}`;
}

function findLoopbackViteClientUrl(html: string): URL | null {
  const absoluteMatch = /https?:\/\/[^\s"'<>]+\/@vite\/client(?:[?#][^\s"'<>]*)?/i.exec(html);
  const absoluteUrl = parseUrl(absoluteMatch?.[0]);
  if (absoluteUrl && isLoopbackHttpUrl(absoluteUrl)) {
    return absoluteUrl;
  }

  const clientSource = /(?:src|href)\s*=\s*["']([^"']*\/@vite\/client(?:[?#][^"']*)?)["']/i.exec(html)?.[1];
  const baseHref = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  if (!clientSource || !baseHref) {
    return null;
  }
  const resolvedUrl = parseUrl(clientSource, baseHref);
  return resolvedUrl && isLoopbackHttpUrl(resolvedUrl) ? resolvedUrl : null;
}

function isLoopbackHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname === "::1";
}

function sameOrigin(left: string, right: string): boolean {
  const leftUrl = parseUrl(left);
  const rightUrl = parseUrl(right);
  return Boolean(leftUrl && rightUrl && leftUrl.origin === rightUrl.origin);
}

function vitePreviewDocumentUrl(viteClientUrl: URL, sourcePath?: string): string {
  const fileName = sourcePath?.split(/[\\/]/).filter(Boolean).at(-1)?.trim();
  const pathname = fileName && fileName.toLowerCase() !== "index.html"
    ? `/${encodeURIComponent(fileName)}`
    : "/";
  return new URL(pathname, viteClientUrl.origin).href;
}

function parseUrl(value?: string, base?: string): URL | null {
  if (!value) {
    return null;
  }
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
}
