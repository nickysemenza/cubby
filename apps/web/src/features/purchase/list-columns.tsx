import type { PurchaseFilters } from "@cubby/schemas/purchase";
import { useMemo } from "react";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";

import { defineListOverride } from "../../entity/list-columns/types";

/**
 * The two totals split on purpose: `statedTotal` is what the paperwork
 * claimed and is NEVER summed (a column sum of stated totals would read as
 * spend, which it isn't), while `expenseTotal` is `SUM(expense.cost)`. Every
 * column and reference filter roster is declared.
 */
export const purchaseListOverride = defineListOverride<
  PurchaseOut,
  PurchaseFilters
>({
  use() {
    const list = useMemo(
      () => ({
        deletable: true as const,
      }),
      [],
    );

    return { list };
  },
});

type PurchaseOut = DetailRecordOf<"purchase">;
