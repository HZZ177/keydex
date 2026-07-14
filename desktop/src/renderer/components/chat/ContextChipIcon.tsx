import { Box, File, Folder, MessageSquareQuote } from "lucide-react";
import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";

export type ContextChipIconKind = "comment" | "context" | "directory" | "file" | "quote" | "skill";

const ICON_SIZE = 14;
const ICON_STROKE_WIDTH = 2;

const ICONS: Record<ContextChipIconKind, ComponentType<LucideProps>> = {
  comment: MessageSquareQuote,
  context: Box,
  directory: Folder,
  file: File,
  quote: MessageSquareQuote,
  skill: Box,
};

export function ContextChipIcon({ kind }: { kind: ContextChipIconKind }) {
  const Icon = ICONS[kind];
  return <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} absoluteStrokeWidth focusable="false" />;
}
