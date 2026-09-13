import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { scheduleDeferredInvalidation } from "~/lib/deferred-invalidation";

interface SessionInvalidateOptions {
  // Schedule a deferred re-invalidation too, so derived work enqueued by the
  // mutation (an AI description, a recomputed valuation) shows up once it
  // lands. When false (the expected-photo path), invalidate synchronously
  // without scheduling one.
  watch?: boolean;
  result?: unknown;
}

/**
 * Single parameterized invalidator for the audit-session surfaces.
 *
 * The inventory ripple already covers everything the three former per-cluster
 * helpers named: the location surfaces a bin's contents are read through, and
 * the product-lookup surfaces the review/capture panes wanted — the old
 * `includeProductLookup` flag selected a strict subset of it.
 */
export function useSessionMutations() {
  const queryClient = useQueryClient();

  const invalidate = useCallback(
    ({ watch = true }: SessionInvalidateOptions = {}) => {
      void invalidateOperationTags(queryClient, ripple.inventory);
      if (watch) scheduleDeferredInvalidation(queryClient, ripple.inventory);
    },
    [queryClient],
  );

  return { invalidate };
}
