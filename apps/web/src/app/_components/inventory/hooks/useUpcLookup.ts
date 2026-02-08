/**
 * useUpcLookup - Shared UPC barcode lookup and product creation logic.
 *
 * Used by: Quick-Capture, Bulk-Edit, and Scanner functionality
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

/**
 * Check if input looks like a UPC barcode (8-14 digits only).
 * Supports UPC-A (12), UPC-E (8), EAN-13 (13), and EAN-8 (8) formats.
 */
function isUpcInput(input: string): boolean {
  const trimmed = input.trim();
  return /^\d{8,14}$/.test(trimmed);
}

interface UseUpcLookupOptions {
  /** Called when a product is successfully found or created */
  onSuccess?: (product: { id: string; name: string }) => void;
  /** Called when UPC lookup fails */
  onError?: (error: string) => void;
}

/**
 * Hook for looking up or creating products by UPC barcode.
 *
 * @example
 * ```tsx
 * const { lookupUpc, isPending } = useUpcLookup({
 *   onSuccess: (product) => {
 *     form.setValue('product', buildProductComboboxItem(product));
 *   },
 * });
 *
 * // When barcode is scanned:
 * lookupUpc(barcode);
 * ```
 */
export function useUpcLookup(options: UseUpcLookupOptions = {}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const findOrCreateByUPCMutation = useMutation(
    api.product.findOrCreateByUPC.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [queryKeys.product.list] });
      },
    }),
  );

  const lookupUpc = useCallback(
    async (upc: string) => {
      const trimmedUpc = upc.trim();

      if (!isUpcInput(trimmedUpc)) {
        const error = "Invalid UPC format";
        options.onError?.(error);
        toast.error(error);
        return null;
      }

      try {
        const product = await findOrCreateByUPCMutation.mutateAsync({
          upc: trimmedUpc,
        });
        options.onSuccess?.(product);
        return product;
      } catch (err) {
        const errorMessage = getErrorMessage(err);
        options.onError?.(errorMessage);
        toast.error(`UPC lookup failed: ${errorMessage}`);
        return null;
      }
    },
    [findOrCreateByUPCMutation, options],
  );

  return {
    lookupUpc,
    isPending: findOrCreateByUPCMutation.isPending,
    isError: findOrCreateByUPCMutation.isError,
    error: findOrCreateByUPCMutation.error,
  };
}
