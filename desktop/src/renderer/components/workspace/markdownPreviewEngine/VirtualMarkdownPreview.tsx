import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronRight } from "lucide-react";
import { Virtuoso, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import { smoothScrollElementTo } from "@/renderer/features/annotations/navigation/AnnotationNavigationEffects";

import {
  MarkdownBlockView,
  type MarkdownBlockRendererRegistry,
  type MarkdownInlineImageRenderer,
} from "./renderer";
import type { MarkdownAnnotationIndexItem } from "./annotationIndex";
import type { MarkdownFindIndex } from "./findIndex";
import type { MarkdownBlock, MarkdownDocumentModel } from "./types";
import styles from "../FilePreview.module.css";

export interface VirtualMarkdownPreviewHandle {
  revealAnnotation: (annotationId: string, options?: VirtualMarkdownRevealOptions) => Promise<void>;
  revealBlock: (blockId: string, options?: VirtualMarkdownRevealOptions) => Promise<void>;
  revealFindMatch: (matchId: string, options?: VirtualMarkdownRevealOptions) => Promise<void>;
  revealIndex: (index: number, options?: VirtualMarkdownRevealOptions) => Promise<void>;
}

export interface VirtualMarkdownRevealOptions {
  align?: "start" | "center" | "end";
  behavior?: ScrollBehavior;
  signal?: AbortSignal;
}

export interface VirtualMarkdownPreviewProps {
  activeAnnotationId?: string | null;
  activeBlockId?: string | null;
  activeFindMatchId?: string | null;
  annotationIndex?: MarkdownAnnotationIndexItem[];
  customScrollParent?: HTMLElement | null;
  findIndex?: MarkdownFindIndex | null;
  flashAnnotationId?: string | null;
  model: MarkdownDocumentModel;
  onMountedBlockIdsChange?: (blockIds: string[]) => void;
  registry?: MarkdownBlockRendererRegistry;
  renderImage?: MarkdownInlineImageRenderer;
  rootClassName?: string;
  rootRef?: Ref<HTMLDivElement>;
  rootStyle?: CSSProperties;
  showSourceGutter?: boolean;
}

interface VirtualMarkdownPreviewItem {
  block: MarkdownDocumentModel["blocks"][number];
  collapsed: boolean;
  exiting: boolean;
  foldKind: MarkdownPreviewFoldKind | null;
  foldMotion: boolean;
  renderStateKey: string;
  sectionEndLine: number | null;
}

interface PendingMarkdownPreviewReveal {
  align: "start" | "center" | "end";
  behavior: ScrollBehavior;
  blockId: string;
  id: number;
  onAbort: () => void;
  reject: (reason: unknown) => void;
  resolve: () => void;
  settleTimer: number | null;
  settling: boolean;
  signal: AbortSignal;
  target:
    | { type: "annotation"; annotationId: string; line: number }
    | { type: "block" }
    | { type: "find"; matchId: string };
}

type MarkdownPreviewFoldKind = "block" | "section";
const MARKDOWN_PREVIEW_FOLD_MOTION_MS = 180;

const markdownVirtuosoComponents = {
  Item: MarkdownVirtuosoItem,
};

function MarkdownVirtuosoItem({
  children,
  ...itemProps
}: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return <div {...itemProps}>{children}</div>;
}

export const VirtualMarkdownPreview = forwardRef<VirtualMarkdownPreviewHandle, VirtualMarkdownPreviewProps>(
  function VirtualMarkdownPreview(
    {
      activeBlockId = null,
      activeAnnotationId = null,
      activeFindMatchId = null,
      annotationIndex = [],
      customScrollParent = null,
      findIndex = null,
      flashAnnotationId = null,
      model,
      onMountedBlockIdsChange,
      registry,
      renderImage,
      rootClassName,
      rootRef,
      rootStyle,
      showSourceGutter = false,
    },
    ref,
  ) {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const rootElementRef = useRef<HTMLDivElement | null>(null);
    const foldMotionTimerRef = useRef<number | null>(null);
    const [collapsedBlockIds, setCollapsedBlockIds] = useState<ReadonlySet<string>>(() => new Set());
    const [foldMotionBlockIds, setFoldMotionBlockIds] = useState<ReadonlySet<string>>(() => new Set());
    const pendingRevealRef = useRef<PendingMarkdownPreviewReveal | null>(null);
    const revealSequenceRef = useRef(0);
    const [pendingReveal, setPendingReveal] = useState<{ blockId: string; id: number } | null>(null);
    const [mountedRange, setMountedRange] = useState<ListRange | null>(null);
    const blockIndexById = useMemo(
      () => new Map(model.blocks.map((block) => [block.id, block.index])),
      [model.blocks],
    );
    const headingSectionEndIndexByBlockId = useMemo(
      () => buildHeadingSectionEndIndexByBlockId(model.blocks),
      [model.blocks],
    );
    const annotationRevealTargetById = useMemo(
      () => new Map(
        annotationIndex.flatMap((item) => {
          const firstRange = item.ranges[0];
          if (!firstRange || !item.anchor) {
            return [];
          }
          return [[item.annotation.id, {
            blockId: firstRange.blockId,
            lineEnd: item.anchor.lineEnd,
            lineStart: item.anchor.lineStart,
          }] as const];
        }),
      ),
      [annotationIndex],
    );
    const findMatchBlockId = useMemo(
      () => new Map((findIndex?.matches ?? []).map((match) => [match.id, match.blockId])),
      [findIndex],
    );
    useEffect(() => {
      setCollapsedBlockIds(new Set());
      setFoldMotionBlockIds(new Set());
    }, [model]);

    const activeTargetBlockId = useMemo(() => {
      if (activeBlockId) {
        return activeBlockId;
      }
      if (activeFindMatchId) {
        return findMatchBlockId.get(activeFindMatchId) ?? null;
      }
      if (activeAnnotationId) {
        return annotationRevealTargetById.get(activeAnnotationId)?.blockId ?? null;
      }
      if (flashAnnotationId) {
        return annotationRevealTargetById.get(flashAnnotationId)?.blockId ?? null;
      }
      return null;
    }, [
      activeAnnotationId,
      activeBlockId,
      activeFindMatchId,
      annotationRevealTargetById,
      findMatchBlockId,
      flashAnnotationId,
    ]);
    const activeAnnotationLineRange = activeAnnotationId
      ? annotationRevealTargetById.get(activeAnnotationId) ?? null
      : null;

    useEffect(() => {
      if (!activeTargetBlockId) {
        return;
      }
      setCollapsedBlockIds((current) =>
        expandCollapsedBlockIdsForBlock(model.blocks, headingSectionEndIndexByBlockId, current, activeTargetBlockId),
      );
    }, [activeTargetBlockId, headingSectionEndIndexByBlockId, model.blocks]);

    const findRenderStateByBlockId = useMemo(() => {
      const state = new Map<string, string>();
      (findIndex?.matches ?? []).forEach((match) => {
        const current = state.get(match.blockId) ?? "";
        state.set(
          match.blockId,
          `${current}|${match.id}:${match.sourceStart}:${match.sourceEnd}:${match.id === activeFindMatchId ? "active" : "idle"}`,
        );
      });
      return state;
    }, [activeFindMatchId, findIndex]);
    const annotationRenderStateByBlockId = useMemo(() => {
      const state = new Map<string, string>();
      annotationIndex.forEach((item) => {
        item.ranges.forEach((range) => {
          const current = state.get(range.blockId) ?? "";
          state.set(
            range.blockId,
            `${current}|${item.annotation.id}:${item.annotation.updated_at}:${range.blockLocalStart}-${range.blockLocalEnd}:${item.annotation.id === activeAnnotationId ? "active" : "idle"}:${item.annotation.id === flashAnnotationId ? "flash" : "idle"}`,
          );
        });
      });
      return state;
    }, [activeAnnotationId, annotationIndex, flashAnnotationId]);
    const renderedBlocks = useMemo<VirtualMarkdownPreviewItem[]>(
      () => {
        let hiddenUntilIndex = -1;
        return model.blocks.flatMap((block) => {
          const exiting = block.index < hiddenUntilIndex;
          if (exiting && !foldMotionBlockIds.has(block.id)) {
            return [];
          }
          const foldKind = showSourceGutter && !exiting
            ? markdownPreviewFoldKind(block, model.blocks, headingSectionEndIndexByBlockId)
            : null;
          const collapsed = Boolean(foldKind && collapsedBlockIds.has(block.id));
          const sectionEndIndex = foldKind === "section"
            ? headingSectionEndIndexByBlockId.get(block.id) ?? model.blocks.length
            : null;
          if (collapsed && sectionEndIndex !== null) {
            hiddenUntilIndex = Math.max(hiddenUntilIndex, sectionEndIndex);
          }
          const sectionEndBlock = sectionEndIndex === null ? null : model.blocks[sectionEndIndex - 1] ?? null;
          return [{
            block,
            collapsed,
            exiting,
            foldKind,
            foldMotion: foldMotionBlockIds.has(block.id),
            renderStateKey: [
              model.version,
              findRenderStateByBlockId.get(block.id) ?? "",
              annotationRenderStateByBlockId.get(block.id) ?? "",
              collapsed ? "collapsed" : "expanded",
              exiting ? "exiting" : "visible",
            ].join(":"),
            sectionEndLine: sectionEndBlock?.lineEnd ?? null,
          }];
        });
      },
      [
        annotationRenderStateByBlockId,
        collapsedBlockIds,
        foldMotionBlockIds,
        findRenderStateByBlockId,
        headingSectionEndIndexByBlockId,
        model.blocks,
        model.version,
        showSourceGutter,
      ],
    );
    const mountedBlockIds = useMemo(() => {
      if (renderedBlocks.length <= 0) {
        return [];
      }
      const initialMountedBlockCount = Math.min(renderedBlocks.length, 32);
      if (!mountedRange) {
        return renderedBlocks.slice(0, initialMountedBlockCount).map((item) => item.block.id);
      }
      return renderedBlocks
        .slice(mountedRange.startIndex, mountedRange.endIndex + 1)
        .map((item) => item.block.id);
    }, [mountedRange, renderedBlocks]);
    const mountedHeavyBlockCount = useMemo(() => {
      if (renderedBlocks.length <= 0) {
        return 0;
      }
      const initialMountedBlockCount = Math.min(renderedBlocks.length, 32);
      if (!mountedRange) {
        return renderedBlocks
          .slice(0, initialMountedBlockCount)
          .filter((item) => item.block.type === "fence" || item.block.type === "table").length;
      }
      return renderedBlocks
        .slice(mountedRange.startIndex, mountedRange.endIndex + 1)
        .filter((item) => item.block.type === "fence" || item.block.type === "table").length;
    }, [mountedRange, renderedBlocks]);
    const usesExternalScrollParent = Boolean(customScrollParent);
    const rootClassNames = rootClassName ? `keydex-markdown ${rootClassName}` : "keydex-markdown";
    const rootStyles = {
      ...(usesExternalScrollParent ? {} : { height: "100%" }),
      "--markdown-preview-source-gutter-width": `${calculateMarkdownPreviewGutterWidth(model.lineMap.lineCount)}px`,
      ...rootStyle,
    } as CSSProperties;
    const setRootElement = useCallback((element: HTMLDivElement | null) => {
      rootElementRef.current = element;
      assignReactRef(rootRef, element);
    }, [rootRef]);

    useEffect(() => {
      onMountedBlockIdsChange?.(mountedBlockIds);
    }, [mountedBlockIds, onMountedBlockIdsChange]);

    useLayoutEffect(() => {
      const request = pendingRevealRef.current;
      if (!request || pendingReveal?.id !== request.id || !mountedBlockIds.includes(request.blockId)) {
        return;
      }
      const target = findPendingRevealElement(rootElementRef.current, request);
      if (!target) {
        return;
      }
      if (request.settling) {
        return;
      }
      request.settling = true;
      if (request.behavior === "smooth" && customScrollParent) {
        const top = centeredScrollTop(customScrollParent, target, request.align);
        void smoothScrollElementTo(customScrollParent, top, request.signal)
          .then(() => completePendingReveal(pendingRevealRef, setPendingReveal, request))
          .catch(() => undefined);
        return;
      }
      target.scrollIntoView?.({
        behavior: request.behavior,
        block: request.align,
        inline: "nearest",
      });
      if (request.behavior !== "smooth") {
        completePendingReveal(pendingRevealRef, setPendingReveal, request);
        return;
      }
      request.settleTimer = window.setTimeout(
        () => completePendingReveal(pendingRevealRef, setPendingReveal, request),
        300,
      );
    }, [customScrollParent, mountedBlockIds, pendingReveal, renderedBlocks]);

    useEffect(() => () => {
      if (foldMotionTimerRef.current !== null) {
        window.clearTimeout(foldMotionTimerRef.current);
      }
      cancelPendingReveal(pendingRevealRef, abortError("Markdown preview unmounted"));
    }, []);

    useEffect(() => () => {
      cancelPendingReveal(pendingRevealRef, abortError("Markdown document changed"));
    }, [model]);

    const toggleCollapsedBlock = useCallback((blockId: string) => {
      if (foldMotionTimerRef.current !== null) {
        window.clearTimeout(foldMotionTimerRef.current);
      }
      setFoldMotionBlockIds(markdownPreviewMotionBlockIdsForToggle(
        model.blocks,
        headingSectionEndIndexByBlockId,
        blockId,
      ));
      foldMotionTimerRef.current = window.setTimeout(() => {
        foldMotionTimerRef.current = null;
        setFoldMotionBlockIds(new Set());
      }, MARKDOWN_PREVIEW_FOLD_MOTION_MS);
      setCollapsedBlockIds((current) => {
        const next = new Set(current);
        if (next.has(blockId)) {
          next.delete(blockId);
        } else {
          next.add(blockId);
        }
        return next;
      });
    }, [headingSectionEndIndexByBlockId, model.blocks]);

    const revealIndex = useCallback((index: number, options: VirtualMarkdownRevealOptions = {}) => {
      if (!Number.isInteger(index) || index < 0 || index >= model.blocks.length) {
        return Promise.reject(new Error(`Markdown block index is unavailable: ${index}`));
      }
      const align = options.align ?? "start";
      const signal = options.signal ?? new AbortController().signal;
      if (signal.aborted) {
        return Promise.reject(abortError("Markdown reveal aborted"));
      }
      const block = model.blocks[index];
      const nextCollapsedBlockIds = expandCollapsedBlockIdsForBlock(
        model.blocks,
        headingSectionEndIndexByBlockId,
        collapsedBlockIds,
        block.id,
      );
      if (nextCollapsedBlockIds !== collapsedBlockIds) {
        setCollapsedBlockIds(nextCollapsedBlockIds);
      }
      const visibleIndex = visibleMarkdownPreviewIndexForBlock(
        model.blocks,
        headingSectionEndIndexByBlockId,
        nextCollapsedBlockIds,
        block.id,
        showSourceGutter,
      );
      if (visibleIndex < 0) {
        return Promise.reject(new Error(`Markdown block is not visible: ${block.id}`));
      }
      return beginPendingReveal({
        align,
        behavior: options.behavior ?? "auto",
        blockId: block.id,
        pendingRevealRef,
        revealSequenceRef,
        setPendingReveal,
        signal,
        target: { type: "block" },
        visibleIndex,
        virtuoso: virtuosoRef.current,
      });
    }, [collapsedBlockIds, headingSectionEndIndexByBlockId, model.blocks, showSourceGutter]);

    const revealBlock = useCallback((blockId: string, options: VirtualMarkdownRevealOptions = {}) => {
      const index = blockIndexById.get(blockId);
      return typeof index === "number"
        ? revealIndex(index, options)
        : Promise.reject(new Error(`Markdown block is unavailable: ${blockId}`));
    }, [blockIndexById, revealIndex]);

    const revealAnnotation = useCallback((annotationId: string, options: VirtualMarkdownRevealOptions = {}) => {
      const target = annotationRevealTargetById.get(annotationId);
      if (!target) {
        return Promise.reject(new Error(`Markdown annotation is unavailable: ${annotationId}`));
      }
      return revealTarget({
        blockId: target.blockId,
        options,
        target: { type: "annotation", annotationId, line: target.lineStart },
      });
    }, [annotationRevealTargetById, collapsedBlockIds, headingSectionEndIndexByBlockId, model.blocks, showSourceGutter]);

    const revealFindMatch = useCallback((matchId: string, options: VirtualMarkdownRevealOptions = {}) => {
      const blockId = findMatchBlockId.get(matchId);
      return blockId
        ? revealTarget({ blockId, options, target: { type: "find", matchId } })
        : Promise.reject(new Error(`Markdown find match is unavailable: ${matchId}`));
    }, [collapsedBlockIds, findMatchBlockId, headingSectionEndIndexByBlockId, model.blocks, showSourceGutter]);

    const revealTarget = useCallback(({ blockId, options, target }: {
      blockId: string;
      options: VirtualMarkdownRevealOptions;
      target: PendingMarkdownPreviewReveal["target"];
    }) => {
      const index = blockIndexById.get(blockId);
      if (typeof index !== "number") {
        return Promise.reject(new Error(`Markdown block is unavailable: ${blockId}`));
      }
      const align = options.align ?? "start";
      const signal = options.signal ?? new AbortController().signal;
      const nextCollapsedBlockIds = expandCollapsedBlockIdsForBlock(
        model.blocks,
        headingSectionEndIndexByBlockId,
        collapsedBlockIds,
        blockId,
      );
      if (nextCollapsedBlockIds !== collapsedBlockIds) {
        setCollapsedBlockIds(nextCollapsedBlockIds);
      }
      const visibleIndex = visibleMarkdownPreviewIndexForBlock(
        model.blocks,
        headingSectionEndIndexByBlockId,
        nextCollapsedBlockIds,
        blockId,
        showSourceGutter,
      );
      if (visibleIndex < 0) {
        return Promise.reject(new Error(`Markdown block is not visible: ${blockId}`));
      }
      return beginPendingReveal({
        align,
        behavior: options.behavior ?? "auto",
        blockId,
        pendingRevealRef,
        revealSequenceRef,
        setPendingReveal,
        signal,
        target,
        visibleIndex,
        virtuoso: virtuosoRef.current,
      });
    }, [blockIndexById, collapsedBlockIds, headingSectionEndIndexByBlockId, model.blocks, showSourceGutter]);

    useImperativeHandle(
      ref,
      () => ({ revealAnnotation, revealBlock, revealFindMatch, revealIndex }),
      [revealAnnotation, revealBlock, revealFindMatch, revealIndex],
    );

    return (
      <div
        ref={setRootElement}
        className={rootClassNames}
        data-markdown-active-find-match-id={activeFindMatchId ?? undefined}
        data-markdown-block-count={model.blocks.length}
        data-markdown-find-match-count={findIndex?.matches.length ?? 0}
        data-markdown-model-ready="true"
        data-markdown-mounted-block-count={mountedBlockIds.length}
        data-markdown-mounted-heavy-block-count={mountedHeavyBlockCount}
        data-markdown-pending-reveal-block-id={pendingReveal?.blockId ?? undefined}
        data-markdown-scroll-parent={usesExternalScrollParent ? "external" : "self"}
        data-markdown-virtual-preview="true"
        style={rootStyles}
      >
        <Virtuoso
          components={markdownVirtuosoComponents}
          computeItemKey={(_index, item) => `${item.block.id}:${item.renderStateKey}`}
          customScrollParent={customScrollParent ?? undefined}
          data={renderedBlocks}
          increaseViewportBy={{ bottom: 640, top: 320 }}
          initialItemCount={Math.min(renderedBlocks.length, 32)}
          itemContent={(_index, item) => (
            showSourceGutter ? (
              <MarkdownPreviewBlockFrame
                activeLineEnd={activeAnnotationLineRange?.lineEnd ?? null}
                activeLineStart={activeAnnotationLineRange?.lineStart ?? null}
                block={item.block}
                collapsed={item.collapsed}
                exiting={item.exiting}
                foldKind={item.foldKind}
                foldMotion={item.foldMotion}
                onToggleFold={toggleCollapsedBlock}
                sectionEndLine={item.sectionEndLine}
              >
                {item.collapsed && item.foldKind === "block" ? (
                  <MarkdownPreviewCollapsedBlock block={item.block} />
                ) : (
                  <MarkdownBlockView
                    active={item.block.id === activeBlockId || item.block.id === pendingReveal?.blockId}
                    activeAnnotationId={activeAnnotationId}
                    activeFindMatchId={activeFindMatchId}
                    annotationIndex={annotationIndex}
                    block={item.block}
                    findIndex={findIndex}
                    flashAnnotationId={flashAnnotationId}
                    registry={registry}
                    renderImage={renderImage}
                  />
                )}
              </MarkdownPreviewBlockFrame>
            ) : (
              <MarkdownBlockView
                active={item.block.id === activeBlockId || item.block.id === pendingReveal?.blockId}
                activeAnnotationId={activeAnnotationId}
                activeFindMatchId={activeFindMatchId}
                annotationIndex={annotationIndex}
                block={item.block}
                findIndex={findIndex}
                flashAnnotationId={flashAnnotationId}
                registry={registry}
                renderImage={renderImage}
              />
            )
          )}
          overscan={480}
          rangeChanged={setMountedRange}
          ref={virtuosoRef}
          style={usesExternalScrollParent ? undefined : { height: "100%" }}
        />
      </div>
    );
  },
);

export function calculateMarkdownPreviewGutterWidth(lineCount: number): number {
  const normalizedLineCount = Number.isFinite(lineCount) ? Math.max(1, Math.floor(lineCount)) : 1;
  const lineNumberDigits = String(normalizedLineCount).length;
  return Math.max(50, 26 + lineNumberDigits * 7);
}

function MarkdownPreviewBlockFrame({
  activeLineEnd,
  activeLineStart,
  block,
  children,
  collapsed,
  exiting,
  foldKind,
  foldMotion,
  onToggleFold,
  sectionEndLine,
}: {
  activeLineEnd: number | null;
  activeLineStart: number | null;
  block: MarkdownBlock;
  children: ReactNode;
  collapsed: boolean;
  exiting: boolean;
  foldKind: MarkdownPreviewFoldKind | null;
  foldMotion: boolean;
  onToggleFold: (blockId: string) => void;
  sectionEndLine: number | null;
}) {
  const foldTarget = foldKind === "section" ? "章节" : "内容";
  const foldLabel = `${collapsed ? "展开" : "折叠"}第 ${block.lineStart} 行${foldTarget}`;
  const foldTitle = sectionEndLine && foldKind === "section"
    ? `${foldLabel}（${block.lineStart}-${sectionEndLine} 行）`
    : foldLabel;
  const sectionCollapsedLineCount = sectionEndLine && foldKind === "section"
    ? Math.max(1, sectionEndLine - block.lineEnd)
    : 0;
  const sourceLines = markdownPreviewSourceLines(block, collapsed);

  return (
    <div
      className={styles.markdownPreviewBlock}
      data-collapsed={collapsed ? "true" : "false"}
      data-fold-exiting={exiting ? "true" : undefined}
      data-fold-kind={foldKind ?? undefined}
      data-fold-motion={foldMotion ? "true" : undefined}
      data-markdown-preview-block-frame="true"
      data-markdown-preview-block-id={block.id}
      data-markdown-preview-line-start={block.lineStart}
    >
      <div className={styles.markdownPreviewGutter}>
        {foldKind ? (
          <button
            aria-expanded={!collapsed}
            aria-label={foldLabel}
            className={styles.markdownPreviewFoldButton}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFold(block.id);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title={foldTitle}
            type="button"
          >
            <ChevronRight size={13} />
          </button>
        ) : (
          <span className={styles.markdownPreviewFoldPlaceholder} />
        )}
        <span
          className={styles.markdownPreviewLineNumbers}
          style={{ gridTemplateRows: `repeat(${sourceLines.length}, minmax(18px, 1fr))` }}
        >
          {sourceLines.map((line) => {
            const active = activeLineStart !== null && activeLineEnd !== null &&
              line >= activeLineStart && line <= activeLineEnd;
            return (
              <span
                className={styles.markdownPreviewLineNumber}
                data-active={active ? "true" : undefined}
                data-markdown-preview-line-number="true"
                data-markdown-preview-source-line={line}
                key={line}
              >
                {line}
              </span>
            );
          })}
        </span>
      </div>
      <div className={styles.markdownPreviewBlockContent}>
        {children}
        {collapsed && foldKind === "section" ? (
          <MarkdownPreviewCollapsedSummary lineCount={sectionCollapsedLineCount} />
        ) : null}
      </div>
    </div>
  );
}

function MarkdownPreviewCollapsedBlock({ block }: { block: MarkdownBlock }) {
  const lineCount = markdownPreviewBlockLineSpan(block);
  return (
    <div
      className={styles.markdownPreviewCollapsedBlock}
      data-markdown-preview-collapsed-block="true"
      data-markdown-source-end={block.sourceEnd}
      data-markdown-source-start={block.sourceStart}
    >
      已折叠 {lineCount} 行
    </div>
  );
}

function MarkdownPreviewCollapsedSummary({ lineCount }: { lineCount: number }) {
  return (
    <div
      className={styles.markdownPreviewCollapsedBlock}
      data-markdown-preview-collapsed-section="true"
    >
      已折叠 {lineCount} 行
    </div>
  );
}

function buildHeadingSectionEndIndexByBlockId(blocks: MarkdownBlock[]): Map<string, number> {
  const endIndexByBlockId = new Map<string, number>();
  blocks.forEach((block) => {
    if (block.type !== "heading" || !block.metadata.headingLevel) {
      return;
    }
    const level = block.metadata.headingLevel;
    let endIndex = blocks.length;
    for (let index = block.index + 1; index < blocks.length; index += 1) {
      const candidate = blocks[index];
      if (
        candidate.type === "heading" &&
        candidate.metadata.headingLevel &&
        candidate.metadata.headingLevel <= level
      ) {
        endIndex = index;
        break;
      }
    }
    endIndexByBlockId.set(block.id, endIndex);
  });
  return endIndexByBlockId;
}

function markdownPreviewFoldKind(
  block: MarkdownBlock,
  blocks: MarkdownBlock[],
  headingSectionEndIndexByBlockId: Map<string, number>,
): MarkdownPreviewFoldKind | null {
  if (block.type === "heading") {
    const sectionEndIndex = headingSectionEndIndexByBlockId.get(block.id);
    return typeof sectionEndIndex === "number" && sectionEndIndex > block.index + 1 ? "section" : null;
  }
  return markdownPreviewBlockLineSpan(block) > 1 && blocks.length > 1 ? "block" : null;
}

function markdownPreviewMotionBlockIdsForToggle(
  blocks: MarkdownBlock[],
  headingSectionEndIndexByBlockId: Map<string, number>,
  blockId: string,
): ReadonlySet<string> {
  const block = blocks.find((item) => item.id === blockId);
  const motionBlockIds = new Set<string>([blockId]);
  if (!block || block.type !== "heading") {
    return motionBlockIds;
  }
  const sectionEndIndex = headingSectionEndIndexByBlockId.get(block.id);
  if (typeof sectionEndIndex !== "number" || sectionEndIndex <= block.index + 1) {
    return motionBlockIds;
  }
  for (let index = block.index + 1; index < sectionEndIndex; index += 1) {
    const child = blocks[index];
    if (child) {
      motionBlockIds.add(child.id);
    }
  }
  return motionBlockIds;
}

function markdownPreviewBlockLineSpan(block: MarkdownBlock): number {
  return Math.max(1, block.lineEnd - block.lineStart + 1);
}

function markdownPreviewSourceLines(block: MarkdownBlock, collapsed: boolean): number[] {
  const lineEnd = collapsed ? block.lineStart : block.lineEnd;
  return Array.from({ length: Math.max(1, lineEnd - block.lineStart + 1) }, (_, index) => block.lineStart + index);
}

function findPendingRevealElement(
  root: HTMLElement | null,
  reveal: PendingMarkdownPreviewReveal,
): HTMLElement | null {
  if (!root) {
    return null;
  }
  if (reveal.target.type === "annotation") {
    const annotationTarget = reveal.target;
    const marker = Array.from(root.querySelectorAll<HTMLElement>("[data-annotation-id]"))
      .find((element) => element.dataset.annotationId === annotationTarget.annotationId);
    if (marker) {
      return marker;
    }
  }
  if (reveal.target.type === "find") {
    const findTarget = reveal.target;
    const match = Array.from(root.querySelectorAll<HTMLElement>("[data-find-match-id]"))
      .find((element) => element.dataset.findMatchId === findTarget.matchId);
    if (match) {
      return match;
    }
  }
  const blockFrame = Array.from(root.querySelectorAll<HTMLElement>("[data-markdown-preview-block-id]"))
    .find((element) => element.dataset.markdownPreviewBlockId === reveal.blockId);
  if (reveal.target.type === "annotation") {
    const annotationTarget = reveal.target;
    const lineNumber = Array.from(blockFrame?.querySelectorAll<HTMLElement>("[data-markdown-preview-source-line]") ?? [])
      .find((element) => Number(element.dataset.markdownPreviewSourceLine) === annotationTarget.line);
    if (lineNumber) {
      return lineNumber;
    }
  }
  return Array.from(root.querySelectorAll<HTMLElement>("[data-markdown-block-id]"))
    .find((element) => element.dataset.markdownBlockId === reveal.blockId) ?? null;
}

function beginPendingReveal({
  align,
  behavior,
  blockId,
  pendingRevealRef,
  revealSequenceRef,
  setPendingReveal,
  signal,
  target,
  visibleIndex,
  virtuoso,
}: {
  align: "start" | "center" | "end";
  behavior: ScrollBehavior;
  blockId: string;
  pendingRevealRef: { current: PendingMarkdownPreviewReveal | null };
  revealSequenceRef: { current: number };
  setPendingReveal: (value: { blockId: string; id: number } | null) => void;
  signal: AbortSignal;
  target: PendingMarkdownPreviewReveal["target"];
  visibleIndex: number;
  virtuoso: VirtuosoHandle | null;
}): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError("Markdown reveal aborted"));
  }
  if (!virtuoso) {
    return Promise.reject(new Error("Markdown virtual list is not ready"));
  }
  cancelPendingReveal(pendingRevealRef, abortError("Markdown reveal superseded"));
  const id = ++revealSequenceRef.current;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const current = pendingRevealRef.current;
      if (current?.id !== id) {
        return;
      }
      pendingRevealRef.current = null;
      setPendingReveal(null);
      reject(abortError("Markdown reveal aborted"));
    };
    const request: PendingMarkdownPreviewReveal = {
      align,
      behavior,
      blockId,
      id,
      onAbort,
      reject,
      resolve,
      settleTimer: null,
      settling: false,
      signal,
      target,
    };
    pendingRevealRef.current = request;
    signal.addEventListener("abort", onAbort, { once: true });
    setPendingReveal({ blockId, id });
    virtuoso.scrollToIndex(behavior === "smooth"
      ? { align, behavior, index: visibleIndex }
      : { align, index: visibleIndex });
  });
}

