import { AlertTriangle, Check, Copy, RefreshCw } from "lucide-react";
import {
  Component,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";

import { LoadingSkeletonStack } from "@/renderer/components/loading";
import type { KeydexDiffProfileName } from "./profiles";
import styles from "./DiffBoundary.module.css";

export type KeydexDiffFailurePhase =
  | "lazy_load"
  | "parse"
  | "highlight"
  | "worker"
  | "render";

export interface KeydexDiffFailurePresentation {
  readonly title: string;
  readonly message: string;
  readonly code: string;
  readonly retryable: boolean;
}

export interface KeydexDiffErrorStateProps {
  readonly phase: KeydexDiffFailurePhase;
  readonly profile: KeydexDiffProfileName;
  readonly documentId?: string;
  readonly fileId?: string;
  readonly rawSource?: string;
  readonly onRetry?: () => void | Promise<unknown>;
  readonly compact?: boolean;
  readonly presentation?: KeydexDiffFailurePresentation;
}

export interface KeydexDiffRenderBoundaryProps
  extends Omit<KeydexDiffErrorStateProps, "phase"> {
  readonly children: ReactNode;
  readonly resetKey: string;
}

export function keydexDiffFailurePresentation(
  phase: KeydexDiffFailurePhase,
): KeydexDiffFailurePresentation {
  return Object.freeze(({
    lazy_load: {
      title: "差异组件加载失败",
      message: "显示组件未能完成加载，可以重试，不会影响页面中的其他操作。",
      code: "diff_lazy_load_failed",
      retryable: true,
    },
    parse: {
      title: "此文件的差异无法解析",
      message: "已跳过这个文件，其余可用文件仍会继续显示。",
      code: "diff_parse_failed",
      retryable: false,
    },
    highlight: {
      title: "代码高亮失败",
      message: "暂时无法生成带语法颜色的差异，可以重试。",
      code: "diff_highlight_failed",
      retryable: true,
    },
    worker: {
      title: "后台解析失败",
      message: "后台差异服务未能完成任务，可以重新启动本次解析。",
      code: "diff_worker_failed",
      retryable: true,
    },
    render: {
      title: "差异显示失败",
      message: "这个差异区域遇到问题，页面中的其他内容仍可继续使用。",
      code: "diff_render_failed",
      retryable: true,
    },
  } satisfies Record<KeydexDiffFailurePhase, KeydexDiffFailurePresentation>)[phase]);
}

export function buildKeydexDiffDiagnostic({
  phase,
  profile,
  documentId,
  fileId,
  rawSource,
}: Omit<KeydexDiffErrorStateProps, "onRetry" | "compact" | "presentation">, code?: string): string {
  const presentation = keydexDiffFailurePresentation(phase);
  return JSON.stringify({
    code: code ?? presentation.code,
    phase,
    profile,
    document_id: documentId ?? null,
    file_id: fileId ?? null,
    source_bytes: rawSource ? new TextEncoder().encode(rawSource).byteLength : 0,
    third_party_detail: "已隐藏",
  }, null, 2);
}

export function KeydexDiffLoadingState({
  profile,
  label = "正在准备差异",
}: {
  readonly profile: KeydexDiffProfileName;
  readonly label?: string;
}) {
  return (
    <div
      className={styles.loading}
      data-diff-profile={profile}
      data-keydex-diff-state="loading"
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <LoadingSkeletonStack className={styles.loadingStack} lineCount={4} />
    </div>
  );
}

export function KeydexDiffErrorState({
  phase,
  profile,
  documentId,
  fileId,
  rawSource = "",
  onRetry,
  compact = false,
  presentation: presentationOverride,
}: KeydexDiffErrorStateProps) {
  const presentation = presentationOverride ?? keydexDiffFailurePresentation(phase);
  const [copied, setCopied] = useState<"raw" | "diagnostic" | null>(null);
  const diagnostic = buildKeydexDiffDiagnostic({
    phase,
    profile,
    documentId,
    fileId,
    rawSource,
  }, presentation.code);
  const copy = async (kind: "raw" | "diagnostic", value: string) => {
    if (!value || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setCopied(null);
    }
  };
  return (
    <section
      className={styles.error}
      data-compact={compact ? "true" : "false"}
      data-diff-failure-phase={phase}
      data-diff-profile={profile}
      role="alert"
    >
      <AlertTriangle size={compact ? 15 : 18} aria-hidden="true" />
      <div className={styles.errorContent}>
        <strong>{presentation.title}</strong>
        <span>{presentation.message}</span>
        <div className={styles.actions}>
          {presentation.retryable && onRetry ? (
            <button type="button" onClick={() => void onRetry()}>
              <RefreshCw size={13} aria-hidden="true" />重试
            </button>
          ) : null}
          {rawSource ? (
            <button type="button" onClick={() => void copy("raw", rawSource)}>
              {copied === "raw" ? <Check size={13} /> : <Copy size={13} />}
              {copied === "raw" ? "已复制原文" : "复制原文"}
            </button>
          ) : null}
        </div>
        <details className={styles.diagnostic}>
          <summary>诊断信息</summary>
          <pre>{diagnostic}</pre>
          <button type="button" onClick={() => void copy("diagnostic", diagnostic)}>
            {copied === "diagnostic" ? <Check size={13} /> : <Copy size={13} />}
            {copied === "diagnostic" ? "已复制诊断" : "复制诊断"}
          </button>
        </details>
      </div>
    </section>
  );
}

export class KeydexDiffRenderBoundary extends Component<
  KeydexDiffRenderBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _errorInfo: ErrorInfo): void {
    // Third-party stack traces intentionally stay out of the product surface.
  }

  componentDidUpdate(previous: Readonly<KeydexDiffRenderBoundaryProps>): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { children: _children, resetKey: _resetKey, onRetry, ...errorProps } = this.props;
    return (
      <KeydexDiffErrorState
        {...errorProps}
        phase="render"
        onRetry={() => {
          this.setState({ failed: false });
          return onRetry?.();
        }}
      />
    );
  }
}
