import type { FilterOptionsOut } from "@cubby/schemas/filter-options";
import type {
  FinancialAccountFilters,
  FinancialAccountOut,
} from "@cubby/schemas/financial-account";
import type {
  FinancialTransactionFilters,
  FinancialTransactionOut,
  FinancialTransactionSourceOptionsOut,
} from "@cubby/schemas/financial-transaction";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import {
  financialTransaction,
  entityFilterOptions,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { useDeletableConfig } from "~/ui/hooks/useDeletableConfig";
import { useFilterOptions } from "~/ui/hooks/useFilterOptions";

import { defineListOverride } from "./types";

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

const NO_OPTIONS: FilterOptionsOut = { items: [], nextCursor: null };
const NO_SOURCES: FinancialTransactionSourceOptionsOut = [];

export const financialTransactionListOverride = defineListOverride<
  FinancialTransactionOut,
  FinancialTransactionFilters
>({
  use() {
    // Eagerly-loaded rosters for the Account and Source header filters (a
    // header control needs the whole list up front).
    const { data: accounts = NO_OPTIONS } = useQuery(
      entityFilterOptions.filterOptions.queryOptions({
        source: "entity",
        entity: "financialAccount",
        limit: 1000,
        include: ["count"],
      }),
    );
    const { data: sources = NO_SOURCES } = useQuery(
      financialTransaction.sourceOptions.queryOptions(null),
    );
    const filterOptions = useFilterOptions({
      account: accounts.items.map((a) => ({
        value: a.id,
        label: a.label,
        hint: `${a.count ?? 0}`,
      })),
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
