import type { SearchableEntity } from "@cubby/schemas/search";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTRPC } from "~/integrations/trpc/react";
import { type QuickAction, quickActions } from "./quick-actions";
import {
  COMMAND_SEARCH_RESULT_LIMIT,
  takeCommandSearchResults,
} from "./search-results";

const DEBOUNCE_MS = 300;
// Mirrors SEMANTIC_MIN_QUERY_LENGTH on the server (~/server/semantic/constants):
// below this the hybrid endpoint returns lexical-only results anyway, so the
// second request would just duplicate the lexical one.
const SEMANTIC_MIN_QUERY_LENGTH = 3;

interface UseGlobalSearchResult {
  results:
    | ReturnType<typeof useTRPC>["search"]["global"]["~types"]["output"]
    | undefined;
  filteredActions: QuickAction[];
  isLoading: boolean;
  isFetching: boolean;
  isEmpty: boolean;
}

export function useGlobalSearch(
  searchQuery: string,
  entityType?: SearchableEntity,
): UseGlobalSearchResult {
  const api = useTRPC();
  const [debouncedQuery] = useDebouncedValue(searchQuery, {
    wait: DEBOUNCE_MS,
  });

  const shouldSearch = debouncedQuery.length > 0;
  const shouldSemantic =
    debouncedQuery.trim().length >= SEMANTIC_MIN_QUERY_LENGTH;

  // Fast path: lexical-only search (no embedding API round-trip). This drives
  // the UI immediately; keepPreviousData keeps the last results on screen
  // between keystrokes instead of blanking to a spinner.
  const lexical = useQuery({
    ...api.search.global.queryOptions({
      query: debouncedQuery,
      limit: COMMAND_SEARCH_RESULT_LIMIT,
      mode: "lexical",
      entityType,
    }),
    enabled: shouldSearch,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  // Slow path: full hybrid search adds semantic (embedding + pgvector)
  // candidates. Its results replace the lexical set when they land.
  const hybrid = useQuery({
    ...api.search.global.queryOptions({
      query: debouncedQuery,
      limit: COMMAND_SEARCH_RESULT_LIMIT,
      mode: "hybrid",
      entityType,
    }),
    enabled: shouldSearch && shouldSemantic,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  // Prefer hybrid only when it answers the CURRENT query — a placeholder
  // hybrid result belongs to the previous keystroke and must not shadow the
  // fresher lexical results.
  const data =
    hybrid.data && !hybrid.isPlaceholderData ? hybrid.data : lexical.data;
  const results = useMemo(
    () =>
      data
        ? takeCommandSearchResults(
            data.filter(
              (item) => !entityType || item.entityType === entityType,
            ),
          )
        : undefined,
    [data, entityType],
  );

  // True only before the very first results ever arrive (no placeholder to
  // show); refetches keep the previous list rendered instead.
  const isLoading = shouldSearch && lexical.isPending;
  const isFetching = lexical.isFetching || hybrid.isFetching;

  // Filter quick actions client-side
  const filteredActions = useMemo(() => {
    if (entityType) return [];
    if (!searchQuery) return quickActions;
    const lowerQuery = searchQuery.toLowerCase();
    return quickActions.filter(
      (action) =>
        action.name.toLowerCase().includes(lowerQuery) ||
        action.keywords?.some((k) => k.toLowerCase().includes(lowerQuery)),
    );
  }, [entityType, searchQuery]);

  // Determine empty state — only once both stages for the current query are
  // in, so "Nothing matched" never flashes while semantic results (which often
  // rescue a zero-lexical query) are still in flight.
  const isEmpty = useMemo(() => {
    if (!shouldSearch) return false;
    if (isLoading || isFetching) return false;
    const hasResults = results && results.length > 0;
    const hasActions = filteredActions.length > 0;
    return !hasResults && !hasActions;
  }, [shouldSearch, isLoading, isFetching, results, filteredActions]);

  return {
    results: shouldSearch ? results : undefined,
    filteredActions,
    isLoading,
    isFetching,
    isEmpty,
  };
}
