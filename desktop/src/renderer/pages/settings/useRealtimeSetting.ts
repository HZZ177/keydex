import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_SAVE_DELAY_MS = 250;

interface RealtimeSettingOptions<T> {
  isValid?: (value: T) => boolean;
  onError: (reason: unknown) => void;
  save: (value: T) => Promise<T>;
}

interface RealtimeSettingController<T> {
  flush: () => void;
  replace: (value: T | null) => void;
  update: (updater: (current: T) => T, delayMs?: number) => void;
  value: T | null;
}

/**
 * Keeps settings controls optimistic while serializing and coalescing writes.
 * The last valid edit wins; a failed latest edit rolls back to the last value
 * confirmed by the runtime.
 */
export function useRealtimeSetting<T>({
  isValid,
  onError,
  save,
}: RealtimeSettingOptions<T>): RealtimeSettingController<T> {
  const [value, setValue] = useState<T | null>(null);
  const optionsRef = useRef({ isValid, onError, save });
  const valueRef = useRef<T | null>(null);
  const confirmedRef = useRef<T | null>(null);
  const pendingRef = useRef<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);

  optionsRef.current = { isValid, onError, save };

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const runPendingRef = useRef<() => void>(() => undefined);

  const flush = useCallback(() => {
    clearTimer();
    runPendingRef.current();
  }, [clearTimer]);

  runPendingRef.current = () => {
    if (savingRef.current || pendingRef.current === null) {
      return;
    }
    const attempted = pendingRef.current;
    const generation = generationRef.current;
    pendingRef.current = null;
    savingRef.current = true;

    void optionsRef.current
      .save(attempted)
      .then((saved) => {
        if (generationRef.current !== generation) {
          return;
        }
        confirmedRef.current = saved;
        if (valueRef.current === attempted) {
          valueRef.current = saved;
          if (mountedRef.current) {
            setValue(saved);
          }
        }
      })
      .catch((reason: unknown) => {
        if (generationRef.current !== generation) {
          return;
        }
        optionsRef.current.onError(reason);
        if (valueRef.current === attempted) {
          valueRef.current = confirmedRef.current;
          if (mountedRef.current) {
            setValue(confirmedRef.current);
          }
        }
      })
      .finally(() => {
        savingRef.current = false;
        if (pendingRef.current !== null) {
          runPendingRef.current();
        }
      });
  };

  const replace = useCallback(
    (nextValue: T | null) => {
      generationRef.current += 1;
      clearTimer();
      pendingRef.current = null;
      valueRef.current = nextValue;
      confirmedRef.current = nextValue;
      setValue(nextValue);
    },
    [clearTimer],
  );

  const update = useCallback(
    (updater: (current: T) => T, delayMs = DEFAULT_SAVE_DELAY_MS) => {
      const current = valueRef.current;
      if (current === null) {
        return;
      }
      const nextValue = updater(current);
      if (Object.is(nextValue, current)) {
        return;
      }
      valueRef.current = nextValue;
      setValue(nextValue);
      clearTimer();

      if (optionsRef.current.isValid && !optionsRef.current.isValid(nextValue)) {
        pendingRef.current = null;
        return;
      }

      pendingRef.current = nextValue;
      if (delayMs <= 0) {
        runPendingRef.current();
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        runPendingRef.current();
      }, delayMs);
    },
    [clearTimer],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      pendingRef.current = null;
    };
  }, [clearTimer]);

  return { flush, replace, update, value };
}
