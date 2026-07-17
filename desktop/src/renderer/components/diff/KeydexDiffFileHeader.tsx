import {
  Copy,
  FileInput,
  FileOutput,
  FilePenLine,
  FileSymlink,
  FileType2,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useMaterialEntryIcon } from "@/renderer/components/workspace/materialIconTheme";
import type { KeydexDiffFile, KeydexDiffStatus } from "./model";
import {
  KeydexDiffFileHeaderChrome,
  keydexDiffFileHeaderPresentation,
} from "./DiffChrome";

export interface KeydexDiffFileHeaderProps {
  readonly file: KeydexDiffFile;
  readonly selected?: boolean;
  readonly actions?: ReactNode;
  readonly density?: "default" | "compact";
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
}

export function KeydexDiffFileHeader({
  file,
  selected = false,
  actions,
  density = "default",
  expanded,
  onToggle,
}: KeydexDiffFileHeaderProps) {
  const icon = useMaterialEntryIcon(file.displayPath, "file");
  const StatusIcon = KEYDEX_DIFF_STATUS_ICONS[file.status];
  return (
    <KeydexDiffFileHeaderChrome
      presentation={keydexDiffFileHeaderPresentation(file)}
      selected={selected}
      density={density}
      expanded={expanded}
      onToggle={onToggle}
      icon={(
        <img
          src={icon.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          data-material-icon={icon.id}
        />
      )}
      statusIcon={<StatusIcon />}
      actions={actions}
    />
  );
}

const KEYDEX_DIFF_STATUS_ICONS: Readonly<Record<KeydexDiffStatus, LucideIcon>> = Object.freeze({
  added: FileInput,
  modified: FilePenLine,
  deleted: FileOutput,
  renamed: FileSymlink,
  copied: Copy,
  type_changed: FileType2,
  unknown: HelpCircle,
});
