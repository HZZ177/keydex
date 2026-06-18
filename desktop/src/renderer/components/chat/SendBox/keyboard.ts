export interface SendKeyState {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
  };
}

export function shouldSubmitFromKeyboard(event: SendKeyState, composing: boolean): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !composing &&
    event.isComposing !== true &&
    event.nativeEvent?.isComposing !== true
  );
}
