import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  KEYDEX_DIFF_PROFILES,
  type KeydexDiffLayout,
  type KeydexDiffProfileName,
} from "./profiles";
import styles from "./DiffLayoutBridge.module.css";

export interface KeydexDiffLayoutDecision {
  readonly preferredLayout: KeydexDiffLayout;
  readonly effectiveLayout: KeydexDiffLayout;
  readonly wrap: boolean;
  readonly width: number;
  readonly autoDowngraded: boolean;
  readonly splitDisabledReason: string | null;
  readonly splitCollapseWidth: number | null;
  readonly splitRecoveryWidth: number | null;
}

export interface ResolveKeydexDiffLayoutInput {
  readonly profile: KeydexDiffProfileName;
  readonly preferredLayout: KeydexDiffLayout;
  readonly wrap: boolean;
  readonly width: number;
  readonly wasAutoDowngraded?: boolean;
}

export interface KeydexDiffLayoutBridgeProps {
  readonly profile: KeydexDiffProfileName;
  readonly preferredLayout: KeydexDiffLayout;
  readonly wrap: boolean;
  readonly className?: string;
  readonly children: ReactNode | ((decision: KeydexDiffLayoutDecision) => ReactNode);
  readonly onDecisionChange?: (decision: KeydexDiffLayoutDecision) => void;
}

export const KEYDEX_DIFF_SPLIT_THRESHOLDS = Object.freeze({
  git: Object.freeze({ collapse: 640, recover: 704 }),
  preview: Object.freeze({ collapse: 720, recover: 784 }),
} satisfies Partial<Record<KeydexDiffProfileName, { collapse: number; recover: number }>>);

export function resolveKeydexDiffLayout({
  profile,
  preferredLayout,
  wrap,
  width,
  wasAutoDowngraded = false,
}: ResolveKeydexDiffLayoutInput): KeydexDiffLayoutDecision {
  const contract = KEYDEX_DIFF_PROFILES[profile];
  const normalizedWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const threshold = KEYDEX_DIFF_SPLIT_THRESHOLDS[profile as keyof typeof KEYDEX_DIFF_SPLIT_THRESHOLDS];
  const supportsSplit = contract.allowedLayouts.includes("split") && Boolean(threshold);
  const splitRequested = preferredLayout === "split";
  const minimumWidth = wasAutoDowngraded ? threshold?.recover : threshold?.collapse;
  const tooNarrow = splitRequested && supportsSplit && normalizedWidth < (minimumWidth ?? 0);
  const unsupported = splitRequested && !supportsSplit;
  const autoDowngraded = tooNarrow || unsupported;
  const effectiveLayout = autoDowngraded ? "stacked" : preferredLayout;
  const splitDisabledReason = unsupported
    ? `${profileLabel(profile)}仅支持统一布局`
    : tooNarrow
      ? `当前区域宽度不足 ${minimumWidth} 像素，已暂时使用统一布局`
      : null;

  return Object.freeze({
    preferredLayout,
    effectiveLayout,
    wrap,
    width: normalizedWidth,
    autoDowngraded,
    splitDisabledReason,
    splitCollapseWidth: threshold?.collapse ?? null,
    splitRecoveryWidth: threshold?.recover ?? null,
  });
}

export function KeydexDiffLayoutBridge({
  profile,
  preferredLayout,
  wrap,
  className,
  children,
  onDecisionChange,
}: KeydexDiffLayoutBridgeProps) {
  const { hostRef, decision } = useKeydexDiffLayoutBridge({ profile, preferredLayout, wrap });
  useEffect(() => onDecisionChange?.(decision), [decision, onDecisionChange]);

  return (
    <div
      ref={hostRef}
      className={[styles.host, className].filter(Boolean).join(" ")}
      data-keydex-diff-layout-bridge="true"
      data-profile={profile}
      data-layout={decision.effectiveLayout}
      data-preferred-layout={decision.preferredLayout}
      data-wrap={decision.wrap ? "true" : "false"}
      data-auto-downgraded={decision.autoDowngraded ? "true" : "false"}
    >
      {typeof children === "function" ? children(decision) : children}
    </div>
  );
}

export function useKeydexDiffLayoutBridge({
  profile,
  preferredLayout,
  wrap,
}: Omit<ResolveKeydexDiffLayoutInput, "width" | "wasAutoDowngraded">) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const wasAutoDowngraded = useRef(false);
  const decisionRef = useRef<KeydexDiffLayoutDecision | null>(null);
  const inputRef = useRef({ profile, preferredLayout, wrap });
  inputRef.current = { profile, preferredLayout, wrap };
  const hostRef = useCallback((node: HTMLDivElement | null) => setHost(node), []);

  useEffect(() => {
    if (!host) return;
    const publishWidth = (nextWidth: number) => {
      const normalized = Math.max(0, Math.round(nextWidth));
      if (inputRef.current.profile === "git" && decisionRef.current) {
        const nextDecision = resolveKeydexDiffLayout({
          ...inputRef.current,
          width: normalized,
          wasAutoDowngraded: decisionRef.current.autoDowngraded,
        });
        if (sameEffectiveLayoutDecision(decisionRef.current, nextDecision)) return;
      }
      setWidth((current) => current === normalized ? current : normalized);
    };
    publishWidth(host.getBoundingClientRect().width || host.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) publishWidth(entry.contentRect.width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);

  const decision = useMemo(() => resolveKeydexDiffLayout({
    profile,
    preferredLayout,
    wrap,
    width,
    wasAutoDowngraded: wasAutoDowngraded.current,
  }), [preferredLayout, profile, width, wrap]);
  decisionRef.current = decision;

  useEffect(() => {
    wasAutoDowngraded.current = decision.autoDowngraded;
  }, [decision.autoDowngraded]);

  return Object.freeze({ hostRef, decision });
}

function sameEffectiveLayoutDecision(
  left: KeydexDiffLayoutDecision,
  right: KeydexDiffLayoutDecision,
): boolean {
  return left.preferredLayout === right.preferredLayout
    && left.effectiveLayout === right.effectiveLayout
    && left.wrap === right.wrap
    && left.autoDowngraded === right.autoDowngraded
    && left.splitDisabledReason === right.splitDisabledReason;
}

function profileLabel(profile: KeydexDiffProfileName): string {
  return ({
    compact: "对话内差异",
    review: "审阅侧栏",
    git: "Git 差异",
    preview: "文件预览",
  } satisfies Record<KeydexDiffProfileName, string>)[profile];
}
