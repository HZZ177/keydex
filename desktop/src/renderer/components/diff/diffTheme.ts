import { useEffect, useState } from "react";

export type KeydexDiffTheme = "light" | "dark";

export function useKeydexDiffTheme(): KeydexDiffTheme {
  const [theme, setTheme] = useState<KeydexDiffTheme>(readKeydexDiffTheme);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(readKeydexDiffTheme());
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

export function readKeydexDiffTheme(): KeydexDiffTheme {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "light";
}
