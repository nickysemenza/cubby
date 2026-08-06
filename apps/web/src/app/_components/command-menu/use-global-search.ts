import type { SearchableEntity } from "@cubby/schemas/search";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useTRPC } from "~/integrations/trpc/react";
import { recordCommandSearch } from "~/lib/perf/perf-store";
import { type QuickAction, quickActions } from "./quick-actions";
import {
  appendNovelSemanticResults,
  COMMAND_SEARCH_RESULT_LIMIT,
  takeCommandSearchResults,
} from "./search-results";

export const LEXICAL_DEBOUNCE_MS = 75;
export const SEMANTIC_DEBOUNCE_MS = 450;
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
  isFindingRelated: boolean;
  isEmpty: boolean;
}

export function useGlobalSearch(
  searchQuery: string,
  entityType?: SearchableEntity,
): UseGlobalSearchResult {
  const api = useTRPC();
  const measurement = useRef({
    query: searchQuery,
    startedAt: performance.now(),
    lexicalRecorded: false,
    semanticRecorded: false,
  });
  if (measurement.current.query !== searchQuery) {
    measurement.current = {
      query: searchQuery,
      startedAt: performance.now(),
      lexicalRecorded: false,
      semanticRecorded: false,
    };
  }
  const [lexicalQuery] = useDebouncedValue(searchQuery, {
    wait: LEXICAL_DEBOUNCE_MS,
  });
  const [semanticQuery] = useDebouncedValue(searchQuery, {
    wait: SEMANTIC_DEBOUNCE_MS,
  });

  const shouldSearch = lexicalQuery.length > 0;
  const shouldSemantic =
    semanticQuery.trim().length >= SEMANTIC_MIN_QUERY_LENGTH;
  const expectsSemantic =
    searchQuery.trim().length >= SEMANTIC_MIN_QUERY_LENGTH;

  // Fast path: lexical-only search (no embedding API round-trip). This drives
  // the UI immediately; keepPreviousData keeps the last results on screen
  // between keystrokes instead of blanking to a spinner.
  const lexical = useQuery({
    ...api.search.global.queryOptions({
      query: lexicalQuery,
      limit: COMMAND_SEARCH_RESULT_LIMIT,
      mode: "lexical",
      entityType,
    }),
    enabled: shouldSearch,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  // Slow path: semantic-only search adds embedding + pgvector candidates
  // without repeating the lexical DB fan-out. Its results append beneath the
  // stable lexical ordering once they land.
  const semantic = useQuery({
    ...api.search.global.queryOptions({
      query: semanticQuery,
      limit: COMMAND_SEARCH_RESULT_LIMIT,
      mode: "semantic",
      entityType,
    }),
    enabled: shouldSearch && shouldSemantic,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  // A placeholder semantic result belongs to the previous keystroke and must
  // never enrich this query's lexical rows.
  const currentSemantic =
    semanticQuery === searchQuery &&
    semantic.data &&
    !semantic.isPlaceholderData
      ? semantic.data
      : undefined;
  const results = useMemo(
    () =>
      lexical.data
        ? appendNovelSemanticResults(
            takeCommandSearchResults(
              lexical.data.filter(
                (item) => !entityType || item.entityType === entityType,
              ),
            ),
            currentSemantic ?? [],
          )
        : undefined,
    [lexical.data, currentSemantic, entityType],
  );

  // True only before the very first results ever arrive (no placeholder to
  // show); refetches keep the previous list rendered instead.
  const isLoading = shouldSearch && lexical.isPending;
  const isFetching = lexical.isFetching || semantic.isFetching;
  const isFindingRelated =
    expectsSemantic &&
    (semanticQuery !== searchQuery ||
      semantic.isPending ||
      semantic.isFetching) &&
    (!results || results.length === 0);

  useEffect(() => {
    const current = measurement.current;
    if (
      !searchQuery ||
      lexicalQuery !== searchQuery ||
      lexical.isFetching ||
      lexical.isPlaceholderData ||
      current.lexicalRecorded
    ) {
      return;
    }
    current.lexicalRecorded = true;
    recordCommandSearch({
      phase: "lexical",
      durationMs: performance.now() - current.startedAt,
      resultCount: lexical.data?.length ?? 0,
      scoped: Boolean(entityType),
      queryLength: searchQuery.trim().length,
    });
  }, [entityType, lexical, lexicalQuery, searchQuery]);

  useEffect(() => {
    const current = measurement.current;
    if (
      !expectsSemantic ||
      semanticQuery !== searchQuery ||
      semantic.isFetching ||
      semantic.isPlaceholderData ||
      current.semanticRecorded
    ) {
      return;
    }
    current.semanticRecorded = true;
    recordCommandSearch({
      phase: "semantic",
      durationMs: performance.now() - current.startedAt,
      resultCount: semantic.data?.length ?? 0,
      scoped: Boolean(entityType),
      queryLength: searchQuery.trim().length,
    });
  }, [entityType, expectsSemantic, searchQuery, semantic, semanticQuery]);

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
    if (isLoading || isFindingRelated) return false;
    const hasResults = results && results.length > 0;
    const hasActions = filteredActions.length > 0;
    return !hasResults && !hasActions;
  }, [shouldSearch, isLoading, isFindingRelated, results, filteredActions]);

  return {
    results: shouldSearch ? results : undefined,
    filteredActions,
    isLoading,
    isFetching,
    isFindingRelated,
    isEmpty,
  };
}
