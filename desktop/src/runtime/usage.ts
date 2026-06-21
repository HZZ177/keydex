import type {
  UsageBucket,
  UsageRequestDetail,
  UsageRequestListResponse,
  UsageRequestStatus,
  UsageSummary,
  UsageTrendResponse,
} from "@/types/protocol";

import type { HttpClient } from "./httpClient";

export interface UsageQueryOptions {
  startTime?: string;
  endTime?: string;
  model?: string;
}

export interface UsageTrendOptions extends UsageQueryOptions {
  bucket?: UsageBucket;
  timezoneOffsetMinutes?: number;
}

export interface UsageRequestListOptions extends UsageQueryOptions {
  status?: UsageRequestStatus;
  page?: number;
  pageSize?: number;
}

export interface UsageRuntime {
  getSummary(options?: UsageQueryOptions): Promise<UsageSummary>;
  getTrend(options?: UsageTrendOptions): Promise<UsageTrendResponse>;
  listRequests(options?: UsageRequestListOptions): Promise<UsageRequestListResponse>;
  getRequestDetail(requestId: string): Promise<UsageRequestDetail>;
}

export function createUsageRuntime(http: HttpClient): UsageRuntime {
  return {
    getSummary(options = {}) {
      return http.request<UsageSummary>(`/api/usage/summary${usageQuery(options)}`);
    },
    getTrend(options = {}) {
      return http.request<UsageTrendResponse>(
        `/api/usage/trend${usageQuery({ ...options, bucket: options.bucket })}`,
      );
    },
    listRequests(options = {}) {
      return http.request<UsageRequestListResponse>(`/api/usage/requests${usageQuery(options)}`);
    },
    getRequestDetail(requestId) {
      return http.request<UsageRequestDetail>(`/api/usage/requests/${encodeURIComponent(requestId)}`);
    },
  };
}

function usageQuery(options: UsageQueryOptions & Partial<UsageTrendOptions & UsageRequestListOptions>) {
  const params = new URLSearchParams();
  appendParam(params, "start_time", options.startTime);
  appendParam(params, "end_time", options.endTime);
  appendParam(params, "model", options.model);
  appendParam(params, "bucket", options.bucket);
  appendParam(params, "timezone_offset_minutes", options.timezoneOffsetMinutes);
  appendParam(params, "status", options.status);
  appendParam(params, "page", options.page);
  appendParam(params, "page_size", options.pageSize);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function appendParam(params: URLSearchParams, key: string, value: string | number | undefined | null) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  params.set(key, String(value));
}
