import JsonView, { type ShouldExpandNodeInitially } from "@uiw/react-json-view";
import { ChevronDown, ChevronUp, Copy, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useCopyFeedback } from "@/renderer/hooks/useCopyFeedback";

import styles from "./JsonTreeViewer.module.css";

export interface JsonTreeViewerProps {
  source: string;
  size?: "inline" | "panel" | "fullscreen";
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonPathSegment = string | number;

interface JsonMatch {
  id: string;
  path: string;
  segments: JsonPathSegment[];
  label: string;
}

type CollapseMode = "default" | "expanded" | "collapsed";

export function JsonTreeViewer({ source, size = "inline" }: JsonTreeViewerProps) {
  const parsed = useMemo(() => parseJson(source), [source]);
  const [query, setQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [collapseMode, setCollapseMode] = useState<CollapseMode>("default");
  const { copyState, showCopyFeedback, resetCopyFeedback } = useCopyFeedback();
  const viewportRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = useMemo(
    () => (parsed.ok && normalizedQuery ? collectMatches(parsed.value, normalizedQuery) : []),
    [normalizedQuery, parsed],
  );
  const activeMatch = matches[activeMatchIndex] ?? null;
  const matchPathSet = useMemo(() => new Set(matches.map((match) => match.path)), [matches]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [normalizedQuery]);

  useEffect(() => {
    resetCopyFeedback();
  }, [resetCopyFeedback, source]);

  useEffect(() => {
    if (activeMatchIndex >= matches.length) {
      setActiveMatchIndex(0);
    }
  }, [activeMatchIndex, matches.length]);

  useEffect(() => {
    if (!activeMatch) {
      return;
    }
    const viewport = viewportRef.current;
    const target = viewport?.querySelector<HTMLElement>(`[data-json-path="${cssEscape(activeMatch.path)}"]`);
    target?.scrollIntoView({ block: "center", inline: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [activeMatch, collapseMode, normalizedQuery]);

  const shouldExpandNodeInitially: ShouldExpandNodeInitially<object> = useCallback(
    (isExpanded, { keys = [] }) => {
      if (!normalizedQuery) {
        return isExpanded;
      }
      return matches.some((match) => isPathPrefix(keys, match.segments));
    },
    [matches, normalizedQuery],
  );

  const moveMatch = (direction: 1 | -1) => {
    if (!matches.length) {
      return;
    }
    setActiveMatchIndex((current) => (current + direction + matches.length) % matches.length);
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(parsed.ok ? stringifyJson(parsed.value) : source);
      showCopyFeedback("copied");
    } catch {
      showCopyFeedback("failed");
    }
  };

  if (!parsed.ok) {
    return (
      <div className={styles.viewer} data-size={size} data-testid="json-tree-viewer">
        <div className={styles.invalid} role="alert">
          <strong>JSON 解析失败</strong>
          <span>{parsed.message}</span>
        </div>
        <pre className={styles.invalidSource}>{source || "内容为空"}</pre>
      </div>
    );
  }

  if (!Array.isArray(parsed.value) && !isPlainObject(parsed.value)) {
    return (
      <div className={styles.viewer} data-size={size} data-testid="json-tree-viewer">
        <div className={styles.toolbar}>
          <div className={styles.primitiveLabel}>JSON 值</div>
          <div className={styles.toolButtons}>
            <button type="button" aria-label="复制 JSON" onClick={copyJson}>
              <Copy size={13} />
              <span>{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}</span>
            </button>
          </div>
        </div>
        <pre className={styles.primitiveValue}>{stringifyJson(parsed.value)}</pre>
      </div>
    );
  }

  return (
    <div className={styles.viewer} data-size={size} data-testid="json-tree-viewer">
      <div className={styles.toolbar}>
        <label className={styles.searchBox}>
          <Search size={14} />
          <input
            type="search"
            aria-label="查找 JSON"
            placeholder="查找 key、value 或 path"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" aria-label="清空 JSON 查找" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          ) : null}
        </label>
        <div className={styles.matchNav} aria-live="polite">
          <span>{normalizedQuery ? `${matches.length ? activeMatchIndex + 1 : 0} / ${matches.length}` : "0 / 0"}</span>
          <button type="button" aria-label="上一个 JSON 查找结果" disabled={!matches.length} onClick={() => moveMatch(-1)}>
            <ChevronUp size={13} />
          </button>
          <button type="button" aria-label="下一个 JSON 查找结果" disabled={!matches.length} onClick={() => moveMatch(1)}>
            <ChevronDown size={13} />
          </button>
        </div>
        <div className={styles.toolButtons}>
          <button type="button" onClick={() => setCollapseMode("expanded")}>
            展开
          </button>
          <button type="button" onClick={() => setCollapseMode("collapsed")}>
            折叠
          </button>
          <button type="button" aria-label="复制 JSON" onClick={copyJson}>
            <Copy size={13} />
            <span>{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}</span>
          </button>
        </div>
      </div>
      <div className={styles.treeShell}>
        {activeMatch ? (
          <button className={styles.activePath} type="button" onClick={() => scrollToMatch(activeMatch.path, viewportRef.current)}>
            {activeMatch.path}
            <span>{activeMatch.label}</span>
          </button>
        ) : null}
        <div ref={viewportRef} className={styles.treeViewport}>
          <JsonView
            key={`${hashText(source)}:${collapseMode}:${normalizedQuery}`}
            className={styles.jsonView}
            value={parsed.value as object}
            collapsed={collapseMode === "expanded" || normalizedQuery ? false : collapseMode === "collapsed" ? 1 : 2}
            shouldExpandNodeInitially={normalizedQuery ? shouldExpandNodeInitially : undefined}
            displayDataTypes={false}
            enableClipboard
            shortenTextAfterLength={96}
            highlightUpdates={false}
            beforeCopy={(copyText, _keyName, value) => stringifyJson((value ?? copyText) as JsonValue)}
            style={jsonViewTheme}
          >
            <JsonView.Row
              render={(props, result) => {
                const segments = normalizePathSegments(result.keys);
                const path = jsonPath(segments);
                const isMatch = matchPathSet.has(path);
                return <div {...props} data-json-path={path} data-match={isMatch ? "true" : "false"} />;
              }}
            />
            <JsonView.KeyName
              render={(props, result) => {
                const segments = normalizePathSegments(result.keys);
                const path = jsonPath(segments);
                const isMatch = matchPathSet.has(path);
                return <span {...props} data-json-path={path} data-match={isMatch ? "true" : "false"} />;
              }}
            />
          </JsonView>
        </div>
      </div>
    </div>
  );
}

const jsonViewTheme = {
  "--w-rjv-font-family": "var(--font-mono)",
  "--w-rjv-background-color": "transparent",
  "--w-rjv-color": "var(--color-text-secondary)",
  "--w-rjv-key-string": "var(--color-accent)",
  "--w-rjv-type-string-color": "var(--color-text-primary)",
  "--w-rjv-type-int-color": "var(--color-primary-6)",
  "--w-rjv-type-float-color": "var(--color-primary-6)",
  "--w-rjv-type-boolean-color": "var(--color-danger)",
  "--w-rjv-type-null-color": "var(--color-text-tertiary)",
  "--w-rjv-arrow-color": "var(--color-text-tertiary)",
  "--w-rjv-line-color": "var(--color-border-subtle)",
  "--w-rjv-copied-color": "var(--color-text-tertiary)",
  "--w-rjv-copied-success-color": "var(--color-accent)",
} as CSSProperties;

function parseJson(source: string): { ok: true; value: JsonValue } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(source || "null") as JsonValue };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "不是有效的 JSON" };
  }
}

