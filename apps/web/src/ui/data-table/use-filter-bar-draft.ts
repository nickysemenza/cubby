import { useDebouncedValue } from "@tanstack/react-pacer";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { useEffect, useState } from "react";

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
  const externalKey = filterStateKey(externalFilters);
  const [state, setState] = useState<{
    draftFilters: Filter[];
    externalKey: string;
    pendingKeys: string[];
  }>(() => ({
    draftFilters: externalFilters,
    externalKey,
    pendingKeys: [],
  }));
  const { draftFilters, pendingKeys } = state;
  const [debouncedDraftFilters] = useDebouncedValue(draftFilters, {
    wait: 500,
  });

  const draftKey = filterStateKey(draftFilters);
  const debouncedDraftKey = filterStateKey(debouncedDraftFilters);
  if (externalKey !== state.externalKey) {
    const acknowledged = pendingKeys.indexOf(externalKey);
    // An owner acknowledgement can trail another keystroke. Only an actual
    // external change replaces the draft; unchanged props during a deferred
    // table transition cannot roll it back. State stays render-local when a
    // concurrent render is discarded.
    setState({
      externalKey,
      draftFilters: acknowledged < 0 ? externalFilters : draftFilters,
      pendingKeys: acknowledged < 0 ? [] : pendingKeys.slice(acknowledged + 1),
    });
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
    if (
      pendingKeys.at(-1) === nextExternalKey ||
      (pendingKeys.length === 0 && nextExternalKey === externalKey)
    )
      return;

    setState((previous) => ({
      ...previous,
      pendingKeys: [...previous.pendingKeys, nextExternalKey],
    }));
    commit(nextColumnFilters);
  }, [
    commit,
    debouncedDraftFilters,
    debouncedDraftKey,
    draftKey,
    externalKey,
    fields,
    pendingKeys,
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

    if (commitImmediately) {
      const { columnFilters: nextColumnFilters, externalKey: nextExternalKey } =
        normalizeBarFilters(nextFilters, fields);
      const shouldCommit =
        pendingKeys.at(-1) !== nextExternalKey &&
        (pendingKeys.length > 0 || nextExternalKey !== externalKey);
      setState((previous) => ({
        ...previous,
        draftFilters: nextFilters,
        pendingKeys: shouldCommit
          ? [...previous.pendingKeys, nextExternalKey]
          : previous.pendingKeys,
      }));
      if (shouldCommit) {
        commit(nextColumnFilters);
      }
    } else {
      setState((previous) => ({ ...previous, draftFilters: nextFilters }));
    }
  };

  return { draftFilters, handleChange };
}
