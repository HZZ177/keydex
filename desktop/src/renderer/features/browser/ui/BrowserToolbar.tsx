import type { FormEvent, Ref } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BanknoteArrowDown,
  Download,
  EyeOff,
  Globe,
  MousePointerClick,
  RefreshCw,
  Search,
  Square,
  ZoomIn,
} from "lucide-react";

import type { BrowserProfileMode } from "../domain";

import styles from "./BrowserPanel.module.css";

export interface BrowserToolbarProps {
  readonly address: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly profileMode: BrowserProfileMode;
  readonly zoomFactor: number;
  readonly annotationCount?: number;
  readonly annotationActive?: boolean;
  readonly annotationDisabled?: boolean;
  readonly annotationDisabledReason?: string;
  readonly disabled?: boolean;
  readonly addressInputRef?: Ref<HTMLInputElement>;
  onAddressChange(value: string): void;
  onAddressSubmit(value: string): void;
  onBack?(): void;
  onForward?(): void;
  onReload?(): void;
  onStop?(): void;
  onFind?(): void;
  onZoom?(): void;
  onDownloads?(): void;
  onAnnotations?(): void;
  onAnnotationList?(): void;
  onChromeInteraction?(): void;
}

export function BrowserToolbar({
  address,
  addressInputRef,
  annotationActive = false,
  annotationCount = 0,
  annotationDisabled = false,
  annotationDisabledReason,
  canGoBack,
  canGoForward,
  disabled = false,
  loading,
  profileMode,
  zoomFactor,
  onAddressChange,
  onAddressSubmit,
  onAnnotations,
  onAnnotationList,
  onBack,
  onChromeInteraction,
  onDownloads,
  onFind,
  onForward,
  onReload,
  onStop,
  onZoom,
}: BrowserToolbarProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = address.trim();
    if (value && !disabled) onAddressSubmit(value);
  };

  return (
    <div
      className={styles.toolbar}
      data-app-tooltip-owner="browser-panel"
      data-browser-chrome-tooltips="true"
      onPointerDown={onChromeInteraction}
    >
      <div className={styles.navigationGroup} aria-label="网页导航">
        <ToolbarButton label="后退" disabled={disabled || !canGoBack} onClick={onBack}>
          <ArrowLeft size={15} />
        </ToolbarButton>
        <ToolbarButton label="前进" disabled={disabled || !canGoForward} onClick={onForward}>
          <ArrowRight size={15} />
        </ToolbarButton>
        {loading ? (
          <ToolbarButton label="停止加载" disabled={disabled} onClick={onStop}>
            <Square size={12} />
          </ToolbarButton>
        ) : (
          <ToolbarButton label="刷新" disabled={disabled} onClick={onReload}>
            <RefreshCw size={14} />
          </ToolbarButton>
        )}
      </div>

      <form className={styles.addressForm} onSubmit={submit} role="search">
        <Globe aria-hidden="true" className={styles.addressIcon} size={13} />
        <input
          ref={addressInputRef}
          aria-label="地址或搜索"
          autoCapitalize="none"
          autoComplete="off"
          className={styles.addressInput}
          disabled={disabled}
          onChange={(event) => onAddressChange(event.currentTarget.value)}
          onFocus={onChromeInteraction}
          spellCheck={false}
          placeholder="输入 URL"
          value={address}
        />
      </form>

      <div className={styles.actionGroup} aria-label="浏览器操作">
        {profileMode === "incognito" ? (
          <span aria-label="无痕浏览" className={styles.profileBadge} data-profile="incognito">
            <EyeOff size={12} />
            <span>无痕</span>
          </span>
        ) : null}
        <ToolbarButton compactOnly label="页内查找" disabled={disabled} onClick={onFind}>
          <Search size={14} />
        </ToolbarButton>
        <ToolbarButton compactOnly label={`缩放 ${Math.round(zoomFactor * 100)}%`} disabled={disabled} onClick={onZoom}>
          <ZoomIn size={14} />
        </ToolbarButton>
        <ToolbarButton compactOnly label="下载" disabled={disabled} onClick={onDownloads}>
          <Download size={14} />
        </ToolbarButton>
        {onAnnotations ? (
          <AnnotationModeButton
            active={annotationActive}
            label={annotationActive
              ? "退出批注模式"
              : annotationDisabledReason ?? "网页批注"}
            disabled={disabled || annotationDisabled}
            onClick={onAnnotations}
          />
        ) : null}
        {onAnnotationList ? (
          <ToolbarButton
            label={`查看网页批注${annotationCount ? `（${annotationCount}）` : ""}`}
            disabled={disabled}
            onClick={onAnnotationList}
          >
            <BanknoteArrowDown size={14} />
            {annotationCount ? <span className={styles.toolbarCount}>{annotationCount > 99 ? "99+" : annotationCount}</span> : null}
          </ToolbarButton>
        ) : null}
      </div>
    </div>
  );
}

function AnnotationModeButton({
  active,
  disabled,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={styles.annotationToggle}
      data-active={active ? "true" : "false"}
      data-annotation-toggle="true"
      data-tooltip-label={active ? undefined : label}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <MousePointerClick aria-hidden="true" className={styles.annotationToggleIcon} size={14} />
      <span aria-hidden="true" className={styles.annotationToggleLabel}>
        <span className={styles.annotationToggleText} data-mode-copy="active">批注模式</span>
        <span className={styles.annotationToggleText} data-mode-copy="close">点击关闭</span>
      </span>
    </button>
  );
}

function ToolbarButton({
  active = false,
  children,
  compactOnly = false,
  disabled,
  label,
  onClick,
}: {
  readonly active?: boolean;
  readonly children: React.ReactNode;
  readonly compactOnly?: boolean;
  readonly disabled: boolean;
  readonly label: string;
  onClick?(): void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active ? true : undefined}
      className={styles.toolbarButton}
      data-active={active ? "true" : undefined}
      data-browser-secondary-action={compactOnly ? "true" : undefined}
      data-tooltip-label={label}
      disabled={disabled || !onClick}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
