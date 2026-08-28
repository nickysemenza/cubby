import { useDebouncedValue } from "@tanstack/react-pacer";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { useEffect, useRef, useState } from "react";

import {
  type Filter,
  type FilterBarField,
  filterStateKey,
  normalizeBarFilters,
} from "./filter-bar-core";

interface UseFilterBarDraftArgs {
  /** Filters as the owning state (table columns, URL) currently has them. */
  externalFilters: Filter[];
  fields: FilterBarField[];
  /** Write accepted draft state back to the owner. */
  commit: (columnFilters: ColumnFiltersState) => void;
}

/**
 * The chip bar's draft state: local edits, a debounce for typing, and the
 * reconciliation that keeps an external change (a saved view, a reset, a URL
 * restore) from being clobbered by an in-flight debounce.
 *
 * Shared by every manifest filter bar, table-backed or URL-backed. The three
 * subtleties below are the reason this is one implementation rather than two.
 */
export function useFilterBarDraft({
  externalFilters,
  fields,
  commit,
}: UseFilterBarDraftArgs) {
  const [draftFilters, setDraftFilters] = useState<Filter[]>(externalFilters);
  const [debouncedDraftFilters] = useDebouncedValue(draftFilters, {
    wait: 500,
  });
  const lastExternalKeyRef = useRef(filterStateKey(externalFilters));

  const externalKey = filterStateKey(externalFilters);
  const draftKey = filterStateKey(draftFilters);
  const debouncedDraftKey = filterStateKey(debouncedDraftFilters);
  if (externalKey !== lastExternalKeyRef.current) {
    lastExternalKeyRef.current = externalKey;
    if (externalKey !== draftKey) {
      setDraftFilters(externalFilters);
    }
  }

  useEffect(() => {
    // Saved views, reset, and URL restoration can advance the owner while this
    // hook's debounced value still represents its previous draft. Only a
    // debounce that has caught up to the latest local draft may write back;
    // otherwise it would immediately undo the external change.
    if (debouncedDraftKey !== draftKey) return;

    // ReUI creates text filters with an empty value so their focused input can
    // exist before the user types. That placeholder is real draft UI state but
    // intentionally normalizes to no filter. Compare the normalized state to
    // the owner's so an empty input stays mounted instead of being written as
    // `[]` and then removed by the external-state sync.
    const { columnFilters: nextColumnFilters, externalKey: nextExternalKey } =
      normalizeBarFilters(debouncedDraftFilters, fields);
    if (nextExternalKey === externalKey) return;

    lastExternalKeyRef.current = nextExternalKey;
    commit(nextColumnFilters);
  }, [
    commit,
    debouncedDraftFilters,
    debouncedDraftKey,
    draftKey,
    externalKey,
    fields,
  ]);

  const handleChange = (nextFilters: Filter[]) => {
    const previousByField = new Map(
      draftFilters.map((filter) => [filter.field, filter]),
    );
    const nextByField = new Map(
      nextFilters.map((filter) => [filter.field, filter]),
    );
    const changedFields = new Set([
      ...previousByField.keys(),
      ...nextByField.keys(),
    ]);
    // Everything but typing commits on the interaction; only a text field
    // waits for the debounce.
    const commitImmediately = [...changedFields].some((fieldKey) => {
      const previous = previousByField.get(fieldKey);
      const next = nextByField.get(fieldKey);
      if (
        JSON.stringify(previous?.values) === JSON.stringify(next?.values) &&
        previous?.operator === next?.operator
      ) {
        return false;
      }
      const field = fields.find((candidate) => candidate.key === fieldKey);
      return !next || field?.type !== "text";
    });

    setDraftFilters(nextFilters);
    if (commitImmediately) {
      const { columnFilters: nextColumnFilters, externalKey: nextExternalKey } =
        normalizeBarFilters(nextFilters, fields);
      lastExternalKeyRef.current = nextExternalKey;
      if (nextExternalKey !== externalKey) {
        commit(nextColumnFilters);
      }
    }
  };

  return { draftFilters, handleChange };
}
