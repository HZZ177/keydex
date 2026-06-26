import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Virtuoso, type ListRange, type VirtuosoHandle } from "react-virtuoso";

import {
  MarkdownBlockView,
  type MarkdownBlockRendererRegistry,
  type MarkdownInlineImageRenderer,
} from "./renderer";
import type { MarkdownAnnotationIndexItem } from "./annotationIndex";
import type { MarkdownFindIndex } from "./findIndex";
import type { MarkdownDocumentModel } from "./types";

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
  findIndex?: MarkdownFindIndex | null;
  flashAnnotationId?: string | null;
  model: MarkdownDocumentModel;
  onMountedBlockIdsChange?: (blockIds: string[]) => void;
  registry?: MarkdownBlockRendererRegistry;
  renderImage?: MarkdownInlineImageRenderer;
}

interface VirtualMarkdownPreviewItem {
  block: MarkdownDocumentModel["blocks"][number];
  renderStateKey: string;
}

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
      findIndex = null,
      flashAnnotationId = null,
      model,
      onMountedBlockIdsChange,
      registry,
      renderImage,
    },
    ref,
  ) {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const [pendingRevealBlockId, setPendingRevealBlockId] = useState<string | null>(null);
    const [mountedRange, setMountedRange] = useState<ListRange | null>(null);
    const blockIndexById = useMemo(
      () => new Map(model.blocks.map((block) => [block.id, block.index])),
      [model.blocks],
    );
    const firstAnnotationBlockId = useMemo(
      () =>
        new Map(
          annotationIndex
            .filter((item) => item.ranges.length > 0)
            .map((item) => [item.annotation.id, item.ranges[0].blockId]),
        ),
      [annotationIndex],
    );
    const findMatchBlockId = useMemo(
      () => new Map((findIndex?.matches ?? []).map((match) => [match.id, match.blockId])),
      [findIndex],
    );
    const initialMountedBlockCount = Math.min(model.blocks.length, 32);
    const mountedBlockIds = useMemo(() => {
      if (model.blocks.length <= 0) {
        return [];
      }
      if (!mountedRange) {
        return model.blocks.slice(0, initialMountedBlockCount).map((block) => block.id);
      }
      return model.blocks
        .slice(mountedRange.startIndex, mountedRange.endIndex + 1)
        .map((block) => block.id);
    }, [initialMountedBlockCount, model.blocks, mountedRange]);
    const mountedHeavyBlockCount = useMemo(() => {
      if (model.blocks.length <= 0) {
        return 0;
      }
      if (!mountedRange) {
        return model.blocks
          .slice(0, initialMountedBlockCount)
          .filter((block) => block.type === "fence" || block.type === "table").length;
      }
      return model.blocks
        .slice(mountedRange.startIndex, mountedRange.endIndex + 1)
        .filter((block) => block.type === "fence" || block.type === "table").length;
    }, [initialMountedBlockCount, model.blocks, mountedRange]);
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
      () =>
        model.blocks.map((block) => ({
          block,
          renderStateKey: [
            model.version,
            findRenderStateByBlockId.get(block.id) ?? "",
            annotationRenderStateByBlockId.get(block.id) ?? "",
          ].join(":"),
        })),
      [annotationRenderStateByBlockId, findRenderStateByBlockId, model.blocks, model.version],
    );

    useEffect(() => {
      onMountedBlockIdsChange?.(mountedBlockIds);
    }, [mountedBlockIds, onMountedBlockIdsChange]);

    useEffect(() => {
      if (pendingRevealBlockId && mountedBlockIds.includes(pendingRevealBlockId)) {
        setPendingRevealBlockId(null);
      }
    }, [mountedBlockIds, pendingRevealBlockId]);

    const scrollToIndex = useCallback((index: number, align: "start" | "center" | "end" = "start") => {
      if (!Number.isInteger(index) || index < 0 || index >= model.blocks.length) {
        return false;
      }
      const block = model.blocks[index];
      setPendingRevealBlockId(block.id);
      const scroll = () => virtuosoRef.current?.scrollToIndex({ align, index });
      scroll();
      window.requestAnimationFrame(scroll);
      window.setTimeout(scroll, 60);
      return true;
    }, [model.blocks]);

    const scrollToBlock = useCallback((blockId: string, align: "start" | "center" | "end" = "start") => {
      const index = blockIndexById.get(blockId);
      return typeof index === "number" ? scrollToIndex(index, align) : false;
    }, [blockIndexById, scrollToIndex]);

    const scrollToAnnotation = useCallback((annotationId: string, align: "start" | "center" | "end" = "start") => {
      const blockId = firstAnnotationBlockId.get(annotationId);
      return blockId ? scrollToBlock(blockId, align) : false;
    }, [firstAnnotationBlockId, scrollToBlock]);

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
        className="keydex-markdown"
        data-markdown-active-find-match-id={activeFindMatchId ?? undefined}
        data-markdown-block-count={model.blocks.length}
        data-markdown-find-match-count={findIndex?.matches.length ?? 0}
        data-markdown-model-ready="true"
        data-markdown-mounted-block-count={mountedBlockIds.length}
        data-markdown-mounted-heavy-block-count={mountedHeavyBlockCount}
        data-markdown-pending-reveal-block-id={pendingRevealBlockId ?? undefined}
        data-markdown-virtual-preview="true"
        style={{ height: "100%" }}
      >
        <Virtuoso
          components={markdownVirtuosoComponents}
          computeItemKey={(_index, item) => `${item.block.id}:${item.renderStateKey}`}
          data={renderedBlocks}
          increaseViewportBy={{ bottom: 640, top: 320 }}
          initialItemCount={Math.min(model.blocks.length, 32)}
          itemContent={(_index, item) => (
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
          overscan={480}
          rangeChanged={setMountedRange}
          ref={virtuosoRef}
          style={{ height: "100%" }}
        />
      </div>
    );
  },
);
