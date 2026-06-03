import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTRPC } from "~/trpc/react";
import { type QuickAction, quickActions } from "./quick-actions";

const DEBOUNCE_MS = 300;

interface UseGlobalSearchResult {
  results:
    | ReturnType<typeof useTRPC>["search"]["global"]["~types"]["output"]
    | undefined;
  filteredActions: QuickAction[];
  isLoading: boolean;
  isEmpty: boolean;
}

export function useGlobalSearch(searchQuery: string): UseGlobalSearchResult {
  const api = useTRPC();
  const [debouncedQuery] = useDebouncedValue(searchQuery, {
    wait: DEBOUNCE_MS,
  });

  // Only search when we have a debounced query with at least 1 character
  const shouldSearch = debouncedQuery.length > 0;

  const { data, isLoading, isFetching } = useQuery({
    ...api.search.global.queryOptions({
      query: debouncedQuery,
      limit: 5,
    }),
    enabled: shouldSearch,
    staleTime: 30_000, // Cache results for 30s
  });

  // Filter quick actions client-side
  const filteredActions = useMemo(() => {
    if (!searchQuery) return quickActions;
    const lowerQuery = searchQuery.toLowerCase();
    return quickActions.filter(
      (action) =>
        action.name.toLowerCase().includes(lowerQuery) ||
        action.keywords?.some((k) => k.toLowerCase().includes(lowerQuery)),
    );
  }, [searchQuery]);

  // Determine empty state
  const isEmpty = useMemo(() => {
    if (!shouldSearch) return false;
    if (isLoading) return false;
    const hasResults = data && data.length > 0;
    const hasActions = filteredActions.length > 0;
    return !hasResults && !hasActions;
  }, [shouldSearch, isLoading, data, filteredActions]);

  return {
    results: shouldSearch ? data : undefined,
    filteredActions,
    isLoading: isLoading || (isFetching && shouldSearch),
    isEmpty,
  };
}
