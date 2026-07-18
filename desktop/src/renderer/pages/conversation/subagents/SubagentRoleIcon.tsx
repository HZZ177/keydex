import { Bot, Radar } from "lucide-react";

import type { SubagentRole } from "@/types/subagents";

export function SubagentRoleIcon({
  role,
  size = 18,
}: {
  role: SubagentRole;
  size?: number;
}) {
  const Icon = role === "explorer" ? Radar : Bot;
  return <Icon aria-hidden="true" size={size} strokeWidth={2} />;
}

export function subagentRoleLabel(role: SubagentRole): string {
  return role === "explorer" ? "sub-explore" : "sub-worker";
}
