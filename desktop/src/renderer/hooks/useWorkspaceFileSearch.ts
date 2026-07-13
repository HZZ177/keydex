import { useEffect, useRef, useState } from "react";

import type { WorkspaceSearchOptions, WorkspaceSearchResult } from "@/runtime";

export type WorkspaceFileSearchFn = (
  query: string,
  options?: WorkspaceSearchOptions,
) => Promise<WorkspaceSearchResult[]>;

export interface UseWorkspaceFileSearchOptions {
  enabled: boolean;
  query: string;
  refreshToken?: number;
  search?: WorkspaceFileSearchFn;
}

export interface WorkspaceFileSearchState {
  error: string | null;
  loading: boolean;
  results: WorkspaceSearchResult[];
}

export function useWorkspaceFileSearch({
  enabled,
  query,
  refreshToken = 0,
  search,
}: UseWorkspaceFileSearchOptions): WorkspaceFileSearchState {
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hadSearchRef = useRef(false);
  const normalizedQuery = query.trim();

  useEffect(() => {
    if (!enabled || !search) {
      if (hadSearchRef.current) {
        hadSearchRef.current = false;
        setResults([]);
        setLoading(false);
        setError(null);
      }
      return;
    }

    let active = true;
    const controller = new AbortController();

    hadSearchRef.current = true;
    setResults([]);
    setLoading(true);
    setError(null);

    void search(normalizedQuery, { signal: controller.signal })
      .then((nextResults) => {
        if (active) {
          setResults(nextResults);
        }
      })
      .catch((reason: unknown) => {
        if (!active || isAbortError(reason)) {
          return;
        }
        setResults([]);
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, normalizedQuery, refreshToken, search]);

  return { error, loading, results };
}

function isAbortError(reason: unknown): boolean {
  return Boolean(reason && typeof reason === "object" && (reason as { name?: unknown }).name === "AbortError");
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "搜索工作区失败";
}
