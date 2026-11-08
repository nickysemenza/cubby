import type { FinancialAccountFilters } from "@cubby/schemas/financial-account";
import type {
  FinancialTransactionFilters,
  FinancialTransactionSourceOptionsOut,
} from "@cubby/schemas/financial-transaction";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { useFilterOptions } from "~/entity/hooks/use-filter-options";
import { financialTransaction } from "~/integrations/tanstack-query/generated/domains/financialTransaction.gen";

import { defineListOverride } from "../../entity/list-columns/types";

/* ---------------------------------------------------------------------- */
/* Financial accounts                                                      */
/* ---------------------------------------------------------------------- */

export const financialAccountListOverride = defineListOverride<
  FinancialAccountOut,
  FinancialAccountFilters
>({
  use() {
    const list = useMemo(() => ({ deletable: true as const }), []);
    return { list };
  },
});

/* ---------------------------------------------------------------------- */
/* Financial transactions                                                  */
/* ---------------------------------------------------------------------- */

const NO_SOURCES: FinancialTransactionSourceOptionsOut = [];

export const financialTransactionListOverride = defineListOverride<
  FinancialTransactionOut,
  FinancialTransactionFilters
>({
  use() {
    const { data: sources = NO_SOURCES } = useQuery(
      financialTransaction.sourceOptions.queryOptions(null),
    );
    const filterOptions = useFilterOptions({
      source: sources.map((s) => ({
        value: s.source,
        label: s.source,
        hint: `${s.count}`,
      })),
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

type FinancialAccountOut = DetailRecordOf<"financialAccount">;
type FinancialTransactionOut = DetailRecordOf<"financialTransaction">;
