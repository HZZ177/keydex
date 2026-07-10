export interface WheelIntentEvent {
  deltaY: number;
  target: EventTarget | null;
}

export function wheelWillScrollElement(event: WheelIntentEvent, scrollElement: HTMLElement): boolean {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) {
    return false;
  }
  if (nestedScrollerWillConsumeWheel(event, scrollElement)) {
    return false;
  }
  const bottom = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  return event.deltaY < 0 ? scrollElement.scrollTop > 0 : scrollElement.scrollTop < bottom;
}

export function isUpwardWheelIntent(event: WheelIntentEvent): boolean {
  return event.deltaY < 0;
}

function nestedScrollerWillConsumeWheel(event: WheelIntentEvent, scrollElement: HTMLElement): boolean {
  let element = event.target instanceof HTMLElement ? event.target : null;
  while (element && element !== scrollElement) {
    const overflowY = window.getComputedStyle(element).overflowY;
    const scrollable =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      element.scrollHeight > element.clientHeight;
    if (scrollable) {
      const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
      if ((event.deltaY < 0 && element.scrollTop > 0) || (event.deltaY > 0 && element.scrollTop < bottom)) {
        return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}
