import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/purchase";
import { useMemo } from "react";

import { useDeferredFilterOptions } from "~/app/_components/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";

import { defineListOverride } from "./types";

/**
 * The two totals split on purpose: `statedTotal` is what the paperwork
 * claimed and is NEVER summed (a column sum of stated totals would read as
 * spend, which it isn't), while `expenseTotal` is `SUM(expense.cost)`. Every
 * column is declared; only the runtime vendor/project picklists are hand-fed.
 */
export const purchaseListOverride = defineListOverride<
  PurchaseOut,
  PurchaseFilters
>({
  use() {
    // The option's VALUE is the vendor id (the spec is `idMulti` on
    // `vendorId`); the purchase count rides in `hint`, never the label.
    const vendorOptions = useDeferredFilterOptions("vendor");
    const projectOptions = useDeferredFilterOptions("project");
    const filterOptions = useFilterOptions({
      vendor: vendorOptions,
      project: projectOptions,
    });

    const list = useMemo(
      () => ({
        deletable: true as const,
        filterOptions,
      }),
      [filterOptions],
    );

    return { list };
  },
});