function collectMatches(value: JsonValue, query: string): JsonMatch[] {
  const matches: JsonMatch[] = [];
  const visit = (node: JsonValue, segments: JsonPathSegment[], keyName?: JsonPathSegment) => {
    const path = jsonPath(segments);
    const keyText = keyName === undefined ? "" : String(keyName);
    const valueText = primitivePreview(node);
    const pathText = path.toLowerCase();
    const haystacks = [keyText.toLowerCase(), valueText.toLowerCase(), pathText];

    if (segments.length === 0 || haystacks.some((item) => item.includes(query))) {
      matches.push({
        id: path,
        path,
        segments,
        label: valueText || (Array.isArray(node) ? `Array(${node.length})` : isPlainObject(node) ? `Object(${Object.keys(node).length})` : ""),
      });
    }

    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, [...segments, index], index));
    } else if (isPlainObject(node)) {
      Object.entries(node).forEach(([key, child]) => visit(child, [...segments, key], key));
    }
  };

  visit(value, []);
  return matches.filter((match) => match.path !== "$" || "$".includes(query));
}

function primitivePreview(value: JsonValue): string {
  if (Array.isArray(value) || isPlainObject(value)) {
    return "";
  }
  return value === null ? "null" : String(value);
}

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePathSegments(segments: unknown): JsonPathSegment[] {
  if (!Array.isArray(segments)) {
    return [];
  }
  return segments.filter((segment): segment is JsonPathSegment => typeof segment === "string" || typeof segment === "number");
}

function isPathPrefix(prefix: JsonPathSegment[], target: JsonPathSegment[]): boolean {
  return prefix.length <= target.length && prefix.every((segment, index) => segment === target[index]);
}

function jsonPath(segments: JsonPathSegment[]): string {
  if (!segments.length) {
    return "$";
  }
  return segments.reduce<string>((path, segment) => {
    if (typeof segment === "number") {
      return `${path}[${segment}]`;
    }
    return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
  }, "$");
}

function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

function scrollToMatch(path: string, viewport: HTMLElement | null) {
  viewport
    ?.querySelector<HTMLElement>(`[data-json-path="${cssEscape(path)}"]`)
    ?.scrollIntoView({ block: "center", inline: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
