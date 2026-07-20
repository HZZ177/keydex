import { useEffect, useState } from "react";
import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import type { TerminalSnapshot } from "@/runtime";
import styles from "./TerminalDock.module.css";

export function TerminalRenameDialog({ terminal, onCancel, onRename }: {
  terminal: TerminalSnapshot;
  onCancel: () => void;
  onRename: (title: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(terminal.title);
  const [saving, setSaving] = useState(false);
  useEffect(() => setTitle(terminal.title), [terminal.terminalId, terminal.title]);
  const valid = title.trim().length > 0 && [...title.trim()].length <= 80;
  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    const renamed = await onRename(title);
    setSaving(false);
    if (renamed) onCancel();
  };
  return (
    <AppDialog title="重命名终端" description="名称仅用于当前终端列表，不会作为命令发送给 Shell。"
      size="confirm" onClose={onCancel} footer={
        <>
          <DialogButton type="button" disabled={saving} onClick={onCancel}>取消</DialogButton>
          <DialogButton type="button" tone="primary" disabled={!valid || saving} onClick={() => void submit()}>保存</DialogButton>
        </>
      }>
      <label className={styles.renameField}>
        <span>终端名称</span>
        <input autoFocus value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void submit(); }
          }} />
      </label>
    </AppDialog>
  );
}
