import type {
  FinancialTransactionFilters,
  FinancialTransactionOut,
} from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { useCallback, useMemo } from "react";

import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { entityListFor } from "~/entities/entity-list.functions";
import { formatCurrency } from "~/lib/utils";

import {
  createFinancialTransactionAccountColumn,
  createFinancialTransactionAmountColumn,
  createFinancialTransactionIdentityColumn,
  createFinancialTransactionPostedDateColumn,
  createFinancialTransactionStatusColumn,
} from "./financial-transaction-columns";

const EMBEDDED_TABLE_STATE = {
  initialSort: "postedDate",
  initialSortDesc: true,
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

export interface LinkedTransactionsOperations {
  list: ListQueryOptionsFn<
    FinancialTransactionFilters,
    FinancialTransactionOut
  >;
}

const productionOperations: LinkedTransactionsOperations = {
  list: entityListFor("financialTransaction").listQueryPlan,
};

// Scoped to one purchase, the slice is the honest figure — the full charge
// settled several orders, and showing it here would overstate what this one
// received. The whole amount stays visible beside it so the split is legible.
function linkedTransactionAmount(
  transaction: FinancialTransactionOut,
  purchaseId: string | undefined,
) {
  const slice = purchaseId
    ? transaction.allocations.find(
        (allocation) => allocation.purchaseId === purchaseId,
      )
    : undefined;
  if (!slice || transaction.allocations.length <= 1)
    return formatCurrency(transaction.amount);
  return (
    <>
      {formatCurrency(slice.amount)}
      <span className="ml-2 text-muted-foreground">
        of {formatCurrency(transaction.amount)}
      </span>
    </>
  );
}

/**
 * Server-backed linked-evidence ledger for account and Purchase detail plates.
 * Account detail already supplies the account context, so its rows omit that
 * redundant column while Purchase settlement keeps it available for comparison.
 */
export function LinkedTransactions({
  accountId,
  purchaseId,
  operations = productionOperations,
}: {
  accountId?: string;
  purchaseId?: string;
  operations?: LinkedTransactionsOperations;
}) {
  const listQueryOptions = useCallback(
    (params: Parameters<LinkedTransactionsOperations["list"]>[0]) =>
      operations.list(params),
    [operations],
  );
  const helper = useMemo(
    () => createCubbyColumnHelper<FinancialTransactionOut>(),
    [],
  );
  const scope = useMemo<Partial<FinancialTransactionFilters>>(() => {
    const filters: Partial<FinancialTransactionFilters> = {};
    if (accountId) {
      filters.accountId = parseShortcodeFor("financialAccount", accountId);
    }
    if (purchaseId) {
      filters.purchaseId = parseShortcodeFor("purchase", purchaseId);
    }
    return filters;
  }, [accountId, purchaseId]);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<FinancialTransactionOut>((add) => {
        add(createFinancialTransactionIdentityColumn(helper, "w-40"));
        if (!accountId) {
          add(createFinancialTransactionAccountColumn(helper, "w-32"));
        }
        add(createFinancialTransactionStatusColumn(helper));
        add(createFinancialTransactionPostedDateColumn(helper, "w-24"));
        add(
          createFinancialTransactionAmountColumn(helper, {
            className: "w-36",
            render: (transaction) =>
              linkedTransactionAmount(transaction, purchaseId),
          }),
        );
      }),
    [accountId, helper, purchaseId],
  );
  const list = useEntityList<
    FinancialTransactionOut,
    FinancialTransactionFilters
  >({
    entity: "financialTransaction",
    queryOptions: listQueryOptions,
    scopeFilters: scope,
    columns,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    includeCatalogActions: false,
    initialColumnVisibility: {
      "related:financialTransaction.vendor": false,
    },
    layoutKey: accountId
      ? "financial-transaction:account-detail"
      : "financial-transaction:purchase-settlement",
  });

  return (
    <ListWorkbench
      model={list.workbench}
      ariaLabel="Linked transactions"
      mode="embedded"
      showColumnMenu
      emptyState={
        <Empty>
          <EmptyTitle>No linked transactions</EmptyTitle>
          <EmptyDescription>
            Settlement evidence can remain unmatched until there is one truthful
            Purchase to link.
          </EmptyDescription>
        </Empty>
      }
    />
  );
}
