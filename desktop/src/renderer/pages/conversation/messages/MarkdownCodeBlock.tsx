import { Check, ChevronDown, ChevronUp, Copy, PanelRightOpen } from "lucide-react";
import katex from "katex";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import SyntaxHighlighter from "react-syntax-highlighter";
import { vs, vs2015 } from "react-syntax-highlighter/dist/esm/styles/hljs";

import { useOptionalPreview } from "@/renderer/providers/PreviewProvider";
import type { PreviewRequest } from "@/renderer/providers/previewTypes";

import { copyText } from "./markdown";
import styles from "./MessageText.module.css";

const PREVIEW_LINES = 3;
type ContentPreviewRequest = Extract<PreviewRequest, { type: "content" }>;

export interface MarkdownCodeBlockProps {
  children?: ReactNode;
  defaultViewMode?: "source" | "preview";
}

export function MarkdownCodeBlock({ children, defaultViewMode = "source" }: MarkdownCodeBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [viewMode, setViewMode] = useState<"source" | "preview">(defaultViewMode);
  const [theme, setTheme] = useState<"light" | "dark">(() => getTheme());
  const containerRef = useRef<HTMLDivElement>(null);
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
  const previewLabel = canPreviewHtml ? "HTML" : canPreviewMermaid ? "Mermaid" : null;
  const canRenderMath = isMathLanguage(language) && !isFullLatexDocument(text);
  const canCollapse = !canRenderMath && lines.length > PREVIEW_LINES;
  const isDiff = language === "diff";
  const highlighterTheme = theme === "dark" ? vs2015 : vs;

  useEffect(() => {
    const themeObserver = new MutationObserver(() => setTheme(getTheme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => themeObserver.disconnect();
  }, []);

  useEffect(() => {
    setViewMode(defaultViewMode);
  }, [defaultViewMode, language, text]);

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
              onClick={() => setViewMode((value) => (value === "source" ? "preview" : "source"))}
            >
              {viewMode === "source" ? `预览 ${previewLabel}` : "查看源码"}
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
          {canCollapse ? (
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

      {canPreviewHtml && viewMode === "preview" ? (
        <HtmlPreviewFrame html={text} />
      ) : canPreviewMermaid && viewMode === "preview" ? (
        <MermaidPreview code={text} theme={theme} />
      ) : canRenderMath ? (
        <MathPreview source={text} />
      ) : (
        <div
          className={styles.codeViewport}
          data-collapsed={canCollapse && !expanded ? "true" : "false"}
          data-scroll-axis="x"
          data-testid="markdown-code-viewport"
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
              fontSize: 13,
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

      {canCollapse ? (
        <button className={styles.codeFooter} type="button" onClick={toggleExpanded}>
          {expanded ? "收起代码" : `展开其余 ${lines.length - PREVIEW_LINES} 行`}
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : null}
      {copyState === "failed" ? <span className={styles.codeCopyError}>复制失败</span> : null}
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

function isMathLanguage(language: string): boolean {
  return language === "math" || language === "latex" || language === "tex";
}

function isFullLatexDocument(source: string): boolean {
  return /\\(documentclass|begin\{document\}|usepackage)\b/.test(source);
}

function isHtmlPreviewLanguage(language: string): boolean {
  return language === "html" || language === "htm" || language === "svg" || language === "xml";
}

function HtmlPreviewFrame({ html }: { html: string }) {
  return (
    <div className={styles.htmlPreview} data-testid="html-preview-frame">
      <iframe
        className={styles.htmlPreviewFrame}
        title="HTML 预览"
        sandbox=""
        srcDoc={html}
      />
    </div>
  );
}

function MathPreview({ source }: { source: string }) {
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
      data-testid="math-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

type MermaidPreviewState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

function MermaidPreview({ code, theme }: { code: string; theme: "light" | "dark" }) {
  const [state, setState] = useState<MermaidPreviewState>({ status: "loading" });
  const instanceId = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    const renderId = `${instanceId.current}-${hashMermaidCode(code)}`;
    setState({ status: "loading" });

    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "default",
          securityLevel: "strict",
        });
        return mermaid.render(renderId, code);
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
        setState({ status: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  return (
    <div className={styles.mermaidPreview} data-testid="mermaid-preview">
      {state.status === "ready" ? (
        <div className={styles.mermaidSvg} aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: state.svg }} />
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
