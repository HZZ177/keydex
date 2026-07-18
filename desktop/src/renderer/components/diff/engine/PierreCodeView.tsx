import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type {
  CodeViewHandle,
  CodeViewProps,
} from "@pierre/diffs/react";
import type {
  CodeViewItem,
  CodeViewScrollBehavior,
  CodeViewScrollTarget,
  ParsedPatch,
} from "@pierre/diffs";

import type { KeydexDiffDocument, KeydexDiffFile } from "../model";
import type { KeydexDiffLayout, KeydexDiffProfileName } from "../profiles";
import {
  loadPierreDiffs,
  pierreEngineLoadSnapshot,
  retryPierreDiffs,
  subscribePierreEngineLoad,
} from "./loadPierreDiffs";
import {
  createPierreRenderOptions,
  type KeydexDiffTheme,
} from "./pierreOptions";
import { keydexPierreStyle } from "./pierreStyleBridge";
import {
  applyPierreCodeViewVirtualization,
  resolveKeydexDiffVirtualizationPolicy,
  type KeydexDiffVirtualizationPolicy,
} from "../virtualizationPolicy";
import {
  useKeydexDiffScrollBridge,
  type KeydexDiffViewportMetrics,
} from "../diffScroll";
import styles from "./PierreCodeView.module.css";
import {
  KeydexDiffErrorState,
  KeydexDiffLoadingState,
  KeydexDiffRenderBoundary,
} from "../DiffBoundary";
import { KeydexDiffAccessibilityBridge } from "../DiffAccessibility";
import {
  keydexDiffScrollBehavior,
  useKeydexDiffReducedMotion,
} from "../diffKeyboard";

type ParsePatchFiles = typeof import("@pierre/diffs")["parsePatchFiles"];

export interface PierreUnavailableFile {
  readonly file: KeydexDiffFile;
  readonly reason: "non_text" | "truncated" | "parse_failed" | "ambiguous_patch";
  readonly message: string;
}

export interface PierreCodeViewItemsResult {
  readonly items: readonly CodeViewItem<undefined>[];
  readonly unavailable: readonly PierreUnavailableFile[];
}

export interface PierreCodeViewAdapterOptions {
  readonly profile: KeydexDiffProfileName;
  readonly layout?: KeydexDiffLayout;
  readonly wrap?: boolean;
  readonly theme: KeydexDiffTheme;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly disableWorkerPool?: boolean;
  readonly virtualizationPolicy?: KeydexDiffVirtualizationPolicy;
}

export interface PierreCodeViewProps extends PierreCodeViewAdapterOptions {
  readonly document: KeydexDiffDocument;
  readonly activeFileId?: string | null;
  readonly expandedFileIds?: readonly string[];
  readonly scrollBehavior?: CodeViewScrollBehavior;
  readonly scrollScopeKey?: string;
  readonly onViewportMetrics?: (metrics: KeydexDiffViewportMetrics) => void;
}

