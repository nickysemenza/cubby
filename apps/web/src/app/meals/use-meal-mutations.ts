import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

/**
 * Returns a callback that invalidates every meal query (calendar, detail,
 * shopping list, list). Meal mutations are cheap and infrequent, so a blanket
 * invalidate is simpler and safer than surgical key updates.
 */
export function useInvalidateMeals() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void invalidateOperationTags(queryClient, ripple.meal);
  }, [queryClient]);
}
