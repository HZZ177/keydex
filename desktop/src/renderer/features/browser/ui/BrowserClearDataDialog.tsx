import { useState } from "react";

import { ConfirmDialog } from "@/renderer/components/dialog";
import { useNotifications } from "@/renderer/providers/NotificationProvider";

import type {
  BrowserCommandPayloadByKind,
  BrowserProfileMode,
} from "../domain";
import type { BrowserHostClient } from "../runtime";

import styles from "./BrowserClearDataDialog.module.css";

type ClearDataPayload = BrowserCommandPayloadByKind["browser_clear_profile_data"];
type DataKind = ClearDataPayload["kinds"][number];

const DATA_KINDS: readonly { readonly kind: DataKind; readonly label: string }[] = [
  { kind: "cookies", label: "Cookie 与登录状态" },
  { kind: "cache", label: "缓存文件" },
  { kind: "storage", label: "网站存储" },
];

export interface BrowserClearDataDialogProps {
  readonly client: Pick<BrowserHostClient, "send">;
  readonly profileMode: BrowserProfileMode;
  onCancel(): void;
  onCleared?(): void;
}

export function BrowserClearDataDialog({
  client,
  profileMode,
  onCancel,
  onCleared,
}: BrowserClearDataDialogProps) {
  const notifications = useNotifications();
  const [kinds, setKinds] = useState<readonly DataKind[]>(["cookies", "cache", "storage"]);
  const [timeRange, setTimeRange] = useState<ClearDataPayload["timeRange"]>("all");
  const [clearing, setClearing] = useState(false);

  const toggleKind = (kind: DataKind) => {
    setKinds((current) => current.includes(kind)
      ? current.filter((value) => value !== kind)
      : [...current, kind]);
  };

  const clear = async () => {
    if (clearing || kinds.length === 0) return;
    setClearing(true);
    try {
      await client.send("browser_clear_profile_data", { profileMode, kinds, timeRange });
      notifications.success(profileMode === "incognito" ? "无痕浏览数据已清除" : "浏览数据已清除");
      onCleared?.();
      onCancel();
    } catch (error) {
      notifications.error(error instanceof Error ? error.message : "清除浏览数据失败");
      setClearing(false);
    }
  };

  return (
    <ConfirmDialog
      title={`清除${profileMode === "incognito" ? "无痕" : "普通"}浏览数据？`}
      description="受影响的页面会重新加载。Keydex 不会读取或清理 Edge 的默认个人资料。"
      preview={
        <div className={styles.options}>
          <label>
            <span>时间范围</span>
            <select
              aria-label="时间范围"
              disabled={clearing}
              value={timeRange}
              onChange={(event) => setTimeRange(event.target.value as ClearDataPayload["timeRange"])}
            >
              <option value="last_hour">过去一小时</option>
              <option value="last_day">过去一天</option>
              <option value="all">全部时间</option>
            </select>
          </label>
          <fieldset>
            <legend>数据类别</legend>
            {DATA_KINDS.map(({ kind, label }) => (
              <label key={kind}>
                <input
                  checked={kinds.includes(kind)}
                  disabled={clearing}
                  type="checkbox"
                  onChange={() => toggleKind(kind)}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        </div>
      }
      cancelDisabled={clearing}
      confirmDisabled={clearing || kinds.length === 0}
      confirmLabel={clearing ? "正在清除…" : "清除数据"}
      confirmTone="danger"
      onCancel={onCancel}
      onConfirm={() => void clear()}
    />
  );
}
