import { type CompositionEvent, type KeyboardEvent, useCallback, useState } from "react";

import { isReverseSubmitFromKeyboard, shouldSubmitFromKeyboard } from "./keyboard";

export interface SendBoxSubmitOptions {
  reverseDeliveryMode?: boolean;
}

export interface UseCompositionInputOptions {
  disabled?: boolean;
  onSubmit: (options?: SendBoxSubmitOptions) => void;
}

export function useCompositionInput({ disabled = false, onSubmit }: UseCompositionInputOptions) {
  const [isComposing, setIsComposing] = useState(false);

  const handleCompositionStart = useCallback((_event: CompositionEvent<HTMLElement>) => {
    setIsComposing(true);
  }, []);

  const handleCompositionEnd = useCallback((_event: CompositionEvent<HTMLElement>) => {
    setIsComposing(false);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!shouldSubmitFromKeyboard(event, isComposing)) {
        return;
      }
      event.preventDefault();
      if (disabled) {
        return;
      }
      onSubmit({ reverseDeliveryMode: isReverseSubmitFromKeyboard(event) });
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
