import { invoke } from "@tauri-apps/api/core";

export interface StorageCategoryUsage {
  id: string;
  label: string;
  bytes: number;
}

export interface StorageStatus {
  installRoot: string;
  dataRoot: string;
  layoutVersion: number;
  totalBytes: number;
  legacyCleanupPending: boolean;
  categories: StorageCategoryUsage[];
}

export interface StorageRuntime {
  getStatus(): Promise<StorageStatus>;
  openDirectory(path: string): Promise<void>;
}

export type StorageInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export function createStorageRuntime(invokeCommand: StorageInvoke = invoke): StorageRuntime {
  return {
    getStatus() {
      return invokeCommand<StorageStatus>("get_storage_status");
    },
    openDirectory(path: string) {
      return invokeCommand<void>("open_path_in_file_manager", { path });
    },
  };
}

export const storageRuntime = createStorageRuntime();
