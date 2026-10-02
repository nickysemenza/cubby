import type {
  SearchableEntity,
  SearchResultGroup,
} from "@cubby/schemas/search";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { search } from "~/integrations/tanstack-query/generated/catalog.gen";
import { recordCommandSearch } from "~/lib/perf/perf-store";

import { type QuickAction, quickActions } from "./quick-actions";

const COMMAND_SEARCH_RESULT_LIMIT = 8;
const LEXICAL_DEBOUNCE_MS = 100;

interface UseGlobalSearchResult {
  results: SearchResultGroup[] | undefined;
  filteredActions: QuickAction[];
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  retry: () => void;
  isEmpty: boolean;
}

/** The command palette is deliberately lexical-only: it is a jump surface. */
export function useGlobalSearch(
  searchQuery: string,
  entityKind?: SearchableEntity,
): UseGlobalSearchResult {
  const measurement = useRef({
    query: searchQuery,
    startedAt: performance.now(),
    recorded: false,
  });
  if (measurement.current.query !== searchQuery) {
    measurement.current = {
      query: searchQuery,
      startedAt: performance.now(),
      recorded: false,
    };
  }

  const [query] = useDebouncedValue(searchQuery, {
    wait: LEXICAL_DEBOUNCE_MS,
  });
  const shouldSearch = query.trim().length > 0;
  // Query options are constructed even while disabled, so their schema-derived
  // input must remain valid before the user has typed anything.
  const queryInput = shouldSearch ? query : "inactive-command-search";
  const lexical = useQuery({
    ...search.grouped.queryOptions({
      query: queryInput,
      entityKinds: entityKind ? [entityKind] : undefined,
      limit: COMMAND_SEARCH_RESULT_LIMIT,
    }),
    enabled: shouldSearch,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    const current = measurement.current;
    if (
      !searchQuery ||
      query !== searchQuery ||
      lexical.isFetching ||
      lexical.isPlaceholderData ||
      current.recorded
    ) {
      return;
    }
    current.recorded = true;
    recordCommandSearch({
      phase: "lexical",
      durationMs: performance.now() - current.startedAt,
      resultCount: lexical.data?.length ?? 0,
      scoped: Boolean(entityKind),
      queryLength: searchQuery.trim().length,
    });
  }, [
    entityKind,
    lexical.data,
    lexical.isFetching,
    lexical.isPlaceholderData,
    query,
    searchQuery,
  ]);

  const filteredActions = useMemo(() => {
    if (entityKind) return [];
    if (!searchQuery) return quickActions;
    const normalized = searchQuery.toLowerCase();
    return quickActions.filter(
      (action) =>
        action.name.toLowerCase().includes(normalized) ||
        action.keywords?.some((keyword) =>
          keyword.toLowerCase().includes(normalized),
        ),
    );
  }, [entityKind, searchQuery]);

  const results = shouldSearch ? lexical.data : undefined;
  return {
    results,
    filteredActions,
    isLoading: shouldSearch && lexical.isPending,
    isFetching: lexical.isFetching,
    error: lexical.error,
    retry: () => void lexical.refetch(),
    isEmpty:
      shouldSearch &&
      !lexical.isPending &&
      !lexical.error &&
      !lexical.isPlaceholderData &&
      (results?.length ?? 0) === 0 &&
      filteredActions.length === 0,
  };
}
