import { Check, ChevronDown, ChevronUp, Copy, Maximize2, PanelRightOpen, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import katex from "katex";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import SyntaxHighlighter from "react-syntax-highlighter";
import { vs, vs2015 } from "react-syntax-highlighter/dist/esm/styles/hljs";

import { useOptionalPreview } from "@/renderer/providers/PreviewProvider";
import type { PreviewRequest } from "@/renderer/providers/previewTypes";

import { MarkdownTable } from "./MarkdownTable";
import { copyText, markdownRehypePlugins, markdownRemarkPlugins, normalizeMarkdownContent } from "./markdown";
import styles from "./MessageText.module.css";

const PREVIEW_LINES = 10;
const VIEW_SWITCH_DELAY_MS = 180;
const COLLAPSED_CODE_HEIGHT = 198;
type ContentPreviewRequest = Extract<PreviewRequest, { type: "content" }>;

export interface MarkdownCodeBlockProps {
  children?: ReactNode;
  defaultViewMode?: "source" | "preview";
}

export function MarkdownCodeBlock({ children, defaultViewMode = "source" }: MarkdownCodeBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [viewModeOverride, setViewModeOverride] = useState<"source" | "preview" | null>(null);
  const [pendingViewMode, setPendingViewMode] = useState<"source" | "preview" | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [sourceHeight, setSourceHeight] = useState(COLLAPSED_CODE_HEIGHT);
  const [theme, setTheme] = useState<"light" | "dark">(() => getTheme());
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceViewportRef = useRef<HTMLDivElement>(null);
  const switchTimerRef = useRef<number | null>(null);
  const previewContext = useOptionalPreview();
  const codeChild = getCodeChild(children);
  const className = codeChild?.props?.className;
  const language = getLanguage(className);
  const text = stripTrailingNewline(extractText(codeChild?.props?.children ?? children));
  const panelPreview = useMemo(() => buildPanelPreviewRequest(language, text), [language, text]);
  const displayText = useMemo(() => formatCode(text), [text]);
  const lines = useMemo(() => displayText.split("\n"), [displayText]);
  const canPreviewHtml = isHtmlPreviewLanguage(language);
  const canPreviewMermaid = language === "mermaid";
  const canPreviewMath = isMathLanguage(language) && !isFullLatexDocument(text);
  const previewLabel = canPreviewHtml ? "HTML" : canPreviewMermaid ? "Mermaid" : canPreviewMath ? "公式" : null;
  const canOpenFullscreen = Boolean(previewLabel || panelPreview);
  const fullscreenLabel = previewLabel ?? panelPreview?.title ?? language;
  const fullscreenTitle = previewLabel ? `${previewLabel} 预览` : panelPreview?.title ?? `${language} 预览`;
  const preferredViewMode = previewLabel ? "preview" : defaultViewMode;
  const viewMode = viewModeOverride ?? preferredViewMode;
  const isSwitchingView = pendingViewMode !== null;
  const canCollapse = lines.length > PREVIEW_LINES;
  const showSourceView = !isSwitchingView && viewMode === "source";
  const showCollapseControls = showSourceView && canCollapse;
  const isDiff = language === "diff";
  const highlighterTheme = theme === "dark" ? vs2015 : vs;
  const sourceViewportStyle = {
    "--code-expanded-height": `${Math.max(sourceHeight, COLLAPSED_CODE_HEIGHT)}px`,
  } as CSSProperties;

  useEffect(() => {
    const themeObserver = new MutationObserver(() => setTheme(getTheme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => themeObserver.disconnect();
  }, []);

  useEffect(() => {
    clearSwitchTimer(switchTimerRef);
    setViewModeOverride(null);
    setPendingViewMode(null);
    setFullscreenOpen(false);
    setExpanded(false);
  }, [language, preferredViewMode, text]);

  useLayoutEffect(() => {
    const element = sourceViewportRef.current;
    if (!element || !showSourceView) {
      return;
    }

    const measure = () => {
      setSourceHeight(Math.max(element.scrollHeight, COLLAPSED_CODE_HEIGHT));
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [displayText, showSourceView, theme]);

  useEffect(() => () => clearSwitchTimer(switchTimerRef), []);

  const handleCopy = async () => {
    try {
      await copyText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const toggleExpanded = () => {
    const willCollapse = expanded;
    setExpanded((value) => !value);
    if (willCollapse) {
      window.requestAnimationFrame(() => {
        containerRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
      });
    }
  };

  const toggleViewMode = () => {
    if (!previewLabel || pendingViewMode) {
      return;
    }
    const nextViewMode = viewMode === "source" ? "preview" : "source";
    clearSwitchTimer(switchTimerRef);
    setPendingViewMode(nextViewMode);
    switchTimerRef.current = window.setTimeout(
      () => {
        setViewModeOverride(nextViewMode);
        setPendingViewMode(null);
        switchTimerRef.current = null;
      },
      prefersReducedMotion() ? 0 : VIEW_SWITCH_DELAY_MS,
    );
  };

  const openInPanel = () => {
    if (!panelPreview) {
      return;
    }
    previewContext?.openPreview(panelPreview);
  };

  return (
    <div ref={containerRef} className={styles.codeBlock} data-language={language}>
      <div className={styles.codeHeader}>
        <span className={styles.codeLanguage}>{language}</span>
        <div className={styles.codeActions}>
          {previewLabel ? (
            <button
              className={styles.codeTextButton}
              type="button"
              aria-pressed={viewMode === "preview"}
              disabled={isSwitchingView}
              onClick={toggleViewMode}
            >
              {isSwitchingView ? "切换中" : viewMode === "source" ? `预览 ${previewLabel}` : "查看源码"}
            </button>
          ) : null}
          {canOpenFullscreen ? (
            <button
              className={styles.codeIconButton}
              type="button"
              aria-label={`全屏显示 ${fullscreenLabel}`}
              title={`全屏显示 ${fullscreenLabel}`}
              onClick={() => setFullscreenOpen(true)}
            >
              <Maximize2 size={14} />
            </button>
          ) : null}
          {previewContext && panelPreview ? (
            <button
              className={styles.codeIconButton}
              type="button"
              aria-label={`在预览面板打开 ${panelPreview.title}`}
              title={`在预览面板打开 ${panelPreview.title}`}
              onClick={openInPanel}
            >
              <PanelRightOpen size={14} />
            </button>
          ) : null}
          {showCollapseControls ? (
            <button
              className={styles.codeIconButton}
              type="button"
              aria-label={expanded ? "折叠代码" : "展开代码"}
              onClick={toggleExpanded}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : null}
          <button className={styles.codeIconButton} type="button" aria-label="复制代码" onClick={handleCopy}>
            {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      {isSwitchingView ? (
        <CodeViewLoading targetMode={pendingViewMode} />
      ) : canPreviewHtml && viewMode === "preview" ? (
        <HtmlPreviewFrame html={text} />
      ) : canPreviewMermaid && viewMode === "preview" ? (
        <MermaidPreview code={text} theme={theme} />
      ) : canPreviewMath && viewMode === "preview" ? (
        <MathPreview source={text} />
      ) : (
        <div
          ref={sourceViewportRef}
          className={styles.codeViewport}
          data-collapsed={canCollapse && !expanded ? "true" : "false"}
          data-scroll-axis="x"
          data-testid="markdown-code-viewport"
          style={sourceViewportStyle}
        >
          <SyntaxHighlighter
            language={language}
            style={highlighterTheme}
            PreTag="div"
            wrapLines={isDiff}
            lineProps={
              isDiff
                ? (lineNumber: number) => ({
                    style: getDiffLineStyle(lines[lineNumber - 1] ?? "", theme),
                  })
                : undefined
            }
            customStyle={{
              margin: 0,
              padding: "0 12px 10px",
              border: "none",
              background: "transparent",
              color: "var(--color-text-1)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.55,
              overflowX: "visible",
            }}
            codeTagProps={{
              style: {
                background: "transparent",
                color: "var(--color-text-1)",
                fontFamily: "var(--font-mono)",
              },
            }}
          >
            {displayText}
          </SyntaxHighlighter>
        </div>
      )}

      {showCollapseControls ? (
        <button className={styles.codeFooter} type="button" onClick={toggleExpanded}>
          {expanded ? "收起代码" : `展开其余 ${lines.length - PREVIEW_LINES} 行`}
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : null}
      {copyState === "failed" ? <span className={styles.codeCopyError}>复制失败</span> : null}
      {fullscreenOpen && canOpenFullscreen ? (
        <PreviewFullscreenDialog title={fullscreenTitle} onClose={() => setFullscreenOpen(false)}>
          <FullscreenPreviewContent
            contentType={panelPreview?.contentType}
            language={language}
            text={text}
            theme={theme}
          />
        </PreviewFullscreenDialog>
      ) : null}
    </div>
  );
}

function PreviewFullscreenDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div className={styles.previewFullscreenOverlay} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.previewFullscreenDialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.previewFullscreenHeader}>
          <h2>{title}</h2>
          <button className={styles.previewFullscreenClose} type="button" aria-label="关闭全屏预览" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className={styles.previewFullscreenBody}>{children}</div>
      </section>
    </div>,
    document.body,
  );
}

function CodeViewLoading({ targetMode }: { targetMode: "source" | "preview" | null }) {
  return (
    <div className={styles.codeViewLoading} aria-label="正在切换代码视图" data-target={targetMode ?? "unknown"}>
      <span />
      <span />
      <span />
    </div>
  );
}

function FullscreenPreviewContent({
  contentType,
  language,
  text,
  theme,
}: {
  contentType?: ContentPreviewRequest["contentType"];
  language: string;
  text: string;
  theme: "light" | "dark";
}) {
  if (contentType === "html" || isHtmlPreviewLanguage(language)) {
    return <HtmlPreviewFrame html={text} size="fullscreen" />;
  }
  if (contentType === "mermaid" || language === "mermaid") {
    return <MermaidPreview code={text} theme={theme} interactive size="fullscreen" />;
  }
  if (isMathLanguage(language) && !isFullLatexDocument(text)) {
    return <MathPreview source={text} size="fullscreen" />;
  }
  if (contentType === "markdown") {
    return (
      <div className={styles.fullscreenMarkdown}>
        <div className="codex-markdown">
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={{ table: MarkdownTable }}
          >
            {normalizeMarkdownContent(text || "内容为空")}
          </ReactMarkdown>
        </div>
      </div>
    );
  }
  return (
    <pre
      className={styles.fullscreenSource}
      data-kind={contentType === "diff" ? "diff" : contentType === "json" ? "json" : "source"}
    >
      {contentType === "json" ? formatCode(text) : text || "内容为空"}
    </pre>
  );
}

function getCodeChild(node: ReactNode): { props?: { className?: string; children?: ReactNode } } | null {
  if (Array.isArray(node)) {
    return getCodeChild(node[0]);
  }
  if (node && typeof node === "object" && "props" in node) {
    return node as { props?: { className?: string; children?: ReactNode } };
  }
  return null;
}

function getLanguage(className?: string): string {
  const match = /language-([\w+-]+)/.exec(className ?? "");
  return match?.[1]?.toLowerCase() ?? "text";
}

function buildPanelPreviewRequest(language: string, content: string): ContentPreviewRequest | null {
  if (!content.trim()) {
    return null;
  }
  if (language === "mermaid") {
    return {
      type: "content",
      title: "Mermaid 图表",
      content,
      contentType: "mermaid",
    };
  }
  if (isHtmlPreviewLanguage(language)) {
    return {
      type: "content",
      title: "HTML 预览",
      content,
      contentType: "html",
    };
  }
  if (language === "markdown" || language === "md" || language === "mdx") {
    return {
      type: "content",
      title: "Markdown 预览",
      content,
      contentType: "markdown",
    };
  }
  if (language === "diff" || language === "patch") {
    return {
      type: "content",
      title: "Diff 预览",
      content,
      contentType: "diff",
    };
  }
  if (language === "json") {
    return {
      type: "content",
      title: "JSON 预览",
      content,
      contentType: "json",
    };
  }
  return null;
}

function isMathLanguage(language: string): boolean {
  return language === "math" || language === "latex" || language === "tex";
}

function isFullLatexDocument(source: string): boolean {
  return /\\(documentclass|begin\{document\}|usepackage)\b/.test(source);
}

function isHtmlPreviewLanguage(language: string): boolean {
  return language === "html" || language === "htm" || language === "svg" || language === "xml";
}

function HtmlPreviewFrame({ html, size = "inline" }: { html: string; size?: "inline" | "fullscreen" }) {
  return (
    <div className={styles.htmlPreview} data-size={size} data-testid="html-preview-frame">
      <iframe
        className={styles.htmlPreviewFrame}
        data-size={size}
        title="HTML 预览"
        sandbox=""
        srcDoc={html}
      />
    </div>
  );
}

function MathPreview({ source, size = "inline" }: { source: string; size?: "inline" | "fullscreen" }) {
  const html = useMemo(
    () =>
      katex.renderToString(source, {
        displayMode: true,
        throwOnError: false,
      }),
    [source],
  );

  return (
    <div
      className={styles.mathPreview}
      data-size={size}
      data-testid="math-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

type MermaidPreviewState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

function MermaidPreview({
  code,
  theme,
  interactive = false,
  size = "inline",
}: {
  code: string;
  theme: "light" | "dark";
  interactive?: boolean;
  size?: "inline" | "fullscreen";
}) {
  const [state, setState] = useState<MermaidPreviewState>({ status: "loading" });
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const previewRef = useRef<HTMLDivElement>(null);
  const instanceId = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const renderId = `${instanceId.current}-${hashMermaidCode(code)}`;
    setState({ status: "loading" });
    setScale(1);
    setOffset({ x: 0, y: 0 });

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "default",
          securityLevel: "strict",
          suppressErrorRendering: true,
        });
        await mermaid.parse(code, { suppressErrors: false });
        const renderHost = document.createElement("div");
        renderHost.setAttribute("data-mermaid-render-host", "true");
        renderHost.style.cssText =
          "position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;";
        previewRef.current?.appendChild(renderHost);
        try {
          return await mermaid.render(renderId, code, renderHost);
        } finally {
          renderHost.remove();
        }
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        const svg = typeof result === "string" ? result : result.svg;
        setState({ status: "ready", svg });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : "Mermaid 渲染失败";
        cleanupGlobalMermaidErrors();
        setState({ status: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  useEffect(() => {
    if (!interactive) {
      return;
    }
    const element = previewRef.current;
    if (!element) {
      return;
    }
    const handleNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      setScale((current) => clampMermaidScale(current + (event.deltaY < 0 ? 0.12 : -0.12)));
    };
    element.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleNativeWheel);
  }, [interactive]);

  const zoomBy = (delta: number) => {
    setScale((current) => clampMermaidScale(current + delta));
  };

  const resetTransform = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || state.status !== "ready") {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!interactive || !drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  return (
    <div
      ref={previewRef}
      className={styles.mermaidPreview}
      data-interactive={interactive ? "true" : "false"}
      data-size={size}
      data-testid="mermaid-preview"
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {interactive ? (
        <div className={styles.mermaidControls} aria-label="Mermaid 视图控制" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" aria-label="放大 Mermaid" onClick={() => zoomBy(0.15)}>
            <ZoomIn size={15} />
          </button>
          <button type="button" aria-label="缩小 Mermaid" onClick={() => zoomBy(-0.15)}>
            <ZoomOut size={15} />
          </button>
          <button type="button" aria-label="重置 Mermaid 视图" onClick={resetTransform}>
            <RotateCcw size={15} />
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <div
          className={styles.mermaidSvg}
          aria-label="Mermaid 图表"
          data-interactive={interactive ? "true" : "false"}
          style={{
            transform: interactive ? `translate(${offset.x}px, ${offset.y}px) scale(${scale})` : undefined,
          }}
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : state.status === "error" ? (
        <div className={styles.mermaidStatus} role="alert">
          {state.message}
        </div>
      ) : (
        <div className={styles.mermaidStatus}>正在渲染 Mermaid...</div>
      )}
    </div>
  );
}

function clampMermaidScale(value: number): number {
  return Math.min(3, Math.max(0.35, Math.round(value * 100) / 100));
}

function cleanupGlobalMermaidErrors() {
  document.querySelectorAll(".error-icon, .error-text").forEach((element) => {
    const svg = element.closest("svg");
    const wrapper = svg?.parentElement;
    if (!svg || !wrapper) {
      return;
    }
    if (wrapper.parentElement === document.body && wrapper.id.startsWith("dmermaid-")) {
      wrapper.remove();
      return;
    }
    if (svg.parentElement === document.body && svg.id.startsWith("mermaid-")) {
      svg.remove();
    }
  });
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join("");
  }
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function stripTrailingNewline(text: string): string {
  return text.replace(/\n$/, "");
}

function formatCode(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function getTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function clearSwitchTimer(timerRef: { current: number | null }) {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function hashMermaidCode(code: string): string {
  let hash = 0;
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 31 + code.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function getDiffLineStyle(line: string, theme: "light" | "dark"): CSSProperties {
  const alpha = theme === "dark" ? 0.18 : 0.11;
  if (line.startsWith("+")) {
    return { display: "block", background: `rgba(39, 174, 96, ${alpha})` };
  }
  if (line.startsWith("-")) {
    return { display: "block", background: `rgba(235, 87, 87, ${alpha})` };
  }
  if (line.startsWith("@@")) {
    return { display: "block", background: `rgba(47, 128, 237, ${alpha})`, color: "var(--color-primary-6)" };
  }
  return { display: "block" };
}
