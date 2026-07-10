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
  scrollToAnnotation: (annotationId: string, align?: "start" | "center" | "end") => boolean;
  scrollToBlock: (blockId: string, align?: "start" | "center" | "end") => boolean;
  scrollToFindMatch: (matchId: string, align?: "start" | "center" | "end") => boolean;
  scrollToIndex: (index: number, align?: "start" | "center" | "end") => boolean;
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

interface PendingMarkdownPreviewAnnotationReveal {
  align: "start" | "center" | "end";
  annotationId: string;
  blockId: string;
  line: number;
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
    const [pendingRevealBlockId, setPendingRevealBlockId] = useState<string | null>(null);
    const [pendingAnnotationReveal, setPendingAnnotationReveal] =
      useState<PendingMarkdownPreviewAnnotationReveal | null>(null);
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
            `${current}|${item.annotation.id}:${item.annotation.updated_at}:${item.annotation.id === activeAnnotationId ? "active" : "idle"}:${item.annotation.id === flashAnnotationId ? "flash" : "idle"}`,
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
    const rootStyles = usesExternalScrollParent ? rootStyle : { height: "100%", ...rootStyle };
    const setRootElement = useCallback((element: HTMLDivElement | null) => {
      rootElementRef.current = element;
      assignReactRef(rootRef, element);
    }, [rootRef]);

    useEffect(() => {
      onMountedBlockIdsChange?.(mountedBlockIds);
    }, [mountedBlockIds, onMountedBlockIdsChange]);

    useEffect(() => {
      if (pendingRevealBlockId && mountedBlockIds.includes(pendingRevealBlockId)) {
        setPendingRevealBlockId(null);
      }
    }, [mountedBlockIds, pendingRevealBlockId]);

    useLayoutEffect(() => {
      if (!pendingAnnotationReveal || !mountedBlockIds.includes(pendingAnnotationReveal.blockId)) {
        return;
      }
      const target = findPendingAnnotationRevealElement(rootElementRef.current, pendingAnnotationReveal);
      if (!target) {
        return;
      }
      target.scrollIntoView?.({
        behavior: "smooth",
        block: pendingAnnotationReveal.align,
        inline: "nearest",
      });
      setPendingAnnotationReveal((current) => current === pendingAnnotationReveal ? null : current);
    }, [mountedBlockIds, pendingAnnotationReveal, renderedBlocks]);

    useEffect(() => () => {
      if (foldMotionTimerRef.current !== null) {
        window.clearTimeout(foldMotionTimerRef.current);
      }
    }, []);

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

    const scrollToIndex = useCallback((index: number, align: "start" | "center" | "end" = "start") => {
      if (!Number.isInteger(index) || index < 0 || index >= model.blocks.length) {
        return false;
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
        return false;
      }
      setPendingRevealBlockId(block.id);
      const scroll = () => virtuosoRef.current?.scrollToIndex({ align, index: visibleIndex });
      scroll();
      window.requestAnimationFrame(scroll);
      window.setTimeout(scroll, 60);
      return true;
    }, [collapsedBlockIds, headingSectionEndIndexByBlockId, model.blocks, showSourceGutter]);

    const scrollToBlock = useCallback((blockId: string, align: "start" | "center" | "end" = "start") => {
      const index = blockIndexById.get(blockId);
      return typeof index === "number" ? scrollToIndex(index, align) : false;
    }, [blockIndexById, scrollToIndex]);

    const scrollToAnnotation = useCallback((annotationId: string, align: "start" | "center" | "end" = "start") => {
      const target = annotationRevealTargetById.get(annotationId);
      if (!target || !scrollToBlock(target.blockId, align)) {
        return false;
      }
      setPendingAnnotationReveal({
        align,
        annotationId,
        blockId: target.blockId,
        line: target.lineStart,
      });
      return true;
    }, [annotationRevealTargetById, scrollToBlock]);

    const scrollToFindMatch = useCallback((matchId: string, align: "start" | "center" | "end" = "start") => {
      const blockId = findMatchBlockId.get(matchId);
      return blockId ? scrollToBlock(blockId, align) : false;
    }, [findMatchBlockId, scrollToBlock]);

    useImperativeHandle(
      ref,
      () => ({ scrollToAnnotation, scrollToBlock, scrollToFindMatch, scrollToIndex }),
      [scrollToAnnotation, scrollToBlock, scrollToFindMatch, scrollToIndex],
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
        data-markdown-pending-reveal-block-id={pendingRevealBlockId ?? undefined}
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
                    active={item.block.id === activeBlockId || item.block.id === pendingRevealBlockId}
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
                active={item.block.id === activeBlockId || item.block.id === pendingRevealBlockId}
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

function findPendingAnnotationRevealElement(
  root: HTMLElement | null,
  reveal: PendingMarkdownPreviewAnnotationReveal,
): HTMLElement | null {
  if (!root) {
    return null;
  }
  const marker = Array.from(root.querySelectorAll<HTMLElement>("[data-preview-annotation-id]"))
    .find((element) => element.dataset.previewAnnotationId === reveal.annotationId);
  if (marker) {
    return marker;
  }
  const blockFrame = Array.from(root.querySelectorAll<HTMLElement>("[data-markdown-preview-block-id]"))
    .find((element) => element.dataset.markdownPreviewBlockId === reveal.blockId);
  const lineNumber = Array.from(blockFrame?.querySelectorAll<HTMLElement>("[data-markdown-preview-source-line]") ?? [])
    .find((element) => Number(element.dataset.markdownPreviewSourceLine) === reveal.line);
  if (lineNumber) {
    return lineNumber;
  }
  return Array.from(root.querySelectorAll<HTMLElement>("[data-markdown-block-id]"))
    .find((element) => element.dataset.markdownBlockId === reveal.blockId) ?? null;
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
