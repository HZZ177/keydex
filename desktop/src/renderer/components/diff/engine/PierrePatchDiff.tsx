import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { PatchDiffProps } from "@pierre/diffs/react";

import type { KeydexDiffFile } from "../model";
import type {
  KeydexDiffDensity,
  KeydexDiffLayout,
  KeydexDiffProfileName,
} from "../profiles";
import {
  KeydexDiffAnnotationSlot,
  toPierreDiffAnnotations,
  type KeydexDiffAnnotation,
} from "../DiffAnnotations";
import {
  fromPierreSelectedLineRange,
  toPierreSelectedLineRange,
  type KeydexDiffSelectionRange,
  type KeydexDiffSelectionSide,
} from "../selectionBridge";
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
  KeydexDiffErrorState,
  KeydexDiffLoadingState,
  KeydexDiffRenderBoundary,
} from "../DiffBoundary";
import { KeydexDiffAccessibilityBridge } from "../DiffAccessibility";

export type { KeydexDiffSelectionRange, KeydexDiffSelectionSide };
export type KeydexDiffLineRange = KeydexDiffSelectionRange;

export interface PierrePatchDiffAdapterOptions {
  readonly profile: KeydexDiffProfileName;
  readonly layout?: KeydexDiffLayout;
  readonly wrap?: boolean;
  readonly theme: KeydexDiffTheme;
  readonly selectedRange?: KeydexDiffLineRange | null;
  readonly onSelectedRangeChange?: (range: KeydexDiffLineRange | null) => void;
  readonly annotations?: readonly KeydexDiffAnnotation[];
  readonly onAnnotationAction?: (annotation: KeydexDiffAnnotation) => void | Promise<void>;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly disableWorkerPool?: boolean;
  readonly density?: KeydexDiffDensity;
}

export interface PierrePatchDiffProps extends PierrePatchDiffAdapterOptions {
  readonly file: KeydexDiffFile;
}

export function pierrePatchDiffProps(
  file: KeydexDiffFile,
  adapter: PierrePatchDiffAdapterOptions,
): PatchDiffProps<KeydexDiffAnnotation> {
  const selectionEnabled = adapter.profile === "git"
    && file.selectableForPatch
    && Boolean(adapter.onSelectedRangeChange);
  const options = createPierreRenderOptions<KeydexDiffAnnotation>({
    kind: "single",
    profile: adapter.profile,
    theme: adapter.theme,
    ...(adapter.layout ? { layout: adapter.layout } : {}),
    ...(adapter.wrap === undefined ? {} : { wrap: adapter.wrap }),
    selectionEnabled,
  });
  return {
    patch: file.patch,
    className: adapter.className,
    style: keydexPierreStyle(adapter.profile, adapter.style, adapter.density),
    disableWorkerPool: adapter.disableWorkerPool,
    selectedLines: toPierreSelectedLineRange(file, adapter.selectedRange),
    lineAnnotations: toPierreDiffAnnotations(file, adapter.annotations ?? []),
    renderAnnotation: ({ metadata }) => (
      <KeydexDiffAnnotationSlot annotation={metadata} onAction={adapter.onAnnotationAction} />
    ),
    options: {
      ...options,
      onLineSelected: selectionEnabled
        ? (range) => adapter.onSelectedRangeChange?.(fromPierreSelectedLineRange(file, range))
        : undefined,
    },
  };
}

export function PierrePatchDiff({ file, ...adapter }: PierrePatchDiffProps) {
  const snapshot = useSyncExternalStore(
    subscribePierreEngineLoad,
    pierreEngineLoadSnapshot,
    pierreEngineLoadSnapshot,
  );
  useEffect(() => {
    void loadPierreDiffs().catch(() => undefined);
  }, []);
  const props = useMemo(
    () => pierrePatchDiffProps(file, adapter),
    [file, adapter.profile, adapter.layout, adapter.wrap, adapter.theme, adapter.selectedRange, adapter.onSelectedRangeChange, adapter.annotations, adapter.onAnnotationAction, adapter.className, adapter.style, adapter.disableWorkerPool, adapter.density],
  );

  if (snapshot.status === "error") {
    return (
      <KeydexDiffErrorState
        phase="lazy_load"
        profile={adapter.profile}
        fileId={file.id}
        rawSource={file.patch}
        onRetry={() => retryPierreDiffs()}
      />
    );
  }
  if (!snapshot.module) {
    return <KeydexDiffLoadingState profile={adapter.profile} label="正在加载差异组件" />;
  }
  const PatchDiff = snapshot.module.PatchDiff;
  return (
    <KeydexDiffAccessibilityBridge
      profile={adapter.profile}
      file={file}
      selection={adapter.selectedRange}
      onClearSelection={adapter.onSelectedRangeChange
        ? () => adapter.onSelectedRangeChange?.(null)
        : undefined}
    >
      <KeydexDiffRenderBoundary
        profile={adapter.profile}
        fileId={file.id}
        rawSource={file.patch}
        resetKey={`${file.id}:${file.cacheKey}:${snapshot.attempt}`}
        onRetry={() => retryPierreDiffs()}
      >
        <div data-keydex-diff-engine="pierre" data-diff-file-id={file.id}>
          <PatchDiff {...props} />
        </div>
      </KeydexDiffRenderBoundary>
    </KeydexDiffAccessibilityBridge>
  );
}

export const toPierreRange = toPierreSelectedLineRange;
export const fromPierreRange = fromPierreSelectedLineRange;
