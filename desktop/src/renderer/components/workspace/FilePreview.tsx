import { Check, Code2, Columns2, Copy, Eye, FileText, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";

import type { RuntimeBridge, WorkspaceMediaResponse, WorkspaceScope } from "@/runtime";
import { MarkdownCodeBlock } from "@/renderer/pages/conversation/messages/MarkdownCodeBlock";
import { MarkdownImage } from "@/renderer/pages/conversation/messages/MarkdownImage";
import { MarkdownTable } from "@/renderer/pages/conversation/messages/MarkdownTable";
import { SelectionToolbar } from "@/renderer/pages/conversation/messages/SelectionToolbar";
import {
  copyText,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownContent,
} from "@/renderer/pages/conversation/messages/markdown";
import { useTextSelection } from "@/renderer/pages/conversation/messages/useTextSelection";
import { useOptionalPreview } from "@/renderer/providers/PreviewProvider";
import type { PreviewContentKind, PreviewRequest } from "@/renderer/providers/previewTypes";

import styles from "./FilePreview.module.css";

export type FilePreviewRequest = PreviewRequest;

export interface FilePreviewProps {
  workspaceId?: string;
  sessionId?: string;
  request: FilePreviewRequest;
  runtime?: RuntimeBridge;
  onQuoteSelection?: (text: string) => void;
}

export function FilePreview({ workspaceId, sessionId, request, runtime, onQuoteSelection }: FilePreviewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const kind = useMemo(() => detectPreviewKind(request), [request]);
  const [content, setContent] = useState("");
  const [media, setMedia] = useState<WorkspaceMediaResponse | null>(null);
  const [loading, setLoading] = useState(request.type === "file");
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const [splitMode, setSplitMode] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const previewContext = useOptionalPreview();
  const previewEntries = previewContext?.entries ?? [];
  const activePreviewId = previewContext?.activeEntryId ?? null;
  const showPreviewTabs = previewEntries.length > 1;
  const selection = useTextSelection(bodyRef, Boolean(onQuoteSelection) && !loading && !error);
  const scope = useMemo(() => workspaceScope({ workspaceId, sessionId }), [workspaceId, sessionId]);

  useEffect(() => {
    let active = true;
    setError(null);
    setMedia(null);
    setCopyState("idle");
    setViewMode(defaultViewMode(request));
    setSplitMode(false);

    if (request.type === "content") {
      setContent(request.content || "");
      setLoading(false);
      return () => {
        active = false;
      };
    }

    if (request.type === "diff") {
      setContent(request.diff || "暂无 diff");
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setContent("");
    if (!scope || !runtime) {
      setError("工作区预览运行时未就绪");
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    const loader =
      kind === "image"
        ? runtime.workspace.readMedia(scope, request.path).then((response) => {
            if (active) {
              setMedia(response);
            }
          })
        : runtime.workspace.readFile(scope, request.path).then((response) => {
            if (active) {
              setContent(response.content);
            }
          });

    void loader
      .catch((reason) => {
        if (active) {
          setError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [kind, scope, runtime, request]);

  const title = previewTitle(request);
  const canPreview = kind === "markdown" || kind === "html" || kind === "diff";
  const canSplit = kind === "markdown" || kind === "html" || kind === "mermaid";
  const subtitle = previewSubtitle(kind, request.type);
  const sourceLabel = previewSourceLabel(request);
  const markdownComponents = useMemo(
    () => ({
      pre: PreviewMarkdownCodeBlock,
      table: MarkdownTable,
      img: (props: Parameters<typeof MarkdownImage>[0]) => (
        <MarkdownImage {...props} workspaceScope={scope} runtime={runtime} sourcePath={sourceLabel} />
      ),
    }),
    [scope, runtime, sourceLabel],
  );
  const markdownContent = kind === "mermaid" ? `\`\`\`mermaid\n${content || ""}\n\`\`\`` : content || "文件为空";

  const renderSourcePane = () => (
    <pre className={kind === "diff" ? styles.diff : styles.content}>{formatSource(content, kind)}</pre>
  );

  const renderPreviewPane = () => {
    if (kind === "markdown" || kind === "mermaid") {
      return (
        <div className={styles.markdownPane}>
          <div className="codex-markdown">
            <ReactMarkdown
              remarkPlugins={markdownRemarkPlugins}
              rehypePlugins={markdownRehypePlugins}
              components={markdownComponents}
            >
              {normalizeMarkdownContent(markdownContent)}
            </ReactMarkdown>
          </div>
        </div>
      );
    }

    if (kind === "html") {
      return (
        <div className={styles.htmlPane}>
          <iframe className={styles.htmlFrame} title="HTML 文件预览" sandbox="" srcDoc={content || "<p>文件为空</p>"} />
        </div>
      );
    }

    if (kind === "diff") {
      return <DiffPreview diff={content || "暂无 diff"} />;
    }

    return renderSourcePane();
  };

  const renderBodyContent = () => {
    if (kind === "image") {
      return <ImagePreview media={media} title={title} sourceLabel={sourceLabel} />;
    }

    if (splitMode && canSplit) {
      return (
        <div className={styles.splitPane} data-testid="preview-split-pane">
          <section className={styles.splitPanel} aria-label="源码内容">
            <div className={styles.splitPanelHeader}>
              <Code2 size={13} />
              <span>源码</span>
            </div>
            <div className={styles.splitPanelBody}>{renderSourcePane()}</div>
          </section>
          <section className={styles.splitPanel} aria-label="渲染预览">
            <div className={styles.splitPanelHeader}>
              <Eye size={13} />
              <span>预览</span>
            </div>
            <div className={styles.splitPanelBody}>{renderPreviewPane()}</div>
          </section>
        </div>
      );
    }

    if (viewMode === "preview" && (canPreview || kind === "mermaid")) {
      return renderPreviewPane();
    }

    return renderSourcePane();
  };

  const handleCopy = async () => {
    try {
      await copyText(content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section className={styles.preview} aria-label="文件预览">
      {showPreviewTabs ? (
        <div className={styles.tabs} role="tablist" aria-label="预览历史">
          {previewEntries.map((entry) => {
            const active = entry.id === activePreviewId;
            return (
              <div key={entry.id} className={styles.tab} data-active={active ? "true" : "false"}>
                <button
                  className={styles.tabMain}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={entry.sourceLabel}
                  onClick={() => previewContext?.switchPreview(entry.id)}
                >
                  <span className={styles.tabTitle}>{entry.title}</span>
                </button>
                <button
                  className={styles.tabClose}
                  type="button"
                  aria-label={`关闭预览 ${entry.title}`}
                  title={`关闭预览 ${entry.title}`}
                  onClick={() => previewContext?.closePreviewEntry(entry.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <header className={styles.header}>
        <div className={styles.titleIcon} aria-hidden="true">
          <FileText size={15} />
        </div>
        <div className={styles.titleGroup}>
          <h3 title={sourceLabel}>{title}</h3>
          <span title={sourceLabel}>{subtitle} · {sourceLabel}</span>
        </div>
        <div className={styles.actions}>
          {canPreview || kind === "mermaid" ? (
            <div className={styles.segmented} aria-label="预览模式">
              <button
                type="button"
                aria-pressed={viewMode === "preview"}
                onClick={() => {
                  setViewMode("preview");
                  setSplitMode(false);
                }}
              >
                <Eye size={13} />
                <span>预览</span>
              </button>
              <button
                type="button"
                aria-pressed={viewMode === "source"}
                onClick={() => {
                  setViewMode("source");
                  setSplitMode(false);
                }}
              >
                <Code2 size={13} />
                <span>源码</span>
              </button>
            </div>
          ) : null}
          {canSplit ? (
            <button
              className={styles.iconButton}
              type="button"
              aria-label={splitMode ? "关闭分屏预览" : "打开分屏预览"}
              aria-pressed={splitMode}
              title={splitMode ? "关闭分屏预览" : "打开分屏预览"}
              onClick={() => {
                setViewMode("preview");
                setSplitMode((current) => !current);
              }}
            >
              <Columns2 size={14} />
            </button>
          ) : null}
          <button
            className={styles.iconButton}
            type="button"
            aria-label="复制预览内容"
            disabled={loading || Boolean(error) || !content}
            onClick={handleCopy}
          >
            {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </header>

      {loading ? <p className={styles.muted}>正在读取文件</p> : null}
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {!loading && !error ? (
        <div className={styles.body} aria-label="预览内容" ref={bodyRef}>
          {renderBodyContent()}
          {onQuoteSelection ? (
            <SelectionToolbar
              selectedText={selection.selectedText}
              position={selection.selectionPosition}
              onQuote={onQuoteSelection}
              onClear={selection.clearSelection}
            />
          ) : null}
        </div>
      ) : null}
      {copyState === "failed" ? <span className={styles.copyError}>复制失败</span> : null}
      {copyState === "copied" ? <span className={styles.copyHint}>已复制</span> : null}
    </section>
  );
}

type PreviewKind = "markdown" | "html" | "diff" | "json" | "code" | "text" | "mermaid" | "image";

function PreviewMarkdownCodeBlock({ children }: { children?: ReactNode }) {
  return <MarkdownCodeBlock defaultViewMode="preview" children={children} />;
}

function workspaceScope({
  workspaceId,
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}): WorkspaceScope | null {
  if (sessionId) {
    return { sessionId };
  }
  if (workspaceId) {
    return { workspaceId };
  }
  return null;
}

function DiffPreview({ diff }: { diff: string }) {
  return (
    <div className={styles.diffPane} aria-label="Diff 渲染内容">
      {diff.split("\n").map((line, index) => (
        <div key={`${index}-${line}`} className={styles.diffLine} data-kind={diffLineKind(line)}>
          <span className={styles.diffLineNo}>{index + 1}</span>
          <code>{line || " "}</code>
        </div>
      ))}
    </div>
  );
}

function defaultViewMode(request: FilePreviewRequest): "preview" | "source" {
  const kind = detectPreviewKind(request);
  return kind === "markdown" || kind === "html" || kind === "diff" || kind === "mermaid" ? "preview" : "source";
}

function detectPreviewKind(request: FilePreviewRequest): PreviewKind {
  if (request.type === "content") {
    return contentKindToPreviewKind(request.contentType);
  }
  if (request.type === "diff") {
    return "diff";
  }
  const path = request.path;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "mdx", "markdown"].includes(ext)) {
    return "markdown";
  }
  if (["html", "htm", "xml"].includes(ext)) {
    return "html";
  }
  if (["diff", "patch"].includes(ext)) {
    return "diff";
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "ico", "avif"].includes(ext)) {
    return "image";
  }
  if (ext === "json") {
    return "json";
  }
  if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "css", "scss", "sql", "yaml", "yml"].includes(ext)) {
    return "code";
  }
  return "text";
}

function contentKindToPreviewKind(kind: PreviewContentKind): PreviewKind {
  if (kind === "mermaid") {
    return "mermaid";
  }
  return kind;
}

function previewSubtitle(kind: PreviewKind, type: FilePreviewRequest["type"]): string {
  if (type === "diff" || kind === "diff") {
    return "Diff 预览";
  }
  switch (kind) {
    case "markdown":
      return "Markdown 预览";
    case "mermaid":
      return "Mermaid 预览";
    case "html":
      return "HTML 预览";
    case "image":
      return "图片预览";
    case "json":
      return "JSON 源码";
    case "code":
      return "代码源码";
    case "text":
      return "文本预览";
  }
}

function formatSource(content: string, kind: PreviewKind): string {
  if (!content) {
    return "文件为空";
  }
  if (kind !== "json") {
    return content;
  }
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function ImagePreview({
  media,
  title,
  sourceLabel,
}: {
  media: WorkspaceMediaResponse | null;
  title: string;
  sourceLabel: string;
}) {
  if (!media) {
    return <div className={styles.imageStatus}>图片未加载</div>;
  }

  return (
    <figure className={styles.imagePane}>
      <img className={styles.imageFrame} src={media.data_url} alt={title || sourceLabel} />
      <figcaption className={styles.imageMeta}>
        <span>{media.media_type}</span>
        <span>{formatBytes(media.size)}</span>
      </figcaption>
    </figure>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function diffLineKind(line: string): "add" | "delete" | "hunk" | "meta" | "context" {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "add";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "delete";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
    return "meta";
  }
  return "context";
}

function previewTitle(request: FilePreviewRequest): string {
  if (request.type === "content") {
    return request.title;
  }
  return fileName(request.path);
}

function previewSourceLabel(request: FilePreviewRequest): string {
  if (request.type === "content") {
    return request.sourcePath ?? "消息内容";
  }
  return request.path;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "文件预览失败";
}
