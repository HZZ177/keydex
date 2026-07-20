import { PanelBottomClose, Pencil, Plus, X } from "lucide-react";
import type { TerminalProfileSnapshot, TerminalSnapshot } from "@/runtime";
import { TerminalSelect } from "./TerminalSelect";
import styles from "./TerminalDock.module.css";

export function TerminalToolbar({ profiles, profilesLoading, defaultProfile, activeTerminal, creating,
  onDefaultProfileChange, onCreate, onRename, onClose, onCollapse }: {
  profiles: TerminalProfileSnapshot[];
  profilesLoading: boolean;
  defaultProfile: TerminalProfileSnapshot["id"];
  activeTerminal: TerminalSnapshot | null;
  creating: boolean;
  onDefaultProfileChange: (profile: TerminalProfileSnapshot["id"]) => void;
  onCreate: (profile: TerminalProfileSnapshot["id"]) => void;
  onRename: () => void;
  onClose: () => void;
  onCollapse: () => void;
}) {
  const canCreate = profiles.some((profile) => profile.id === defaultProfile && profile.available);
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="终端操作">
      <TerminalSelect
        ariaLabel="新终端配置"
        disabled={profilesLoading}
        options={profiles.map((profile) => ({
          disabled: !profile.available,
          label: `${profile.label}${profile.available ? "" : "（不可用）"}`,
          value: profile.id,
        }))}
        placeholder={profilesLoading ? "正在读取" : "没有可用配置"}
        value={defaultProfile}
        variant="profile"
        onChange={(profile) => onDefaultProfileChange(profile as TerminalProfileSnapshot["id"])}
      />
      <button type="button" aria-label="新建终端" title="新建终端" disabled={!canCreate || creating}
        onClick={() => onCreate(defaultProfile)}><Plus size={15} /></button>
      <span className={styles.toolbarDivider} aria-hidden="true" />
      <button type="button" aria-label="重命名当前终端" title="重命名" disabled={!activeTerminal} onClick={onRename}>
        <Pencil size={14} />
      </button>
      <button type="button" aria-label="关闭当前终端" title="关闭终端" disabled={!activeTerminal} onClick={onClose}>
        <X size={15} />
      </button>
      <button type="button" aria-label="收起终端面板" title="收起终端" onClick={onCollapse}>
        <PanelBottomClose size={15} />
      </button>
    </div>
  );
}
