import { useMutation, useQueryClient } from "@tanstack/react-query";

import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { scheduleDeferredInvalidation } from "~/lib/deferred-invalidation";
import type { UnparsedError } from "~/lib/error-utils";

/**
 * Returns a callback that invalidates inventory queries and re-invalidates
 * them again shortly after, so its background work (whole-tree location
 * valuation) shows up once it lands. Callers may still pass the mutation
 * `data` (kept for source compatibility — it's unused now that there's no
 * batch left to watch); called with no args it just invalidates. Safe to pass
 * directly as a React Query `onSuccess`.
 */
export function useInventoryInvalidation() {
  const queryClient = useQueryClient();

  return <Result>(_result?: Result) => {
    void invalidateOperationTags(queryClient, ripple.inventory);
    scheduleDeferredInvalidation(queryClient, ripple.inventory);
  };
}

export function useCreateInventoryMutation({
  onSuccess,
  onError,
}: {
  onSuccess?: () => void;
  onError?: (error: UnparsedError) => void;
} = {}) {
  const invalidateInventory = useInventoryInvalidation();

  return useMutation(
    entityMutationOptionsFactory(
      "inventory",
      "create",
    )({
      onSuccess: (data) => {
        invalidateInventory(data);
        onSuccess?.();
      },
      onError,
    }),
  );
}

export function useProductLookupInvalidation() {
  const queryClient = useQueryClient();

  return () => {
    void invalidateOperationTags(queryClient, ripple.productLookup);
  };
}
