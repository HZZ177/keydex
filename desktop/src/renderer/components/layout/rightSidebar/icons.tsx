import { Bot, FileDiff, Folder, Globe, MessageSquare } from "lucide-react";

import type { RightSidebarPanelIcon } from "./types";

export function RightSidebarPanelIconGlyph({
  icon,
  size = 12,
  strokeWidth,
}: {
  icon: RightSidebarPanelIcon;
  size?: number;
  strokeWidth?: number;
}) {
  const props = { size, strokeWidth };
  switch (icon) {
    case "folder":
      return <Folder {...props} />;
    case "message":
      return <MessageSquare {...props} />;
    case "bot":
      return <Bot {...props} />;
    case "review":
      return <FileDiff {...props} />;
    case "browser":
      return <Globe {...props} />;
  }
}