function completePendingReveal(
  pendingRevealRef: { current: PendingMarkdownPreviewReveal | null },
  setPendingReveal: (value: { blockId: string; id: number } | null) => void,
  request: PendingMarkdownPreviewReveal,
): void {
  if (pendingRevealRef.current?.id !== request.id) {
    return;
  }
  pendingRevealRef.current = null;
  if (request.settleTimer !== null) {
    window.clearTimeout(request.settleTimer);
  }
  request.signal.removeEventListener("abort", request.onAbort);
  setPendingReveal(null);
  request.resolve();
}

function cancelPendingReveal(
  pendingRevealRef: { current: PendingMarkdownPreviewReveal | null },
  reason: unknown,
): void {
  const request = pendingRevealRef.current;
  if (!request) {
    return;
  }
  pendingRevealRef.current = null;
  if (request.settleTimer !== null) {
    window.clearTimeout(request.settleTimer);
  }
  request.signal.removeEventListener("abort", request.onAbort);
  request.reject(reason);
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function centeredScrollTop(
  scrollElement: HTMLElement,
  target: HTMLElement,
  align: "start" | "center" | "end",
): number {
  const viewportRect = scrollElement.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTop = scrollElement.scrollTop + targetRect.top - viewportRect.top;
  const alignedTop = align === "center"
    ? targetTop - (scrollElement.clientHeight - targetRect.height) / 2
    : align === "end" ? targetTop - scrollElement.clientHeight + targetRect.height : targetTop;
  return Math.max(0, Math.min(alignedTop, Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight)));
}

function assignReactRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    (ref as { current: T | null }).current = value;
  }
}

function expandCollapsedBlockIdsForBlock(
  blocks: MarkdownBlock[],
  headingSectionEndIndexByBlockId: Map<string, number>,
  collapsedBlockIds: ReadonlySet<string>,
  blockId: string,
): ReadonlySet<string> {
  const targetBlock = blocks.find((block) => block.id === blockId);
  if (!targetBlock || collapsedBlockIds.size <= 0) {
    return collapsedBlockIds;
  }

  let next: Set<string> | null = null;
  const ensureNext = () => {
    if (!next) {
      next = new Set(collapsedBlockIds);
    }
    return next;
  };

  if (collapsedBlockIds.has(targetBlock.id)) {
    ensureNext().delete(targetBlock.id);
  }

  blocks.forEach((block) => {
    if (!collapsedBlockIds.has(block.id) || block.type !== "heading") {
      return;
    }
    const sectionEndIndex = headingSectionEndIndexByBlockId.get(block.id);
    if (typeof sectionEndIndex !== "number") {
      return;
    }
    if (targetBlock.index > block.index && targetBlock.index < sectionEndIndex) {
      ensureNext().delete(block.id);
    }
  });

  return next ?? collapsedBlockIds;
}

function visibleMarkdownPreviewIndexForBlock(
  blocks: MarkdownBlock[],
  headingSectionEndIndexByBlockId: Map<string, number>,
  collapsedBlockIds: ReadonlySet<string>,
  blockId: string,
  showSourceGutter: boolean,
): number {
  let visibleIndex = 0;
  let hiddenUntilIndex = -1;
  for (const block of blocks) {
    if (block.index < hiddenUntilIndex) {
      continue;
    }
    if (block.id === blockId) {
      return visibleIndex;
    }
    const foldKind = showSourceGutter ? markdownPreviewFoldKind(block, blocks, headingSectionEndIndexByBlockId) : null;
    if (foldKind === "section" && collapsedBlockIds.has(block.id)) {
      hiddenUntilIndex = Math.max(hiddenUntilIndex, headingSectionEndIndexByBlockId.get(block.id) ?? blocks.length);
    }
    visibleIndex += 1;
  }
  return -1;
}
