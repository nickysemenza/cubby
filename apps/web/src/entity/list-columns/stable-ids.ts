import { uniq } from "es-toolkit";
import { useEffect, useState } from "react";

/**
 * The sorted, de-duplicated id set of the loaded rows, kept referentially
 * stable while its contents don't change, so a query keyed on it does not
 * churn on every infinite-scroll page or mutation refetch.
 */
export function useStableIds(ids: readonly string[]): readonly string[] {
  const [stable, setStable] = useState<readonly string[]>([]);
  useEffect(() => {
    const next = uniq(ids).sort();
    setStable((current) =>
      current.length === next.length &&
      current.every((id, index) => id === next[index])
        ? current
        : next,
    );
  }, [ids]);
  return stable;
}
