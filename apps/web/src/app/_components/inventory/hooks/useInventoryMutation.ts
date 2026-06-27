import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateTRPCQueries,
  inventoryMutationInvalidateKeys,
  productLookupMutationInvalidateKeys,
} from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

export function useInventoryInvalidation() {
  const queryClient = useQueryClient();

  return () => {
    invalidateTRPCQueries(queryClient, inventoryMutationInvalidateKeys);
  };
}

export function useCreateInventoryMutation({
  onSuccess,
  onError,
}: {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
} = {}) {
  const api = useTRPC();
  const invalidateInventory = useInventoryInvalidation();

  return useMutation(
    api.inventory.create.mutationOptions({
      onSuccess: () => {
        invalidateInventory();
        onSuccess?.();
      },
      onError,
    }),
  );
}

export function useProductLookupInvalidation() {
  const queryClient = useQueryClient();

  return () => {
    invalidateTRPCQueries(queryClient, productLookupMutationInvalidateKeys);
  };
}
