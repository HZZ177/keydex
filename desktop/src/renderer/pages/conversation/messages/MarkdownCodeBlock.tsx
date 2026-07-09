import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Maximize2,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import katex from "katex";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { AppDialog } from "@/renderer/components/dialog";
import { LoadingSkeleton } from "@/renderer/components/loading";
import {
  MarkdownDocumentModelCache,
  VirtualMarkdownPreview,
} from "@/renderer/components/workspace/markdownPreviewEngine";
import { useOptionalPreview } from "@/renderer/providers/PreviewProvider";
import type { PreviewRequest } from "@/renderer/providers/previewTypes";
import {
  centerMermaidViewport,
  formatMermaidCssPixels,
  normalizeMermaidSvgDimensions,
  preserveMermaidZoomAnchor,
  syncMermaidCanvasPadding,
  type SvgDimensions,
} from "@/renderer/utils/mermaidSvg";
import { getMermaidConfig } from "@/renderer/utils/mermaidConfig";
import { useCopyFeedback } from "@/renderer/hooks/useCopyFeedback";

import { LineChangeTicker } from "./LineChangeTicker";
import { copyText, normalizeMarkdownContent } from "./markdown";
import styles from "./MessageText.module.css";
import { useExpansionScrollAnchor } from "./useExpansionScrollAnchor";

const PREVIEW_LINES = 10;
const VIEW_SWITCH_DELAY_MS = 180;
const COLLAPSED_CODE_HEIGHT = 198;
const CODE_COLLAPSE_ANIMATION_MS = 220;
const CODE_HIGHLIGHTER_STYLE: CSSProperties = {
  margin: 0,
  padding: "10px 14px 12px",
  border: "none",
  background: "transparent",
  color: "var(--color-text-1)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.55,
  overflowX: "visible",
};
const CODE_TAG_PROPS = {
  style: {
    background: "transparent",
    color: "var(--color-text-1)",
    fontFamily: "var(--font-mono)",
  },
};
const CODE_HIGHLIGHTER_STATE_STYLE: CSSProperties = {
  display: "contents",
};
const MERMAID_MIN_SCALE = 0.1;
const MERMAID_MAX_SCALE = 10;
const MERMAID_SCALE_STEP = 0.1;
const MERMAID_FIT_PADDING = 64;
const MERMAID_AUTO_FIT_FRAMES = 40;
const fullscreenMarkdownModelCache = new MarkdownDocumentModelCache(24);
type ContentPreviewRequest = Extract<PreviewRequest, { type: "content" }>;
type SyntaxHighlighterRuntimeProps = {
  language: string;
  PreTag: string;
  wrapLines?: boolean;
  lineProps?: (lineNumber: number) => { style: CSSProperties };
  customStyle: CSSProperties;
  codeTagProps: typeof CODE_TAG_PROPS;
  children: string;
};
type SyntaxHighlighterModule = {
  default: ComponentType<SyntaxHighlighterRuntimeProps & { style: unknown }>;
};
type HighlightStyleModule = {
  vs: unknown;
  vs2015: unknown;
};
type SyntaxHighlighterViewProps = SyntaxHighlighterRuntimeProps & { theme: "light" | "dark" };
type SyntaxHighlighterViewModule = {
  default: ComponentType<SyntaxHighlighterViewProps>;
};

let syntaxHighlighterViewPromise: Promise<SyntaxHighlighterViewModule> | null = null;
let loadedSyntaxHighlighterView: ComponentType<SyntaxHighlighterViewProps> | null = null;

function loadSyntaxHighlighterView(): Promise<SyntaxHighlighterViewModule> {
  if (!syntaxHighlighterViewPromise) {
    syntaxHighlighterViewPromise = Promise.all([
      import("react-syntax-highlighter") as Promise<SyntaxHighlighterModule>,
      import("react-syntax-highlighter/dist/esm/styles/hljs") as Promise<HighlightStyleModule>,
    ])
      .then(([highlighterModule, styleModule]) => {
        const SyntaxHighlighter = highlighterModule.default;

        const SyntaxHighlighterView = function SyntaxHighlighterView({ theme, ...props }: SyntaxHighlighterViewProps) {
          return <SyntaxHighlighter {...props} style={theme === "dark" ? styleModule.vs2015 : styleModule.vs} />;
        };
        loadedSyntaxHighlighterView = SyntaxHighlighterView;

        return {
          default: SyntaxHighlighterView,
        };
      })
      .catch((error: unknown) => {
        syntaxHighlighterViewPromise = null;
        throw error;
      });
  }

  return syntaxHighlighterViewPromise;
}

