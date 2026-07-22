import { ConfirmDialog } from "@/renderer/components/dialog";

import type { BrowserExternalProtocolRequest } from "../runtime/BrowserPolicyCoordinator";

export interface BrowserExternalProtocolPromptProps {
  readonly request: BrowserExternalProtocolRequest;
  onCancel(): void;
  onConfirm(target: string): void;
}

export function BrowserExternalProtocolPrompt({
  request,
  onCancel,
  onConfirm,
}: BrowserExternalProtocolPromptProps) {
  const application = request.scheme === "mailto" ? "邮件应用" : "电话应用";
  return (
    <ConfirmDialog
      title={`打开外部${application}？`}
      description={`网站请求离开 Keydex 并打开系统${application}。仅在你确认后才会继续。`}
      preview={<span title={request.target}>{truncateTarget(request.target)}</span>}
      cancelLabel="留在 Keydex"
      confirmLabel={`打开${application}`}
      onCancel={onCancel}
      onConfirm={() => onConfirm(request.target)}
    />
  );
}

function truncateTarget(target: string): string {
  return target.length <= 240 ? target : `${target.slice(0, 237)}…`;
}
