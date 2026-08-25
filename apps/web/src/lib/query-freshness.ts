import type { QueryClient } from "@tanstack/react-query";
import { cookbookListQueryOptions } from "~/entities/cookbook.functions";
import { entityDetailRootKey } from "~/entities/entity-detail.functions";
import { normalizeQueryRoot, queryKeys } from "./query-keys";

const MINUTE = 60 * 1000;

/**
 * Freshness is intentionally procedure-specific: reference data stays warm
 * across navigation, while inventory, tasks and finance retain the 60s default.
 * Focus/reconnect revalidates these longer-lived views once they are stale,
 * bounding repeat reads while still noticing MCP and import changes.
 */
export function configureQueryFreshness(queryClient: QueryClient): void {
  // These four plus "inventory" are exactly the PERSISTED_ROOTS allowlist in
  // integrations/tanstack-query/root-provider.tsx. Keep the two lists in sync:
  // a root that is persisted but not listed here gets the 5-minute default
  // gcTime and is evicted from the snapshot long before maxAge (see below).
  const stableDetailKeys = [
    entityDetailRootKey("product"),
    entityDetailRootKey("location"),
    entityDetailRootKey("recipe"),
    entityDetailRootKey("ingredient"),
    entityDetailRootKey("inventory"),
  ];
  const stableIndexKeys = [
    queryKeys.product.list,
    queryKeys.location.list,
    queryKeys.location.makeTree,
    queryKeys.recipe.list,
    cookbookListQueryOptions().queryKey,
    queryKeys.ingredient.list,
  ];
  const revalidateOnFocus = {
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  };
  // gcTime must be >= the persister's maxAge (24h, set in root-provider). With
  // the 5-minute default, an unmounted detail query is garbage-collected and
  // the next persist write drops it from IndexedDB — so the offline warm start
  // silently covered ~5 minutes instead of the 24 hours it advertises. Scoped
  // to these roots on purpose: a global 24h gcTime would pin every inactive
  // `.list` infinite query (up to 1000 rows per filter/sort permutation) in
  // memory for the whole session, and lists are deliberately not persisted.
  for (const key of stableDetailKeys) {
    queryClient.setQueryDefaults(key, {
      staleTime: 5 * MINUTE,
      gcTime: 24 * 60 * MINUTE,
      ...revalidateOnFocus,
    });
  }
  for (const key of stableIndexKeys) {
    queryClient.setQueryDefaults(
      Array.isArray(key) && Array.isArray(key[0])
        ? key
        : normalizeQueryRoot(key),
      {
        staleTime: 2 * MINUTE,
        ...revalidateOnFocus,
      },
    );
  }
}
