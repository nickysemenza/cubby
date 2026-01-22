/**
 * useProductFindOrCreate - Unified product search/create logic.
 *
 * Handles both UPC barcode lookup and text-based product search,
 * with support for creating new products on the fly.
 *
 * Used by: Quick-Capture, Bulk-Edit, and Scanner functionality
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import type { ProductTopLevelOut } from "~/schemas/product";
import { useTRPC } from "~/trpc/react";
import { applyMiscPrefix, isUpcInput, useUpcLookup } from "./useUpcLookup";

interface UseProductFindOrCreateOptions {
  /** Called when a product is successfully found or created */
  onProductResolved?: (product: ProductTopLevelOut) => void;
  /** Called when product resolution fails */
  onError?: (error: string) => void;
}

/**
 * Hook for finding or creating products via UPC or text search.
 *
 * @example
 * ```tsx
 * const { resolveProduct, quickCreate, isPending } = useProductFindOrCreate({
 *   onProductResolved: (product) => {
 *     form.setValue('product', buildProductComboboxItem(product));
 *   },
 * });
 *
 * // Handle barcode scan
 * const handleScan = async (barcode: string) => {
 *   await resolveProduct(barcode);
 * };
 *
 * // Handle text input that might be UPC or name
 * const handleInput = async (input: string, isMiscMode: boolean) => {
 *   if (isUpcInput(input)) {
 *     await resolveProduct(input);
 *   } else {
 *     const name = isMiscMode ? `misc:${input}` : input;
 *     await quickCreate(name);
 *   }
 * };
 * ```
 */
export function useProductFindOrCreate(
  options: UseProductFindOrCreateOptions = {},
) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  // UPC lookup
  const { lookupUpc, isPending: isUpcPending } = useUpcLookup({
    onSuccess: (product) => {
      options.onProductResolved?.(product as ProductTopLevelOut);
    },
    onError: options.onError,
  });

  // Quick create product mutation
  const quickCreateMutation = useMutation(
    api.product.quickCreate.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [queryKeys.product.list] });
      },
    }),
  );

  /**
   * Resolve a product from either UPC or by creating it.
   * Automatically detects if the input is a UPC barcode.
   */
  const resolveProduct = useCallback(
    async (input: string, createIfNotUpc = false, isMiscMode = false) => {
      const trimmed = input.trim();

      if (isUpcInput(trimmed)) {
        return lookupUpc(trimmed);
      }

      if (createIfNotUpc) {
        const name = isMiscMode ? applyMiscPrefix(trimmed) : trimmed;
        try {
          const product = await quickCreateMutation.mutateAsync({ name });
          options.onProductResolved?.(product);
          return product;
        } catch (err) {
          const errorMessage = getErrorMessage(err);
          options.onError?.(errorMessage);
          toast.error(`Failed to create product: ${errorMessage}`);
          return null;
        }
      }

      return null;
    },
    [lookupUpc, quickCreateMutation, options],
  );

  /**
   * Quick create a new product by name.
   */
  const quickCreate = useCallback(
    async (name: string) => {
      try {
        const product = await quickCreateMutation.mutateAsync({
          name: name.trim(),
        });
        options.onProductResolved?.(product);
        toast.success(`Created: ${product.name}`);
        return product;
      } catch (err) {
        const errorMessage = getErrorMessage(err);
        options.onError?.(errorMessage);
        toast.error(`Failed to create product: ${errorMessage}`);
        return null;
      }
    },
    [quickCreateMutation, options],
  );

  return {
    resolveProduct,
    quickCreate,
    lookupUpc,
    isPending: isUpcPending || quickCreateMutation.isPending,
    isUpcPending,
    isCreatePending: quickCreateMutation.isPending,
  };
}
