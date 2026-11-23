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

/**
 * One line that stands for a section's body while it is closed: what it holds
 * in words ("2 mailboxes connected", "Matched · $42.99"). Pending reads report
 * undefined, so the row keeps its declared digest. Outside a section it is a
 * safe no-op.
 */
export const SectionDigestContext = createContext<
  ((digest: string | undefined) => void) | null
>(null);
export function useSectionDigest(digest: string | undefined) {
  const report = useContext(SectionDigestContext);
  useEffect(() => {
    report?.(digest || undefined);
    return () => report?.(undefined);
  }, [report, digest]);
}

/** What the section index shows for one section: list sections carry a row
 * count (0 included); other sections only report emptiness. */
export interface SectionIndexState {
  empty: boolean;
  count: number | undefined;
}
export const SectionIndexRegistryContext = createContext<
  ((id: string, state: SectionIndexState | undefined) => void) | null
>(null);
export const ContinuousDetailContext = createContext(false);
