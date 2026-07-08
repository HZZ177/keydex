import { useEffect, useState } from "react";

export function useHeldActiveFlag(active: boolean, holdMs: number): boolean {
  const [heldActive, setHeldActive] = useState(active);

  useEffect(() => {
    if (active) {
      setHeldActive(true);
      return;
    }
    if (!heldActive) {
      return;
    }
    const timeoutId = window.setTimeout(() => setHeldActive(false), Math.max(0, holdMs));
    return () => window.clearTimeout(timeoutId);
  }, [active, heldActive, holdMs]);

  return heldActive;
}