export function createPierreCodeViewItems(
  document: KeydexDiffDocument,
  parsePatchFiles: ParsePatchFiles,
  expandedFileIds?: readonly string[],
): PierreCodeViewItemsResult {
  const items: CodeViewItem<undefined>[] = [];
  const unavailable: PierreUnavailableFile[] = [];

  document.files.forEach((file) => {
    const blocked = unavailableReason(file);
    if (blocked) {
      unavailable.push(blocked);
      return;
    }
    try {
      const parsedFiles = flattenParsedFiles(
        parsePatchFiles(file.patch, file.cacheKey, true),
      );
      if (parsedFiles.length !== 1) {
        unavailable.push({
          file,
          reason: "ambiguous_patch",
          message: `预期一个文件差异，实际解析出 ${parsedFiles.length} 个。`,
        });
        return;
      }
      const parsed = parsedFiles[0]!;
      const collapsed = expandedFileIds ? !expandedFileIds.includes(file.id) : undefined;
      items.push(Object.freeze({
        id: file.id,
        type: "diff",
        ...(collapsed === undefined ? {} : { collapsed }),
        version: stableVersion(`${document.sourceVersion}\0${file.cacheKey}\0${String(collapsed)}`),
        fileDiff: {
          ...parsed,
          name: file.displayPath,
          ...(file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? { prevName: file.oldPath }
            : {}),
          lang: file.language,
          cacheKey: file.cacheKey,
        },
      }));
    } catch (reason: unknown) {
      unavailable.push({
        file,
        reason: "parse_failed",
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });

  return Object.freeze({
    items: Object.freeze(items),
    unavailable: Object.freeze(unavailable),
  });
}

export function pierreCodeViewProps(
  items: readonly CodeViewItem<undefined>[],
  adapter: PierreCodeViewAdapterOptions,
  viewport?: Pick<CodeViewProps<undefined>, "containerRef" | "onScroll">,
): CodeViewProps<undefined> {
  const options = createPierreRenderOptions({
    kind: "multi",
    profile: adapter.profile,
    theme: adapter.theme,
    ...(adapter.layout ? { layout: adapter.layout } : {}),
    ...(adapter.wrap === undefined ? {} : { wrap: adapter.wrap }),
  });
  return {
    items,
    className: [styles.scrollViewport, adapter.className].filter(Boolean).join(" "),
    style: keydexPierreStyle(adapter.profile, {
      minWidth: 0,
      minHeight: 0,
      height: "100%",
      ...adapter.style,
    }),
    disableWorkerPool: adapter.disableWorkerPool,
    ...viewport,
    options: {
      ...options,
      ...(adapter.virtualizationPolicy
        ? { itemMetrics: adapter.virtualizationPolicy.itemMetrics }
        : {}),
      __devOnlyValidateItemHeights: false,
    },
  };
}

export function PierreCodeView({
  document,
  activeFileId,
  expandedFileIds,
  scrollBehavior = "instant",
  scrollScopeKey = "default",
  onViewportMetrics,
  ...adapter
}: PierreCodeViewProps) {
  const snapshot = useSyncExternalStore(
    subscribePierreEngineLoad,
    pierreEngineLoadSnapshot,
    pierreEngineLoadSnapshot,
  );
  const viewRef = useRef<CodeViewHandle<undefined>>(null);
  const reducedMotion = useKeydexDiffReducedMotion();
  const restorePosition = useCallback((position: number) => {
    viewRef.current?.scrollTo({ type: "position", position, behavior: "instant" });
  }, []);
  const scrollBridge = useKeydexDiffScrollBridge({
    profile: adapter.profile,
    scopeKey: scrollScopeKey,
    documentId: document.id,
    sourceVersion: document.sourceVersion,
    onRestoreRequested: restorePosition,
    onViewportMetrics,
  });

  useEffect(() => {
    void loadPierreDiffs().catch(() => undefined);
  }, []);

  const result = useMemo(
    () => snapshot.module
      ? createPierreCodeViewItems(document, snapshot.module.parsePatchFiles, expandedFileIds)
      : null,
    [document, expandedFileIds, snapshot.module],
  );
  const virtualizationPolicy = useMemo(
    () => adapter.virtualizationPolicy ?? resolveKeydexDiffVirtualizationPolicy(
      document,
      adapter.profile,
      adapter.wrap ?? false,
    ),
    [adapter.profile, adapter.virtualizationPolicy, adapter.wrap, document],
  );
  const props = useMemo(
    () => pierreCodeViewProps(
      result?.items ?? [],
      { ...adapter, virtualizationPolicy },
      { containerRef: scrollBridge.containerRef, onScroll: scrollBridge.onScroll },
    ),
    [result?.items, adapter.profile, adapter.layout, adapter.wrap, adapter.theme, adapter.className, adapter.style, adapter.disableWorkerPool, virtualizationPolicy, scrollBridge.containerRef, scrollBridge.onScroll],
  );

  useEffect(() => {
    applyPierreCodeViewVirtualization(viewRef.current, virtualizationPolicy);
  }, [virtualizationPolicy, result?.items]);

  useEffect(() => {
    const target = pierreCodeViewScrollTarget(
      result?.items ?? [],
      activeFileId,
      keydexDiffScrollBehavior(scrollBehavior, reducedMotion),
    );
    if (target) viewRef.current?.scrollTo(target);
  }, [activeFileId, reducedMotion, scrollBehavior, result?.items]);

  if (snapshot.status === "error") {
    return (
      <KeydexDiffErrorState
        phase="lazy_load"
        profile={adapter.profile}
        documentId={document.id}
        rawSource={document.files.map((file) => file.patch).join("\n")}
        onRetry={() => retryPierreDiffs()}
      />
    );
  }
  if (!snapshot.module || !result) {
    return <KeydexDiffLoadingState profile={adapter.profile} label="正在加载多文件差异" />;
  }

  const CodeView = snapshot.module.CodeView;
  return (
    <KeydexDiffAccessibilityBridge profile={adapter.profile} document={document}>
      <KeydexDiffRenderBoundary
        profile={adapter.profile}
        documentId={document.id}
        rawSource={document.files.map((file) => file.patch).join("\n")}
        resetKey={`${document.id}:${document.sourceVersion}:${snapshot.attempt}`}
        onRetry={() => retryPierreDiffs()}
      >
        <div
          className={styles.scrollHost}
          data-keydex-diff-engine="pierre"
          data-diff-document-id={document.id}
          data-virtualization={virtualizationPolicy.level}
          data-diff-scroll-owner={scrollBridge.owner}
          data-diff-window-scroll="false"
        >
          {result.unavailable.length > 0 ? (
            <div data-keydex-diff-unavailable-files>
              {result.unavailable.map(({ file }) => (
                <KeydexDiffErrorState
                  compact
                  key={file.id}
                  phase="parse"
                  profile={adapter.profile}
                  documentId={document.id}
                  fileId={file.id}
                  rawSource={file.patch}
                />
              ))}
            </div>
          ) : null}
          <CodeView {...props} ref={viewRef} />
        </div>
      </KeydexDiffRenderBoundary>
    </KeydexDiffAccessibilityBridge>
  );
}

export function pierreCodeViewScrollTarget(
  items: readonly CodeViewItem<undefined>[],
  activeFileId: string | null | undefined,
  behavior: CodeViewScrollBehavior = "instant",
): CodeViewScrollTarget | null {
  if (!activeFileId || !items.some((item) => item.id === activeFileId)) return null;
  return { type: "item", id: activeFileId, align: "start", behavior };
}

function flattenParsedFiles(parsed: ParsedPatch[]) {
  return parsed.flatMap((patch) => patch.files);
}

function unavailableReason(file: KeydexDiffFile): PierreUnavailableFile | null {
  if (file.truncated) {
    return { file, reason: "truncated", message: "差异内容不完整，暂不渲染。" };
  }
  if (file.contentKind !== "text") {
    return { file, reason: "non_text", message: "此文件不是可显示的文本差异。" };
  }
  return null;
}

function stableVersion(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
