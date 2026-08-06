import type { QueryClient } from "@tanstack/react-query";
import { normalizeTRPCQueryKey, queryKeys } from "./query-keys";

const MINUTE = 60 * 1000;

/**
 * Freshness is intentionally procedure-specific: reference data stays warm
 * across navigation, while inventory, tasks and finance retain the 60s default.
 * Focus/reconnect always revalidates these longer-lived views in the background
 * because MCP and imports can mutate them outside this tab.
 */
export function configureQueryFreshness(queryClient: QueryClient): void {
  const stableDetailKeys = [
    queryKeys.product.getByID,
    queryKeys.product.getByShortcode,
    queryKeys.location.getByID,
    queryKeys.location.getByShortcode,
    queryKeys.recipe.getByID,
    queryKeys.recipe.getByShortcode,
    queryKeys.ingredient.getByID,
    queryKeys.ingredient.getByShortcode,
  ];
  const stableIndexKeys = [
    queryKeys.product.list,
    queryKeys.location.list,
    queryKeys.location.makeTree,
    queryKeys.recipe.list,
    queryKeys.recipe.listCookbooks,
    queryKeys.ingredient.list,
  ];
  const revalidateOnFocus = {
    refetchOnWindowFocus: "always" as const,
    refetchOnReconnect: "always" as const,
  };
  for (const key of stableDetailKeys) {
    queryClient.setQueryDefaults(normalizeTRPCQueryKey(key), {
      staleTime: 5 * MINUTE,
      ...revalidateOnFocus,
    });
  }
  for (const key of stableIndexKeys) {
    queryClient.setQueryDefaults(normalizeTRPCQueryKey(key), {
      staleTime: 2 * MINUTE,
      ...revalidateOnFocus,
    });
  }
}
