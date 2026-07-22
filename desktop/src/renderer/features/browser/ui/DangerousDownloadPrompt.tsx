import { ConfirmDialog } from "@/renderer/components/dialog";
import type { BrowserDownloadItem } from "../runtime/BrowserDownloadController";

export function DangerousDownloadPrompt({
  item,
  responding,
  onAccept,
  onCancel,
}: {
  readonly item: BrowserDownloadItem;
  readonly responding: boolean;
  onAccept(): void;
  onCancel(): void;
}) {
  return (
    <ConfirmDialog
      title="下载可能有风险的文件？"
      description="可执行文件和脚本可能更改你的设备。仅在信任来源时继续。"
      preview={<><strong>{item.filename}</strong><br /><span>{item.url}</span></>}
      cancelLabel="取消下载"
      confirmLabel="仍然下载"
      confirmTone="danger"
      cancelDisabled={responding}
      confirmDisabled={responding}
      onCancel={onCancel}
      onConfirm={onAccept}
    />
  );
}
