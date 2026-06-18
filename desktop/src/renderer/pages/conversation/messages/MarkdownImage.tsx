import { ImageOff } from "lucide-react";
import { useEffect, useMemo, useState, type ImgHTMLAttributes } from "react";

import type { RuntimeBridge } from "@/runtime";

import styles from "./MessageText.module.css";

export interface MarkdownImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  root?: string;
  sourcePath?: string;
  runtime?: RuntimeBridge;
  node?: unknown;
}

export function MarkdownImage({
  src,
  alt,
  root,
  sourcePath,
  runtime,
  node: _node,
  ...props
}: MarkdownImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(typeof src === "string" ? src : null);
  const [status, setStatus] = useState<"idle" | "loading" | "failed">("idle");
  const workspacePath = useMemo(() => resolveWorkspaceImagePath(src, sourcePath), [src, sourcePath]);

  useEffect(() => {
    let active = true;

    if (!src) {
      setResolvedSrc(null);
      setStatus("failed");
      return () => {
        active = false;
      };
    }

    if (isDirectImageUrl(src)) {
      setResolvedSrc(src);
      setStatus("idle");
      return () => {
        active = false;
      };
    }

    if (!root || !runtime || !workspacePath) {
      setResolvedSrc(null);
      setStatus("failed");
      return () => {
        active = false;
      };
    }

    setResolvedSrc(null);
    setStatus("loading");
    void runtime.workspace
      .readMedia(root, workspacePath)
      .then((response) => {
        if (!active) {
          return;
        }
        setResolvedSrc(response.data_url);
        setStatus("idle");
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setResolvedSrc(null);
        setStatus("failed");
      });

    return () => {
      active = false;
    };
  }, [root, runtime, src, workspacePath]);

  if (status === "loading") {
    return <span className={styles.imagePlaceholder}>正在读取图片</span>;
  }

  if (!resolvedSrc) {
    return (
      <span className={styles.imageError} role="img" aria-label={alt || "图片无法预览"}>
        <ImageOff size={14} />
        <span>{alt || "图片无法预览"}</span>
      </span>
    );
  }

  return (
    <img
      {...props}
      src={resolvedSrc}
      alt={alt || ""}
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
    />
  );
}

function isDirectImageUrl(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

function resolveWorkspaceImagePath(src?: string, sourcePath?: string): string | null {
  if (!src || isDirectImageUrl(src) || /^file:/i.test(src)) {
    return null;
  }
  const normalizedSrc = decodeURIComponent(src).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!sourcePath) {
    return normalizedSrc;
  }
  const normalizedSource = sourcePath.replace(/\\/g, "/");
  const slashIndex = normalizedSource.lastIndexOf("/");
  if (slashIndex < 0) {
    return normalizedSrc;
  }
  return `${normalizedSource.slice(0, slashIndex + 1)}${normalizedSrc}`;
}
