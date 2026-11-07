import type { FinancialAccountFilters } from "@cubby/schemas/financial-account";
import type {
  FinancialTransactionFilters,
  FinancialTransactionSourceOptionsOut,
} from "@cubby/schemas/financial-transaction";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { useDeletableConfig } from "~/entity/hooks/use-deletable-config";
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
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory("financialAccount", "delete"),
      entity: "financialAccount",
    });
    const list = useMemo(() => ({ deletable }), [deletable]);
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
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory(
        "financialTransaction",
        "delete",
      ),
      entity: "financialTransaction",
    });
    const list = useMemo(
      () => ({
        deletable,
        filterOptions,
      }),
      [deletable, filterOptions],
    );
    return { list };
  },
});

type FinancialAccountOut = DetailRecordOf<"financialAccount">;
type FinancialTransactionOut = DetailRecordOf<"financialTransaction">;
