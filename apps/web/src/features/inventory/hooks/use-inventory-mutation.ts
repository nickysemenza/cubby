import { useMutation, useQueryClient } from "@tanstack/react-query";

import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import type { UnparsedError } from "~/lib/error-utils";

/**
 * Explicit refresh for inventory workflows that do not use the entity command.
 */
export function useInventoryInvalidation() {
  const queryClient = useQueryClient();

  return <Result>(_result?: Result) => {
    void invalidateOperationTags(queryClient, ripple.inventory);
  };
}

export function useCreateInventoryMutation({
  onSuccess,
  onError,
}: {
  onSuccess?: () => void;
  onError?: (error: UnparsedError) => void;
} = {}) {
  return useMutation(
    entityMutationOptionsFactory(
      "inventory",
      "create",
    )({
      onSuccess: () => {
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
