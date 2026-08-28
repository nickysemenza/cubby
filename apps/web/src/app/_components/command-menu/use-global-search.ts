import type { SearchableEntity, SearchHit } from "@cubby/schemas/search";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { recordCommandSearch } from "~/lib/perf/perf-store";
import { search } from "~/lib/search.functions";

import { type QuickAction, quickActions } from "./quick-actions";

const COMMAND_SEARCH_RESULT_LIMIT = 8;
const LEXICAL_DEBOUNCE_MS = 100;

interface UseGlobalSearchResult {
  results: SearchHit[] | undefined;
  filteredActions: QuickAction[];
  isLoading: boolean;
  isFetching: boolean;
  isEmpty: boolean;
}

/** The command palette is deliberately lexical-only: it is a jump surface. */
export function useGlobalSearch(
  searchQuery: string,
  entityType?: SearchableEntity,
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
  const lexical = useQuery({
    ...search.find.queryOptions({
      query,
      entityTypes: entityType ? [entityType] : undefined,
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
      scoped: Boolean(entityType),
      queryLength: searchQuery.trim().length,
    });
  }, [
    entityType,
    lexical.data,
    lexical.isFetching,
    lexical.isPlaceholderData,
    query,
    searchQuery,
  ]);

  const filteredActions = useMemo(() => {
    if (entityType) return [];
    if (!searchQuery) return quickActions;
    const normalized = searchQuery.toLowerCase();
    return quickActions.filter(
      (action) =>
        action.name.toLowerCase().includes(normalized) ||
        action.keywords?.some((keyword) =>
          keyword.toLowerCase().includes(normalized),
        ),
    );
  }, [entityType, searchQuery]);

  const results = shouldSearch ? lexical.data : undefined;
  return {
    results,
    filteredActions,
    isLoading: shouldSearch && lexical.isPending,
    isFetching: lexical.isFetching,
    isEmpty:
      shouldSearch &&
      !lexical.isPending &&
      !lexical.isPlaceholderData &&
      (results?.length ?? 0) === 0 &&
      filteredActions.length === 0,
  };
}
