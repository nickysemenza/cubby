import { createContext, useContext, useEffect } from "react";

/** Loaded row counts inform headings and empty state; pending reads report
 * undefined. Reporting outside a section is a safe no-op. */
export const SectionCountContext = createContext<
  ((count: number | undefined) => void) | null
>(null);

export function useSectionCount(count: number | undefined) {
  const setCount = useContext(SectionCountContext);
  useEffect(() => {
    setCount?.(count);
    return () => setCount?.(undefined);
  }, [setCount, count]);
}

/** A resolved empty body stays reachable; loading and errors must report false. */
export const SectionEmptyContext = createContext<
  ((empty: boolean) => void) | null
>(null);
export function useSectionEmpty(empty: boolean) {
  const report = useContext(SectionEmptyContext);
  useEffect(() => {
    report?.(empty);
    return () => report?.(false);
  }, [report, empty]);
}

export const SectionEmptyRegistryContext = createContext<
  ((id: string, empty: boolean) => void) | null
>(null);
export const ContinuousDetailContext = createContext(false);
export function useContinuousDetail() {
  return useContext(ContinuousDetailContext);
}
