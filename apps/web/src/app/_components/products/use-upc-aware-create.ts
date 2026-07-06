import { upc as upcSchema } from "@cubby/usda-schemas";
import { useCallback } from "react";
import { useUpcLookup } from "~/app/_components/inventory/hooks/useUpcLookup";
import { buildProductComboboxItem } from "../combobox/combobox-builders";
import type { ComboboxItem } from "../combobox/combobox-types";

/**
 * Wraps a product-picker "create new" callback so a pasted/typed UPC is routed
 * through findOrCreateByUPC (local DB → USDA → UPC worker → default-named
 * create, image import included) and selected straight into the picker. Any
 * non-UPC term falls through to `fallbackCreate` unchanged, so name-only quick
 * creates keep working. A failed lookup rethrows (useUpcLookup already toasts)
 * so the combobox selects nothing.
 */
export function useUpcAwareCreate(
  fallbackCreate: (name: string) => Promise<ComboboxItem>,
) {
  const { lookupUpc } = useUpcLookup();

  return useCallback(
    async (term: string): Promise<ComboboxItem> => {
      const trimmed = term.trim();
      const parsed = upcSchema.safeParse(trimmed);
      if (parsed.success) {
        const product = await lookupUpc(parsed.data);
        if (!product) throw new Error("UPC lookup failed");
        return buildProductComboboxItem(product);
      }
      return fallbackCreate(trimmed);
    },
    [lookupUpc, fallbackCreate],
  );
}
