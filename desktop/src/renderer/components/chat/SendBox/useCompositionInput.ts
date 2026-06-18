import { type CompositionEvent, type KeyboardEvent, useCallback, useState } from "react";

import { shouldSubmitFromKeyboard } from "./keyboard";

export interface UseCompositionInputOptions {
  disabled?: boolean;
  onSubmit: () => void;
}

export function useCompositionInput({ disabled = false, onSubmit }: UseCompositionInputOptions) {
  const [isComposing, setIsComposing] = useState(false);

  const handleCompositionStart = useCallback((_event: CompositionEvent<HTMLTextAreaElement>) => {
    setIsComposing(true);
  }, []);

  const handleCompositionEnd = useCallback((_event: CompositionEvent<HTMLTextAreaElement>) => {
    setIsComposing(false);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (disabled || !shouldSubmitFromKeyboard(event, isComposing)) {
        return;
      }
      event.preventDefault();
      onSubmit();
    },
    [disabled, isComposing, onSubmit],
  );

  return {
    isComposing,
    handleCompositionStart,
    handleCompositionEnd,
    handleKeyDown,
  };
}
