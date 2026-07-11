export function formatConversationDuration(durationMs: number): string {
  const normalizedDurationMs = Math.max(0, durationMs);
  if (normalizedDurationMs <= 1000) {
    return `${Math.round(normalizedDurationMs)}毫秒`;
  }

  const totalSeconds = Math.floor(normalizedDurationMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}天${hours}小时${minutes}分${seconds}秒`;
  }
  if (hours > 0) {
    return `${hours}小时${minutes}分${seconds}秒`;
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}
