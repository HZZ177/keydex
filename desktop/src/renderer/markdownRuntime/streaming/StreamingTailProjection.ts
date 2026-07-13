export function repairStreamingMarkdownTail(content: string): string {
  return closeUnclosedDisplayMath(closeUnclosedFence(content));
}

export function repairStreamingDisplayMathTail(content: string): string {
  return closeUnclosedDisplayMath(content);
}

function closeUnclosedFence(content: string): string {
  const lines = content.split("\n");
  let activeFence: { marker: "`" | "~"; length: number } | null = null;
  for (const line of lines) {
    const match = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    const markerText = match[2];
    const marker = markerText[0] as "`" | "~";
    if (!activeFence) {
      activeFence = { marker, length: markerText.length };
      continue;
    }
    if (activeFence.marker === marker && markerText.length >= activeFence.length) activeFence = null;
  }
  if (!activeFence) return content;
  const closingFence = activeFence.marker.repeat(activeFence.length);
  return `${content.endsWith("\n") ? content : `${content}\n`}${closingFence}`;
}

function closeUnclosedDisplayMath(content: string): string {
  const outsideCode = stripCompleteCodeSegments(content);
  const delimiterCount = outsideCode.match(/(^|[^\\])\$\$/g)?.length ?? 0;
  if (delimiterCount % 2 === 0) return content;
  return `${content.endsWith("\n") ? content : `${content}\n`}$$`;
}

function stripCompleteCodeSegments(content: string): string {
  return content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, "");
}
