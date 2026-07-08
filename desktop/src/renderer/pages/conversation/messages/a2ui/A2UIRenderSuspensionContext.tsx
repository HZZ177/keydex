import { createContext, useContext, type ReactNode } from "react";

const A2UIRenderSuspensionContext = createContext(false);

export function A2UIRenderSuspensionProvider({
  children,
  suspended,
}: {
  children: ReactNode;
  suspended: boolean;
}) {
  return (
    <A2UIRenderSuspensionContext.Provider value={suspended}>
      {children}
    </A2UIRenderSuspensionContext.Provider>
  );
}

export function useA2UIRenderSuspension(): boolean {
  return useContext(A2UIRenderSuspensionContext);
}
