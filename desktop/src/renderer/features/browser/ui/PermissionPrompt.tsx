import { ConfirmDialog } from "@/renderer/components/dialog";

export interface BrowserPermissionRequest {
  readonly permissionRequestId: string;
  readonly origin: string;
  readonly permission: string;
  readonly deadline: string;
}

export interface PermissionPromptProps {
  readonly request: BrowserPermissionRequest;
  readonly responding?: boolean;
  onAllow(): void;
  onDeny(): void;
}

const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  camera: "摄像头",
  geolocation: "位置信息",
  microphone: "麦克风",
};

export function PermissionPrompt({
  request,
  responding = false,
  onAllow,
  onDeny,
}: PermissionPromptProps) {
  const permission = PERMISSION_LABELS[request.permission] ?? "受保护能力";
  return (
    <ConfirmDialog
      title={`允许网站使用${permission}？`}
      description="仅对当前 WebView 的这一次请求生效；30 秒内未选择会自动拒绝。"
      preview={<><strong>{request.origin}</strong><br /><span>{permission}</span></>}
      cancelLabel="拒绝"
      confirmLabel="仅允许本次"
      cancelDisabled={responding}
      confirmDisabled={responding}
      onCancel={onDeny}
      onConfirm={onAllow}
    />
  );
}
