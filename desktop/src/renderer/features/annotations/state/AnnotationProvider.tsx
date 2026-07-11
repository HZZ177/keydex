import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useStore } from "zustand";

import {
  createAnnotationStore,
  type AnnotationStore,
  type AnnotationStoreState,
} from "./annotationStore";

const AnnotationStoreContext = createContext<AnnotationStore | null>(null);

export function AnnotationProvider({
  children,
  store,
}: {
  children: ReactNode;
  store?: AnnotationStore;
}) {
  const storeRef = useRef<AnnotationStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = store ?? createAnnotationStore();
  }
  useEffect(() => {
    const current = storeRef.current;
    return () => current?.getState().dispose();
  }, []);
  return (
    <AnnotationStoreContext.Provider value={storeRef.current}>
      {children}
    </AnnotationStoreContext.Provider>
  );
}

export function useAnnotationStoreApi(): AnnotationStore {
  const store = useContext(AnnotationStoreContext);
  if (!store) {
    throw new Error("useAnnotationStoreApi must be used inside AnnotationProvider");
  }
  return store;
}

export function useAnnotationStore<T>(selector: (state: AnnotationStoreState) => T): T {
  return useStore(useAnnotationStoreApi(), selector);
}
