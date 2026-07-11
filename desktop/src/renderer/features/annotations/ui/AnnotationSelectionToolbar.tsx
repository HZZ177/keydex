import { MessageSquarePlus } from "lucide-react";

import type { DocumentSelection } from "../document/DocumentTextModel";
import styles from "./AnnotationRail.module.css";

export function AnnotationSelectionToolbar({
  action = "create",
  selection,
  onCreate,
}: {
  action?: "create" | "retarget";
  selection: DocumentSelection | null;
  onCreate(selection: DocumentSelection): void;
}) {
  if (!selection || selection.range.start === selection.range.end) {
    return null;
  }
  return (
    <div aria-label="选区操作" className={styles.selectionToolbar} role="toolbar">
      <button aria-label={action === "retarget" ? "将批注关联到此选区" : "为选区添加批注"} onClick={() => onCreate(selection)} type="button">
        <MessageSquarePlus size={14} />
        {action === "retarget" ? "关联" : "批注"}
      </button>
    </div>
  );
}