export function preloadMarkdownCodeBlockRuntime(): Promise<void> {
  return loadSyntaxHighlighterView().then(() => undefined);
}

const LazySyntaxHighlighter = lazy(loadSyntaxHighlighterView);

const LazyJsonTreeViewer = lazy(() =>
  import("@/renderer/components/json/JsonTreeViewer").then((module) => ({
    default: module.JsonTreeViewer,
  })),
);

export interface MarkdownCodeBlockProps {
  children?: ReactNode;
  defaultViewMode?: "source" | "preview";
  streaming?: boolean;
}

export function MarkdownCodeBlock({ children, defaultViewMode, streaming = false }: MarkdownCodeBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const { copyState, showCopyFeedback, resetCopyFeedback } = useCopyFeedback();
  const [viewModeOverride, setViewModeOverride] = useState<"source" | "preview" | null>(null);
  const [pendingViewMode, setPendingViewMode] = useState<"source" | "preview" | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => getTheme());
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceViewportRef = useRef<HTMLDivElement>(null);
  const sourceAnimationRef = useRef<Animation | null>(null);
  const switchTimerRef = useRef<number | null>(null);
  const previewContext = useOptionalPreview();
  const captureExpansionAnchor = useExpansionScrollAnchor();
  const codeChild = getCodeChild(children);
  const className = codeChild?.props?.className;
  const language = getLanguage(className);
  const text = stripTrailingNewline(extractText(codeChild?.props?.children ?? children));
  const panelPreview = useMemo(() => buildPanelPreviewRequest(language, text), [language, text]);
  const displayText = useMemo(() => formatCode(text), [text]);
  const lines = useMemo(() => displayText.split("\n"), [displayText]);
  const previewLines = useMemo(() => lines.slice(0, PREVIEW_LINES), [lines]);
  const canPreviewHtml = isHtmlPreviewLanguage(language);
  const canPreviewMermaid = language === "mermaid";
  const canPreviewMath = isMathLanguage(language) && !isFullLatexDocument(text);
  const canPreviewJson = language === "json";
  const previewLabel = canPreviewHtml
    ? "HTML"
    : canPreviewMermaid
      ? "Mermaid"
      : canPreviewMath
        ? "公式"
        : canPreviewJson
          ? "JSON"
          : null;
  const canOpenFullscreen = Boolean(previewLabel || panelPreview);
  const fullscreenLabel = previewLabel ?? panelPreview?.title ?? language;
  const fullscreenTitle = previewLabel ? `${previewLabel} 预览` : panelPreview?.title ?? `${language} 预览`;
  const panelPreviewEntryId = useMemo(
    () =>
      panelPreview && previewContext
        ? previewEntryIdForRequest(panelPreview, previewContext.activeScopeKey)
        : null,
    [panelPreview, previewContext],
  );
  const panelPreviewActive = Boolean(
    panelPreviewEntryId && previewContext?.panelOpen && previewContext.panelActiveEntryId === panelPreviewEntryId,
  );
  const preferredViewMode = defaultViewMode ?? (previewLabel && !streaming ? "preview" : "source");
  const viewMode = viewModeOverride ?? preferredViewMode;
  const isSwitchingView = pendingViewMode !== null;
  const switchViewMode = pendingViewMode ?? viewMode;
  const overflowLineCount = Math.max(0, lines.length - PREVIEW_LINES);
  const canCollapse = overflowLineCount > 0;
  const showSourceView = !isSwitchingView && viewMode === "source";
  const sourceCollapsed = canCollapse && (!expanded || streaming);
  const showCollapseControls = showSourceView && canCollapse && !streaming;
  const showStreamingLineStatus = showSourceView && streaming && overflowLineCount > 0;
  const isDiff = language === "diff";
  const renderedLines = sourceCollapsed ? previewLines : lines;
  const renderedDisplayText = sourceCollapsed ? previewLines.join("\n") : displayText;

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
    clearSourceAnimation(sourceAnimationRef, sourceViewportRef.current);
    resetCopyFeedback();
    setExpanded(false);
  }, [language, preferredViewMode, resetCopyFeedback, text]);

  useEffect(
    () => () => {
      clearSwitchTimer(switchTimerRef);
      clearSourceAnimation(sourceAnimationRef, sourceViewportRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await copyText(text);
      showCopyFeedback("copied");
    } catch {
      showCopyFeedback("failed");
    }
  };

  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    const viewport = sourceViewportRef.current;
    captureExpansionAnchor(containerRef.current);

    if (!viewport || prefersReducedMotion() || typeof viewport.animate !== "function") {
      setExpanded(nextExpanded);
      return;
    }

    const fromHeight = viewport.getBoundingClientRect().height;
    const targetHeight = nextExpanded
      ? viewport.scrollHeight
      : Math.min(COLLAPSED_CODE_HEIGHT, viewport.scrollHeight);

    clearSourceAnimation(sourceAnimationRef, viewport);
    viewport.dataset.animating = "true";
    viewport.style.height = `${fromHeight}px`;
    viewport.style.maxHeight = "none";
    viewport.style.overflow = "hidden";

    setExpanded(nextExpanded);

    window.requestAnimationFrame(() => {
      const activeViewport = sourceViewportRef.current;
      if (activeViewport !== viewport) {
        return;
      }
      const currentTargetHeight = nextExpanded
        ? viewport.scrollHeight
        : Math.min(COLLAPSED_CODE_HEIGHT, viewport.scrollHeight);
      const animation = viewport.animate(
        [
          { height: `${fromHeight}px`, opacity: nextExpanded ? 0.96 : 1 },
          { height: `${currentTargetHeight || targetHeight}px`, opacity: 1 },
        ],
        {
          duration: CODE_COLLAPSE_ANIMATION_MS,
          easing: "cubic-bezier(0.2, 0, 0.13, 1)",
        },
      );
      sourceAnimationRef.current = animation;

      animation.onfinish = () => {
        if (sourceAnimationRef.current !== animation) {
          return;
        }
        clearSourceAnimation(sourceAnimationRef, viewport);
      };
      animation.oncancel = () => {
        if (sourceAnimationRef.current === animation) {
          clearSourceAnimation(sourceAnimationRef, viewport);
        }
      };
    });
  };

  const setCodeViewMode = (nextViewMode: "source" | "preview") => {
    if (!previewLabel || pendingViewMode || nextViewMode === viewMode) {
      return;
    }
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
    previewContext?.togglePreview(panelPreview);
  };

  return (
    <div
      ref={containerRef}
      className={styles.codeBlock}
      data-has-text-footer={showCollapseControls || showStreamingLineStatus ? "true" : "false"}
      data-language={language}
    >
      <div className={styles.codeHeader}>
        <span className={styles.codeLanguage}>{language}</span>
        <div className={styles.codeActions}>
          {previewLabel ? (
            <div
              className={styles.codeViewSwitch}
              data-mode={switchViewMode}
              role="group"
              aria-label={`${previewLabel} 视图切换`}
            >
              <button
                type="button"
                aria-label="查看源码"
                aria-pressed={switchViewMode === "source"}
                disabled={isSwitchingView}
                onClick={() => setCodeViewMode("source")}
              >
                源码
              </button>
              <button
                type="button"
                aria-label={`预览 ${previewLabel}`}
                aria-pressed={switchViewMode === "preview"}
                disabled={isSwitchingView}
                onClick={() => setCodeViewMode("preview")}
              >
                预览
              </button>
            </div>
          ) : null}
          {canOpenFullscreen ? (
            <button
              className={styles.codeIconButton}
              type="button"
              aria-label={`全屏显示 ${fullscreenLabel}`}
              data-tooltip-label="全屏显示"
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
              aria-label={panelPreviewActive ? `收起预览面板 ${panelPreview.title}` : `在预览面板打开 ${panelPreview.title}`}
              data-tooltip-label={panelPreviewActive ? "收起预览面板" : "打开预览面板"}
              aria-pressed={panelPreviewActive}
              title={panelPreviewActive ? `收起预览面板 ${panelPreview.title}` : `在预览面板打开 ${panelPreview.title}`}
              onClick={openInPanel}
            >
              {panelPreviewActive ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </button>
          ) : null}
          {showCollapseControls ? (
            <button
              className={styles.codeIconButton}
              type="button"
              aria-label={expanded ? "折叠代码" : "展开代码"}
              data-tooltip-label={expanded ? "折叠代码" : "展开代码"}
              onClick={toggleExpanded}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : null}
          <button
            className={styles.codeIconButton}
            type="button"
            aria-label="复制代码"
            data-tooltip-label="复制代码"
            onClick={handleCopy}
          >
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
      ) : canPreviewJson && viewMode === "preview" ? (
        <Suspense fallback={<CodeViewLoading targetMode="preview" />}>
          <LazyJsonTreeViewer source={text} size="inline" />
        </Suspense>
      ) : (
        <div
          ref={sourceViewportRef}
          className={styles.codeViewport}
          data-collapsed={sourceCollapsed ? "true" : "false"}
          data-scroll-axis="x"
          data-testid="markdown-code-viewport"
        >
          <SourceCodeHighlighter
            displayText={renderedDisplayText}
            language={language}
            lines={renderedLines}
            isDiff={isDiff}
            theme={theme}
          />
        </div>
      )}

      {showStreamingLineStatus ? (
        <div className={styles.codeGenerationFooter} aria-live="polite">
          <LineChangeTicker label="正在生成内容" added={overflowLineCount} />
        </div>
      ) : null}
      {showCollapseControls ? (
        <button className={styles.codeFooter} type="button" onClick={toggleExpanded}>
          {expanded ? "收起代码" : `展开其余 ${overflowLineCount} 行`}
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

const SourceCodeHighlighter = memo(function SourceCodeHighlighter({
  displayText,
  language,
  lines,
  isDiff,
  theme,
}: {
  displayText: string;
  language: string;
  lines: string[];
  isDiff: boolean;
  theme: "light" | "dark";
}) {
  const lineProps = useMemo(
    () =>
      isDiff
        ? (lineNumber: number) => ({
            style: getDiffLineStyle(lines[lineNumber - 1] ?? ""),
          })
        : undefined,
    [isDiff, lines, theme],
  );
  const highlighterProps = {
    language,
    theme,
    PreTag: "div",
    wrapLines: isDiff,
    lineProps,
    customStyle: CODE_HIGHLIGHTER_STYLE,
    codeTagProps: CODE_TAG_PROPS,
    children: displayText,
  } satisfies SyntaxHighlighterViewProps;
  const SyntaxHighlighterView = loadedSyntaxHighlighterView;

  if (SyntaxHighlighterView) {
    return (
      <div data-markdown-code-highlighter-state="ready" style={CODE_HIGHLIGHTER_STATE_STYLE}>
        <SyntaxHighlighterView {...highlighterProps} />
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div data-markdown-code-highlighter-state="fallback" style={CODE_HIGHLIGHTER_STATE_STYLE}>
          <PlainCodeBlock displayText={displayText} />
        </div>
      }
    >
      <div data-markdown-code-highlighter-state="ready" style={CODE_HIGHLIGHTER_STATE_STYLE}>
        <LazySyntaxHighlighter {...highlighterProps} />
      </div>
    </Suspense>
  );
});

function PlainCodeBlock({ displayText }: { displayText: string }) {
  return (
    <pre style={{ ...CODE_HIGHLIGHTER_STYLE, whiteSpace: "pre" }}>
      <code style={CODE_TAG_PROPS.style}>{displayText}</code>
    </pre>
  );
}

function clearSourceAnimation(animationRef: { current: Animation | null }, element: HTMLElement | null) {
  const animation = animationRef.current;
  if (animation) {
    animation.onfinish = null;
    animation.oncancel = null;
    animation.cancel();
    animationRef.current = null;
  }

  if (!element) {
    return;
  }
  delete element.dataset.animating;
  element.style.height = "";
  element.style.maxHeight = "";
  element.style.overflow = "";
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
  return (
    <AppDialog
      title={title}
      size="fullscreen"
      placement="fullscreen"
      backdrop="preview"
      closeLabel="关闭全屏预览"
      onClose={onClose}
    >
      {children}
    </AppDialog>
  );
}

function CodeViewLoading({ targetMode: _targetMode }: { targetMode: "source" | "preview" | null }) {
  return (
    <LoadingSkeleton aria-label="正在切换代码视图" className={styles.codeViewLoading} lineCount={3} width="compact" />
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
  if (contentType === "json" || language === "json") {
    return (
      <Suspense fallback={<CodeViewLoading targetMode="preview" />}>
        <LazyJsonTreeViewer source={text} size="fullscreen" />
      </Suspense>
    );
  }
  if (contentType === "markdown") {
    return <FullscreenMarkdownPreview source={text || "内容为空"} />;
  }
  return (
    <pre className={styles.fullscreenSource} data-kind={contentType === "diff" ? "diff" : "source"}>
      {text || "内容为空"}
    </pre>
  );
}

function FullscreenMarkdownPreview({ source }: { source: string }) {
  const normalizedSource = useMemo(() => normalizeMarkdownContent(source), [source]);
  const model = useMemo(
    () =>
      fullscreenMarkdownModelCache.getOrCreate({
        cacheKey: "message-code-fullscreen",
        idPrefix: "message-code-fullscreen",
        source: normalizedSource,
      }),
    [normalizedSource],
  );

  return (
    <div className={styles.fullscreenMarkdown}>
      <VirtualMarkdownPreview model={model} />
    </div>
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

function previewEntryIdForRequest(request: PreviewRequest, scopeKey: string): string {
  if (request.type === "file" || request.type === "local-file") {
    return `${scopeKey}:file:${request.path}`;
  }
  if (request.type === "diff") {
    return `${scopeKey}:diff:${request.path}:${hashPreviewText(request.diff)}`;
  }
  return `${scopeKey}:content:${request.contentType}:${request.title}:${hashPreviewText(request.content)}`;
}

function hashPreviewText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
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
  | { status: "ready"; svg: string; dimensions: SvgDimensions | null }
  | { status: "error"; message: string };

interface MermaidDragState {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
}

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
  const previewRef = useRef<HTMLDivElement>(null);
  const instanceId = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);
  const dragRef = useRef<MermaidDragState | null>(null);
  const autoFitRef = useRef(true);
  const centerFrameRef = useRef<number | null>(null);
  const autoFitFrameRef = useRef<number | null>(null);
  const autoFitAttemptRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const renderId = `${instanceId.current}-${hashMermaidCode(code)}`;
    setState({ status: "loading" });
    setScale(1);
    autoFitRef.current = true;

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize(getMermaidConfig(theme));
        await mermaid.parse(code, { suppressErrors: false });
        const renderHost = document.createElement("div");
        renderHost.setAttribute("data-mermaid-render-host", "true");
        renderHost.style.cssText =
          "position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;";
        document.body.appendChild(renderHost);
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
        const normalized = normalizeMermaidSvgDimensions(svg);
        setState({ status: "ready", svg: normalized.svg, dimensions: normalized.dimensions });
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

  const cancelCenterViewport = useCallback(() => {
    if (centerFrameRef.current !== null) {
      window.cancelAnimationFrame(centerFrameRef.current);
      centerFrameRef.current = null;
    }
  }, []);

  const scheduleCenterViewport = useCallback((viewport: HTMLElement, dimensions: SvgDimensions, nextScale: number) => {
    if (!autoFitRef.current) {
      return;
    }
    cancelCenterViewport();
    centerMermaidViewport(viewport, dimensions, nextScale);
    centerFrameRef.current = window.requestAnimationFrame(() => {
      centerFrameRef.current = null;
      if (autoFitRef.current) {
        centerMermaidViewport(viewport, dimensions, nextScale);
      }
    });
  }, [cancelCenterViewport]);

  const cancelAutoFitLoop = useCallback(() => {
    if (autoFitFrameRef.current !== null) {
      window.cancelAnimationFrame(autoFitFrameRef.current);
      autoFitFrameRef.current = null;
    }
    cancelCenterViewport();
  }, [cancelCenterViewport]);

  const fitMermaidToViewport = useCallback(() => {
    if (!interactive || state.status !== "ready" || !state.dimensions) {
      return false;
    }
    const viewport = previewRef.current;
    if (!viewport) {
      return false;
    }
    syncMermaidCanvasPadding(viewport);
    const next = calculateMermaidFitScale(viewport, state.dimensions);
    if (next === null) {
      return false;
    }
    setScale((current) => (current === next ? current : next));
    scheduleCenterViewport(viewport, state.dimensions, next);
    return true;
  }, [interactive, scheduleCenterViewport, state]);

  const scheduleAutoFitLoop = useCallback(() => {
    cancelAutoFitLoop();
    autoFitAttemptRef.current = 0;

    const tick = () => {
      autoFitFrameRef.current = null;
      if (!autoFitRef.current) {
        return;
      }

      fitMermaidToViewport();
      autoFitAttemptRef.current += 1;

      if (autoFitAttemptRef.current < MERMAID_AUTO_FIT_FRAMES) {
        autoFitFrameRef.current = window.requestAnimationFrame(tick);
      }
    };

    autoFitFrameRef.current = window.requestAnimationFrame(tick);
  }, [cancelAutoFitLoop, fitMermaidToViewport]);

  const zoomBy = useCallback((delta: number, focus?: { clientX: number; clientY: number }) => {
    autoFitRef.current = false;
    cancelAutoFitLoop();
    setScale((current) => {
      const next = clampMermaidScale(current + delta);
      const viewport = previewRef.current;
      if (focus && viewport && next !== current) {
        preserveMermaidZoomAnchor(viewport, current, next, focus);
      }
      return next;
    });
  }, [cancelAutoFitLoop]);

  const resetTransform = () => {
    autoFitRef.current = true;
    if (state.status !== "ready" || !state.dimensions) {
      setScale(1);
      return;
    }
    scheduleAutoFitLoop();
  };

  useLayoutEffect(() => {
    if (!interactive || !autoFitRef.current) {
      return;
    }
    scheduleAutoFitLoop();
  }, [interactive, scheduleAutoFitLoop]);

  useEffect(() => {
    if (!interactive || state.status !== "ready" || !state.dimensions || typeof ResizeObserver === "undefined") {
      return;
    }
    const viewport = previewRef.current;
    if (!viewport) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (autoFitRef.current) {
        scheduleAutoFitLoop();
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [interactive, scheduleAutoFitLoop, state]);

  useEffect(() => {
    return () => {
      if (centerFrameRef.current !== null) {
        window.cancelAnimationFrame(centerFrameRef.current);
      }
      cancelAutoFitLoop();
    };
  }, [cancelAutoFitLoop]);

  useEffect(() => {
    if (!interactive || state.status !== "ready") {
      return;
    }
    const element = previewRef.current;
    if (!element) {
      return;
    }
    const handleNativeWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) === 0) {
        return;
      }
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? MERMAID_SCALE_STEP : -MERMAID_SCALE_STEP, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };
    element.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleNativeWheel);
  }, [interactive, state.status, zoomBy]);

  const zoomFromViewportCenter = (delta: number) => {
    const viewport = previewRef.current;
    if (!viewport) {
      zoomBy(delta);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    zoomBy(delta, {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || state.status !== "ready" || event.button > 0) {
      return;
    }
    autoFitRef.current = false;
    cancelAutoFitLoop();
    dragRef.current = {
      pointerId: pointerIdValue(event),
      startX: pointerCoordinate(event.clientX),
      startY: pointerCoordinate(event.clientY),
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    };
    event.currentTarget.dataset.dragging = "true";
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!interactive || !drag || drag.pointerId !== pointerIdValue(event)) {
      return;
    }
    event.currentTarget.scrollLeft = drag.scrollLeft - (pointerCoordinate(event.clientX) - drag.startX);
    event.currentTarget.scrollTop = drag.scrollTop - (pointerCoordinate(event.clientY) - drag.startY);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== pointerIdValue(event)) {
      return;
    }
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const scaleLabel = formatMermaidScale(scale);
  const usesLayoutScale = state.status === "ready" && interactive && Boolean(state.dimensions);
  const renderDimensions =
    state.status === "ready" && interactive && state.dimensions
      ? {
          "--mermaid-render-width": formatMermaidCssPixels(state.dimensions.width * scale),
          "--mermaid-render-height": formatMermaidCssPixels(state.dimensions.height * scale),
        }
      : null;

  const controls = interactive ? (
    <div className={styles.mermaidControls} aria-label="Mermaid 视图控制" onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" aria-label="缩小 Mermaid" onClick={() => zoomFromViewportCenter(-MERMAID_SCALE_STEP)}>
        <ZoomOut size={15} />
      </button>
      <span className={styles.mermaidScaleValue} aria-label={`当前缩放 ${scaleLabel}`}>
        {scaleLabel}
      </span>
      <button type="button" aria-label="放大 Mermaid" onClick={() => zoomFromViewportCenter(MERMAID_SCALE_STEP)}>
        <ZoomIn size={15} />
      </button>
      <button type="button" aria-label="重置 Mermaid 视图" onClick={resetTransform}>
        <RotateCcw size={15} />
      </button>
    </div>
  ) : null;
  const previewContent =
    state.status === "ready" ? (
      <div
        className={styles.mermaidSvg}
        aria-label="Mermaid 图表"
        data-interactive={interactive ? "true" : "false"}
        data-sized={usesLayoutScale ? "true" : "false"}
        style={
          {
            "--mermaid-scale": scale,
            ...renderDimensions,
          } as CSSProperties
        }
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    ) : state.status === "error" ? (
      <div className={styles.mermaidStatus} role="alert">
        {state.message}
      </div>
    ) : (
      <div className={styles.mermaidStatus} aria-hidden="true" />
    );
  const preview = (
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
      {size === "fullscreen" ? null : controls}
      {previewContent}
    </div>
  );

  if (interactive && size === "fullscreen") {
    return (
      <div className={styles.mermaidFullscreenShell}>
        {controls}
        {preview}
      </div>
    );
  }

  return preview;
}

function clampMermaidScale(value: number): number {
  return Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, Math.round(value * 100) / 100));
}

function calculateMermaidFitScale(viewport: HTMLElement, dimensions: SvgDimensions): number | null {
  const availableWidth = viewport.clientWidth - MERMAID_FIT_PADDING;
  const availableHeight = viewport.clientHeight - MERMAID_FIT_PADDING;
  if (availableWidth <= 0 || availableHeight <= 0) {
    return null;
  }
  return clampMermaidScale(Math.min(availableWidth / dimensions.width, availableHeight / dimensions.height));
}

function formatMermaidScale(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function pointerIdValue(event: ReactPointerEvent<HTMLElement>): number {
  return Number.isFinite(event.pointerId) ? event.pointerId : 1;
}

function pointerCoordinate(value: number): number {
  return Number.isFinite(value) ? value : 0;
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

function getDiffLineStyle(line: string): CSSProperties {
  if (line.startsWith("+")) {
    return { display: "block", background: "var(--diff-added-bg)", color: "var(--diff-added-text)" };
  }
  if (line.startsWith("-")) {
    return { display: "block", background: "var(--diff-removed-bg)", color: "var(--diff-removed-text)" };
  }
  if (line.startsWith("@@")) {
    return { display: "block", background: "var(--diff-hunk-bg)", color: "var(--diff-hunk-text)" };
  }
  return { display: "block" };
}
