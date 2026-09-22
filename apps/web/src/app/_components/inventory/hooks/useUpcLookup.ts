/**
 * useUpcLookup - Shared UPC barcode lookup and product creation logic.
 *
 * Used by: Quick-Capture, Bulk-Edit, and Scanner functionality
 */

import { upc as upcSchema } from "@cubby/usda-schemas";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { product } from "~/app/products/product.functions";
import { showErrorToast } from "~/components/feedback/error-details";
import { getErrorMessage } from "~/lib/error-utils";

import { useProductLookupInvalidation } from "./useInventoryMutation";

interface UseUpcLookupOptions {
  /** Called when a product is successfully found or created. `created` is true
   * only for a brand-new product (vs a match against an existing one). */
  onSuccess?: (product: { id: string; name: string }, created: boolean) => void;
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
 *     form.setValue('product', { id: product.id, name: product.name });
 *   },
 * });
 *
 * // When barcode is scanned:
 * lookupUpc(barcode);
 * ```
 */
export function useUpcLookup(options: UseUpcLookupOptions = {}) {
  const invalidateProductLookup = useProductLookupInvalidation();

  const findOrCreateByUPCMutation = useMutation(
    product.findOrCreateByUPC.mutationOptions({
      onSuccess: invalidateProductLookup,
    }),
  );

  const lookupUpc = useCallback(
    async (upc: string) => {
      const parsedUpc = upcSchema.safeParse(upc);

      if (!parsedUpc.success) {
        const error = "Invalid UPC format";
        options.onError?.(error);
        toast.error(error);
        return null;
      }

      try {
        const { product, created } =
          await findOrCreateByUPCMutation.mutateAsync({
            upc: parsedUpc.data,
          });
        options.onSuccess?.(product, created);
        // Preserve the historical return shape (the product) plus the new
        // `created` flag so callers can prompt to link an ingredient.
        return { ...product, created };
      } catch (err) {
        const errorMessage = getErrorMessage(err);
        options.onError?.(errorMessage);
        showErrorToast(err, "UPC lookup failed");
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
