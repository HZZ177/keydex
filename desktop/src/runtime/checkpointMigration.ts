import type { HttpClient } from "./httpClient";

export type CheckpointMigrationState =
  | "not_required"
  | "required"
  | "running"
  | "failed"
  | "completed"
  | "ready";

export interface CheckpointMigrationError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CheckpointMigrationStatus {
  state: CheckpointMigrationState;
  percent: number;
  can_start: boolean;
  can_retry: boolean;
  can_acknowledge: boolean;
  error: CheckpointMigrationError | null;
}

export interface CheckpointMigrationRuntime {
  status(): Promise<CheckpointMigrationStatus>;
  start(): Promise<CheckpointMigrationStatus>;
  retry(): Promise<CheckpointMigrationStatus>;
  acknowledge(): Promise<CheckpointMigrationStatus>;
}

export function createCheckpointMigrationRuntime(
  http: HttpClient,
): CheckpointMigrationRuntime {
  return {
    status() {
      return http.request<CheckpointMigrationStatus>(
        "/api/checkpoint-migration",
      );
    },
    start() {
      return http.request<CheckpointMigrationStatus>(
        "/api/checkpoint-migration/start",
        { method: "POST" },
      );
    },
    retry() {
      return http.request<CheckpointMigrationStatus>(
        "/api/checkpoint-migration/retry",
        { method: "POST" },
      );
    },
    acknowledge() {
      return http.request<CheckpointMigrationStatus>(
        "/api/checkpoint-migration/acknowledge",
        { method: "POST" },
      );
    },
  };
}
