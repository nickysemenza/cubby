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
  const stableDetailKeys = [
    entityDetailRootKey("product"),
    entityDetailRootKey("location"),
    entityDetailRootKey("recipe"),
    entityDetailRootKey("ingredient"),
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
  for (const key of stableDetailKeys) {
    queryClient.setQueryDefaults(key, {
      staleTime: 5 * MINUTE,
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
