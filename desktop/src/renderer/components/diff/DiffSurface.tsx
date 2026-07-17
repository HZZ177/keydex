import type { HTMLAttributes, ReactNode } from "react";

import type { KeydexDiffProfileName } from "./profiles";
import styles from "./DiffSurface.module.css";

export type KeydexDiffScrollOwner = "viewer" | "host";

export interface KeydexDiffSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly profile: KeydexDiffProfileName;
  readonly embedded?: boolean;
  readonly scrollOwner?: KeydexDiffScrollOwner;
  readonly children: ReactNode;
}

export function KeydexDiffSurface({
  profile,
  embedded = false,
  scrollOwner = "viewer",
  children,
  className,
  ...props
}: KeydexDiffSurfaceProps) {
  return (
    <div
      {...props}
      className={[styles.surface, className].filter(Boolean).join(" ")}
      data-keydex-diff-surface=""
      data-profile={profile}
      data-embedded={embedded ? "true" : "false"}
      data-scroll-owner={scrollOwner}
    >
      {children}
    </div>
  );
}

export interface KeydexDiffQuietStateProps {
  readonly title: string;
  readonly detail?: string;
  readonly tone?: "neutral" | "error";
}

export function KeydexDiffQuietState({
  title,
  detail,
  tone = "neutral",
}: KeydexDiffQuietStateProps) {
  return (
    <div
      className={styles.quietState}
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
      aria-label={title}
    >
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}
